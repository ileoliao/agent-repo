import * as fs from 'fs';
import * as path from 'path';

/**
 * File-backed state. Plain JSON on disk: survives VS Code restarts, inspectable, hand-editable.
 *
 *   .loop/queue/<agent>/<id>.json      runnable work
 *   .loop/queue/_waiting/<id>.json     parked on a human gate
 *   .loop/queue/_done/<id>.json        finished work
 *   .loop/gates/<id>.json              questions and approvals for the human (the inbox)
 *   .loop/checkpoints/<itemId>.json    conversation snapshot for resuming a parked item
 *   .loop/runs/<date>/<chainId>.jsonl  audit
 */
export interface WorkItem {
  id: string;
  agent: string;
  task: string;
  context?: string;
  /** 'schedule' | 'user' | 'chat' | 'task' | <agent name> */
  from: string;
  /** The goal (see `GoalDef`) that triggered a scheduled run. */
  goal?: string;
  /** May use the reserved worker slot and goes before other items. Inherited by handoffs and return wakes. */
  urgent?: boolean;
  /** Shared by every item spawned from the same origin, across handoffs. Becomes the trace id later. */
  chainId: string;
  hop: number;
  createdAt: string;
  /** Set when the item is re-queued after a gate resolves: the runner resumes from the checkpoint. */
  resumeGate?: string;
  status?: string;
  summary?: string;
  finishedAt?: string;
}

export type GateKind = 'question' | 'approval';
export type GateStatus = 'pending' | 'answered' | 'executed' | 'failed' | 'rejected';

export interface Gate {
  id: string;
  kind: GateKind;
  agent: string;
  itemId: string;
  chainId: string;
  /** Goal of the run that asked, so an approval is executed under that goal's policy. */
  goal?: string;
  title: string;
  /** question: what the agent asks. approval: what and why. */
  body: string;
  /** question: optional choices (free text always allowed). */
  options?: string[];
  /** approval: exact command run on approval, shown verbatim. */
  command?: string;
  /** Draft files the human can open and edit first. */
  files: string[];
  /** If true the work item is parked and resumes with the outcome; if false it already finished. */
  resume: boolean;
  status: GateStatus;
  createdAt: string;
  resolvedAt?: string;
  notifiedAt?: string;
  /** What the agent sees when resumed: the answer, the command result, or the rejection. */
  outcome?: string;
}

/** Serializable conversation, independent of vscode classes. */
export type PlainPart =
  | { t: 'text'; v: string }
  | { t: 'call'; callId: string; name: string; input: unknown }
  | { t: 'result'; callId: string; text: string };
export interface PlainMsg { role: 'user' | 'assistant'; parts: PlainPart[] }
export interface Checkpoint {
  itemId: string;
  gateId: string;
  messages: PlainMsg[];
  /** Results of the other tool calls in the turn that parked; sent together with the gate outcome. */
  turnResults: { callId: string; text: string }[];
  parkedCallId: string;
  step: number;
}

export function newId(): string {
  const t = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `${t}-${Math.random().toString(36).slice(2, 8)}`;
}

const L = (root: string, ...p: string[]) => path.join(root, '.loop', ...p);
const writeJson = (f: string, v: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2)); };
const readJson = <T>(f: string): T | undefined => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined);
const readDir = <T>(d: string): T[] =>
  fs.existsSync(d) ? fs.readdirSync(d).filter(f => f.endsWith('.json')).map(f => JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')) as T) : [];

// ---- work items ----
export function enqueue(root: string, item: WorkItem): void {
  writeJson(L(root, 'queue', item.agent, `${item.id}.json`), item);
}

export function pending(root: string, agent: string): WorkItem[] {
  return readDir<WorkItem>(L(root, 'queue', agent)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function waiting(root: string): WorkItem[] {
  return readDir<WorkItem>(L(root, 'queue', '_waiting'));
}

/**
 * Which queued item may start now, given what is running. Pure.
 *  - never an item whose chain already has a running item;
 *  - with more than one worker, non-urgent items may fill at most `workers - 1` slots, so one is left for urgent work;
 *  - among the eligible, urgent first, then oldest first (resumed items keep their original age).
 * With one worker and no urgent items this is plain FIFO.
 */
export function pickItem(queued: WorkItem[], running: WorkItem[], workers = 1): WorkItem | undefined {
  if (running.length >= workers) { return undefined; }
  const busy = new Set(running.map(r => r.chainId));
  const plain = running.filter(r => !r.urgent).length;
  const eligible = queued.filter(i => !busy.has(i.chainId) && (i.urgent || workers <= 1 || plain < workers - 1));
  return eligible.sort((a, b) => (a.urgent ? 0 : 1) - (b.urgent ? 0 : 1) || a.createdAt.localeCompare(b.createdAt))[0];
}

/** Next runnable item across the given agents (see `pickItem`). */
export function nextItem(root: string, agents: string[], running: WorkItem[] = [], workers = 1): WorkItem | undefined {
  return pickItem(agents.flatMap(a => pending(root, a)), running, workers);
}

/** A scheduled item for this agent is still queued or parked on a gate; a new wake would duplicate it. */
export function hasOpenScheduled(root: string, agent: string, goal = 'default'): boolean {
  const mine = (i: WorkItem) => i.from === 'schedule' && (i.goal ?? 'default') === goal;
  return pending(root, agent).some(mine) || waiting(root).some(i => i.agent === agent && mine(i));
}

/** Scheduled items this agent already had today (local date), whether queued, parked or finished. */
export function scheduledToday(root: string, agent: string, now = new Date(), goal = 'default'): number {
  const day = now.toDateString();
  const mine = [...pending(root, agent), ...waiting(root).filter(i => i.agent === agent), ...readDir<WorkItem>(L(root, 'queue', '_done')).filter(i => i.agent === agent)];
  return mine.filter(i => i.from === 'schedule' && (i.goal ?? 'default') === goal && new Date(i.createdAt).toDateString() === day).length;
}

/**
 * `gateId` is the gate a `waiting` item parked on. The human may have resolved it while the turn was still
 * running, before the item reached `_waiting`; that answer's wake() found nothing, so wake it here.
 */
export function complete(root: string, item: WorkItem, status: string, summary?: string, gateId?: string): void {
  const src = L(root, 'queue', item.agent, `${item.id}.json`);
  const done: WorkItem = { ...item, resumeGate: undefined, status, summary, finishedAt: new Date().toISOString() };
  if (status === 'waiting') {
    writeJson(L(root, 'queue', '_waiting', `${item.id}.json`), done);
  } else {
    writeJson(L(root, 'queue', '_done', `${item.id}.json`), done);
    const cp = L(root, 'checkpoints', `${item.id}.json`);
    if (fs.existsSync(cp)) { fs.unlinkSync(cp); }
  }
  if (fs.existsSync(src)) { fs.unlinkSync(src); }
  if (status === 'waiting' && gateId && getGate(root, gateId)?.status !== 'pending') { wake(root, item.id, gateId); }
}

/** Move a parked item back to its agent's queue so the runner resumes it from the checkpoint. */
export function wake(root: string, itemId: string, gateId: string): boolean {
  const f = L(root, 'queue', '_waiting', `${itemId}.json`);
  const item = readJson<WorkItem>(f);
  if (!item) { return false; }
  enqueue(root, { ...item, status: undefined, summary: undefined, finishedAt: undefined, resumeGate: gateId });
  fs.unlinkSync(f);
  return true;
}

// ---- gates ----
export function saveGate(root: string, g: Gate): void { writeJson(L(root, 'gates', `${g.id}.json`), g); }
export function getGate(root: string, id: string): Gate | undefined { return readJson<Gate>(L(root, 'gates', `${id}.json`)); }
export function listGates(root: string): Gate[] {
  return readDir<Gate>(L(root, 'gates')).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ---- checkpoints ----
export function saveCheckpoint(root: string, cp: Checkpoint): void { writeJson(L(root, 'checkpoints', `${cp.itemId}.json`), cp); }
export function loadCheckpoint(root: string, itemId: string): Checkpoint | undefined {
  return readJson<Checkpoint>(L(root, 'checkpoints', `${itemId}.json`));
}

// ---- audit ----
export function audit(root: string, chainId: string, ev: Record<string, unknown>): void {
  const day = new Date().toISOString().slice(0, 10);
  const d = L(root, 'runs', day);
  fs.mkdirSync(d, { recursive: true });
  fs.appendFileSync(path.join(d, `${chainId}.jsonl`), JSON.stringify({ ts: new Date().toISOString(), chainId, ...ev }) + '\n');
}

// ---- retry policy ----
const TRANSIENT = /rate.?limit|quota|exhausted|too many requests|temporarily blocked/i;

/**
 * Cancelled work and temporary quota/rate-limit errors stay in the agent queue so the next start retries them.
 * A context overflow ("Message exceeds token limit.") is permanent for that item: retrying it would loop forever.
 */
export function keepQueued(status: string, summary?: string): boolean {
  const s = summary ?? '';
  return status === 'cancelled' || (status === 'error' && TRANSIENT.test(s) && !/token limit/i.test(s));
}
