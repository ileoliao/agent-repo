import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Policy, decideCommand, decideWrite, hardReject } from './policy';
import { AgentDef } from './team';
import { WorkItem, enqueue, newId, saveGate } from './queue';
import { exec, redact } from './exec';
import { taskOnHandoff, updateTask } from './tasks';
import { createEditToolDefinition } from './vendor/pi/tools/edit';
import { createLsToolDefinition } from './vendor/pi/tools/ls';
import { createReadToolDefinition } from './vendor/pi/tools/read';
import { createWriteToolDefinition } from './vendor/pi/tools/write';

export interface ToolContext {
  root: string;
  agent: AgentDef;
  team: Map<string, AgentDef>;
  item: WorkItem;
  policy: Policy;
  /** Allow rules derived from the agent's skills (their scripts/ folders). */
  extraAllow: string[];
  secrets: Record<string, string>;
  maxHops: number;
  token: vscode.CancellationToken;
}

export interface ToolOutcome {
  text: string;
  decision?: string;
  finished?: { status: string; summary: string; next?: string; deliverables?: string[] };
  /** Gate id: the item parks here and resumes when the human resolves the gate. */
  park?: string;
}

/** Generic, capability-free tools. What an agent can *do* comes from its skills' scripts. */
export function buildTools(agent: AgentDef): vscode.LanguageModelChatTool[] {
  const tools: vscode.LanguageModelChatTool[] = [
    {
      name: 'read_file',
      description: 'Read a UTF-8 text file in the workspace (workspace-relative path). Use for SKILL.md references, code, data. To continue a truncated read, pass startLine (and optionally endLine).',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          startLine: { type: 'number', description: 'First line to return, 1-based. Also accepts offset as an alias.' },
          endLine: { type: 'number', description: 'Last line to return, inclusive.' }
        },
        required: ['path']
      }
    },
    {
      name: 'list_dir',
      description: 'List a workspace directory (non-recursive). "." is the root. If the result says the entry limit was reached, call again with a higher limit.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, limit: { type: 'number', description: 'Maximum entries to return (default 500).' } },
        required: ['path']
      }
    },
    {
      name: 'write_file',
      description: 'Create/overwrite a workspace file. Drafts for human review go under .loop/outbox/.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content']
      }
    },
    {
      name: 'edit_file',
      description: 'Replace exactly one occurrence of oldText with newText in a workspace file.',
      inputSchema: {
        type: 'object',
        properties: { path: { type: 'string' }, oldText: { type: 'string' }, newText: { type: 'string' } },
        required: ['path', 'oldText', 'newText']
      }
    },
    {
      name: 'run_command',
      description:
        "Run a non-interactive shell command at the workspace root. Your skills' scripts are pre-approved. " +
        'A REFUSED result is final: do not retry it; use another route or request_approval.',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] }
    },
    {
      name: 'ask_human',
      description:
        'Ask the human a question when you cannot decide responsibly on your own: ambiguous evidence, a judgement call, ' +
        'missing access or information. You pause here and continue this same conversation when they answer ' +
        '(it may take hours). Ask one specific question, give your recommendation, and offer options when you can.',
      inputSchema: {
        type: 'object',
        properties: {
          question: { type: 'string' },
          context: { type: 'string', description: 'What you found and why you are asking; the human reads only this' },
          options: { type: 'array', items: { type: 'string' }, description: 'Suggested answers, recommended first' },
          files: { type: 'array', items: { type: 'string' }, description: 'Workspace files worth looking at' }
        },
        required: ['question', 'context']
      }
    },
    {
      name: 'request_approval',
      description:
        'Ask the human to approve an action (e.g. sending a reply to a user). Write any draft to .loop/outbox/ first and ' +
        'list it in files; the human may edit it before approving. The command runs only after approval, so make it read ' +
        'the draft file rather than embedding text. With wait=true you pause and continue this conversation with the ' +
        'result or the rejection feedback; with wait=false it returns immediately and you should carry on or finish.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line, e.g. "Reply to SUP-1234"' },
          summary: { type: 'string', description: 'What and why, for the reviewer' },
          command: { type: 'string', description: 'Exact command executed on approval' },
          files: { type: 'array', items: { type: 'string' }, description: 'Draft files to review' },
          wait: { type: 'boolean', description: 'Pause and resume with the outcome (default true)' }
        },
        required: ['title', 'summary', 'command']
      }
    },
    {
      name: 'finish',
      description:
        'End this work item with a short summary. done = resolved; nothing_to_do = nothing needed doing; blocked = you cannot proceed. ' +
        'open = this task is NOT finished and you will continue it later (for example you are waiting for a teammate); ' +
        'it stays on your list of open tasks and you must say in next what the next step is and what you are waiting for.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['done', 'blocked', 'nothing_to_do', 'open'] },
          summary: { type: 'string' },
          next: { type: 'string', description: 'For status open: the next step and what you are waiting for.' },
          deliverables: { type: 'array', items: { type: 'string' }, description: 'Workspace files you produced for the human to read, such as the report. Not notes or intermediate files.' }
        },
        required: ['status', 'summary']
      }
    },
    {
      name: 'update_task',
      description:
        'Update an open task you hold, which need not be the one you are working on now (see "Your open tasks"). ' +
        'state open + note: it is still open, note says what remains. state done or dropped: you no longer hold it; note says why.',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Task id from your open tasks' },
          state: { type: 'string', enum: ['open', 'done', 'dropped'] },
          note: { type: 'string' }
        },
        required: ['id', 'state', 'note']
      }
    }
  ];
  if (agent.handoffs.length > 0) {
    tools.push({
      name: 'handoff',
      description: 'Pass work to a teammate. Include everything they need in context; they do not see your conversation.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', enum: agent.handoffs },
          task: { type: 'string' },
          context: { type: 'string', description: 'Evidence, ids, file paths, findings so far' }
        },
        required: ['to', 'task', 'context']
      }
    });
  }
  return tools;
}

export async function runTool(name: string, input: any, ctx: ToolContext): Promise<ToolOutcome> {
  const outcome = await dispatchTool(name, input, ctx);
  if (outcome.text) outcome.text = redact(outcome.text, ctx.secrets);
  return outcome;
}

async function dispatchTool(name: string, input: any, ctx: ToolContext): Promise<ToolOutcome> {
  switch (name) {
    case 'read_file': {
      const rel = workspaceRel(ctx.root, input.path);
      const window = readWindow(input);
      const result = await createReadToolDefinition(ctx.root).execute(
        'read', { path: rel, offset: window.offset, limit: window.limit }, abortSignal(ctx)
      );
      return { text: rewriteReadHint(toolText(result)) };
    }
    case 'list_dir': {
      const rel = workspaceRel(ctx.root, input.path || '.');
      const limit = asNumber(input.limit);
      const result = await createLsToolDefinition(ctx.root).execute(
        'ls', limit == null ? { path: rel } : { path: rel, limit }, abortSignal(ctx)
      );
      return { text: toolText(result) };
    }
    case 'write_file':
    case 'edit_file': {
      const rel = workspaceRel(ctx.root, input.path);
      const gate = decideWrite(ctx.policy, rel);
      if (gate.decision !== 'allow') {
        return { text: `REFUSED by policy (${gate.rule}).`, decision: 'deny' };
      }
      const signal = abortSignal(ctx);
      if (name === 'write_file') {
        await createWriteToolDefinition(ctx.root).execute('write', { path: rel, content: input.content ?? '' }, signal);
        return { text: `Wrote ${rel}.`, decision: 'allow' };
      }
      const definition = createEditToolDefinition(ctx.root);
      const prepared = definition.prepareArguments?.({ path: rel, oldText: input.oldText, newText: input.newText })
        ?? { path: rel, edits: [{ oldText: input.oldText, newText: input.newText }] };
      try {
        await definition.execute('edit', prepared, signal);
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const found = /Found (\d+) occurrences/.exec(msg);
        if (found) return { text: `edit_file failed: oldText matched ${found[1]} times (need exactly 1).`, decision: 'allow' };
        if (msg.includes('Could not find')) return { text: 'edit_file failed: oldText matched 0 times (need exactly 1).', decision: 'allow' };
        throw e;
      }
      return { text: `Edited ${rel}.`, decision: 'allow' };
    }
    case 'run_command': {
      const gate = decideCommand(ctx.policy, input.command, ctx.extraAllow);
      if (gate.decision !== 'allow') {
        return {
          text: `REFUSED by policy (${gate.rule}). If this action truly needs doing, use request_approval.`,
          decision: 'deny'
        };
      }
      const r = await exec(input.command, {
        cwd: ctx.root,
        timeoutSec: ctx.policy.commandTimeoutSec,
        maxOutputBytes: ctx.policy.maxOutputBytes,
        secrets: ctx.secrets,
        onCancel: kill => ctx.token.onCancellationRequested(kill)
      });
      return { text: r.text, decision: 'allow' };
    }
    case 'ask_human':
    case 'request_approval': {
      const isApproval = name === 'request_approval';
      if (isApproval) {
        const deny = hardReject(ctx.policy, input.command ?? '');
        if (deny) {
          return { text: `REFUSED: command matches deny rule ${deny}; not even a human can approve it here.`, decision: 'deny' };
        }
      }
      const files: string[] = (input.files ?? []).map((f: string) =>
        path.relative(ctx.root, inside(ctx.root, f)).replace(/\\/g, '/'));
      const missing = files.filter(f => !fs.existsSync(path.join(ctx.root, f)));
      if (missing.length) {
        return { text: `${name} failed: files not found: ${missing.join(', ')}. Write them first.` };
      }
      const id = newId();
      const resume = isApproval ? input.wait !== false : true;
      saveGate(ctx.root, {
        id,
        kind: isApproval ? 'approval' : 'question',
        agent: ctx.agent.name,
        itemId: ctx.item.id,
        chainId: ctx.item.chainId,
        goal: ctx.item.goal,
        title: isApproval ? input.title : input.question,
        body: isApproval ? input.summary : input.context,
        options: isApproval ? undefined : input.options,
        command: isApproval ? input.command : undefined,
        files,
        resume,
        status: 'pending',
        createdAt: new Date().toISOString()
      });
      if (!resume) {
        return { text: `Approval ${id} queued; you will not be woken for it. Carry on or finish.`, decision: 'gate' };
      }
      return { text: '', decision: 'gate', park: id };
    }
    case 'handoff': {
      if (!ctx.agent.handoffs.includes(input.to)) {
        const allowed = ctx.agent.handoffs.length ? ctx.agent.handoffs.join(', ') : 'nobody (no handoffs declared)';
        return { text: `REFUSED: ${ctx.agent.name} may only hand off to ${allowed}.`, decision: 'deny' };
      }
      if (ctx.item.hop + 1 > ctx.maxHops) {
        return { text: `REFUSED: chain reached max hops (${ctx.maxHops}). Finish with status blocked.`, decision: 'deny' };
      }
      const id = newId();
      enqueue(ctx.root, {
        id, agent: input.to, task: input.task, context: input.context, from: ctx.agent.name,
        chainId: ctx.item.chainId, hop: ctx.item.hop + 1, createdAt: new Date().toISOString(),
        ...(ctx.item.urgent ? { urgent: true } : {})
      });
      taskOnHandoff(ctx.root, ctx.item, input.to, String(input.task ?? ''));
      return { text: `Handed off to ${input.to} as ${id}.`, decision: 'allow' };
    }
    case 'finish':
      if (input.status === 'open' && !String(input.next ?? '').trim()) {
        return { text: 'Not finished: status open needs next (the next step and what you are waiting for). Call finish again with next, or use another status.' };
      }
      {
        const kept: string[] = [], dropped: string[] = [];
        for (const raw of Array.isArray(input.deliverables) ? input.deliverables.slice(0, 20) : []) {
          try {
            const rel = workspaceRel(ctx.root, String(raw));
            if (rel !== '.' && fs.existsSync(path.resolve(ctx.root, rel)) && fs.statSync(path.resolve(ctx.root, rel)).isFile()) { if (!kept.includes(rel)) { kept.push(rel); } } else { dropped.push(String(raw)); }
          } catch { dropped.push(String(raw)); }
        }
        return { text: dropped.length ? `ok. Not recorded as deliverables (missing or outside the workspace): ${dropped.join(', ')}` : 'ok',
          finished: { status: input.status, summary: input.summary, ...(input.status === 'open' ? { next: String(input.next) } : {}), ...(kept.length ? { deliverables: kept } : {}) } };
      }
    case 'update_task': {
      const text = updateTask(ctx.root, String(input.id ?? ''), ctx.agent.name, String(input.state ?? ''), String(input.note ?? ''));
      return { text, decision: text.startsWith('REFUSED') ? 'deny' : 'allow' };
    }
    default:
      return { text: `Unknown tool ${name}` };
  }
}

function abortSignal(ctx: ToolContext): AbortSignal {
  const ac = new AbortController();
  if (ctx.token.isCancellationRequested) ac.abort();
  else ctx.token.onCancellationRequested(() => ac.abort());
  return ac.signal;
}

function toolText(result: { content?: { type?: string; text?: string }[] }): string {
  return (result.content ?? []).map(part => part.text ?? '').join('\n');
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

/** `startLine`/`endLine` are the tool contract. `offset` is accepted because older hints used that name. */
function readWindow(input: any): { offset?: number; limit?: number } {
  const start = asNumber(input.startLine ?? input.offset);
  const end = asNumber(input.endLine);
  if (end == null) return { offset: start, limit: asNumber(input.limit) };
  const from = start ?? 1;
  return { offset: start, limit: Math.max(0, end - from + 1) };
}

/** pi's reader says `offset`; this tool's schema is `startLine`/`endLine`. */
function rewriteReadHint(text: string): string {
  return text.replace(/Use offset=(\d+) to continue/g, 'Use startLine=$1 to continue');
}

/** Workspace-relative path, or throw if it escapes the root. pi resolves the path against cwd. */
function workspaceRel(root: string, rel: string): string {
  const abs = path.resolve(root, rel ?? '.');
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`Path escapes workspace: ${rel}`);
  }
  const relative = path.relative(root, abs);
  return (relative === '' ? '.' : relative).replace(/\\/g, '/');
}

function inside(root: string, rel: string): string {
  return path.resolve(root, workspaceRel(root, rel));
}
