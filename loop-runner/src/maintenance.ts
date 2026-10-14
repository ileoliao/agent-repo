import * as fs from 'fs';
import * as path from 'path';
import { Gate, WorkItem, audit, complete, getGate, saveGate } from './queue';
import { Task, listTasks } from './tasks';

/**
 * Housekeeping for `.loop/`: what finished work is kept for how long, what a cleanup would delete, which agents
 * are paused, and how a queued item is cancelled. No model is involved. Anything the human still has to look at
 * (pending gates, parked or queued items, open tasks, blocked or failed runs) is never deleted by the automatic pass.
 */
export interface Retention { doneDays: number; runsDays: number; gateDays: number; taskDays: number }
export const DEFAULT_RETENTION: Retention = { doneDays: 14, runsDays: 30, gateDays: 14, taskDays: 30 };

/** Finished items in these states are waiting for a person, so they stay unless the human asks for them to go. */
export const PROBLEM_STATUSES = new Set(['blocked', 'error', 'max_steps', 'stalled']);

export type VictimKind = 'item' | 'run' | 'gate' | 'checkpoint' | 'task';
export interface Victim { kind: VictimKind; /** Workspace-relative. */ file: string; label: string; ageDays: number; bytes: number }
export interface CleanupOptions {
  /** Only this agent's finished work. Checkpoints and run files follow the item they belong to. */
  agent?: string;
  /** Replace the configured age for every kind (0 = everything finished). */
  olderThanDays?: number;
  /** Also remove finished items that ended blocked, error, max_steps or stalled. Never automatic. */
  includeProblems?: boolean;
}

const DAY = 86_400_000;
const L = (root: string, ...p: string[]) => path.join(root, '.loop', ...p);
const rel = (root: string, f: string) => path.relative(root, f).split(path.sep).join('/');
/** Days since `iso` (or since `fallbackMs` when it is missing or unreadable). */
const age = (iso: string | undefined, fallbackMs: number, now: Date) => { const t = iso ? Date.parse(iso) : NaN; return Math.max(0, (now.getTime() - (Number.isNaN(t) ? fallbackMs : t)) / DAY); };
const size = (f: string) => { try { return fs.statSync(f).size; } catch { return 0; } };
const mtime = (f: string) => { try { return fs.statSync(f).mtimeMs; } catch { return Date.now(); } };
const jsonFiles = (d: string): string[] => { try { return fs.readdirSync(d).filter(n => n.endsWith('.json')).map(n => path.join(d, n)); } catch { return []; } };
const readJson = <T>(f: string): T | undefined => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return undefined; } };
const dirs = (d: string): string[] => { try { return fs.readdirSync(d).filter(n => !n.startsWith('_') && fs.statSync(path.join(d, n)).isDirectory()); } catch { return []; } };

/** Items that are queued for an agent or parked on a gate. */
function liveItems(root: string): WorkItem[] {
  const q = L(root, 'queue');
  const out: WorkItem[] = [];
  for (const d of [...dirs(q), '_waiting']) { for (const f of jsonFiles(path.join(q, d))) { const i = readJson<WorkItem>(f); if (i) { out.push(i); } } }
  return out;
}
const doneItems = (root: string): { item: WorkItem; file: string }[] =>
  jsonFiles(L(root, 'queue', '_done')).flatMap(file => { const item = readJson<WorkItem>(file); return item ? [{ item, file }] : []; });

/** What a cleanup would delete, oldest rules first. Pure over the files: nothing is touched. */
export function planCleanup(root: string, ret: Retention = DEFAULT_RETENTION, now = new Date(), opts: CleanupOptions = {}): Victim[] {
  const days = (n: number) => (opts.olderThanDays ?? n);
  const out: Victim[] = [];
  const live = liveItems(root);
  const liveIds = new Set(live.map(i => i.id));
  const done = doneItems(root);

  // Chains that must keep their audit: anything still moving, open tasks, and (unless asked) runs that ended badly.
  const keepChains = new Set(live.map(i => i.chainId));
  for (const t of listTasks(root)) { if (t.state === 'open') { keepChains.add(t.id); } }
  for (const g of jsonFiles(L(root, 'gates')).map(f => readJson<Gate>(f))) { if (g && g.status === 'pending') { keepChains.add(g.chainId); } }
  if (!opts.includeProblems) { for (const d of done) { if (PROBLEM_STATUSES.has(String(d.item.status))) { keepChains.add(d.item.chainId); } } }

  const mine = (agent: string) => !opts.agent || agent === opts.agent;
  const chainsOfAgent = new Set(done.filter(d => d.item.agent === opts.agent).map(d => d.item.chainId));

  for (const { item, file } of done) {
    if (!mine(item.agent)) { continue; }
    if (!opts.includeProblems && PROBLEM_STATUSES.has(String(item.status))) { continue; }
    const a = age(item.finishedAt ?? item.createdAt, mtime(file), now);
    if (a < days(ret.doneDays)) { continue; }
    out.push({ kind: 'item', file: rel(root, file), label: `${item.agent}: ${String(item.task).replace(/\s+/g, ' ').slice(0, 60)} (${item.status ?? 'done'})`, ageDays: Math.floor(a), bytes: size(file) });
  }

  for (const f of jsonFiles(L(root, 'checkpoints'))) {
    const id = path.basename(f, '.json');
    if (liveIds.has(id)) { continue; }
    const owner = done.find(d => d.item.id === id)?.item;
    if (opts.agent && owner?.agent !== opts.agent) { continue; }
    const a = (now.getTime() - mtime(f)) / DAY;
    if (a >= days(ret.doneDays)) { out.push({ kind: 'checkpoint', file: rel(root, f), label: `checkpoint ${id}`, ageDays: Math.floor(a), bytes: size(f) }); }
  }

  for (const f of jsonFiles(L(root, 'gates'))) {
    const g = readJson<Gate>(f);
    if (!g || g.status === 'pending' || liveIds.has(g.itemId) || !mine(g.agent)) { continue; }
    const a = age(g.resolvedAt ?? g.createdAt, mtime(f), now);
    if (a >= days(ret.gateDays)) { out.push({ kind: 'gate', file: rel(root, f), label: `${g.kind} "${g.title.slice(0, 50)}" (${g.status})`, ageDays: Math.floor(a), bytes: size(f) }); }
  }

  for (const t of listTasks(root)) {
    if (t.state === 'open' || (opts.agent && !t.log.some(e => e.agent === opts.agent))) { continue; }
    const a = age(t.updatedAt, Date.now(), now);
    if (a >= days(ret.taskDays)) { out.push({ kind: 'task', file: `.loop/tasks/${t.id}.json`, label: `task "${t.title.slice(0, 50)}" (${t.state})`, ageDays: Math.floor(a), bytes: size(path.join(L(root, 'tasks'), `${t.id}.json`)) }); }
  }

  const runs = L(root, 'runs');
  for (const day of dirs(runs)) {
    const t = Date.parse(day);
    if (Number.isNaN(t)) { continue; }
    const a = (now.getTime() - t) / DAY;
    if (a < days(ret.runsDays)) { continue; }
    for (const n of fs.readdirSync(path.join(runs, day)).filter(n => n.endsWith('.jsonl'))) {
      const chain = n.slice(0, -6);
      if (keepChains.has(chain) || (opts.agent && !chainsOfAgent.has(chain))) { continue; }
      const f = path.join(runs, day, n);
      out.push({ kind: 'run', file: rel(root, f), label: `run ${chain} (${day})`, ageDays: Math.floor(a), bytes: size(f) });
    }
  }
  return out;
}

export interface CleanupResult { removed: Record<VictimKind, number>; bytes: number }

/** Delete the planned files, drop emptied run folders, and leave one line in `.loop/maintenance.jsonl`. */
export function runCleanup(root: string, victims: Victim[], by: 'auto' | 'human', now = new Date()): CleanupResult {
  const removed: Record<VictimKind, number> = { item: 0, run: 0, gate: 0, checkpoint: 0, task: 0 };
  let bytes = 0;
  for (const v of victims) {
    const abs = path.join(root, v.file);
    // Only ever inside .loop/, whatever a caller passes.
    if (!abs.startsWith(L(root) + path.sep) || !fs.existsSync(abs)) { continue; }
    fs.rmSync(abs, { force: true });
    removed[v.kind]++; bytes += v.bytes;
  }
  const runs = L(root, 'runs');
  for (const day of dirs(runs)) { try { if (!fs.readdirSync(path.join(runs, day)).length) { fs.rmdirSync(path.join(runs, day)); } } catch { /* in use */ } }
  if (victims.length) {
    try { fs.appendFileSync(L(root, 'maintenance.jsonl'), JSON.stringify({ ts: now.toISOString(), by, removed, bytes }) + '\n'); } catch { /* a log must never stop housekeeping */ }
  }
  return { removed, bytes };
}

export const describeResult = (r: CleanupResult): string => {
  const parts = Object.entries(r.removed).filter(([, n]) => n).map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`);
  return parts.length ? `Removed ${parts.join(', ')} (${(r.bytes / 1024).toFixed(0)} KB).` : 'Nothing to remove.';
};

/** The automatic pass: at most once per local day. Returns the result when it ran. */
export function autoCleanup(root: string, ret: Retention, now = new Date()): CleanupResult | undefined {
  const stamp = L(root, 'maintenance-state.json');
  const today = now.toDateString();
  if (readJson<{ day?: string }>(stamp)?.day === today) { return undefined; }
  const r = runCleanup(root, planCleanup(root, ret, now), 'auto', now);
  try { fs.mkdirSync(path.dirname(stamp), { recursive: true }); fs.writeFileSync(stamp, JSON.stringify({ day: today })); } catch { /* retried next time */ }
  return r;
}

/** How much `.loop/` holds, by kind, so the human can tell whether cleaning is worth it. */
export function storageUsage(root: string): Record<string, { count: number; bytes: number }> {
  const sum = (files: string[]) => ({ count: files.length, bytes: files.reduce((n, f) => n + size(f), 0) });
  const q = L(root, 'queue');
  const runs = dirs(L(root, 'runs')).flatMap(d => fs.readdirSync(path.join(L(root, 'runs'), d)).map(n => path.join(L(root, 'runs'), d, n)));
  return {
    'queued items': sum([...dirs(q).flatMap(d => jsonFiles(path.join(q, d))), ...jsonFiles(path.join(q, '_waiting'))]),
    'finished items': sum(jsonFiles(path.join(q, '_done'))),
    'run logs': sum(runs),
    gates: sum(jsonFiles(L(root, 'gates'))),
    checkpoints: sum(jsonFiles(L(root, 'checkpoints'))),
    tasks: sum(jsonFiles(L(root, 'tasks')))
  };
}

// ---- pausing an agent's schedule ----

const pausedFile = (root: string) => L(root, 'paused.json');
export function pausedAgents(root: string): Set<string> {
  const v = readJson<{ agents?: unknown }>(pausedFile(root));
  return new Set(Array.isArray(v?.agents) ? v!.agents.map(String) : []);
}
/** A paused agent keeps its configuration; only its scheduled wakes are skipped. A task given by hand still runs. */
export function setPaused(root: string, agent: string, paused: boolean): void {
  const s = pausedAgents(root);
  if (paused) { s.add(agent); } else { s.delete(agent); }
  fs.mkdirSync(path.dirname(pausedFile(root)), { recursive: true });
  fs.writeFileSync(pausedFile(root), JSON.stringify({ agents: [...s].sort() }, null, 2));
}

// ---- what the console has been told to stop showing ----

const uiFile = (root: string) => L(root, 'ui-state.json');
interface UiState { dismissed?: unknown; flags?: unknown }
/** One blocked command of one mate: the unit "Dismiss" ignores from then on. */
export const blockKey = (agent: string, command: string) => `${agent}\n${command}`;
export function dismissedBlocks(root: string): Set<string> {
  const v = readJson<UiState>(uiFile(root));
  return new Set(Array.isArray(v?.dismissed) ? (v!.dismissed as unknown[]).map(String) : []);
}
function saveUi(root: string, dismissed: Set<string>, flags: Set<string>): void {
  fs.mkdirSync(path.dirname(uiFile(root)), { recursive: true });
  fs.writeFileSync(uiFile(root), JSON.stringify({ dismissed: [...dismissed].slice(-200), flags: [...flags].sort() }, null, 2));
}
const uiFlags = (root: string) => { const v = readJson<UiState>(uiFile(root)); return new Set(Array.isArray(v?.flags) ? (v!.flags as unknown[]).map(String) : []); };
export const uiFlag = (root: string, name: string): boolean => uiFlags(root).has(name);
/** Stop offering to allow this command for this mate. Nothing in the policy changes. */
export function dismissBlock(root: string, agent: string, command: string): void {
  saveUi(root, new Set([...dismissedBlocks(root), blockKey(agent, command)]), uiFlags(root));
}
/** A one-time hint the human has seen (for example the note on the first approval card). */
export function setUiFlag(root: string, name: string): void { saveUi(root, dismissedBlocks(root), new Set([...uiFlags(root), name])); }

// ---- the queue ----

export interface QueueRow { id: string; agent: string; state: 'queued' | 'waiting'; task: string; from: string; createdAt: string }
export function listQueue(root: string): QueueRow[] {
  const q = L(root, 'queue');
  const rows: QueueRow[] = [];
  for (const d of [...dirs(q), '_waiting']) {
    for (const f of jsonFiles(path.join(q, d))) {
      const i = readJson<WorkItem>(f);
      if (i) { rows.push({ id: i.id, agent: i.agent, state: d === '_waiting' ? 'waiting' : 'queued', task: i.task.replace(/\s+/g, ' ').slice(0, 160), from: i.from, createdAt: i.createdAt }); }
    }
  }
  return rows.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/**
 * Cancel a queued or parked item: it moves to the finished list as `cancelled`, and any question or approval it was
 * parked on is closed so the inbox does not keep asking. A running item is cancelled through the runner instead.
 */
export function cancelQueued(root: string, id: string, now = new Date()): string {
  const row = listQueue(root).find(r => r.id === id);
  if (!row) { return `No queued or waiting item ${id}.`; }
  const file = row.state === 'waiting' ? L(root, 'queue', '_waiting', `${id}.json`) : L(root, 'queue', row.agent, `${id}.json`);
  const item = readJson<WorkItem>(file);
  if (!item) { return `Item ${id} is gone.`; }
  for (const f of jsonFiles(L(root, 'gates'))) {
    const g = readJson<Gate>(f);
    if (g && g.itemId === id && g.status === 'pending') { saveGate(root, { ...getGate(root, g.id)!, status: 'rejected', resolvedAt: now.toISOString(), outcome: 'The item was cancelled by the human.' }); }
  }
  complete(root, item, 'cancelled', 'cancelled by the human');
  if (row.state === 'waiting') { fs.rmSync(file, { force: true }); }
  audit(root, item.chainId, { type: 'end', agent: item.agent, itemId: item.id, step: 0, status: 'cancelled', summary: 'cancelled by the human', outputs: [] });
  return `Cancelled ${row.agent}'s ${row.state} item ${id}.`;
}

/** Tasks the human may close: open, and who holds them. */
export const openTasks = (root: string): Task[] => listTasks(root).filter(t => t.state === 'open');
