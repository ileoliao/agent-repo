import * as fs from 'fs';
import { Gate, listGates } from './queue';
import { sha256Of } from './gates';
import * as path from 'path';
import { RunSummary, recentRuns } from './runs';
import { AgentRow, agentRows, nextWake } from './status';
import { brief, clip, firstLine } from './textutil';
import { AvatarState, ChatState, ThreadEvent, Tone, buildThread, glance } from './thread';

/** One line of a run's story: what the agent did at a step. */
export interface Step {
  step: number;
  kind: 'say' | 'tool' | 'gate' | 'end' | 'error';
  title: string;
  detail?: string;
  /** false for REFUSED / ERROR results. */
  ok: boolean;
}

export interface ConsoleRun extends RunSummary { steps: Step[] }

/** A pending gate plus what the reviewer sees of each draft file, with the hash the approval is bound to. */
export interface GateView extends Gate { previews: { path: string; text: string; sha256: string; truncated: boolean }[] }

const PREVIEW_CHARS = 6000;
function previewsOf(root: string, g: Gate): GateView['previews'] {
  return g.files.map(f => {
    // One read: the text shown and the hash the approval is bound to come from the same bytes.
    try {
      const buf = fs.readFileSync(path.join(root, f));
      const text = buf.toString('utf8');
      return { path: f, text: text.slice(0, PREVIEW_CHARS), sha256: sha256Of(buf), truncated: text.length > PREVIEW_CHARS };
    } catch { return { path: f, text: '(file is missing)', sha256: 'missing', truncated: false }; }
  });
}

export interface ChatModel {
  agents: { name: string; description: string; state: ChatState; avatar: AvatarState; line: string; at?: string; pendingMessages: number; needsYou: number }[];
  selected?: string;
  events: ThreadEvent[];
  /** Earlier events that are not shown. */
  hidden: number;
  /** The selected agent's open questions and approvals, shown at the end of the conversation. */
  gates: GateView[];
}

export interface ConsoleModel {
  running: boolean;
  active?: string;
  next?: { agent: string; at: string };
  pending: GateView[];
  agents: AgentRow[];
  runs: ConsoleRun[];
  /** Which page is showing. Chat is the default. */
  tab: 'chat' | 'overview';
  /** The conversation with one agent; only built while the chat tab is showing. */
  chat?: ChatModel;
  /** ISO time this view was built. */
  updatedAt: string;
  /** Page-level message: no workspace, or the data could not be read. */
  note?: { tone: 'bad' | 'info'; text: string };
}

// clip, firstLine and brief live in textutil.ts so the chat thread can use them too.

/** A run's audit file as a short list of steps. Read-only; torn lines are skipped. */
export function stepsOf(file: string): Step[] {
  const out: Step[] = [];
  let events: any[];
  try {
    events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
  } catch { return out; }
  for (const e of events) {
    const step = Number(e.step) || 0;
    if (e.type === 'model' && typeof e.text === 'string' && e.text.trim()) {
      out.push({ step, kind: 'say', title: clip(firstLine(e.text), 140), detail: e.text.length > 140 ? clip(e.text, 800) : undefined, ok: true });
    } else if (e.type === 'tool') {
      const result = String(e.result ?? '');
      const ok = !/^(REFUSED|ERROR|Not sent)/.test(result);
      out.push({ step, kind: e.gateId ? 'gate' : 'tool', title: `${e.name}${brief(e.input) ? ` · ${brief(e.input)}` : ''}`, detail: clip(firstLine(result), 160) || undefined, ok });
    } else if (e.type === 'end') {
      out.push({ step, kind: 'end', title: `${e.status ?? 'done'}${e.summary ? ` · ${clip(String(e.summary), 140)}` : ''}`, ok: e.status === 'done' || e.status === undefined });
    } else if (e.type === 'error') {
      out.push({ step, kind: 'error', title: clip(String(e.message ?? 'error'), 160), ok: false });
    }
  }
  return out;
}

/** Everything the console shows, as plain data. Pure and read-only: the same files the sidebar reads. */
export function consoleModel(root: string, state: { running: boolean; active?: string; tab?: 'chat' | 'overview'; agent?: string }, now = new Date(), runLimit = 10): ConsoleModel {
  const agents = agentRows(root, state.active, now);
  const nw = nextWake(agents);
  const tab = state.tab ?? 'chat';
  const pending = listGates(root).filter(g => g.status === 'pending').map(g => ({ ...g, previews: previewsOf(root, g) }));
  let chat: ChatModel | undefined;
  if (tab === 'chat') {
    const rows = agents.map(a => ({ name: a.name, description: a.description, ...glance(root, a.name, a.description, state.active, now) }));
    const selected = rows.find(r => r.name === state.agent)?.name ?? rows.find(r => r.needsYou)?.name ?? rows.find(r => r.state === 'running')?.name ?? rows[0]?.name;
    const th = selected ? buildThread(root, selected) : { events: [], hidden: 0 };
    chat = { agents: rows, selected, events: th.events, hidden: th.hidden, gates: pending.filter(g => g.agent === selected) };
  }
  return {
    tab,
    chat,
    running: state.running,
    active: state.active,
    next: nw ? { agent: nw.agent, at: nw.at.toISOString() } : undefined,
    pending,
    agents,
    // A run whose last event says "running" but that no live worker owns (team stopped, or another agent is active)
    // was cut off, for example when VS Code closed. Say so instead of showing it as running forever.
    runs: recentRuns(root, runLimit).map(r => ({
      ...r,
      status: r.status === 'running' && !(state.running && state.active === r.agent) ? 'interrupted' : r.status,
      steps: stepsOf(r.file)
    })),
    updatedAt: now.toISOString()
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
/** hh:mm today; with the weekday and date otherwise (a wake tomorrow must not look like one today). */
const when = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) { return ''; }
  return d.toDateString() === new Date().toDateString() ? time(iso) : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })} ${time(iso)}`;
};
/** hh:mm today; month/day and hh:mm on another day. Short enough for a chat. */
const whenShort = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) { return ''; }
  return d.toDateString() === new Date().toDateString() ? time(iso) : `${d.toLocaleDateString([], { month: 'numeric', day: 'numeric' })} ${time(iso)}`;
};
/** A time with its exact value on hover. */
const stamp = (iso: string, text: string) => `<time datetime="${esc(iso)}" title="${esc(new Date(iso).toLocaleString())}">${esc(text)}</time>`;
const span = (a: string, b: string) => {
  const ms = Date.parse(b) - Date.parse(a);
  if (!(ms >= 0)) { return ''; }
  const sec = Math.round(ms / 1000);
  return sec < 60 ? `${sec}s` : sec < 3600 ? `${Math.floor(sec / 60)}m ${sec % 60}s` : `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
};
const ago = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return isNaN(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
};

/** Small stroke icons (16px, currentColor) so the page needs no font or external file. */
const ICONS: Record<string, string> = {
  check: 'M3 8.5l3 3 7-7',
  x: 'M4 4l8 8M12 4l-8 8',
  alert: 'M8 2.5l6 10.5H2L8 2.5zM8 7v3M8 11.5v.5',
  bell: 'M4 11V7a4 4 0 018 0v4l1 1.5H3L4 11zM6.5 14a1.5 1.5 0 003 0',
  help: 'M6 6a2 2 0 114 0c0 1.5-2 1.5-2 3M8 12v.5',
  play: 'M5 3.5v9l7-4.5-7-4.5z',
  stop: 'M4.5 4.5h7v7h-7z',
  spin: 'M8 2.5a5.5 5.5 0 105.5 5.5',
  clock: 'M8 2.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM8 5v3.2l2 1.3',
  file: 'M4 2.5h5l3 3v8H4v-11zM9 2.5v3h3',
  bot: 'M4 6h8v6H4V6zM8 6V3.5M6.2 8.8v.4M9.8 8.8v.4',
  chevron: 'M6 4l4 4-4 4',
  send: 'M2.5 8l11-5-4 10-2.5-4L2.5 8z',
  up: 'M8 13V3M4 7l4-4 4 4',
  copy: 'M5.5 5.5h7v8h-7v-8zM3.5 10.5v-8h7',
  dot: 'M8 6a2 2 0 100 4 2 2 0 000-4z'
};
const icon = (name: string, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ICONS.dot}"/></svg>`;

const STATUS: Record<string, { label: string; tone: string; ic: string }> = {
  done: { label: 'Done', tone: 'ok', ic: 'check' }, running: { label: 'Running', tone: 'info', ic: 'spin' },
  waiting: { label: 'Waiting for you', tone: 'warn', ic: 'bell' }, error: { label: 'Error', tone: 'bad', ic: 'x' },
  retry: { label: 'Will retry', tone: 'warn', ic: 'clock' }, blocked: { label: 'Blocked', tone: 'warn', ic: 'alert' },
  max_steps: { label: 'Step limit', tone: 'warn', ic: 'alert' }, stalled: { label: 'Stalled', tone: 'bad', ic: 'alert' },
  interrupted: { label: 'Interrupted', tone: 'warn', ic: 'alert' },
  nothing_to_do: { label: 'Nothing to do', tone: 'mute', ic: 'check' }, cancelled: { label: 'Cancelled', tone: 'mute', ic: 'stop' }
};
/** Statuses the "Problems" filter shows. */
const PROBLEMS = new Set(['error', 'stalled', 'blocked', 'max_steps', 'interrupted', 'retry']);
const chip = (status: string) => { const s = STATUS[status] ?? { label: status, tone: 'mute', ic: 'dot' }; return `<span class="chip ${s.tone}">${icon(s.ic)}<span>${esc(s.label)}</span></span>`; };
const btn = (label: string, attrs: string, kind = '', ic = '') => `<button class="btn ${kind}" ${attrs}>${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;
const copy = (text: string, label: string) => `<button class="btn ghost" data-copy="${esc(text)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">${icon('copy')}</button>`;

function gateCard(g: GateView): string {
  const isQ = g.kind === 'question';
  const head = `<div class="card-head">${icon(isQ ? 'help' : 'bell', 'lead warn')}<div class="grow"><div class="card-title">${esc(g.title)}</div>
    <div class="meta"><span class="tag">${esc(g.agent)}</span><span>${esc(isQ ? 'Question' : 'Approval needed')}</span><span>${stamp(g.createdAt, ago(g.createdAt))}</span></div></div></div>`;
  const body = g.body ? `<p class="body">${esc(g.body)}</p>` : '';
  const previews = g.previews ?? [];
  const missing = previews.filter(p => p.sha256 === 'missing').map(p => p.path);
  const files = previews.map(p => `<details class="file" open data-k="f-${esc(g.id)}-${esc(p.path)}"><summary>${icon('chevron', 'chev')}${icon('file')}<span class="mono grow">${esc(p.path)}</span>${p.truncated ? '<span class="muted">first part shown</span>' : ''}</summary>
    <pre class="code" tabindex="0" data-hash-for="${esc(p.path)}" data-hash="${esc(p.sha256)}">${esc(p.text)}</pre>
    <div class="row wrap"><a class="filechip" href="#" data-open="${esc(p.path)}">${icon('file')}${p.truncated ? 'Open full file' : 'Open to edit'}</a></div></details>`).join('')
    + (g.files.length && !previews.length ? g.files.map(f => `<a class="filechip" href="#" data-open="${esc(f)}">${icon('file')}${esc(f)}</a>`).join('') : '');
  if (isQ) {
    const opts = (g.options ?? []).map(o => btn(o, `data-pick="${esc(g.id)}" data-text="${esc(o)}"`, 'secondary')).join('');
    return `<section class="card attention" data-gate="${esc(g.id)}" aria-label="Question from ${esc(g.agent)}">${head}${body}${files}
      ${opts ? `<div class="label">Suggested answers (pick one, then send)</div><div class="row wrap">${opts}</div>` : ''}
      <div class="row"><textarea rows="2" placeholder="Type an answer…" aria-label="Your answer" data-input="${esc(g.id)}"></textarea>${btn('Send answer', `data-send="${esc(g.id)}"`, 'primary', 'send')}</div></section>`;
  }
  const truncated = previews.some(p => p.truncated);
  const notes = [
    missing.length ? `<div class="alert bad">${icon('alert')}<span>${esc(missing.join(', '))} ${missing.length === 1 ? 'is' : 'are'} missing, so this cannot be approved. Reject it, or ask the agent to write the draft again.</span></div>` : '',
    previews.length && !missing.length ? `<div class="note">Your approval covers ${truncated ? 'the whole of each file (only the first part of a long one is shown above; open it to read the rest)' : 'the file contents shown above'}. If a file changes before it runs, nothing runs and you review again.</div>` : '',
    '<div class="note">Runs in the workspace folder, not in a sandbox.</div>'
  ].join('');
  return `<section class="card attention" data-gate="${esc(g.id)}" aria-label="Approval requested by ${esc(g.agent)}">${head}${body}
    <div class="label">This exact command runs when you approve</div><div class="cmdrow"><pre class="code cmd" tabindex="0">${esc(g.command ?? '')}</pre>${copy(g.command ?? '', 'command')}</div>${files}${notes}
    <div class="row"><textarea rows="1" placeholder="Reason, if you reject (optional)" aria-label="Feedback for the agent" data-input="${esc(g.id)}"></textarea>
    ${btn('Reject', `data-reject="${esc(g.id)}"`, 'secondary', 'x')}${btn('Approve and run', `data-approve="${esc(g.id)}"${missing.length ? ' disabled' : ''}`, 'primary', 'check')}</div></section>`;
}

function runCard(r: ConsoleRun): string {
  const shown = r.steps.map(s => {
    const quiet = s.ok && (s.kind === 'tool' || s.kind === 'gate') && /^(\[exit 0\]|ok)$/.test(s.detail ?? '');
    return `<li class="step ${s.ok ? '' : 'bad'}"><span class="node">${icon(s.kind === 'end' ? 'check' : s.ok ? 'dot' : 'x')}</span>
    <div class="grow"><div class="step-title"><span class="kind">${esc(s.kind)}</span>${s.step ? `<span class="muted">#${s.step}</span>` : ''}<span class="${s.kind === 'tool' || s.kind === 'gate' ? 'mono' : ''}">${esc(s.title)}</span></div>${s.detail && !quiet ? `<div class="${s.ok ? 'muted' : 'result-bad'} wrap-text">${esc(s.detail)}</div>` : ''}</div></li>`;
  }).join('');
  const outs = r.outputs.map(o => `<a class="filechip" href="#" data-open="${esc(o)}">${icon('file')}${esc(o)}</a>`).join('');
  const dur = r.status === 'running' ? span(r.started, new Date().toISOString()) : span(r.started, r.updated);
  const live = r.status === 'running';
  return `<details class="run" ${live ? 'open' : ''} data-k="r-${esc(r.chainId)}" data-status="${esc(r.status)}"><summary>${icon('chevron', 'chev')}${chip(r.status)}<span class="run-agent">${esc(r.agent)}</span>
    <span class="grow run-sum" title="${esc(r.summary)}">${esc(clip(r.summary, 110))}</span><span class="muted nowrap">${r.step} step${r.step === 1 ? '' : 's'}${dur ? ` · ${esc(dur)}` : ''} · ${stamp(r.started, ago(r.started))}</span></summary>
    <div class="run-body">${r.summary ? `<p class="body">${esc(r.summary)}</p>` : ''}${outs ? `<div class="label">Files written</div><div class="row wrap">${outs}</div>` : ''}
    <div class="label">What happened</div><ol class="timeline">${shown || '<li class="muted">No steps recorded.</li>'}</ol>
    <div class="row wrap"><a class="link muted" href="#" data-open-abs="${esc(r.file)}">Open raw log</a><span class="muted">·</span><span class="muted mono">${esc(r.chainId)}</span>${copy(r.chainId, 'run id')}</div></div></details>`;
}

function agentRow(a: AgentRow): string {
  const label = a.state === 'running' ? 'Running' : a.state === 'waiting' ? 'Waiting on you' : 'Idle';
  const tone = a.state === 'running' ? 'info' : a.state === 'waiting' ? 'warn' : 'mute';
  const lw = a.lastWake;
  const last = !lw ? '<span class="muted">none yet</span>'
    : lw.capped !== undefined ? `daily cap reached (${lw.capped}) <span class="muted">${stamp(lw.at, ago(lw.at))}</span>`
    : `${lw.wake ? 'found work' : 'nothing to do'} <span class="muted">${stamp(lw.at, ago(lw.at))}</span>`;
  return `<div class="agent"><div class="agent-top">${icon('bot', 'lead')}<a class="agent-name" href="#" data-open="${esc(a.file)}">${esc(a.name)}</a>
    <span class="chip ${tone}">${icon(a.state === 'running' ? 'spin' : a.state === 'waiting' ? 'bell' : 'dot')}<span>${label}</span></span></div>
    <dl class="kv"><dt>Model</dt><dd class="mono">${esc(a.model ?? 'default')}</dd>
    <dt>Next wake</dt><dd>${a.next ? stamp(a.next.toISOString(), when(a.next.toISOString())) : '<span class="muted">manual only</span>'}</dd>
    <dt>Last check</dt><dd>${last}</dd></dl></div>`;
}

/** `hint` is trusted markup: callers pass only fixed strings. */
const empty = (ic: string, title: string, hint: string) => `<div class="empty">${icon(ic, 'big')}<div class="empty-title">${esc(title)}</div><div class="muted">${hint}</div></div>`;


const DELIVERY: Record<string, string> = { start: 'read when the run started', turn: 'read at its next step', resume: 'read when it resumed', task: 'started a run' };
const toneOf = (t: Tone) => (t === 'mute' ? 'mute' : t);

function threadEvent(e: ThreadEvent, agent: string): string {
  if (e.kind === 'human') {
    const seen = e.status === 'pending' ? `waiting for ${esc(agent)} to read it` : esc(DELIVERY[e.via ?? ''] ?? 'read');
    return `<div class="msg human"><div class="bubble"><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))} · ${seen}</div></div></div>`;
  }
  if (e.kind === 'answer') {
    return `<div class="msg human"><div class="bubble answer ${e.tone}"><div class="mkind">You answered “${esc(clip(e.title, 80))}”</div><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))}</div></div></div>`;
  }
  if (e.kind === 'agent') {
    return `<div class="msg agent">${avatar(agent, 'idle', 28)}<div class="bubble"><div class="mname">${esc(agent)}</div><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))}${e.step ? ` · step ${e.step}` : ''}</div></div></div>`;
  }
  if (e.kind === 'steps') {
    const failed = e.steps.filter(s => !s.ok).length;
    const li = e.steps.map(s => `<li class="step ${s.ok ? '' : 'bad'}"><span class="node">${icon(s.ok ? 'dot' : 'x')}</span><div class="grow"><div class="step-title"><span class="kind">${esc(s.kind)}</span>${s.step ? `<span class="muted">#${s.step}</span>` : ''}<span class="mono">${esc(s.title)}</span></div>${s.detail && !/^(\[exit 0\]|ok)$/.test(s.detail) ? `<div class="${s.ok ? 'muted' : 'result-bad'} wrap-text">${esc(s.detail)}</div>` : ''}</div></li>`).join('');
    return `<details class="msg steps" data-k="st-${esc(e.ts)}"><summary>${icon('chevron', 'chev')}<span class="muted mono grow steps-sum">${esc(clip(e.steps[0].title, 70))}${e.steps.length > 1 ? ` +${e.steps.length - 1} more` : ''}${failed ? ` · ${failed} failed` : ''}</span><span class="muted nowrap">${stamp(e.ts, whenShort(e.ts))}</span></summary><ol class="timeline">${li}</ol></details>`;
  }
  const outs = (e.outputs ?? []).map(o => `<a class="filechip" href="#" data-open="${esc(o)}">${icon('file')}${esc(o)}</a>`).join('');
  return `<div class="sline"><span class="chip ${toneOf(e.tone)}">${esc(e.label)}</span>${e.detail ? `<span class="wrap-text">${esc(e.detail)}</span>` : ''}${outs}<span class="muted nowrap">${stamp(e.ts, whenShort(e.ts))}</span></div>`;
}

function composerHint(name: string, state: ChatState, running: boolean): string {
  switch (state) {
    case 'running': return `${name} is working. It reads this at its next step, and can change course.`;
    case 'waiting': return `${name} is waiting for your answer above. It reads this when it continues.`;
    case 'queued': return `${name} has work queued. It reads this when it starts.${running ? '' : ' The team is stopped.'}`;
    default: return running ? `${name} is idle. This starts a new run.` : `The team is stopped. This is saved, and starts a run when you start the team.`;
  }
}

const STATE_LABEL: Record<ChatState, string> = { running: 'working', waiting: 'waiting for you', queued: 'queued', idle: 'idle' };

const hash = (s: string) => { let h = 2166136261; for (const ch of s) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const AVATAR_TITLE: Record<AvatarState, string> = { idle: 'idle', working: 'working', waiting: 'waiting for you', blocked: 'blocked', done: 'finished' };

/**
 * A small geometric face, different for every agent (colour, shape, eyes), so a roster is scannable at a glance.
 * The state is carried by motion around it, not by a separate status light: idle is still, working turns, waiting pulses,
 * blocked is red, done has a check.
 */
function avatar(name: string, state: AvatarState, size = 38): string {
  const h = hash(name), hue = h % 360, shape = (h >> 9) % 3, eyes = (h >> 12) % 3;
  const body = shape === 0 ? '<circle cx="20" cy="20" r="17"/>' : shape === 1 ? '<rect x="4" y="4" width="32" height="32" rx="11"/>' : '<rect x="7" y="7" width="26" height="26" rx="6" transform="rotate(45 20 20)"/>';
  const eye = (cx: number) => eyes === 2
    ? `<ellipse cx="${cx}" cy="19" rx="3.2" ry="4.6" fill="#fff"/><circle class="pupil" cx="${cx}" cy="20" r="1.8" fill="#222"/>`
    : `<circle cx="${cx}" cy="19" r="${eyes === 0 ? 4.2 : 3.4}" fill="#fff"/><circle class="pupil" cx="${cx}" cy="19.5" r="${eyes === 0 ? 2 : 1.7}" fill="#222"/>`;
  return `<span class="av ${state}" style="--h:${hue};--sz:${size}px" aria-hidden="true"><svg viewBox="0 0 40 40" width="${size}" height="${size}"><g fill="hsl(${hue} 55% 42%)">${body}</g>${eye(14)}${eye(26)}</svg></span>`;
}

function renderChat(m: ConsoleModel): string {
  const c = m.chat!;
  if (!c.agents.length) { return empty('bot', 'No agents on the team', 'Add a <code>loop:</code> block to a <code>.github/agents/*.agent.md</code> file, then reload.'); }
  const sel = c.agents.find(a => a.name === c.selected)!;
  const list = c.agents.map(a => `<button class="roster-row ${a.name === sel.name ? 'on' : ''}" data-agent="${esc(a.name)}" aria-pressed="${a.name === sel.name}" title="${esc(a.name)} is ${AVATAR_TITLE[a.avatar]}: ${esc(a.line)}">${avatar(a.name, a.avatar)}`
    + `<span class="rr-main"><span class="rr-top"><span class="rr-name">${esc(a.name)}</span>${a.at ? `<span class="muted rr-time">${stamp(a.at, whenShort(a.at))}</span>` : ''}</span><span class="rr-line ${a.avatar === 'waiting' ? 'warn' : a.avatar === 'blocked' ? 'bad' : 'muted'}">${esc(a.line)}</span></span>`
    + `${a.needsYou ? `<span class="count warn" title="needs you">${a.needsYou}</span>` : a.pendingMessages ? '<span class="unread" title="your message has not been read yet"></span>' : ''}</button>`).join('');
  const events = c.events.map(e => threadEvent(e, sel.name)).join('');
  const gates = c.gates.length ? `<div class="thread-gates">${c.gates.map(gateCard).join('')}</div>` : '';
  const empty0 = !c.events.length && !c.gates.length ? empty('send', `Nothing yet with ${sel.name}`, 'Say what you want below. If it is idle, this starts a run; if it is working, it will read it at its next step.') : '';
  const running = sel.state === 'running';
  return `<div class="chat">
    <nav class="roster" aria-label="Agents">${list}</nav>
    <section class="chat-main" aria-label="Conversation with ${esc(sel.name)}">
      <header class="chat-head">${avatar(sel.name, sel.avatar, 34)}<div class="grow"><div class="ch-name">${esc(sel.name)}</div><div class="muted ch-sub" title="${esc(sel.line)}">${esc(STATE_LABEL[sel.state])} · ${esc(sel.line)}</div></div></header>
      <div class="thread" data-thread="${esc(sel.name)}" tabindex="0" aria-live="polite">${c.hidden ? `<div class="muted center">${c.hidden} earlier event${c.hidden === 1 ? '' : 's'} not shown</div>` : ''}${events}${empty0}${gates}</div>
      <div class="composer ${running ? 'running' : ''}"><div class="muted hint">${esc(composerHint(sel.name, sel.state, m.running))}</div>
        <div class="inputbar"><textarea rows="1" data-input="chat:${esc(sel.name)}" data-chat-input="${esc(sel.name)}" aria-label="Message ${esc(sel.name)}" placeholder="Message ${esc(sel.name)}…"></textarea>`
    + `<button class="roundbtn stop" data-chat-cancel="${esc(sel.name)}" title="Stop this run" aria-label="Stop this run">${icon('stop')}<span class="stoplabel">Stop</span></button>`
    + `<button class="roundbtn send" data-chat-send="${esc(sel.name)}" title="Send" aria-label="Send">${icon('up')}</button></div>
        <div class="muted tiny">Enter sends · Shift+Enter new line · @name writes to another agent · /stop ends the current run</div></div>
    </section></div>`;
}

function renderTabs(m: ConsoleModel): string {
  const tab = (id: string, label: string, extra = '') => `<button role="tab" class="tab ${m.tab === id ? 'on' : ''}" aria-selected="${m.tab === id}" data-tab="${id}">${label}${extra}</button>`;
  const needs = m.pending.length ? `<span class="count warn" title="needs you">${m.pending.length}</span>` : '';
  return `<nav class="tabs" role="tablist">${tab('chat', 'Chat', needs)}${tab('overview', 'Overview')}</nav>`;
}

/** Console body (the part that is re-rendered when data changes). */
export function renderBody(m: ConsoleModel): string {
  const live = m.runs.find(r => r.status === 'running' && r.agent === m.active);
  const state = !m.running ? `<span class="state off">${icon('stop')}Team stopped</span>`
    : m.active ? `<span class="state on">${icon('spin', 'spin')}Running · ${esc(m.active)}${live ? ` · step ${live.step}` : ''}</span>`
    : `<span class="state idle">${icon('clock')}Team on · idle${m.next ? ` · next wake ${esc(when(m.next.at))}` : ''}</span>`;
  const actions = (m.running ? btn('Stop team', 'data-cmd="stopTeam"', 'secondary', 'stop') : btn('Start team', 'data-cmd="startTeam"', 'primary', 'play'))
    + btn('Give a task', 'data-cmd="runAgent"', 'secondary', 'send') + btn('Latest result', 'data-cmd="openLatestResult"', 'secondary', 'file');
  const last = m.runs.find(r => r.status !== 'running');
  const tiles = [
    { k: 'Needs you', v: String(m.pending.length), tone: m.pending.length ? 'warn' : '', sub: m.pending.length ? 'waiting for your decision' : 'all clear' },
    { k: 'Agents', v: String(m.agents.length), tone: '', sub: `${m.agents.filter(a => a.state === 'running').length} running · ${m.agents.filter(a => a.state === 'waiting').length} waiting` },
    { k: 'Last run', v: last ? (STATUS[last.status]?.label ?? last.status) : '—', tone: last ? (STATUS[last.status]?.tone ?? '') : '', sub: last ? `${last.agent} · ${ago(last.started)}` : 'no runs yet' },
    { k: 'Next wake', v: m.next ? when(m.next.at) : '—', tone: '', sub: m.next ? m.next.agent : 'nothing scheduled' }
  ].map(t => `<div class="tile ${t.tone}"><div class="tile-k">${esc(t.k)}</div><div class="tile-v">${esc(t.v)}</div><div class="muted">${esc(t.sub)}</div></div>`).join('');
  const needs = m.pending.length ? m.pending.map(gateCard).join('') : empty('check', 'Nothing is waiting for you', 'Questions and approvals from agents show up here.');
  const problems = m.runs.filter(r => PROBLEMS.has(r.status)).length;
  const filter = m.runs.length ? `<label class="filter"><span class="muted">Show</span><select data-filter aria-label="Filter runs"><option value="all">All runs (${m.runs.length})</option><option value="problems">Problems (${problems})</option><option value="done">Done</option></select></label>` : '';
  const runs = m.runs.length ? `<div class="runs">${m.runs.map(runCard).join('')}</div><div class="empty hidden" data-filter-empty>No runs match this filter.</div>`
    : empty('clock', 'No runs yet', 'Press Start team, or use “Give a task” to run an agent now.');
  const agents = m.agents.length ? m.agents.map(agentRow).join('')
    : empty('bot', 'No agents on the team', 'Add a <code>loop:</code> block to a <code>.github/agents/*.agent.md</code> file, then reload.');
  const note = m.note ? `<div class="alert ${m.note.tone}" role="alert">${icon(m.note.tone === 'bad' ? 'x' : 'alert')}<span>${esc(m.note.text)}</span></div>` : '';
  return `<header class="bar"><div class="brand">Loop Console</div>${state}<span class="grow"></span><span class="muted updated">Updated <time data-updated datetime="${esc(m.updatedAt)}">${esc(new Date(m.updatedAt).toLocaleTimeString())}</time></span><div class="row">${actions}</div></header>
    ${note}${renderTabs(m)}${m.tab === 'chat' && m.chat ? renderChat(m) : `<div class="tiles">${tiles}</div>
    <div class="cols"><main><h2>Needs you${m.pending.length ? `<span class="count warn">${m.pending.length}</span>` : ''}</h2>${needs}
    <h2>Recent runs<span class="grow"></span>${filter}</h2>${runs}</main><aside><h2>Agents</h2>${agents}</aside></div>`}`;
}

const STYLE = `
:root{--gap:12px;--r:6px;--ok:var(--vscode-testing-iconPassed,var(--vscode-charts-green));--bad:var(--vscode-errorForeground,var(--vscode-charts-red));--warn:var(--vscode-editorWarning-foreground,var(--vscode-charts-orange));--info:var(--vscode-charts-blue);--cb:var(--vscode-contrastBorder,transparent);--cab:var(--vscode-contrastActiveBorder,var(--vscode-focusBorder))}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 32px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);line-height:1.45}
.mono,code,pre{font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.muted{color:var(--vscode-descriptionForeground)}.grow{flex:1;min-width:0}.nowrap{white-space:nowrap}.wrap-text{overflow-wrap:anywhere}.hidden{display:none}
.ic{flex:none}.big{width:28px;height:28px}.lead{width:18px;height:18px;margin-top:2px}.spin{animation:sp 1.2s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:var(--gap);flex-wrap:wrap;padding:12px 0;margin-bottom:4px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
.brand{font-size:1.25em;font-weight:600;margin-right:4px}.updated{font-size:.85em}
.state{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-weight:600;font-size:.92em;border:1px solid var(--vscode-panel-border)}
.state.on{color:var(--ok);border-color:currentColor}.state.off{color:var(--vscode-descriptionForeground)}
.row{display:flex;gap:8px;align-items:flex-start}.row.wrap{flex-wrap:wrap;align-items:center}.row>textarea{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border:1px solid var(--cb);border-radius:2px;font:inherit;cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.btn.primary:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
.btn.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.btn.secondary:hover:not(:disabled){background:var(--vscode-button-secondaryHoverBackground)}
.btn.ghost{background:transparent;color:var(--vscode-descriptionForeground);padding:3px 6px}.btn.ghost:hover{background:var(--vscode-toolbar-hoverBackground,var(--vscode-list-hoverBackground))}
.btn:disabled{opacity:.5;cursor:not-allowed}.btn.picked{outline:2px solid var(--cab);outline-offset:0}
.btn:focus-visible,a:focus-visible,summary:focus-visible,textarea:focus-visible,select:focus-visible,pre:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
textarea,select{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:6px 8px;font:inherit;min-width:0}textarea{resize:vertical}select{padding:3px 6px}
.filter{display:inline-flex;align-items:center;gap:6px;font-weight:400;text-transform:none;letter-spacing:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--gap);margin:16px 0 8px}
.tile{padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);background:var(--vscode-sideBar-background,transparent)}
.tile-k{font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}.tile-v{font-size:1.5em;font-weight:600;margin:2px 0}
.tile.warn{border-color:var(--warn)}.tile.warn .tile-v{color:var(--warn)}.tile.ok .tile-v{color:var(--ok)}.tile.bad .tile-v{color:var(--bad)}.tile.info .tile-v{color:var(--info)}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
@media (max-width:820px){.cols{grid-template-columns:1fr}}
h2{display:flex;align-items:center;gap:8px;margin:22px 0 10px;font-size:.82em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.count{padding:0 7px;border-radius:999px;font-size:.95em;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}.count.warn{background:var(--warn);color:var(--vscode-editor-background)}
.card{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:14px;margin-bottom:var(--gap);background:var(--vscode-sideBar-background,transparent)}
.card.attention{border-left:3px solid var(--warn)}
.card-head{display:flex;gap:10px}.card-title{font-weight:600;font-size:1.05em;overflow-wrap:anywhere}.lead.warn{color:var(--warn)}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.88em;color:var(--vscode-descriptionForeground)}.meta>*+*::before{content:"·";margin-right:8px}
.tag{padding:0 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.meta .tag::before{content:none;margin:0}
.body{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:9em;overflow:auto}.label{margin:12px 0 4px;font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}
.note{margin:8px 0;font-size:.9em;color:var(--vscode-descriptionForeground)}
.alert{display:flex;gap:8px;align-items:flex-start;margin:8px 0;padding:8px 10px;border-radius:4px;border:1px solid currentColor}.alert.bad{color:var(--bad)}.alert.info,.alert.warn{color:var(--warn)}.alert>span{color:var(--vscode-foreground)}
.code{margin:0 0 6px;padding:10px;border-radius:4px;background:var(--vscode-textCodeBlock-background);white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto}.code.cmd{border-left:3px solid var(--info);flex:1}
.cmdrow{display:flex;gap:6px;align-items:flex-start}
details>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;border-radius:4px}details>summary::-webkit-details-marker{display:none}
.chev{transition:transform .12s}details[open]>summary>.chev{transform:rotate(90deg)}
.file{margin:8px 0}.file>summary{padding:4px 0;color:var(--vscode-descriptionForeground)}
.filechip{display:inline-flex;align-items:center;gap:6px;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:999px;color:var(--vscode-textLink-foreground);text-decoration:none;overflow-wrap:anywhere}.filechip:hover{background:var(--vscode-list-hoverBackground)}
a{color:var(--vscode-textLink-foreground)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:.88em;font-weight:600;white-space:nowrap;border:1px solid currentColor}
.chip.ok{color:var(--ok)}.chip.bad{color:var(--bad)}.chip.warn{color:var(--warn)}.chip.info{color:var(--info)}.chip.mute{color:var(--vscode-descriptionForeground)}
.run{border:1px solid var(--vscode-panel-border);border-radius:var(--r);margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.run>summary{padding:10px 12px}.run>summary:hover{background:var(--vscode-list-hoverBackground)}.run-agent{font-weight:600}.run-sum{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-body{padding:0 14px 12px 36px}
.timeline{list-style:none;margin:6px 0 10px;padding:0}
.step{display:flex;gap:10px;padding:5px 0;position:relative}.step:not(:last-child)::before{content:"";position:absolute;left:7px;top:22px;bottom:-4px;width:1px;background:var(--vscode-panel-border)}
.node{color:var(--vscode-descriptionForeground);margin-top:1px}.step.bad .node{color:var(--bad)}.result-bad{color:var(--bad)}.step-title{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;overflow-wrap:anywhere}
.kind{font-size:.75em;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground)}
.agent{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:12px;margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.agent-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agent-name{font-weight:600;flex:1;text-decoration:none}.agent-name:hover{text-decoration:underline}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:10px 0 0;font-size:.92em}.kv dt{color:var(--vscode-descriptionForeground)}.kv dd{margin:0;overflow-wrap:anywhere}
.empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px 12px;text-align:center;border:1px dashed var(--vscode-panel-border);border-radius:var(--r);color:var(--vscode-descriptionForeground)}.empty-title{color:var(--vscode-foreground);font-weight:600}
.stale{margin:8px 0}.link{font-size:.9em}
.tabs{display:flex;gap:4px;margin:12px 0 0;border-bottom:1px solid var(--vscode-panel-border)}
.tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:transparent;color:var(--vscode-descriptionForeground);border:0;border-bottom:2px solid transparent;font:inherit;cursor:pointer}
.tab.on{color:var(--vscode-foreground);border-bottom-color:var(--vscode-focusBorder)}.tab:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.chat{display:grid;grid-template-columns:280px minmax(0,1fr);gap:0;margin-top:12px;height:calc(100vh - 170px);min-height:400px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);overflow:hidden}
@media (max-width:760px){.chat{grid-template-columns:1fr;height:auto}.roster{max-height:220px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}}
.roster{display:flex;flex-direction:column;overflow:auto;background:var(--vscode-sideBar-background,transparent);border-right:1px solid var(--vscode-panel-border)}
.roster-row{display:flex;align-items:center;gap:12px;padding:10px 14px;text-align:left;background:transparent;color:var(--vscode-foreground);border:0;border-bottom:1px solid var(--vscode-panel-border);font:inherit;cursor:pointer;width:100%}
.roster-row:hover{background:var(--vscode-list-hoverBackground)}.roster-row.on{background:var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground))}
.roster-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.rr-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.rr-top{display:flex;align-items:baseline;gap:8px}.rr-name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rr-time{font-size:.8em;white-space:nowrap}
.rr-line{font-size:.88em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rr-line.warn{color:var(--warn)}.rr-line.bad{color:var(--bad)}
.unread{width:9px;height:9px;border-radius:50%;background:var(--vscode-focusBorder);flex:none}
.av{position:relative;display:inline-flex;flex:none;width:var(--sz);height:var(--sz);border-radius:50%}
.av::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid transparent;pointer-events:none}
.av.working::after{border-color:var(--info) transparent var(--info) transparent;animation:sp 1.4s linear infinite}
.av.waiting::after{border-color:var(--warn);animation:pulse 1.4s ease-in-out infinite}
.av.blocked::after{border-color:var(--bad)}
.av.done::after{border-color:var(--ok)}.av.done::before{content:"✓";position:absolute;right:-4px;bottom:-4px;width:15px;height:15px;border-radius:50%;background:var(--ok);color:var(--vscode-editor-background);font-size:10px;font-weight:700;line-height:15px;text-align:center;z-index:1}
.av.working .pupil{animation:look 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(1.08)}}@keyframes look{0%,100%{transform:translateX(-1px)}50%{transform:translateX(1px)}}
@media (prefers-reduced-motion:reduce){.av.working::after,.av.waiting::after,.av.working .pupil{animation:none}}
.chat-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--vscode-editor-background)}
.chat-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border)}.ch-name{font-weight:600;font-size:1.05em}.ch-sub{font-size:.88em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thread{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px}.center{text-align:center}
.msg{display:flex;gap:10px;max-width:100%}.msg.human{justify-content:flex-end}.msg.agent{justify-content:flex-start;align-items:flex-start}
.bubble{max-width:78%;padding:8px 14px;border-radius:18px;overflow-wrap:anywhere}
.human .bubble{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-bottom-right-radius:5px}
.human .bubble .mmeta{color:inherit;opacity:.8}.human .bubble.answer{background:var(--vscode-input-background);color:var(--vscode-foreground);border:1px solid var(--cab)}
.agent .bubble{background:var(--vscode-input-background);border-bottom-left-radius:5px}
.mtext{white-space:pre-wrap}.mname{font-weight:600;margin-bottom:2px}.mkind{font-size:.85em;opacity:.8;margin-bottom:2px}.mmeta{font-size:.78em;color:var(--vscode-descriptionForeground);margin-top:3px}
.steps{display:block;width:100%;border:0;border-left:2px solid var(--vscode-panel-border);border-radius:0;padding:2px 10px;margin-left:38px;max-width:calc(100% - 38px);background:transparent}.steps>summary{padding:2px 0}.steps .timeline{margin:6px 0 4px}
.steps-sum{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}time{font-weight:400}
.sline{display:flex;align-items:center;gap:8px;flex-wrap:wrap;justify-content:center;font-size:.9em;color:var(--vscode-descriptionForeground)}
.thread-gates{width:100%;margin-top:6px}.thread-gates .card{margin-bottom:8px}
.composer{padding:10px 16px 12px}.composer .hint{font-size:.85em;margin:0 6px 6px}.tiny{font-size:.75em;margin:6px 6px 0}
.inputbar{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:24px;background:var(--vscode-input-background);padding:6px 8px 6px 16px}
.inputbar:focus-within{border-color:var(--vscode-focusBorder)}
.inputbar textarea{flex:1;border:0;background:transparent;color:var(--vscode-input-foreground);resize:none;padding:6px 0;max-height:160px;outline:none;font:inherit}
.roundbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:34px;height:34px;border-radius:17px;border:1px solid var(--cb);cursor:pointer;font:inherit;padding:0 8px;flex:none}
.roundbtn.send{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.roundbtn.send:hover{background:var(--vscode-button-hoverBackground)}
.roundbtn.stop{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.roundbtn.stop .stoplabel{display:none}.roundbtn.stop[data-armed] .stoplabel{display:inline}
.roundbtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.composer:not(.running) .stop,.composer.running textarea:not(:placeholder-shown) ~ .stop{display:none}
.composer.running textarea:placeholder-shown ~ .send{display:none}
`;

const SCRIPT = `
const vs = acquireVsCodeApi(); const app = document.getElementById('app');
const q = id => '[data-gate="' + CSS.escape(id) + '"]';
const val = id => (document.querySelector('[data-input="' + CSS.escape(id) + '"]') || {}).value || '';
const busy = new Set();      // approvals whose command is running: a second click must not run it again
const reviewed = {};         // gate id -> { path: hash } the reader has been shown and accepted
let filter = 'all';
const hashes = id => { const h = {}; document.querySelectorAll(q(id) + ' [data-hash-for]').forEach(x => h[x.dataset.hashFor] = x.dataset.hash); return h; };
const same = (a, b) => Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => a[k] === b[k]);
// A draft that changes while the card is open must be read again before it can be approved.
function scan() {
  document.querySelectorAll('[data-gate]').forEach(card => {
    const id = card.dataset.gate; const now = hashes(id); const ap = card.querySelector('[data-approve]');
    if (!ap) return;
    if (!reviewed[id]) reviewed[id] = now;
    const changed = !same(reviewed[id], now);
    card.querySelectorAll('.stale').forEach(x => x.remove());
    if (changed) {
      const d = document.createElement('div'); d.className = 'alert warn stale'; d.setAttribute('role', 'alert');
      d.innerHTML = '<span>The draft changed after you opened this card. Read it again, then confirm.</span>';
      const b = document.createElement('button'); b.className = 'btn secondary'; b.dataset.ack = id; b.textContent = 'I have reviewed the new version'; d.appendChild(b);
      ap.closest('.row').before(d);
    }
    const missing = Object.values(now).includes('missing');
    ap.disabled = missing || changed || busy.has(id);
    ap.setAttribute('aria-busy', busy.has(id) ? 'true' : 'false');
    const label = ap.querySelector('span'); if (label) label.textContent = busy.has(id) ? 'Running…' : 'Approve and run';
  });
  document.querySelectorAll('details.run').forEach(d => { d.classList.toggle('hidden', !(filter === 'all' || (filter === 'done' ? d.dataset.status === 'done' : !['done','running','waiting','nothing_to_do','cancelled'].includes(d.dataset.status)))); });
  const empty = document.querySelector('[data-filter-empty]');
  if (empty) empty.classList.toggle('hidden', !document.querySelectorAll('details.run').length || [...document.querySelectorAll('details.run')].some(d => !d.classList.contains('hidden')));
  const sel = document.querySelector('[data-filter]'); if (sel) sel.value = filter;
}
function autosize(t) { t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight, 160) + 'px'; }
document.addEventListener('input', e => { if (e.target.matches && e.target.matches('textarea[data-chat-input]')) autosize(e.target); });
function sendChat(agent) {
  const ta = document.querySelector('[data-chat-input="' + CSS.escape(agent) + '"]');
  let text = ta ? ta.value.trim() : '';
  if (!text) return;
  // /stop ends the current run, like telling it to stop.
  if (/^\\/stop$/i.test(text)) { ta.value = ''; autosize(ta); vs.postMessage({ type:'chatCancel', agent }); return; }
  // @name writes to another agent, and takes you to that conversation.
  const known = new Set([...document.querySelectorAll('[data-agent]')].map(x => x.dataset.agent));
  const at = /^@([\\w.-]+)\\s+([\\s\\S]+)$/.exec(text);
  let target = agent;
  if (at && known.has(at[1])) { target = at[1]; text = at[2].trim(); }
  vs.postMessage({ type:'chatSend', agent: target, text });
  ta.value = ''; autosize(ta);
  if (target !== agent) vs.postMessage({ type:'view', tab:'chat', agent: target });
}
// Enter sends, Shift+Enter is a new line; Enter that confirms an input-method composition (Chinese, Japanese) must not send.
// Cmd/Ctrl+Enter sends from anywhere on the page.
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing) {
    const ta = document.querySelector('textarea[data-chat-input]');
    if (ta && ta.value.trim()) { e.preventDefault(); sendChat(ta.dataset.chatInput); }
  }
});
document.addEventListener('keydown', e => {
  const t = e.target;
  if (t && t.matches && t.matches('textarea[data-chat-input]') && e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); sendChat(t.dataset.chatInput); }
});
document.addEventListener('change', e => { if (e.target.matches('[data-filter]')) { filter = e.target.value; scan(); } });
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-open-abs],[data-cmd],[data-pick],[data-send],[data-approve],[data-reject],[data-ack],[data-copy],[data-tab],[data-agent],[data-chat-send],[data-chat-cancel]'); if (!t) return;
  e.preventDefault(); const d = t.dataset;
  if (d.open) vs.postMessage({ type:'open', path:d.open });
  else if (d.openAbs) vs.postMessage({ type:'openAbs', path:d.openAbs });
  else if (d.cmd) vs.postMessage({ type:'cmd', name:d.cmd });
  else if (d.pick) { const ta = document.querySelector('[data-input="' + CSS.escape(d.pick) + '"]'); if (ta) { ta.value = d.text; ta.focus(); } document.querySelectorAll(q(d.pick) + ' [data-pick]').forEach(b => b.classList.toggle('picked', b === t)); }
  else if (d.send) { const text = val(d.send).trim(); if (text) vs.postMessage({ type:'answer', id:d.send, text }); }
  else if (d.approve) { if (busy.has(d.approve) || t.disabled) return; busy.add(d.approve); scan(); vs.postMessage({ type:'approve', id:d.approve, seen:hashes(d.approve) }); }
  else if (d.reject) vs.postMessage({ type:'reject', id:d.reject, feedback:val(d.reject) });
  else if (d.ack) { reviewed[d.ack] = hashes(d.ack); scan(); }
  else if (d.tab) vs.postMessage({ type:'view', tab:d.tab });
  else if (d.agent) vs.postMessage({ type:'view', tab:'chat', agent:d.agent });
  else if (d.chatSend) sendChat(d.chatSend);
  else if (d.chatCancel) {
    // Cancelling ends the run for good, so it takes two clicks.
    if (t.dataset.armed) { delete t.dataset.armed; vs.postMessage({ type:'chatCancel', agent:d.chatCancel }); }
    else { t.dataset.armed = '1'; const label = t.querySelector('span'); const old = label ? label.textContent : ''; if (label) label.textContent = 'Click again to cancel the run'; setTimeout(() => { delete t.dataset.armed; if (label) label.textContent = old; }, 4000); }
  }
  else if (d.copy != null) { const done = () => { t.classList.add('picked'); setTimeout(() => t.classList.remove('picked'), 900); }; try { navigator.clipboard.writeText(d.copy).then(done, () => {}); } catch (_) {} }
});
// Re-render without losing what the user is doing: open sections, typed text, focus, filter.
window.addEventListener('message', ev => {
  if (ev.data.type === 'idle') { busy.delete(ev.data.id); scan(); return; }
  if (ev.data.type !== 'body') return;
  const open = new Set([...document.querySelectorAll('details[open]')].map(d => d.dataset.k));
  const closed = new Set([...document.querySelectorAll('details:not([open])')].map(d => d.dataset.k));
  const typed = {}; document.querySelectorAll('textarea[data-input]').forEach(t => { typed[t.dataset.input] = t.value; });
  const f = document.activeElement; const fk = f && f.dataset ? Object.entries(f.dataset).find(([k]) => /^(input|approve|reject|send|cmd|pick|open|ack|copy)$/.test(k)) : undefined;
  const sel = f && f.selectionStart;
  const y = window.scrollY;
  // A conversation stays pinned to its newest message, unless the reader has scrolled up to read.
  const th = document.querySelector('[data-thread]');
  const stick = !th || th.scrollHeight - th.scrollTop - th.clientHeight < 40;
  const topBefore = th ? th.scrollTop : 0, whose = th ? th.dataset.thread : '';
  app.innerHTML = ev.data.html;
  document.querySelectorAll('details[data-k]').forEach(d => { if (closed.has(d.dataset.k)) d.open = false; else if (open.has(d.dataset.k)) d.open = true; });
  document.querySelectorAll('textarea[data-input]').forEach(t => { if (typed[t.dataset.input]) t.value = typed[t.dataset.input]; if (t.dataset.chatInput) autosize(t); });
  scan();
  if (fk) { const t = document.querySelector('[data-' + fk[0].replace(/[A-Z]/g, c => '-' + c.toLowerCase()) + '="' + CSS.escape(fk[1]) + '"]'); if (t) { t.focus(); if (sel != null && t.setSelectionRange) t.setSelectionRange(sel, sel); } }
  window.scrollTo(0, y);
  const th2 = document.querySelector('[data-thread]');
  if (th2) th2.scrollTop = (stick || th2.dataset.thread !== whose) ? th2.scrollHeight : topBefore;
});
scan();
{ const th0 = document.querySelector('[data-thread]'); if (th0) th0.scrollTop = th0.scrollHeight; }
vs.postMessage({ type:'ready' });`;

/** Full page. The script is the only inline code and carries the nonce; everything shown is escaped. */
export function renderPage(m: ConsoleModel, nonce: string, cspSource: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Loop Console</title><style>${STYLE}</style></head><body><div id="app">${renderBody(m)}</div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
