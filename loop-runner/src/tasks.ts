import * as fs from 'fs';
import * as path from 'path';
import { WorkItem, enqueue, newId, pending, waiting } from './queue';
import { clip, firstLine } from './textutil';

/**
 * The task ledger: `.loop/tasks/<chainId>.json`. Pure, no vscode.
 *
 * Who knows what: the runtime records task identity, who holds it and how each run ended (at lifecycle points); the
 * model only supplies "is it still open" and "what is my next step", through `finish` (status open + next) and
 * `update_task`. The ledger lives under `.loop/`, so agents cannot edit it with their file tools. It must never make
 * a run fail: a missing or corrupt file reads as absent, and write errors are swallowed.
 */
export type TaskState = 'open' | 'done' | 'dropped';
export interface TaskLogEntry { ts: string; agent: string; event: 'start' | 'handoff' | 'end' | 'update' | 'human'; status?: string; to?: string; text?: string }
export interface Task {
  /** = chainId */
  id: string;
  title: string;
  /** The goal whose run created the task, if any. */
  goal?: string;
  state: TaskState;
  /** Agents currently responsible. */
  holders: string[];
  /** Per holder: that agent's own "what remains". */
  next?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** The last 30 entries. */
  log: TaskLogEntry[];
}

const LOG_MAX = 30;
const ID_OK = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
/** One line, no control characters, bounded. */
const line = (s: unknown, n: number): string => clip(String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim(), n);
const file = (root: string, id: string): string | undefined => (ID_OK.test(id) && !id.includes('..') ? path.join(root, '.loop', 'tasks', `${id}.json`) : undefined);

function sane(t: any): t is Task {
  return !!t && typeof t === 'object' && typeof t.id === 'string' && Array.isArray(t.holders) && Array.isArray(t.log) && ['open', 'done', 'dropped'].includes(t.state);
}

export function getTask(root: string, id: string): Task | undefined {
  const f = file(root, String(id));
  if (!f) { return undefined; }
  try {
    const t = JSON.parse(fs.readFileSync(f, 'utf8'));
    return sane(t) ? t : undefined;
  } catch { return undefined; }
}

function save(root: string, t: Task): void {
  const f = file(root, t.id);
  if (!f) { return; }
  try {
    t.log = t.log.slice(-LOG_MAX);
    t.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(t, null, 2));
  } catch { /* the ledger must never stop a run */ }
}

/** Most recently updated first. */
export function listTasks(root: string): Task[] {
  const d = path.join(root, '.loop', 'tasks');
  let names: string[] = [];
  try { names = fs.readdirSync(d).filter(n => n.endsWith('.json')); } catch { return []; }
  return names.flatMap(n => { const t = getTask(root, n.slice(0, -5)); return t ? [t] : []; }).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Open tasks this agent holds, most recently updated first. */
export function openTasksFor(root: string, agent: string): Task[] {
  return listTasks(root).filter(t => t.state === 'open' && t.holders.includes(agent));
}

const entry = (agent: string, event: TaskLogEntry['event'], extra: Partial<TaskLogEntry> = {}): TaskLogEntry => {
  const e: TaskLogEntry = { ts: new Date().toISOString(), agent, event };
  if (extra.status) { e.status = line(extra.status, 40); }
  if (extra.to) { e.to = line(extra.to, 60); }
  if (extra.text) { e.text = line(extra.text, 300); }
  return e;
};

function create(item: WorkItem): Task {
  const now = new Date().toISOString();
  return {
    id: item.chainId, title: line(firstLine(String(item.task ?? '')), 120), ...(item.goal ? { goal: item.goal } : {}), state: 'open', holders: [item.agent], createdAt: now, updatedAt: now,
    // The run began before the task had a record: say so, so the history reads from the start.
    log: [entry(item.agent, 'start', { text: item.from })]
  };
}

/**
 * A fresh run (not a resume) begins. A task only gets a record once it outlives a single run (see `taskOnHandoff` and
 * `taskOnEnd`), so this only updates a task that already exists.
 */
export function taskOnStart(root: string, item: WorkItem): void {
  try {
    const t = getTask(root, item.chainId);
    if (!t) { return; }
    if (t.state === 'open' && !t.holders.includes(item.agent)) { t.holders.push(item.agent); }
    // A run that was interrupted before its first checkpoint starts fresh again: do not log the same start twice.
    const last = t.log[t.log.length - 1];
    if (!(last && last.event === 'start' && last.agent === item.agent)) { t.log.push(entry(item.agent, 'start', { text: item.from === 'task' ? 'woken: a task you hold progressed' : item.from })); }
    save(root, t);
  } catch { /* ignore */ }
}

/** `handoff` succeeded: the receiver now shares the task. A handoff is what makes a task outlive one run, so it is created here. */
export function taskOnHandoff(root: string, item: WorkItem, to: string, taskText: string): void {
  try {
    const t = getTask(root, item.chainId) ?? create(item);
    if (t.state === 'open' && !t.holders.includes(to)) { t.holders.push(to); }
    t.log.push(entry(item.agent, 'handoff', { to, text: taskText }));
    save(root, t);
  } catch { /* ignore */ }
}

export interface EndEffect {
  /** A return wake that was enqueued (for the caller's information). */
  woke?: WorkItem;
  /** Why a return wake was not enqueued although it would have been due. */
  skipped?: string;
}

const hasLive = (root: string, agent: string, chainId: string, exceptItem: string): boolean =>
  pending(root, agent).some(i => i.chainId === chainId && i.id !== exceptItem) || waiting(root).some(i => i.agent === agent && i.chainId === chainId && i.id !== exceptItem);

/** The agent's last statement about the task was "still open". */
const openByThem = (t: Task, agent: string): boolean => {
  const last = [...t.log].reverse().find(e => e.agent === agent && (e.event === 'end' || e.event === 'update'));
  return !!t.next?.[agent] && last?.status === 'open';
};

/**
 * An item reached a terminal status. `waiting` and `cancelled` are not terminal (the item is still live: a retry) and change
 * nothing. `cancelled_by_human` is the human's "Cancel this run": the item is gone for good, so it is recorded like `blocked`.
 * A run that ends `done`/`nothing_to_do` and never had a record leaves none; any other ending creates it.
 * When the ending agent was the last one a holder was waiting on, the waiting holder gets a return-wake item.
 */
export function taskOnEnd(root: string, item: WorkItem, status: string, summary: string | undefined, next: string | undefined, maxHops: number): EndEffect {
  if (status === 'waiting' || status === 'cancelled') { return {}; }
  try {
    const byHuman = status === 'cancelled_by_human';
    if (byHuman) { status = 'cancelled'; summary = 'cancelled by the human'; next = 'cancelled by the human'; }
    const closes = status === 'done' || status === 'nothing_to_do';
    const t = getTask(root, item.chainId) ?? (closes ? undefined : create(item));
    if (!t) { return {}; }
    const agent = item.agent;
    t.log.push(entry(agent, 'end', { status, text: summary }));
    if (t.state === 'open') {
      t.next = t.next ?? {};
      if (closes) {
        t.holders = t.holders.filter(h => h !== agent);
        delete t.next[agent];
      } else {
        if (!t.holders.includes(agent)) { t.holders.push(agent); }
        t.next[agent] = line(next || summary || status, 300);
      }
      if (!t.holders.length) { t.state = 'done'; }
    }
    if (!Object.keys(t.next ?? {}).length) { delete t.next; }
    const effect = closes && t.state === 'open' ? returnWake(root, t, item, summary, maxHops) : {};
    save(root, t);
    return effect;
  } catch { return {}; }
}

function returnWake(root: string, t: Task, item: WorkItem, summary: string | undefined, maxHops: number): EndEffect {
  const x = t.holders.find(h => openByThem(t, h) && !hasLive(root, h, t.id, item.id));
  if (!x) { return {}; }
  // Someone else still has a live item for this task: it is not time yet.
  if (t.holders.some(h => hasLive(root, h, t.id, item.id))) { return {}; }
  if (item.hop + 1 > maxHops) {
    const why = `return wake for ${x} skipped: chain reached max hops (${maxHops})`;
    t.log.push(entry('task', 'update', { status: 'skipped', text: why }));
    return { skipped: why };
  }
  const woke: WorkItem = {
    id: newId(), agent: x, from: 'task', chainId: t.id, hop: item.hop + 1, createdAt: new Date().toISOString(), ...(item.urgent ? { urgent: true } : {}),
    task: `Task ${t.id} progressed: ${item.agent} finished: ${line(summary, 300)}. Your next step was: ${t.next![x]}`
  };
  enqueue(root, woke);
  t.log.push(entry('task', 'update', { status: 'woken', text: `return wake queued after ${item.agent} finished` }));
  return { woke };
}

/** `update_task`: an agent changes a task it holds. Returns the text the model sees. */
export function updateTask(root: string, id: string, agent: string, state: string, note: string): string {
  const t = getTask(root, String(id));
  if (!t) { return `REFUSED: no task ${line(id, 80)}.`; }
  if (!t.holders.includes(agent)) { return `REFUSED: ${agent} does not hold task ${t.id}.`; }
  if (t.state !== 'open') { return `REFUSED: task ${t.id} is already ${t.state}.`; }
  if (state !== 'open' && state !== 'done' && state !== 'dropped') { return `REFUSED: state must be open, done or dropped.`; }
  if (state === 'open' && !String(note ?? '').trim()) { return 'REFUSED: say what remains in note.'; }
  t.next = t.next ?? {};
  t.log.push(entry(agent, 'update', { status: state, text: note }));
  if (state === 'open') {
    t.next[agent] = line(note, 300);
  } else {
    t.holders = t.holders.filter(h => h !== agent);
    delete t.next[agent];
    if (!t.holders.length) { t.state = state; }
  }
  if (!Object.keys(t.next).length) { delete t.next; }
  save(root, t);
  return state === 'open' ? `Task ${t.id} stays open; your next step is recorded.` : `You no longer hold task ${t.id}${t.state === state ? ` (it is now ${state})` : ''}.`;
}

/** The human closes a task from the console. */
export function closeTaskByHuman(root: string, id: string): boolean {
  const t = getTask(root, id);
  if (!t) { return false; }
  t.log.push(entry('human', 'human', { status: 'dropped', text: 'closed by the human' }));
  t.state = 'dropped';
  t.holders = [];
  delete t.next;
  save(root, t);
  return true;
}
