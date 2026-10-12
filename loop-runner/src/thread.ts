import * as fs from 'fs';
import * as path from 'path';
import { getGate, listGates, newId, pending as queuedItems, waiting } from './queue';
import { brief, clip, firstLine } from './textutil';

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

export interface ThreadStep { step: number; kind: 'tool' | 'gate'; title: string; detail?: string; ok: boolean }
export type Tone = 'info' | 'ok' | 'bad' | 'warn' | 'mute';
export type ThreadEvent =
  | { kind: 'human'; ts: string; id: string; text: string; status: 'pending' | 'delivered'; deliveredAt?: string; via?: HumanMessage['via'] }
  | { kind: 'agent'; ts: string; text: string; step: number }
  | { kind: 'steps'; ts: string; steps: ThreadStep[] }
  | { kind: 'status'; ts: string; label: string; tone: Tone; detail?: string; chainId: string; outputs?: string[] }
  | { kind: 'answer'; ts: string; title: string; text: string; tone: Tone };

const END_LABEL: Record<string, [string, Tone]> = {
  done: ['Finished', 'ok'], blocked: ['Blocked', 'warn'], nothing_to_do: ['Nothing to do', 'mute'], max_steps: ['Reached its step limit', 'warn'],
  stalled: ['Stopped: going in circles or out of time', 'bad'], cancelled: ['Cancelled', 'mute'], error: ['Failed', 'bad']
};

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
  switch (e.status) {
    case 'answered': return { kind: 'answer', ts: e.ts, title, text: out.replace(/^The human answered:\s*/, ''), tone: 'info' };
    case 'executed': return { kind: 'answer', ts: e.ts, title, text: 'Approved, and the command ran.', tone: 'ok' };
    case 'failed': return { kind: 'answer', ts: e.ts, title, text: 'Approved, but the command failed.', tone: 'bad' };
    case 'rejected': return { kind: 'answer', ts: e.ts, title, text: 'Rejected.' + (/Feedback: ([^\n]+)/.exec(out) ? ` ${/Feedback: ([^\n]+)/.exec(out)![1]}` : ''), tone: 'warn' };
    default: return undefined;
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
    const flush = () => { if (block) { events.push(block); block = undefined; } };
    for (const e of c.events) {
      const mine = e.agent === agent || (e.type === 'gate' && gateOwner.get(String(e.gateId)) === agent);
      if (!mine) { continue; }
      if (e.type === 'tool') {
        if (e.name === 'finish') { continue; }
        const result = String(e.result ?? '');
        const step: ThreadStep = { step: Number(e.step) || 0, kind: e.gateId ? 'gate' : 'tool', title: `${e.name}${brief(e.input) ? ` · ${brief(e.input)}` : ''}`,
          detail: clip(firstLine(result), 160) || undefined, ok: !/^(REFUSED|ERROR|Not sent)/.test(result) };
        if (!block) { block = { kind: 'steps', ts: e.ts, steps: [] }; }
        block.steps.push(step);
        continue;
      }
      flush();
      if (e.type === 'start') {
        const from = String(e.from ?? '');
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'info',
          label: from === 'schedule' ? 'Scheduled run started' : from === 'chat' ? 'Started from your message' : from === 'user' ? 'Task from you' : `Handed over by ${from}`,
          detail: from === 'chat' ? undefined : clip(String(e.task ?? ''), 240) });
      } else if (e.type === 'resume') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'info', label: e.from === 'checkpoint' ? 'Continued after an interruption' : 'Continued after your answer' });
      } else if (e.type === 'model') {
        if (typeof e.text === 'string' && e.text.trim()) { events.push({ kind: 'agent', ts: e.ts, text: clip(e.text.trim(), 1500), step: Number(e.step) || 0 }); }
      } else if (e.type === 'park') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'warn', label: 'Waiting for you' });
      } else if (e.type === 'end') {
        const [label, tone] = END_LABEL[String(e.status)] ?? [String(e.status), 'mute' as Tone];
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone, label, detail: e.summary ? clip(String(e.summary), 400) : undefined, outputs: Array.isArray(e.outputs) && e.outputs.length ? e.outputs.map(String) : undefined });
      } else if (e.type === 'error') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: e.cancelled ? 'mute' : 'bad', label: e.cancelled ? 'Cancelled' : 'Error', detail: clip(String(e.message ?? ''), 300) });
      } else if (e.type === 'retry') {
        events.push({ kind: 'status', ts: e.ts, chainId: c.chainId, tone: 'warn', label: `Will be retried (${e.reason})` });
      } else if (e.type === 'gate') {
        const a = gateAnswer(root, e);
        if (a) { events.push(a); }
      }
    }
    flush();
  }
  for (const m of listMessages(root, agent)) {
    events.push({ kind: 'human', ts: m.ts, id: m.id, text: m.text, status: m.status, deliveredAt: m.deliveredAt, via: m.via });
  }
  events.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  return { events: events.slice(-limit), hidden: Math.max(0, events.length - limit) };
}

// ---- where a message goes ----

export type ChatState = 'running' | 'waiting' | 'queued' | 'idle';

export function chatState(root: string, agent: string, active?: string): { state: ChatState; pendingMessages: number; needsYou: number } {
  const needsYou = listGates(root).filter(g => g.agent === agent && g.status === 'pending').length;
  const state: ChatState = active === agent ? 'running'
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
    : e.kind === 'status' && e.detail && e.label !== 'Scheduled run started' && !e.label.startsWith('Task') && !e.label.startsWith('Handed') ? [`${agent}: ${e.label}. ${clip(e.detail, 300)}`]
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

const BAD_END = new Set(['blocked', 'error', 'stalled', 'max_steps']);
const HOUR = 3600_000;

export function glance(root: string, agent: string, description: string, active?: string, now = new Date()): Glance {
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
    line = lastTool ? `${lastTool.name} · ${brief(lastTool.input) || '…'}` : 'Starting…';
    at = lastTool?.ts ?? sinceStart[0]?.ts;
  } else if (cs.state === 'waiting') {
    avatar = 'waiting';
    const g = listGates(root).find(x => x.agent === agent && x.status === 'pending');
    line = g ? `Needs you: ${clip(g.title, 70)}` : 'Waiting for you';
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
