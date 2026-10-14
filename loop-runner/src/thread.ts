import * as fs from 'fs';
import * as path from 'path';
import { getGate, listGates, newId, pending as queuedItems, waiting } from './queue';
import { Active, brief, clip, firstLine, humanize, isActive, refusalOf } from './textutil';

/**
 * Chat with an agent: the human's messages, and the conversation shown as a thread.
 * The human's side lives in `.loop/chat/<agent>/<id>.json`, one small file per message (the runtime delivers it at the next turn
 * boundary and marks it delivered). The agent's side is not stored twice: it is read from the audit files the runtime already writes.
 * Pure and vscode-free.
 */
export interface HumanMessage {
  id: string;
  ts: string;
  text: string;
  status: 'pending' | 'delivered';
  deliveredAt?: string;
  itemId?: string;
  /** How it reached the agent: in the first prompt, between two turns, together with a gate's answer, or as a new task. */
  via?: 'start' | 'turn' | 'resume' | 'task';
}

const MAX_CHARS = 4000;
const AGENT = /^[\w.-]{1,60}$/;
const dir = (root: string, agent: string) => path.join(root, '.loop', 'chat', agent);

/** The human's words, without control characters (newlines and tabs stay) and bounded. */
export function cleanMessage(text: string): string {
  const t = String(text ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  return t.length <= MAX_CHARS ? t : t.slice(0, MAX_CHARS - 1) + '…';
}

export function postHumanMessage(root: string, agent: string, text: string, now = new Date()): HumanMessage {
  if (!AGENT.test(agent)) { throw new Error(`bad agent name "${agent}"`); }
  const clean = cleanMessage(text);
  if (!clean) { throw new Error('The message is empty.'); }
  const m: HumanMessage = { id: newId(), ts: now.toISOString(), text: clean, status: 'pending' };
  fs.mkdirSync(dir(root, agent), { recursive: true });
  fs.writeFileSync(path.join(dir(root, agent), `${m.id}.json`), JSON.stringify(m, null, 1));
  return m;
}

export function listMessages(root: string, agent: string): HumanMessage[] {
  const d = dir(root, agent);
  if (!AGENT.test(agent) || !fs.existsSync(d)) { return []; }
  const out: HumanMessage[] = [];
  for (const f of fs.readdirSync(d).filter(n => n.endsWith('.json')).sort()) {
    try { out.push(JSON.parse(fs.readFileSync(path.join(d, f), 'utf8'))); } catch { /* a torn or hand-edited file is skipped */ }
  }
  return out;
}

export const pendingMessages = (root: string, agent: string): HumanMessage[] => listMessages(root, agent).filter(m => m.status === 'pending');

export function markDelivered(root: string, agent: string, ids: string[], meta: { itemId?: string; via: NonNullable<HumanMessage['via']> }, now = new Date()): void {
  for (const id of ids) {
    const f = path.join(dir(root, agent), `${id}.json`);
    try {
      const m = JSON.parse(fs.readFileSync(f, 'utf8')) as HumanMessage;
      fs.writeFileSync(f, JSON.stringify({ ...m, status: 'delivered', deliveredAt: now.toISOString(), itemId: meta.itemId, via: meta.via }, null, 1));
    } catch { /* already gone */ }
  }
}

const hhmm = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };

/** What the model is told. The human is the owner of the work, so these are instructions, within the policy. */
export function formatForModel(msgs: HumanMessage[], when: 'start' | 'while-working' = 'while-working'): string {
  const head = when === 'start' ? 'Messages from the human, sent before this run started:' : 'Message from the human, sent while you were working:';
  return `${head}\n` + msgs.map(m => `[${hhmm(m.ts)}] ${m.text}`).join('\n\n');
}

// ---- the thread ----

/** `title` is the full call (audit detail); `phrase` is the plain-words version; `fam`/`famKind` say what routine calls fold under. */
export interface ThreadStep { step: number; kind: 'tool' | 'gate'; title: string; phrase: string; routine: boolean; fam?: string; famKind?: 'skill' | 'read' | 'list'; detail?: string; ok: boolean; ts?: string; path?: string; refused?: { command: string; rule: string } }
export type Tone = 'info' | 'ok' | 'bad' | 'warn' | 'mute';
export type ThreadEvent =
  | { kind: 'human'; ts: string; id: string; text: string; status: 'pending' | 'delivered'; deliveredAt?: string; via?: HumanMessage['via'] }
  | { kind: 'agent'; ts: string; text: string; step: number }
  | { kind: 'steps'; ts: string; steps: ThreadStep[] }
  | { kind: 'status'; ts: string; label: string; tone: Tone; detail?: string; chainId: string; outputs?: string[]; /** The line that opens a run (its task): the run's card says it, so it is not repeated inside the fold. */ start?: boolean }
  /** How a run ended, as one card: the key result. `detail` is the full finish summary. */
  | { kind: 'result'; ts: string; chainId: string; status: string; label: string; tone: Tone; /** How the run began (`schedule`, `user`, a mate's name...): its task is only worth showing when it adds something. */ from?: string; /** Why the run ended this way, for the label's hover text. */ why?: string; goal?: string; detail?: string; next?: string; handoff?: { to: string; task: string }; deliverables: { path: string; preview?: string }[]; supporting: string[]; /** One line per question or approval settled during the run: "You approved: Roll back payments-service". */ approvals?: string[];
      /** Everything the run did, folded behind the card: today's detailed view, one click away. */
      fold: ThreadEvent[]; stepCount: number; problems: { refused: number; error: number; failed: number } }
  /** A run that has started and not ended (working, or parked on a gate): one card, its steps folded, like a finished run. */
  | { kind: 'live'; ts: string; chainId: string; from?: string; goal?: string; fold: ThreadEvent[]; stepCount: number; last?: string; approvals?: string[] }
  | { kind: 'answer'; ts: string; title: string; text: string; tone: Tone; decision: 'answered' | 'executed' | 'failed' | 'rejected' };

/**
 * One vocabulary for how a run ended: Done, Nothing new, Blocked, Failed (error, step limit, stalled), Stopped (cancelled, interrupted).
 * `open` is not an ending: the task goes on later. The third item is the longer reason, shown as hover text.
 */
export const END_LABEL: Record<string, [string, Tone, string?]> = {
  done: ['Done', 'ok'], open: ['Continues later', 'info'], blocked: ['Blocked', 'warn', 'It could not go on without something from you.'], nothing_to_do: ['Nothing new', 'mute', 'Checked, nothing found.'],
  max_steps: ['Failed', 'warn', 'It reached its step limit.'], stalled: ['Failed', 'bad', 'It went in circles or ran out of time.'], cancelled: ['Stopped', 'mute'], interrupted: ['Stopped', 'mute', 'Stopped mid-run.'], error: ['Failed', 'bad']
};


const DOC_EXT = /\.(md|html|pdf|csv|xlsx|docx|txt)$/i;
/** The files meant for the human. The agent declares them in finish; for older runs, a document in the outbox is a deliverable and everything else supports. */
export function splitOutputs(declared: string[] | undefined, outputs: string[]): { deliverables: string[]; supporting: string[] } {
  const all = [...new Set([...(declared ?? []), ...outputs])];
  const isDoc = (f: string) => f.startsWith('.loop/outbox/') && DOC_EXT.test(f) && !f.slice('.loop/outbox/'.length).split('/').some(seg => seg.startsWith('.'));
  const deliverables = declared?.length ? declared : outputs.filter(isDoc);
  return { deliverables: [...new Set(deliverables)], supporting: all.filter(f => !deliverables.includes(f)) };
}

/** One line about a document: its first heading, or its first line. Only for text formats. */
function previewOf(root: string, rel: string): string | undefined {
  if (!/\.(md|txt)$/i.test(rel)) { return undefined; }
  try {
    const abs = path.resolve(root, rel);
    if (abs !== root && !abs.startsWith(root + path.sep)) { return undefined; }
    const fd = fs.openSync(abs, 'r'); const buf = Buffer.alloc(4096); const n = fs.readSync(fd, buf, 0, 4096, 0); fs.closeSync(fd);
    const lines = buf.slice(0, n).toString('utf8').split('\n').map(l => l.trim()).filter(Boolean);
    const line = lines.find(l => /^#+\s/.test(l)) ?? lines[0];
    return line ? clip(line.replace(/^#+\s*/, ''), 140) : undefined;
  } catch { return undefined; }
}

function readAudit(root: string, days: number): { chainId: string; events: any[] }[] {
  const base = path.join(root, '.loop', 'runs');
  if (!fs.existsSync(base)) { return []; }
  const out: { chainId: string; events: any[] }[] = [];
  for (const day of fs.readdirSync(base).filter(d => fs.statSync(path.join(base, d)).isDirectory()).sort().slice(-days)) {
    for (const name of fs.readdirSync(path.join(base, day)).filter(n => n.endsWith('.jsonl') && !n.startsWith('wake-')).sort()) {
      const events = fs.readFileSync(path.join(base, day, name), 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
      out.push({ chainId: name.slice(0, -6), events });
    }
  }
  return out;
}

function gateAnswer(root: string, e: any): Extract<ThreadEvent, { kind: 'answer' }> | undefined {
  const g = getGate(root, String(e.gateId));
  const title = g?.title ?? 'a request';
  const out = String(e.outcome ?? '');
  const feedback = /Feedback: ([^\n]+)/.exec(out)?.[1] ?? '';
  switch (e.status) {
    case 'answered': return { kind: 'answer', ts: e.ts, title, text: out.replace(/^The human answered:\s*/, ''), tone: 'info', decision: 'answered' };
    case 'executed': return { kind: 'answer', ts: e.ts, title, text: 'The command ran.', tone: 'ok', decision: 'executed' };
    case 'failed': return { kind: 'answer', ts: e.ts, title, text: 'The command failed.', tone: 'bad', decision: 'failed' };
    case 'rejected': return { kind: 'answer', ts: e.ts, title, text: feedback, tone: 'warn', decision: 'rejected' };
    default: return undefined;
  }
}

/** The one-line record of a settled question or approval, for the run's card. */
function decisionLine(a: Extract<ThreadEvent, { kind: 'answer' }>): string {
  const t = clip(a.title, 100);
  switch (a.decision) {
    case 'answered': return `You answered: ${t}${a.text ? ` — ${clip(firstLine(a.text), 80)}` : ''}`;
    case 'executed': return `You approved: ${t}`;
    case 'failed': return `You approved: ${t} (the command failed)`;
    default: return `You rejected: ${t}${a.text ? ` — ${clip(firstLine(a.text), 80)}` : ''}`;
  }
}

/** The conversation with one agent, oldest first: your messages, what it said and did, runs starting and ending, and your answers to its gates. */
export function buildThread(root: string, agent: string, opts: { limit?: number; days?: number } = {}): { events: ThreadEvent[]; hidden: number } {
  const limit = opts.limit ?? 120;
  const chains = readAudit(root, opts.days ?? 3);
  const gateOwner = new Map<string, string>();
  for (const c of chains) { for (const e of c.events) { if (e.type === 'tool' && e.gateId && e.agent) { gateOwner.set(String(e.gateId), String(e.agent)); } } }
  const events: ThreadEvent[] = [];
  for (const c of chains) {
    let block: Extract<ThreadEvent, { kind: 'steps' }> | undefined;
    const flush = () => { if (block) { events.push(block); runBlocks.push(block); block = undefined; } };
    // What the card for this run's end needs, gathered between its start and its end.
    let runBlocks: Extract<ThreadEvent, { kind: 'steps' }>[] = [];
    let from = '', goal: string | undefined, next: string | undefined, handoff: { to: string; task: string } | undefined, wrote: string[] = [];
    let approvals: string[] = [];
    let errEv: { ev: ThreadEvent; message: string } | undefined;
    let runStart = 0, open = false;
    const resetRun = () => { runBlocks = []; goal = next = handoff = errEv = undefined; wrote = []; approvals = []; };
    for (const e of c.events) {
      const mine = e.agent === agent || (e.type === 'gate' && gateOwner.get(String(e.gateId)) === agent);
      if (!mine) { continue; }
      if (e.type === 'tool') {
        if (e.name === 'finish') { const n = e.input?.next; next = typeof n === 'string' && n.trim() ? n.trim() : next; continue; }
        const result = String(e.result ?? '');
        if (Array.isArray(e.wrote)) { wrote.push(...e.wrote.map(String)); }
        const h = humanize(String(e.name), e.input);
        const gate = !!e.gateId;
        const step: ThreadStep = { step: Number(e.step) || 0, kind: gate ? 'gate' : 'tool', phrase: gate ? `Asked you${e.name === 'ask_human' ? '' : ' to approve'}: ${clip(brief(e.input), 80)}` : h.phrase, routine: !gate && h.routine, fam: h.fam, famKind: h.famKind, ts: e.ts, title: `${e.name}${brief(e.input) ? ` · ${brief(e.input)}` : ''}`,
          detail: clip(firstLine(result), 160) || undefined, ok: !/^(REFUSED|ERROR|Not sent)/.test(result) };
        const refusal = refusalOf(e.name, e.input, result);
        if (refusal) { step.refused = refusal; }
        if (step.ok && e.name === 'handoff' && typeof e.input?.to === 'string') { handoff = { to: e.input.to, task: String(e.input.task ?? '') }; }
        if (e.name === 'write_file' || e.name === 'edit_file') { step.path = String(e.input?.path ?? ''); }
        if (!block) { block = { kind: 'steps', ts: e.ts, steps: [] }; }
        block.steps.push(step);
        continue;
      }
      flush();
      if (e.type === 'start') {
        resetRun();
        open = true;
        runStart = events.length;
        from = String(e.from ?? '');
        goal = from === 'chat' ? undefined : clip(firstLine(String(e.task ?? '')), 140) || undefined;
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'info',
          label: from === 'schedule' ? 'Scheduled run started' : from === 'chat' ? 'Started from your message' : from === 'task' ? 'Woken: a task it holds progressed' : from === 'user' ? 'Task from you' : `Handed over by ${from}`,
          detail: from === 'chat' ? undefined : clip(String(e.task ?? ''), 240), start: true });
      } else if (e.type === 'resume') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'info', label: e.from === 'checkpoint' ? 'Continued after an interruption' : 'Continued after your answer' });
      } else if (e.type === 'model') {
        if (typeof e.text === 'string' && e.text.trim()) { events.push({ kind: 'agent', ts: e.ts, text: clip(e.text.trim(), 1500), step: Number(e.step) || 0 }); }
      } else if (e.type === 'park') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'warn', label: 'Needs you' });
      } else if (e.type === 'end') {
        const st = String(e.status);
        open = false;
        const [label, tone, why] = END_LABEL[st] ?? [st, 'mute' as Tone];
        const outputs = Array.isArray(e.outputs) && e.outputs.length ? e.outputs.map(String) : [...new Set(wrote)];
        const split = splitOutputs(Array.isArray(e.deliverables) ? e.deliverables.map(String) : undefined, outputs);
        const summary = e.summary ? clip(String(e.summary), 1200) : undefined;
        const msg = errEv && !(summary ?? '').includes(errEv.message) ? errEv.message : undefined;
        // The whole run folds behind its card; the human's own messages are not part of the audit and stay outside, in order.
        const fold = events.splice(runStart);
        const bad = fold.flatMap(f => (f.kind === 'steps' ? f.steps.filter(x => !x.ok) : []));
        const count = (re: RegExp) => bad.filter(x => re.test(x.detail ?? '')).length;
        const problems = { refused: count(/^REFUSED/), error: count(/^ERROR/), failed: 0 };
        problems.failed = bad.length - problems.refused - problems.error;
        events.push({ kind: 'result', ts: e.ts, chainId: c.chainId, status: st, label, tone, why, from, goal,
          detail: [summary, msg].filter(Boolean).join('\n') || undefined, next: st === 'open' ? next : undefined, handoff, deliverables: split.deliverables.map(d => ({ path: d, preview: previewOf(root, d) })), supporting: split.supporting, approvals: approvals.length ? approvals : undefined,
          fold, stepCount: fold.reduce((n2, f) => n2 + (f.kind === 'steps' ? f.steps.length : 0), 0), problems });
        resetRun();
      } else if (e.type === 'error') {
        const ev: ThreadEvent = { kind: 'status', ts: e.ts, chainId: c.chainId, tone: e.cancelled ? 'mute' : 'bad', label: e.cancelled ? 'Stopped' : 'Failed', detail: clip(String(e.message ?? ''), 300) };
        events.push(ev);
        errEv = { ev, message: clip(String(e.message ?? ''), 300) };
      } else if (e.type === 'retry') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'warn', label: `Will be retried (${e.reason})` });
      } else if (e.type === 'gate') {
        const a = gateAnswer(root, e);
        if (a) { events.push(a); approvals.push(decisionLine(a)); }
      }
    }
    flush();
    if (open) {
      const fold = events.splice(runStart);
      const first = fold[0];
      const all = fold.flatMap(f => (f.kind === 'steps' ? f.steps : []));
      events.push({ kind: 'live', ts: first?.ts ?? '', chainId: c.chainId, from, goal, fold, stepCount: all.length, last: all[all.length - 1]?.phrase, approvals: approvals.length ? approvals : undefined });
    }
  }
  for (const m of listMessages(root, agent)) {
    events.push({ kind: 'human', ts: m.ts, id: m.id, text: m.text, status: m.status, deliveredAt: m.deliveredAt, via: m.via });
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { events: events.slice(-limit), hidden: Math.max(0, events.length - limit) };
}

// ---- where a message goes ----

export type ChatState = 'running' | 'waiting' | 'queued' | 'idle';

export function chatState(root: string, agent: string, active?: Active): { state: ChatState; pendingMessages: number; needsYou: number } {
  const needsYou = listGates(root).filter(g => g.agent === agent && g.status === 'pending').length;
  const state: ChatState = isActive(active, agent) ? 'running'
    : needsYou > 0 || waiting(root).some(i => i.agent === agent) ? 'waiting'
      : queuedItems(root, agent).length > 0 ? 'queued' : 'idle';
  return { state, pendingMessages: pendingMessages(root, agent).length, needsYou };
}

export type Route = 'in-run' | 'on-resume' | 'at-start' | 'new-task';

/** Running: seen at its next step. Waiting for you: seen when it resumes. Queued: seen when it starts. Idle: starts a new run. */
export const routeFor = (state: ChatState): Route => (state === 'running' ? 'in-run' : state === 'waiting' ? 'on-resume' : state === 'queued' ? 'at-start' : 'new-task');

/** A few lines of the conversation so far, for a run that starts from a message. */
export function conversationContext(root: string, agent: string, max = 6): string {
  const { events } = buildThread(root, agent, { limit: 60 });
  const lines = events.flatMap(e => e.kind === 'human' ? [`You: ${clip(e.text, 300)}`]
    : (e.kind === 'status' || e.kind === 'result') && e.detail && e.label !== 'Scheduled run started' && !e.label.startsWith('Task') && !e.label.startsWith('Handed') ? [`${agent}: ${e.label}. ${clip(e.detail, 300)}`]
      : e.kind === 'answer' ? [`You, on "${clip(e.title, 60)}": ${clip(e.text, 200)}`] : []);
  return lines.length ? `Conversation so far (oldest first):\n${lines.slice(-max).join('\n')}` : '';
}

// ---- the roster: one glance at each agent ----

/** How an agent looks in the roster. Motion carries it: idle is still, working turns, waiting pulses, blocked is red, done is a check. */
export type AvatarState = 'idle' | 'working' | 'waiting' | 'blocked' | 'done';

export interface Glance {
  state: ChatState;
  avatar: AvatarState;
  /** One line about what it is doing or did last: the roster's progress line, and the tooltip. */
  line: string;
  /** When that line happened. */
  at?: string;
  needsYou: number;
  pendingMessages: number;
}

/** Only a failure turns the face red; a blocked run is waiting on something, which its card and amber rule already say. */
const BAD_END = new Set(['error', 'stalled', 'max_steps']);
const HOUR = 3600_000;

export function glance(root: string, agent: string, description: string, active?: Active, now = new Date()): Glance {
  const cs = chatState(root, agent, active);
  // The newest few audit files are enough to know what it is doing or did last.
  const mine = readAudit(root, 2).slice(-8).flatMap(c => c.events.filter(e => e.agent === agent));
  const lastStart = mine.map(e => e.type).lastIndexOf('start');
  const sinceStart = lastStart >= 0 ? mine.slice(lastStart) : [];
  const lastTool = [...sinceStart].reverse().find(e => e.type === 'tool' && e.name !== 'finish');
  const lastEnd = [...mine].reverse().find(e => e.type === 'end');
  let line = clip(description, 90) || 'No activity yet';
  let at: string | undefined;
  let avatar: AvatarState = 'idle';
  if (cs.state === 'running') {
    avatar = 'working';
    line = lastTool ? humanize(String(lastTool.name), lastTool.input).phrase : 'Starting…';
    at = lastTool?.ts ?? sinceStart[0]?.ts;
  } else if (cs.state === 'waiting') {
    avatar = 'waiting';
    const g = listGates(root).find(x => x.agent === agent && x.status === 'pending');
    line = g ? `Needs you: ${clip(g.title, 70)}` : 'Needs you';
    at = g?.createdAt;
  } else if (cs.state === 'queued') {
    const q = queuedItems(root, agent)[0];
    line = `Queued: ${clip(firstLine(q?.task ?? ''), 70)}`;
    at = q?.createdAt;
  } else {
    // How the last run ended decides the face, whatever the line says.
    if (lastEnd) {
      const age = now.getTime() - Date.parse(lastEnd.ts);
      if (lastEnd.status === 'done' && age < HOUR) { avatar = 'done'; }
      else if (BAD_END.has(String(lastEnd.status)) && age < 24 * HOUR) { avatar = 'blocked'; }
    }
    if (cs.pendingMessages > 0) {
      line = 'Your message is waiting to be read';
    } else if (lastEnd) {
      const [label] = END_LABEL[String(lastEnd.status)] ?? [String(lastEnd.status)];
      line = `${label}${lastEnd.summary ? `: ${clip(firstLine(String(lastEnd.summary)), 70)}` : ''}`;
      at = lastEnd.ts;
    }
  }
  return { state: cs.state, avatar, line, at, needsYou: cs.needsYou, pendingMessages: cs.pendingMessages };
}
