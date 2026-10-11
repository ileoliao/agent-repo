import { Gate, audit, getGate, saveGate, wake } from './queue';
import { Policy, hardReject } from './policy';
import { exec } from './exec';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Resolving human gates. vscode-free so it can be tested directly.
 * Every resolution writes an outcome; if the gate parked a work item, that item wakes up
 * and continues its own conversation with the outcome as the tool result.
 */
const EDIT_NOTE = (g: Gate) =>
  g.files.length ? `\nThe human may have edited these files before deciding; re-read them if it matters: ${g.files.join(', ')}` : '';

function settle(root: string, g: Gate, status: Gate['status'], outcome: string): { woke: boolean } {
  g.status = status;
  g.outcome = outcome;
  g.resolvedAt = new Date().toISOString();
  saveGate(root, g);
  audit(root, g.chainId, { type: 'gate', gateId: g.id, kind: g.kind, status, outcome: outcome.slice(0, 2000) });
  return { woke: g.resume ? wake(root, g.itemId, g.id) : false };
}

function pendingGate(root: string, id: string, kind: Gate['kind']): Gate {
  const g = getGate(root, id);
  if (!g || g.kind !== kind) { throw new Error(`No ${kind} ${id}`); }
  if (g.status !== 'pending') { throw new Error(`${kind} ${id} is already ${g.status}`); }
  return g;
}

/** sha256 of a workspace file's bytes, or 'missing'. What the reviewer saw is compared against this at execution time. */
export const sha256Of = (buf: Buffer): string => crypto.createHash('sha256').update(buf).digest('hex');
export function fileSha256(root: string, rel: string): string {
  try { return sha256Of(fs.readFileSync(path.join(root, rel))); } catch { return 'missing'; }
}

export function answerQuestion(root: string, id: string, answer: string) {
  const g = pendingGate(root, id, 'question');
  return settle(root, g, 'answered', `The human answered: ${answer}${EDIT_NOTE(g)}`);
}

export function rejectApproval(root: string, id: string, feedback?: string) {
  const g = pendingGate(root, id, 'approval');
  const fb = feedback?.trim();
  return settle(root, g, 'rejected',
    `REJECTED by the human. The command was not run.${fb ? `\nFeedback: ${fb}\nRevise accordingly; request approval again if still appropriate.` : ''}${EDIT_NOTE(g)}`);
}

/**
 * Runs the approved command. Hard rejects are applied again here: deny rules, command
 * substitution, and redirection onto a protected path. Human approval cannot bypass them,
 * even if the gate was queued before the policy changed.
 */
export async function approveAndRun(root: string, id: string, policy: Policy, secrets: Record<string, string>, seen?: Record<string, string>) {
  const g = pendingGate(root, id, 'approval');
  // When the reviewer approved from a view that showed file contents, run only what they saw: a file that
  // changed since (or a file they were never shown) means the approval no longer matches, so ask again.
  if (seen) {
    const changed = g.files.filter(f => { const now = fileSha256(root, f); return seen[f] === undefined || now === 'missing' || seen[f] !== now; });
    if (changed.length) { throw new Error(`Not run: ${changed.join(', ')} changed after you reviewed it. Review again, then approve.`); }
  }
  const deny = hardReject(policy, g.command ?? '');
  if (deny) { throw new Error(`Blocked by deny rule ${deny}`); }
  const r = await exec(g.command!, { cwd: root, timeoutSec: policy.commandTimeoutSec, maxOutputBytes: policy.maxOutputBytes, secrets });
  const ok = r.code === 0;
  const res = settle(root, g, ok ? 'executed' : 'failed',
    `APPROVED by the human and executed (${ok ? 'success' : 'FAILED'}).\n${r.text}`);
  return { ...res, ok, text: r.text };
}

export interface LoopEvent {
  kind: 'question' | 'approval' | 'blocked' | 'error' | 'max_steps' | 'stalled';
  agent: string;
  title: string;
  detail?: string;
  gateId?: string;
  itemId?: string;
  chainId?: string;
}

/**
 * Tell the human they are needed. The channel is a script (a skill), not built in:
 * it receives the event as JSON in LOOP_EVENT plus LOOP_EVENT_KIND / LOOP_EVENT_TITLE.
 */
export async function notify(root: string, command: string | undefined, ev: LoopEvent, secrets: Record<string, string>) {
  if (!command) { return undefined; }
  const r = await exec(command, {
    cwd: root, timeoutSec: 30, maxOutputBytes: 2000, secrets,
    env: { LOOP_EVENT: JSON.stringify(ev), LOOP_EVENT_KIND: ev.kind, LOOP_EVENT_TITLE: ev.title }
  });
  if (ev.chainId) { audit(root, ev.chainId, { type: 'notify', kind: ev.kind, gateId: ev.gateId, ok: r.code === 0 }); }
  return r;
}
