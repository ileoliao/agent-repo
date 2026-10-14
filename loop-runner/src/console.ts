import * as fs from 'fs';
import { Gate, listGates } from './queue';
import { sha256Of } from './gates';
import * as path from 'path';
import { RunSummary, recentRuns } from './runs';
import { AgentRow, agentRows, nextWake } from './status';
import { refusalOf, Active, brief, clip, firstLine, isActive } from './textutil';
import { Task, listTasks } from './tasks';
import { AvatarState, ChatState, ThreadEvent, ThreadStep, Tone, buildThread, glance, splitOutputs } from './thread';
import { blockKey, dismissedBlocks, uiFlag } from './maintenance';
import { planAllowCommand } from './policyEdit';

/** One line of a run's story: what the agent did at a step. */
export interface Step {
  step: number;
  kind: 'say' | 'tool' | 'gate' | 'end' | 'error';
  title: string;
  detail?: string;
  /** false for REFUSED / ERROR results. */
  ok: boolean;
  /** A command policy refused, and the rule that did: `no allow rule matched` can be allowed with one click; a deny rule cannot. */
  refused?: { command: string; rule: string };
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

/** A command policy refused that no rule allowed: a to-do like a question or an approval, until the human allows or dismisses it. */
export interface BlockedView { id: string; agent: string; command: string; chainId: string; at: string }

/** The newest file a mate produced, for the "Latest output" line and the top button. */
export interface LatestOutput { agent: string; path: string; at: string }

export interface ChatModel {
  agents: { name: string; description: string; file?: string; triggers?: AgentRow['triggers']; paused?: boolean; state: ChatState; avatar: AvatarState; line: string; at?: string; pendingMessages: number; needsYou: number }[];
  selected?: string;
  events: ThreadEvent[];
  /** Earlier events that are not shown. */
  hidden: number;
  /** The selected agent's open questions and approvals, shown at the end of the conversation. */
  gates: GateView[];
  /** The selected agent's blocked commands waiting to be allowed or dismissed. */
  blocked?: BlockedView[];
}

export interface ConsoleModel {
  running: boolean;
  active?: Active;
  next?: { agent: string; at: string };
  pending: GateView[];
  /** Blocked commands waiting for the human, counted with `pending` everywhere. Absent in older callers. */
  blocked?: BlockedView[];
  /** Newest produced file per agent (and the newest of all, `latest`). Absent in older callers. */
  outputs?: Record<string, LatestOutput>;
  latest?: LatestOutput;
  /** The "runs as you, not in a sandbox" note has not been shown yet (no approval decided so far). */
  firstApproval?: boolean;
  /** Tasks agents have in progress (state open). Absent in older callers. */
  tasks?: Task[];
  /** The last questions and approvals the human settled: an audit trail visible where it is needed. */
  decisions?: { id: string; kind: Gate['kind']; agent: string; title: string; status: Gate['status']; at: string }[];
  agents: AgentRow[];
  runs: ConsoleRun[];
  /** Which page is showing. Chat is the default. */
  tab: 'chat' | 'overview';
  /** The conversation with one agent; only built while the chat tab is showing. */
  chat?: ChatModel;
  /** ISO time this view was built. */
  updatedAt: string;
  /** How many Copilot models VS Code offers right now; undefined while unknown. 0 means agents cannot run. */
  copilot?: number;
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
      const refusal = refusalOf(e.name, e.input, result);
      out.push({ step, kind: e.gateId ? 'gate' : 'tool', title: `${e.name}${brief(e.input) ? ` · ${brief(e.input)}` : ''}`, detail: clip(firstLine(result), 160) || undefined, ok, ...(refusal ? { refused: refusal } : {}) });
    } else if (e.type === 'end') {
      out.push({ step, kind: 'end', title: `${e.status ?? 'done'}${e.summary ? ` · ${clip(String(e.summary), 140)}` : ''}`, ok: e.status === 'done' || e.status === undefined });
    } else if (e.type === 'error') {
      out.push({ step, kind: 'error', title: clip(String(e.message ?? 'error'), 160), ok: false });
    }
  }
  return out;
}

/** Everything the console shows, as plain data. Pure and read-only: the same files the sidebar reads. */
/** The file a run is known for: the last file it declared for the human, else the last one it wrote. */
export function mainOutput(r: { outputs: string[]; deliverables?: string[] }): string | undefined {
  const split = splitOutputs(r.deliverables, r.outputs);
  return split.deliverables[split.deliverables.length - 1] ?? r.outputs[r.outputs.length - 1];
}

/**
 * Commands policy refused that nothing allows yet. Only the mate's newest run counts, and only when it ended blocked:
 * an older refusal was worked around or is history. Already allowed (by a click or by editing the policy) or dismissed ones are not to-dos.
 */
function blockedOf(root: string, runs: ConsoleRun[], defaultPolicy?: string): BlockedView[] {
  const dismissed = dismissedBlocks(root), seen = new Set<string>(), out: BlockedView[] = [];
  for (const r of runs) {
    if (seen.has(r.agent)) { continue; }
    seen.add(r.agent);
    if (r.status !== 'blocked') { continue; }
    for (const s of r.steps) {
      if (!s.refused || s.refused.rule !== 'no allow rule matched') { continue; }
      const key = blockKey(r.agent, s.refused.command);
      if (dismissed.has(key) || out.some(b => b.agent === r.agent && b.command === s.refused!.command)) { continue; }
      // A plan means the policy still refuses it and a click can fix that; an error means it is allowed now, denied on purpose, or not ours to change.
      if ('error' in planAllowCommand(root, r.agent, s.refused.command, defaultPolicy)) { continue; }
      out.push({ id: `b-${r.chainId}-${out.length}`, agent: r.agent, command: s.refused.command, chainId: r.chainId, at: r.updated || r.started });
      if (out.filter(b => b.agent === r.agent).length >= 3) { break; }
    }
  }
  return out;
}

export function consoleModel(root: string, state: { running: boolean; active?: Active; tab?: 'chat' | 'overview'; agent?: string; defaultPolicy?: string }, now = new Date(), runLimit = 10): ConsoleModel {
  const agents = agentRows(root, state.active, now);
  const nw = nextWake(agents);
  const tab = state.tab ?? 'chat';
  const pending = listGates(root).filter(g => g.status === 'pending').map(g => ({ ...g, previews: previewsOf(root, g) }));
  // Runs are read once, more than are shown, so "latest output" still finds a mate whose last runs wrote nothing.
  const all = recentRuns(root, Math.max(runLimit, 40));
  const runs: ConsoleRun[] = all.slice(0, runLimit).map(r => ({
    ...r,
    // A run whose last event says "running" but that no live worker owns (team stopped, or another agent is active)
    // was cut off, for example when VS Code closed. Say so instead of showing it as running forever.
    status: r.status === 'running' && !(state.running && isActive(state.active, r.agent)) ? 'interrupted' : r.status,
    steps: stepsOf(r.file)
  }));
  const blocked = blockedOf(root, runs, state.defaultPolicy);
  const outputs: Record<string, LatestOutput> = {};
  for (const r of all) {
    const f = mainOutput(r);
    if (f && r.status !== 'running' && !outputs[r.agent]) { outputs[r.agent] = { agent: r.agent, path: f, at: r.updated || r.started }; }
  }
  const latest = Object.values(outputs).sort((a, b) => b.at.localeCompare(a.at))[0];
  let chat: ChatModel | undefined;
  if (tab === 'chat') {
    const rows = agents.map(a => { const g = glance(root, a.name, a.description, state.active, now); return { name: a.name, description: a.description, file: a.file, triggers: a.triggers, paused: a.paused, ...g, needsYou: g.needsYou + blocked.filter(b => b.agent === a.name).length }; });
    // With no choice made, land on the mate behind the first to-do.
    const first = pending[0]?.agent ?? blocked[0]?.agent;
    const selected = rows.find(r => r.name === state.agent)?.name ?? rows.find(r => r.name === first)?.name ?? rows.find(r => r.needsYou)?.name ?? rows.find(r => r.state === 'running')?.name ?? rows[0]?.name;
    const th = selected ? buildThread(root, selected) : { events: [], hidden: 0 };
    chat = { agents: rows, selected, events: th.events, hidden: th.hidden, gates: pending.filter(g => g.agent === selected), blocked: blocked.filter(b => b.agent === selected) };
  }
  return {
    tab,
    chat,
    running: state.running,
    active: state.active,
    next: nw ? { agent: nw.agent, at: nw.at.toISOString() } : undefined,
    pending,
    blocked,
    outputs,
    latest,
    firstApproval: !uiFlag(root, 'approvalNoteSeen'),
    tasks: listTasks(root).filter(t => t.state === 'open').slice(0, 30),
    decisions: listGates(root).filter(g => g.status !== 'pending').map(g => ({ id: g.id, kind: g.kind, agent: g.agent, title: g.title, status: g.status, at: g.resolvedAt ?? g.createdAt })).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 6),
    agents,
    runs,
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
  nothing_to_do: { label: 'Checked, nothing found', tone: 'mute', ic: 'check' }, open: { label: 'Not finished', tone: 'info', ic: 'clock' }, cancelled: { label: 'Cancelled', tone: 'mute', ic: 'stop' }
};
/** Why a run ended this way and what to do next, in words a first-time user can act on. */
const STATUS_HINT: Record<string, string> = {
  blocked: 'It could not go on. Open the steps, then tell it what it needs in Chat.',
  error: 'Something failed. Open the steps; “Check mates” finds setup problems.',
  stalled: 'It went in circles or ran out of time. Try a narrower task.',
  max_steps: 'It hit its step limit. Narrow the task, or raise the limit.',
  interrupted: 'VS Code closed or the mates were stopped mid-run. Start the mates to pick it up.',
  retry: 'A temporary limit stopped it. It retries by itself.'
};
/** Statuses the "Problems" filter shows. */
const PROBLEMS = new Set(['error', 'stalled', 'blocked', 'max_steps', 'interrupted', 'retry']);
const chip = (status: string) => { const s = STATUS[status] ?? { label: status, tone: 'mute', ic: 'dot' }; return `<span class="chip ${s.tone}">${icon(s.ic)}<span>${esc(s.label)}</span></span>`; };
const btn = (label: string, attrs: string, kind = '', ic = '') => `<button class="btn ${kind}" ${attrs}>${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;
const iconBtn = (label: string, attrs: string, ic: string) => `<button class="btn secondary iconbtn" ${attrs} aria-label="${esc(label)}">${icon(ic)}</button>`;
const copy = (text: string, label: string) => `<button class="btn ghost" data-copy="${esc(text)}" aria-label="Copy ${esc(label)}" title="Copy ${esc(label)}">${icon('copy')}</button>`;

/** Mate name, kind and age: the line every to-do card (question, approval, blocked command) opens with. */
const todoMeta = (agent: string, kind: string, at: string, tip = '') => `<div class="meta"><span class="tag">${esc(agent)}</span><span${tip ? ` title="${esc(tip)}"` : ''}>${esc(kind)}</span><span>${stamp(at, ago(at))}</span></div>`;

/**
 * A question or an approval, as a card with buttons only: the one text box is the composer at the bottom of the chat
 * (it answers a question, or gives the reason when rejecting). `note` is the one-time "runs as you" line for a first approval.
 */
function gateCard(g: GateView, note = false): string {
  const isQ = g.kind === 'question';
  const head = `<div class="card-head">${icon(isQ ? 'help' : 'bell', 'lead warn')}<div class="grow"><div class="card-title">${esc(g.title)}</div>
    ${todoMeta(g.agent, isQ ? 'Question' : 'Approval needed', g.createdAt, `Asked in run ${g.chainId}. Its steps are under Overview, Recent runs.`)}</div></div>`;
  const previews = g.previews ?? [];
  const missing = previews.filter(p => p.sha256 === 'missing').map(p => p.path);
  const files = previews.map(p => `<details class="file" open data-k="f-${esc(g.id)}-${esc(p.path)}"><summary>${icon('chevron', 'chev')}${icon('file')}<span class="mono grow">${esc(p.path)}</span>${p.truncated ? '<span class="muted">first part shown</span>' : ''}</summary>
    <pre class="code" tabindex="0" data-hash-for="${esc(p.path)}" data-hash="${esc(p.sha256)}">${esc(p.text)}</pre>
    <div class="row wrap"><a class="filechip" href="#" data-open="${esc(p.path)}">${icon('file')}${p.truncated ? 'Open full file' : 'Open to edit'}</a></div></details>`).join('')
    + (g.files.length && !previews.length ? g.files.map(f => `<a class="filechip" href="#" data-open="${esc(f)}">${icon('file')}${esc(f)}</a>`).join('') : '');
  if (isQ) {
    const body = g.body ? `<p class="body">${esc(g.body)}</p>` : '';
    const opts = (g.options ?? []).map(o => btn(o, `data-pick="${esc(g.id)}" data-text="${esc(o)}"`, 'secondary')).join('');
    return `<section class="card attention" data-gate="${esc(g.id)}" aria-label="Question from ${esc(g.agent)}">${head}${body}${files}
      ${opts ? `<div class="label">Suggested answers</div><div class="row wrap">${opts}</div>` : ''}
      <div class="muted tiny">${opts ? 'Pick one, or type your answer' : 'Type your answer'} in the box below.</div></section>`;
  }
  const truncated = previews.some(p => p.truncated);
  const alerts = missing.length ? `<div class="alert bad">${icon('alert')}<span>${esc(missing.join(', '))} ${missing.length === 1 ? 'is' : 'are'} missing, so this cannot be approved. Reject it, or ask the agent to write the draft again.</span></div>` : '';
  // The files and the covers-what-you-saw line are behind one fold, so the command and the buttons share a screen.
  const names = (previews.length ? previews.map(p => p.path) : g.files).map(f => baseName(f));
  const fold = previews.length || g.files.length ? `<details class="gatefiles" data-k="gf-${esc(g.id)}"><summary>${icon('chevron', 'chev')}<span>Approving also covers ${names.length === 1 ? 'this file' : `these ${names.length} files`}: <b>${esc(clip(names.join(', '), 70))}</b></span></summary>
    <div class="note">${truncated ? 'Approval covers the whole of each file; open a long one to read it all.' : 'Approval covers the files shown.'}</div>${files}</details>` : '';
  return `<section class="card attention approval" data-gate="${esc(g.id)}" aria-label="Approval requested by ${esc(g.agent)}">${head}${g.body ? `<p class="body brief" title="${esc(g.body)}">${esc(g.body)}</p>` : ''}
    <div class="label">Command that will run</div><div class="cmdrow"><pre class="code cmd" tabindex="0">${esc(g.command ?? '')}</pre>${copy(g.command ?? '', 'command')}</div>${alerts}
    ${fold}<div class="row actions">${btn('Reject', `data-reject="${esc(g.id)}" title="Sends the text in the box below as the reason, if you wrote one"`, 'secondary danger', 'x')}${btn('Approve and run', `data-approve="${esc(g.id)}"${missing.length ? ' disabled' : ''}`, 'primary', 'check')}</div>
    ${note ? `<div class="note">Runs as you, not in a sandbox.</div>` : ''}</section>`;
}

/** A question or approval that comes after the one being handled: seen in order, decided in order. */
const gateQueued = (g: GateView) => `<div class="card queued" data-queued="${esc(g.id)}">${icon(g.kind === 'question' ? 'help' : 'bell', 'lead')}<span class="grow ell" title="${esc(g.title)}">${esc(g.title)}</span><span class="muted nowrap">${g.kind === 'question' ? 'Question' : 'Approval'} · next</span></div>`;

/** A refused command that no rule allowed: shaped like an approval, with Allow and Dismiss. */
function blockedCard(b: BlockedView): string {
  return `<section class="card attention blocked" data-blocked="${esc(b.id)}" aria-label="Blocked command from ${esc(b.agent)}"><div class="card-head">${icon('alert', 'lead warn')}<div class="grow"><div class="card-title">${esc(b.agent)} was blocked from running a command</div>
    ${todoMeta(b.agent, 'Blocked command', b.at, `Refused in run ${b.chainId}.`)}</div></div>
    <p class="body brief">No policy rule allows it yet. Allowing adds only this exact command, for ${esc(b.agent)} only.</p>
    <div class="label">Blocked command</div><div class="cmdrow"><pre class="code cmd" tabindex="0">${esc(b.command)}</pre>${copy(b.command, 'command')}</div>
    <div class="row actions">${btn('Dismiss', `data-dismiss-agent="${esc(b.agent)}" data-dismiss-cmd="${esc(b.command)}" title="Stop asking about this command"`, 'secondary', 'x')}${btn('Allow', `data-allow-agent="${esc(b.agent)}" data-allow-cmd="${esc(b.command)}" title="Adds this exact command for ${esc(b.agent)} only. Anything else it tries is still checked against the policy."`, 'primary', 'check')}</div></section>`;
}

/** One line per to-do for the Overview: click to handle it in that mate's Chat. */
function needRow(kind: string, title: string, agent: string, at: string): string {
  return `<button class="needrow" data-agent="${esc(agent)}" title="Handle this in ${esc(agent)}'s chat">${icon(kind === 'Question' ? 'help' : kind === 'Approval' ? 'bell' : 'alert', 'lead warn')}<span class="grow ell" title="${esc(title)}">${esc(title)}</span>${kind === 'Blocked' ? '' : `<span class="tag">${esc(agent)}</span>`}<span class="muted nowrap">${esc(kind)}</span><span class="muted nowrap">${stamp(at, ago(at))}</span>${icon('chevron')}</button>`;
}

/** For each command policy refused: say which rule did it, and offer the one-click allow only when no deny rule is involved. */
function refusalsOf(r: { agent: string; steps: { refused?: { command: string; rule: string } }[] }, compact = false): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const s of r.steps) {
    if (!s.refused || seen.has(s.refused.command)) { continue; }
    seen.add(s.refused.command);
    if (rows.length >= 3) { break; }
    const { command, rule } = s.refused;
    const open = `<a class="link" href="#" data-open=".loop/policy.json">policy file</a>`;
    // In the chat the same command is a to-do card below (Allow, Dismiss), so the history says nothing more than "N refused".
    if (rule === 'no allow rule matched' && compact) { continue; }
    rows.push(rule === 'no allow rule matched'
      ? `<div class="hintbox warn">${icon('alert')}<span class="grow"><code>${esc(clip(command, 140))}</code> is not allowed yet. Allowing adds this exact command for ${esc(r.agent)} only. <a class="link" href="#" data-open=".loop/policy.json">Policy file</a></span>${btn('Allow it', `data-allow-agent="${esc(r.agent)}" data-allow-cmd="${esc(command)}" title="Adds this exact command for ${esc(r.agent)} only. Anything else it tries is still checked against the policy."`, 'secondary', 'check')}</div>`
      : `<div class="hintbox warn">${icon('alert')}<span class="grow"><code>${esc(clip(command, 140))}</code> matches the deny rule <code>${esc(clip(rule, 80))}</code>. A deny rule is a limit you set on purpose, so it is not lifted with one click. Open the ${open} to change it.</span></div>`);
  }
  return rows.join('');
}

/** A produced file as a row: name, folder, and (when known) its first line. One look and one click to open it. */
function delivRow(d: { path: string; preview?: string }): string {
  const i = d.path.lastIndexOf('/');
  return `<a class="deliv" href="#" data-open="${esc(d.path)}" title="${esc(d.path)}">${icon('file')}<span class="dtext"><span class="dline"><span class="dname">${esc(d.path.slice(i + 1))}</span>${i > 0 ? `<span class="ddir ell">${esc(d.path.slice(0, i))}</span>` : ''}</span>${d.preview ? `<span class="dprev ell">${esc(d.preview)}</span>` : ''}</span></a>`;
}

/** What a finished run shows right under its summary: the files meant for the human, else (up to 3) of the files it wrote. The rest stay folded. */
function shownFiles(deliverables: string[], supporting: string[]): { rows: string[]; rest: string[] } {
  const promoted = deliverables.length ? [] : supporting.slice(0, 3);
  return { rows: [...deliverables, ...promoted], rest: supporting.filter(f => !promoted.includes(f)) };
}

const baseName = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/** "Latest output: today.md · 3 h ago · Open". Nothing when the mate has produced nothing. */
function latestLine(o?: LatestOutput): string {
  return o ? `<div class="muted lastout">Latest output: <span class="mono" title="${esc(o.path)}">${esc(baseName(o.path))}</span> · ${stamp(o.at, ago(o.at))} · <a class="link" href="#" data-open="${esc(o.path)}">Open</a></div>` : '';
}

function runCard(r: ConsoleRun, blocked: BlockedView[] = []): string {
  const shown = r.steps.map(s => {
    const quiet = s.ok && (s.kind === 'tool' || s.kind === 'gate') && /^(\[exit 0\]|ok)$/.test(s.detail ?? '');
    return `<li class="step ${s.ok ? '' : 'bad'}"><span class="node">${icon(s.kind === 'end' ? 'check' : s.ok ? 'dot' : 'x')}</span>
    <div class="grow"><div class="step-title"><span class="kind">${esc(s.kind)}</span>${s.step ? `<span class="muted">#${s.step}</span>` : ''}<span class="${s.kind === 'tool' || s.kind === 'gate' ? 'mono' : ''}">${esc(s.title)}</span></div>${s.detail && !quiet ? `<div class="${s.ok ? 'muted' : 'result-bad'} wrap-text">${esc(s.detail)}</div>` : ''}</div></li>`;
  }).join('');
  const outs = r.outputs.map(o => `<a class="filechip" href="#" data-open="${esc(o)}">${icon('file')}${esc(o)}</a>`).join('');
  // Under the summary, without opening the run: what it produced, or the one-click fix when a command was blocked.
  const split = splitOutputs(r.deliverables, r.outputs);
  const fileRows = r.status === 'running' ? [] : shownFiles(split.deliverables, split.supporting).rows;
  const rerun = blocked.length ? btn('Decide in Chat', `data-agent="${esc(blocked[0].agent)}" title="Allow or dismiss ${esc(clip(blocked[0].command, 80))} in ${esc(blocked[0].agent)}'s chat"`, 'secondary', 'send') : '';
  const hint = blocked.length ? 'A command it needed was not allowed. Decide in Chat.' : STATUS_HINT[r.status];
  const extra = rerun + fileRows.map(f => delivRow({ path: f })).join('');
  const dur = r.status === 'running' ? span(r.started, new Date().toISOString()) : span(r.started, r.updated);
  const live = r.status === 'running';
  return `<details class="run" ${live ? 'open' : ''} data-k="r-${esc(r.chainId)}" data-status="${esc(r.status)}"><summary>${icon('chevron', 'chev')}${chip(r.status)}<span class="run-agent">${esc(r.agent)}</span>
    <span class="grow run-sum" title="${esc(r.summary)}">${esc(clip(r.summary, 110))}</span><span class="muted nowrap">${r.step} step${r.step === 1 ? '' : 's'}${dur ? ` · ${esc(dur)}` : ''} · ${stamp(r.started, ago(r.started))}</span>${PROBLEMS.has(r.status) && hint ? `<span class="run-why">${esc(hint)}</span>` : ''}${extra ? `<span class="run-extra">${extra}</span>` : ''}</summary>
    <div class="run-body">${refusalsOf(r)}${hint ? `<div class="hintbox ${PROBLEMS.has(r.status) ? 'warn' : ''}">${icon('help')}<span>${esc(hint)}</span></div>` : ''}${r.summary ? `<p class="body">${esc(r.summary)}</p>` : ''}${outs ? `<div class="label">Files written</div><div class="row wrap">${outs}</div>` : ''}
    <div class="label">What happened</div><ol class="timeline">${shown || '<li class="muted">No steps recorded.</li>'}</ol>
    <div class="row wrap"><a class="link muted" href="#" data-open-abs="${esc(r.file)}">Open raw log</a><span class="muted">·</span><span class="muted mono">${esc(r.chainId)}</span>${copy(r.chainId, 'run id')}</div></div></details>`;
}

function taskCard(t: Task): string {
  const nexts = t.holders.map(h => `<dt>${esc(h)}</dt><dd>${esc(t.next?.[h] ?? '(no next step recorded)')}</dd>`).join('');
  return `<div class="card" data-task="${esc(t.id)}"><div class="card-head">${icon('clock', 'lead')}<div class="grow"><div class="card-title">${esc(t.title)}</div>
    <div class="meta">${t.holders.map(h => `<span class="tag">${esc(h)}</span>`).join('')}<span class="mono">${esc(t.id)}</span><span>${stamp(t.updatedAt, ago(t.updatedAt))}</span></div></div>
    ${btn('Drop task', `data-close-task="${esc(t.id)}" title="Stop tracking this task. Agents holding it let go of it; nothing is deleted."`, 'secondary', 'x')}</div>
    ${nexts ? `<dl class="kv">${nexts}</dl>` : ''}</div>`;
}

/** A cron expression in words, for the common shapes; anything else is shown as written. */
export function plainCron(c: string): string {
  const p = c.trim().split(/\s+/);
  if (p.length !== 5) { return c; }
  const [mi, h, dom, mon, dow] = p;
  const hhmm = /^\d+$/.test(mi) && /^\d+$/.test(h) ? `${h.padStart(2, '0')}:${mi.padStart(2, '0')}` : undefined;
  const every = /^\*\/(\d+)$/.exec(mi);
  if (every && h === '*' && dom === '*' && mon === '*' && dow === '*') { return `every ${every[1]} minutes`; }
  if (mi === '*' && h === '*' && dom === '*' && mon === '*' && dow === '*') { return 'every minute'; }
  if (hhmm && dom === '*' && mon === '*') {
    if (dow === '*') { return `every day at ${hhmm}`; }
    if (dow === '1-5') { return `weekdays at ${hhmm}`; }
  }
  if (/^\d+$/.test(mi) && h === '*' && dom === '*' && mon === '*' && dow === '*') { return 'every hour'; }
  return c;
}

function agentRow(a: AgentRow, copilotOff = false, out?: LatestOutput): string {
  const label = a.paused ? 'Paused' : a.state === 'running' ? 'Running' : a.state === 'waiting' ? 'Waiting on you' : 'Idle';
  const tone = a.paused ? 'mute' : a.state === 'running' ? 'info' : a.state === 'waiting' ? 'warn' : 'mute';
  const lw = a.lastWake;
  const last = !lw ? '<span class="muted">none yet</span>'
    : lw.capped !== undefined ? `daily cap reached (${lw.capped}) <span class="muted">${stamp(lw.at, ago(lw.at))}</span>`
    : `${lw.wake ? 'found work' : 'nothing to do'} <span class="muted">${stamp(lw.at, ago(lw.at))}</span>`;
  const trig = (a.triggers ?? []).map(t => t.kind === 'schedule' ? plainCron(t.text) : t.kind === 'webhook' ? `when webhook “${t.text}” is called` : `when a new file appears in ${t.text}`);
  const icoFor = (k: string) => (k === 'schedule' ? 'clock' : k === 'webhook' ? 'send' : 'file');
  const runs = (a.triggers ?? []).length ? `<dt>Runs</dt><dd class="trigs">${(a.triggers ?? []).map((t, i) => `<span class="trig">${icon(icoFor(t.kind))}${esc(trig[i])}</span>`).join('')}</dd>` : '';
  const pauseBtn = a.paused ? btn('Resume', `data-cmd="resumeAgent" data-arg="${esc(a.name)}" title="Let ${esc(a.name)} wake on its schedule and triggers again"`, 'secondary', 'play') : (a.triggers ?? []).length ? btn('Pause', `data-cmd="pauseAgent" data-arg="${esc(a.name)}" title="Skip ${esc(a.name)}'s scheduled and event wakes. A task you give it still runs."`, 'secondary', 'stop') : '';
  return `<div class="agent ${a.paused ? 'paused' : ''}"><div class="agent-top">${avatar(a.name, a.paused ? 'idle' : a.state === 'running' ? 'working' : a.state === 'waiting' ? 'waiting' : 'idle', 26)}<a class="agent-name" href="#" data-open="${esc(a.file)}" title="Edit ${esc(a.file)}: its instructions, schedule and skills">${esc(a.name)}</a>
    <span class="chip ${tone}">${icon(a.paused ? 'stop' : a.state === 'running' ? 'spin' : a.state === 'waiting' ? 'bell' : 'dot')}<span>${label}</span></span></div>
    <dl class="kv">${runs}
    <dt>Next</dt><dd>${a.paused ? '<span class="muted">paused</span>' : a.next ? stamp(a.next.toISOString(), when(a.next.toISOString())) : '<span class="muted">when you give it a task or a trigger fires</span>'}</dd>
    ${lw ? `<dt>Last check</dt><dd>${last}</dd>` : ''}${a.model ? `<dt>Model</dt><dd class="mono">${esc(a.model)}</dd>` : ''}</dl>${latestLine(out)}
    <div class="agent-actions">${btn('Chat', `data-agent="${esc(a.name)}" title="Open the conversation with ${esc(a.name)}"`, 'secondary', 'send')}${btn('Run now', `data-cmd="runAgent" data-arg="${esc(a.name)}"${copilotOff ? ' disabled title="Sign in to GitHub Copilot first"' : ` title="Give ${esc(a.name)} a task now"`}`, 'secondary', 'send')}${pauseBtn}</div></div>`;
}


/** What a brand-new user sees: a way forward, not a note about config files. */
const getStartedCard = (off = false) => `<div class="start-wrap"><div class="start-head">${icon('bot', 'big')}<div class="empty-title">Set up your first mate</div>
  <div class="muted">A mate does a job for you on its own and only stops to ask when it needs you.</div></div>
  <ol class="steps"><li><b>Add</b> a starter below, or say what you want.</li><li><b>Check</b> it: we confirm it can run, before it ever does.</li><li><b>Start</b> the mates <button class="btn secondary" disabled title="Becomes available once you have a mate">Start mates</button> <span class="muted">(appears at the top once you have a mate)</span> You decide anything risky; they never do it alone.</li></ol>
  <div class="starters">
    <div class="starter"><div class="starter-title">Daily report</div><div class="muted">Every weekday at 09:00 it reads yesterday's commits and writes a one-page summary: what changed, and what is risky.</div><div class="muted tiny">Writes <code>.loop/outbox/daily-report/&lt;date&gt;.md</code>. Reads only; needs no setup.</div>${btn('Add this', 'data-cmd="getStarted" data-arg="daily-report"' + (off ? ' disabled title="Sign in to GitHub Copilot first"' : ''), 'primary', 'play')}</div>
    <div class="starter"><div class="starter-title">Folder watch</div><div class="muted">Every 10 minutes it checks <code>drop/</code> for new files, at no model cost, and summarises each one when it finds some.</div><div class="muted tiny">Shows how a cheap pre-check works. Writes summaries to <code>.loop/outbox/folder-watch/</code>.</div>${btn('Add this', 'data-cmd="getStarted" data-arg="folder-watch"' + (off ? ' disabled title="Sign in to GitHub Copilot first"' : ''), 'primary', 'play')}</div>
    <div class="starter"><div class="starter-title">Your own</div><div class="muted">Tell the <code>@mate</code> assistant in Chat what you want in plain words. It builds the agent and checks it can run.</div><div class="muted tiny">For example: watch my build every hour and ask me before it re-runs anything.</div>${btn('Describe what you want', 'data-cmd="describeAgent"', 'secondary', 'send')}</div>
  </div>${off ? '<div class="alert warn" role="alert">' + icon('alert') + '<span>The Add buttons are off because GitHub Copilot is not signed in. Sign in to Copilot in VS Code (Accounts menu, bottom left), then they work.</span></div>' : ''}<div class="muted tiny center">When a mate needs you, it appears here with the exact command it wants to run, and VS Code shows a notification. Agents use your GitHub Copilot models, so Copilot must be signed in.</div></div>`;

/** `hint` is trusted markup: callers pass only fixed strings. */
const empty = (ic: string, title: string, hint: string) => `<div class="empty">${icon(ic, 'big')}<div class="empty-title">${esc(title)}</div><div class="muted">${hint}</div></div>`;


const DELIVERY: Record<string, string> = { start: 'read when the run started', turn: 'read at its next step', resume: 'read when it resumed', task: 'started a run' };
const toneOf = (t: Tone) => (t === 'mute' ? 'mute' : t);


const stepLi = (s: ThreadStep) => `<li class="step ${s.ok ? '' : 'bad'}"><span class="node">${icon(s.ok ? 'dot' : 'x')}</span><div class="grow"><div class="step-title"><span class="mono small">${esc(s.title)}</span></div>${s.detail && !/^(\[exit 0\]|ok)$/.test(s.detail) ? `<div class="${s.ok ? 'muted' : 'result-bad'} small wrap-text">${esc(s.detail)}</div>` : ''}</div></li>`;
const badWord = (s: ThreadStep) => (/^REFUSED/.test(s.detail ?? '') ? 'refused' : /^ERROR/.test(s.detail ?? '') ? 'error' : 'failed');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What a folded group of routine calls says in one line: "loop-memory ×4 · read 2 files". */
function groupLine(g: ThreadStep[]): string {
  if (g.length === 1) { return g[0].phrase; }
  const skills = new Map<string, number>();
  let reads = 0, lists = 0;
  for (const s of g) {
    if (s.famKind === 'read') { reads++; } else if (s.famKind === 'list') { lists++; } else { skills.set(s.fam ?? s.phrase, (skills.get(s.fam ?? s.phrase) ?? 0) + 1); }
  }
  return [...[...skills].map(([k, n]) => `${k} ×${n}`), ...(reads ? [plural(reads, 'file', 'files').replace(/^/, 'read ')] : []), ...(lists ? [`listed ${plural(lists, 'folder', 'folders')}`] : [])].join(' · ');
}

/**
 * Tool calls as quiet lines. Consecutive routine calls (skill scripts, reads, listings) fold into one line; every other call is one line.
 * A refused or failed call is never folded away: it stays visible, with its full result, and the line counts it in the warning colour.
 */
function stepsBlock(steps: ThreadStep[], ts: string): string {
  const segs: ThreadStep[][] = [];
  for (const s of steps) {
    const last = segs[segs.length - 1];
    if (s.routine && last && last[0].routine) { last.push(s); } else { segs.push([s]); }
  }
  return segs.map((g, i) => {
    const bad = g.filter(s => !s.ok), good = g.filter(s => s.ok);
    const word = bad.length ? [...new Set(bad.map(badWord))].join('/') : '';
    const tag = bad.length ? `<span class="bad-count">· ${bad.length} ${esc(word)}</span>` : '';
    const text = groupLine(g);
    const full = g.map(s => s.title).join('\n');
    const wraps = !g[0].routine && /^(handed|asked)/.test(g[0].phrase);
    const head = `<span class="steps-sum ${wraps ? 'wrap-text' : 'ell'}" title="${esc(full)}">${esc(text)}</span>${tag}`;
    const body = g.filter(s => s.ok || good.length).map(stepLi).join('');
    const line = good.length
      ? `<details class="msg steps" data-k="st-${esc(ts)}-${i}"><summary>${icon('chevron', 'chev')}${head}</summary><ol class="timeline">${body}</ol></details>`
      : g.length > 1 ? `<div class="msg steps flat"><span class="chev-pad"></span>${head}</div>` : '';
    const shown = bad.map(s => `<div class="msg steps badcall" title="${esc(s.title)}"><span class="node">${icon('x')}</span><div class="grow"><div class="small"><span class="steps-sum">${esc(s.phrase)}</span>${g.length === 1 ? ' <span class="bad-count">· ' + esc(badWord(s)) + '</span>' : ''}</div>${s.detail ? `<div class="result-bad small wrap-text">${esc(s.detail)}</div>` : ''}</div></div>`).join('');
    return line + shown;
  }).join('');
}

function threadEvent(e: ThreadEvent, agent: string): string {
  if (e.kind === 'human') {
    const seen = e.status === 'pending' ? `waiting for ${esc(agent)} to read it` : esc(DELIVERY[e.via ?? ''] ?? 'read');
    return `<div class="msg human"><div class="bubble"><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))} · ${seen}</div></div></div>`;
  }
  if (e.kind === 'answer') {
    return `<div class="msg human"><div class="bubble answer ${e.tone}"><div class="mkind">You answered “${esc(clip(e.title, 80))}”</div><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))}</div></div></div>`;
  }
  if (e.kind === 'agent') {
    return `<div class="msg bot">${avatar(agent, 'idle', 28)}<div class="bubble"><div class="mtext">${esc(e.text)}</div><div class="mmeta">${stamp(e.ts, whenShort(e.ts))}</div></div></div>`;
  }
  if (e.kind === 'steps') { return stepsBlock(e.steps, e.ts); }
  if (e.kind === 'result') {
    const inner = e.fold.map(f => threadEvent(f, agent)).join('');
    const stepPhrases = e.fold.flatMap(f => (f.kind === 'steps' ? f.steps.map(x => x.phrase) : [])).filter(Boolean);
    const gist = [...new Set(stepPhrases)].slice(0, 2).map(x => clip(x, 38)).join(' · ');
    const label = e.stepCount ? `Show ${plural(e.stepCount, 'step', 'steps')}` : 'Show details';
    const fold = inner ? `<details class="rfold" data-k="rf-${esc(e.chainId)}-${esc(e.ts)}"><summary>${icon('chevron', 'chev')}<span class="fold-label">${esc(label)}</span>${gist ? `<span class="fold-gist">${esc(gist)}</span>` : ''}</summary><div class="rfold-body">${inner}</div></details>` : '';
    const foldSteps = e.fold.flatMap(f => (f.kind === 'steps' ? f.steps : []));
    const refusals = refusalsOf({ agent, steps: foldSteps }, true);
    const pr = e.problems, probs = [pr.refused ? `${pr.refused} refused` : '', pr.error ? `${pr.error} error${pr.error === 1 ? '' : 's'}` : '', pr.failed ? `${pr.failed} failed` : ''].filter(Boolean).join(' · ');
    if (e.status === 'nothing_to_do') {
      return `<div class="rquiet" data-result="nothing_to_do"><div class="rtop"><span class="chip mute">${esc(e.label)}</span>${e.detail ? `<span class="rgoal ell" title="${esc(e.detail)}">${esc(e.detail)}</span>` : '<span class="rgoal"></span>'}<span class="stime nowrap">${stamp(e.ts, whenShort(e.ts))}</span></div>${probs ? `<div class="rprob">${esc(probs)}</div>` : ''}${refusals}${fold}</div>`;
    }
    // Files first: the declared deliverables, or (when it declared none) the first few files it wrote.
    const sf = shownFiles(e.deliverables.map(d => d.path), e.supporting);
    const sup = sf.rest.length ? `<details class="rsup" data-k="rs-${esc(e.chainId)}-${esc(e.ts)}"><summary>${icon('chevron', 'chev')}<span>${plural(sf.rest.length, 'supporting file', 'supporting files')}</span></summary><div class="rfiles">${sf.rest.map(o => `<a class="filechip" href="#" data-open="${esc(o)}" title="${esc(o)}">${icon('file')}<span class="ell">${esc(o)}</span></a>`).join('')}</div></details>` : '';
    const files = sf.rows.map(p => delivRow(e.deliverables.find(d => d.path === p) ?? { path: p })).join('');
    const line = (k: string, v: string) => `<div class="rline wrap-text"><span class="rk">${esc(k)}</span> ${esc(v)}</div>`;
    return `<div class="rcard ${esc(e.status)} ${toneOf(e.tone)}" data-result="${esc(e.status)}"><div class="rtop"><span class="chip ${toneOf(e.tone)}">${esc(e.label)}</span>${e.goal ? `<span class="rgoal ell" title="${esc(e.goal)}">${esc(e.goal)}</span>` : '<span class="rgoal"></span>'}<span class="stime nowrap">${stamp(e.ts, whenShort(e.ts))}</span></div>`
      + (e.detail ? `<div class="rsum wrap-text">${esc(e.detail)}</div>` : '')
      + (e.next ? line('Next:', e.next) : '') + (e.handoff ? line(`Handed to ${e.handoff.to}:`, e.handoff.task) : '')
      + (e.approvals ?? []).map(a => line('Approved:', a)).join('')
      + (files ? `<div class="rdelivs">${files}</div>` : '') + sup + (probs ? `<div class="rprob">${esc(probs)}</div>` : '') + refusals + fold + '</div>';
  }
  const outs = (e.outputs ?? []).map(o => `<a class="filechip" href="#" data-open="${esc(o)}">${icon('file')}${esc(o)}</a>`).join('');
  return `<div class="sline"><span class="chip ${toneOf(e.tone)}">${esc(e.label)}</span>${e.detail ? `<span class="sdetail wrap-text">${esc(e.detail)}</span>` : ''}${outs}<span class="stime nowrap">${stamp(e.ts, whenShort(e.ts))}</span></div>`;
}

function composerHint(name: string, state: ChatState, running: boolean): string {
  switch (state) {
    case 'running': return `${name} reads this at its next step.`;
    case 'waiting': return '';
    case 'queued': return `${name} has work queued and reads this when it starts.${running ? '' : ' The mates are off.'}`;
    default: return running ? '' : 'The mates are off. This is saved, and runs when you start them.';
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

/** Today, Yesterday, or the weekday and date. */
function dayLabel(d: Date, now = new Date()): string {
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day(now) - day(d)) / 86_400_000);
  return diff === 0 ? 'Today' : diff === 1 ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

/** What wakes this mate, in words: it is the first thing a person wants to know about it. */
function chatFacts(sel: ChatModel['agents'][number]): string {
  const t = (sel.triggers ?? []).map(x => x.kind === 'schedule' ? plainCron(x.text) : x.kind === 'webhook' ? `webhook “${x.text}”` : `new files in ${x.text}`);
  return `<div class="muted ch-facts">${sel.paused ? '<b>Paused</b> · ' : ''}${t.length ? `Runs ${esc(t.join(' · '))}` : 'Runs only when you give it a task'}${sel.file ? ` · <a class="link" href="#" data-open="${esc(sel.file)}" title="Open ${esc(sel.file)}: its instructions, schedule and skills">Edit file</a>` : ''}</div>`;
}

/** The few things a person does to a mate, one click from its conversation. */
function chatActions(sel: ChatModel['agents'][number], copilotOff: boolean): string {
  const n = esc(sel.name);
  const btns = [
    btn('Run now', `data-cmd="runAgent" data-arg="${n}"${copilotOff ? ' disabled title="Sign in to GitHub Copilot first"' : ` title="Give ${n} a task now"`}`, 'secondary', 'send'),
    (sel.triggers ?? []).length || sel.paused ? (sel.paused ? btn('Resume', `data-cmd="resumeAgent" data-arg="${n}" title="Wake ${n} on its schedule and triggers again"`, 'secondary', 'play') : btn('Pause', `data-cmd="pauseAgent" data-arg="${n}" title="Skip ${n}'s scheduled and event wakes. A task you give it still runs."`, 'secondary', 'stop')) : '',
  ].join('');
  return `<div class="ch-actions" role="group" aria-label="Actions for ${n}">${btns}</div>`;
}

function renderChat(m: ConsoleModel): string {
  const c = m.chat!;
  if (!c.agents.length) { return getStartedCard(m.copilot === 0); }
  const sel = c.agents.find(a => a.name === c.selected)!;
  const list = c.agents.map(a => `<button class="roster-row ${a.name === sel.name ? 'on' : ''}" data-agent="${esc(a.name)}" aria-pressed="${a.name === sel.name}" title="${esc(a.name)} is ${AVATAR_TITLE[a.avatar]}: ${esc(a.line)}">${avatar(a.name, a.avatar)}`
    + `<span class="rr-main"><span class="rr-top"><span class="rr-name">${esc(a.name)}</span>${a.at ? `<span class="muted rr-time">${stamp(a.at, whenShort(a.at))}</span>` : ''}</span><span class="rr-line ${a.avatar === 'waiting' ? 'warn' : a.avatar === 'blocked' ? 'bad' : 'muted'}">${esc(a.line)}</span></span>`
    + `${a.needsYou ? `<span class="count warn" title="needs you">${a.needsYou}</span>` : a.pendingMessages ? '<span class="unread" title="your message has not been read yet"></span>' : ''}</button>`).join('');
  let lastDay = '';
  const events = c.events.map(e => {
    const ts = 'ts' in e ? String((e as { ts?: string }).ts ?? '') : '';
    const d = ts ? new Date(ts) : undefined;
    const key = d && !isNaN(d.getTime()) ? d.toDateString() : '';
    const sep = key && key !== lastDay ? `<div class="daysep"><span>${esc(dayLabel(d!))}</span></div>` : '';
    if (key) { lastDay = key; }
    const tone = e.kind === 'result' ? e.tone : undefined;
    const av: AvatarState = tone === 'ok' ? 'done' : tone === 'warn' || tone === 'bad' ? 'blocked' : 'idle';
    return sep + (e.kind === 'result' ? `<div class="turn"><span class="turn-av">${avatar(sel.name, av, 26)}</span>${threadEvent(e, sel.name)}</div>` : threadEvent(e, sel.name));
  }).join('');
  const liveRun = m.runs.find(r => r.agent === sel.name && r.status === 'running');
  const working = sel.state === 'running' ? `<div class="turn working" role="status"><span class="turn-av">${avatar(sel.name, 'working', 26)}</span><div class="working-text">${icon('spin', 'spin')}<span><b>${esc(sel.name)}</b> is working: ${esc(sel.line)}${liveRun ? ` <span class="muted">· ${esc(span(liveRun.started, new Date().toISOString()))} · step ${liveRun.step}</span>` : ''}</span></div></div>` : '';
  // Everything waiting on the person, in one place at the end of the thread: the first question or approval is handled through the
  // composer below; the ones after it wait their turn; blocked commands carry their own Allow and Dismiss.
  const blocked = c.blocked ?? [];
  const todo = c.gates.length + blocked.length;
  const first = c.gates[0];
  const todoWord = todo === 1 ? (first ? (first.kind === 'approval' ? 'asks for your approval' : 'has a question for you') : 'was blocked from running a command') : `needs ${todo} decisions from you`;
  const gates = todo ? `<div class="thread-gates"><div class="turn gates-head"><span class="turn-av">${avatar(sel.name, 'waiting', 26)}</span><div class="gh-text"><b>${esc(sel.name)}</b> ${todoWord}</div></div>${c.gates.map((g, i) => (i === 0 ? gateCard(g, !!m.firstApproval) : gateQueued(g))).join('')}${blocked.map(blockedCard).join('')}</div>` : '';
  const empty0 = !c.events.length && !todo ? empty('send', `Nothing yet with ${sel.name}`, 'Say what you want below. If it is idle, this starts a run; if it is working, it will read it at its next step.') : '';
  const running = sel.state === 'running';
  return `<div class="chat">
    <nav class="roster" aria-label="Agents">${list}</nav>
    <section class="chat-main" aria-label="Conversation with ${esc(sel.name)}">
      <header class="chat-head">${avatar(sel.name, sel.avatar, 34)}<div class="grow"><div class="ch-name">${esc(sel.name)}</div><div class="muted ch-sub" title="${esc(sel.line)}">${esc(STATE_LABEL[sel.state])}${sel.state === 'running' ? ` · ${esc(sel.line)}` : ''}</div>${chatFacts(sel)}${latestLine(m.outputs?.[sel.name])}</div>${chatActions(sel, m.copilot === 0)}</header>
      <div class="thread" data-thread="${esc(sel.name)}" tabindex="0" aria-live="polite">${todo ? `<button class="pinned" data-jump=".thread-gates" title="Scroll to what ${esc(sel.name)} is asking">${icon('bell')}<span><b>${esc(sel.name)}</b> is waiting for you: ${esc(clip(first ? first.title : `blocked: ${blocked[0].command}`, 60))}${todo > 1 ? ` and ${todo - 1} more` : ''}</span><span class="pin-go">Jump</span></button>` : ''}${c.hidden ? `<div class="muted center">${c.hidden} earlier event${c.hidden === 1 ? '' : 's'} not shown</div>` : ''}${events}${empty0}${working}${gates}</div>
      <div class="composer ${running ? 'running' : ''}">${composerHint(sel.name, sel.state, m.running) ? `<div class="muted hint">${esc(composerHint(sel.name, sel.state, m.running))}</div>` : ''}
        <div class="inputbar"><textarea rows="1" data-input="chat:${esc(sel.name)}" data-chat-input="${esc(sel.name)}"${first ? ` data-${first.kind === 'question' ? 'answer' : 'approval'}-for="${esc(first.id)}"` : ''} aria-label="${first ? (first.kind === 'question' ? `Your answer to ${esc(sel.name)}` : 'Reason if you reject (optional)') : `Message ${esc(sel.name)}`}" placeholder="${esc(first ? (first.kind === 'question' ? `Answer ${sel.name}'s question…` : 'Reason if you reject (optional)…') : `Message ${sel.name}…`)}"></textarea>`
    + `<button class="roundbtn stop" data-chat-cancel="${esc(sel.name)}" title="Stop this run" aria-label="Stop this run">${icon('stop')}<span class="stoplabel">Stop</span></button>`
    + `<button class="roundbtn send" data-chat-send="${esc(sel.name)}"${first?.kind === 'approval' ? ' disabled title="Use Approve or Reject above"' : ' title="Send"'} aria-label="Send">${icon('up')}</button></div>
        <div class="chips-row" role="group" aria-label="Shortcuts">${!running && sel.state !== 'waiting' ? `<button class="chip-btn" data-insert="What did you do last, and what is next?" title="Ask for a quick status">ask for status</button>` : ''}${c.agents.filter(x => x.name !== sel.name).slice(0, 2).map(x => `<button class="chip-btn" data-insert="@${esc(x.name)} " title="Write to ${esc(x.name)} from here">@${esc(x.name)}</button>`).join('')}${running ? '<button class="chip-btn" data-insert="/stop" title="End the current run">/stop</button>' : ''}</div></div>
    </section></div>`;
}

function renderTabs(m: ConsoleModel): string {
  const tab = (id: string, label: string, extra = '') => `<button role="tab" class="tab ${m.tab === id ? 'on' : ''}" aria-selected="${m.tab === id}" data-tab="${id}" title="${id === 'chat' ? 'Talk to a mate, answer it, see what it did' : 'Everything at a glance: what needs you, tasks, runs and all mates'}"><span class="tab-main">${label}${extra}</span><span class="tab-sub">${id === 'chat' ? 'talk to a mate' : 'all mates and runs'}</span></button>`;
  const n = m.pending.length + (m.blocked ?? []).length;
  const needs = n ? `<span class="count warn" title="needs you">${n}</span>` : '';
  return `<nav class="tabs" role="tablist">${tab('chat', 'Chat', needs)}${tab('overview', 'Overview')}</nav>`;
}

/** Console body (the part that is re-rendered when data changes). */
export function renderBody(m: ConsoleModel): string {
  const live = m.runs.find(r => r.status === 'running' && isActive(m.active, r.agent));
  const blocked = m.blocked ?? [];
  // Everything waiting on the person counts once, wherever it is shown: questions, approvals and blocked commands.
  const todos = m.pending.length + blocked.length;
  const firstAgent = m.pending[0]?.agent ?? blocked[0]?.agent;
  const nextRun = m.next ? ` · next run ${esc(when(m.next.at))}` : '';
  const state = todos ? `<button class="state wait" data-agent="${esc(firstAgent!)}" title="Open the conversation with ${esc(firstAgent!)}, who is waiting for you">${icon('bell')}${todos} waiting on you${m.running && m.active ? ` · ${esc([m.active].flat().join(', '))} running` : ''}</button>`
    : !m.running ? `<span class="state off">${icon('stop')}Mates off</span>`
    : m.active ? `<span class="state on">${icon('spin', 'spin')}Running · ${esc([m.active].flat().join(', '))}${live && !Array.isArray(m.active) ? ` · step ${live.step}` : ''}</span>`
    : `<span class="state idle">${icon('check')}All good${m.next ? nextRun : ' · nothing scheduled'}</span>`;
  // A brand-new workspace gets only the way forward: no tabs, no team controls that would do nothing.
  const hasAgents = m.agents.length > 0 || m.runs.length > 0 || todos > 0 || (m.tasks ?? []).length > 0;
  const latest = m.latest ? btn(`Latest: ${clip(m.latest.agent, 24)} · ${clip(baseName(m.latest.path), 32)}`, `data-open="${esc(m.latest.path)}" title="Open ${esc(m.latest.path)}, the newest file a mate produced"`, 'secondary', 'file') : '';
  const actions = !hasAgents ? '' : (m.running ? '' : btn('Start mates', 'data-cmd="startTeam" title="Start every mate: schedules and triggers begin, queued work runs"', 'primary', 'play'))
    + btn('Give a mate a task', 'data-cmd="runAgent" title="Pick a mate and give it a one-off task now"', 'secondary', 'send') + latest;
  // One line per to-do. Handling it happens in that mate's Chat, where the one input box is.
  const needs = todos ? `<div class="needlist">${[...m.pending.map(g => needRow(g.kind === 'question' ? 'Question' : 'Approval', g.title, g.agent, g.createdAt)), ...blocked.map(b => needRow('Blocked', `${b.agent} was blocked: ${clip(b.command, 70)}`, b.agent, b.at))].join('')}</div>` : empty('check', 'Nothing is waiting for you', 'Questions, approvals and blocked commands from mates show up here.');
  const DECIDED: Record<string, string> = { executed: 'Approved, ran', failed: 'Approved, failed', rejected: 'Rejected', answered: 'Answered' };
  const decisions = (m.decisions ?? []).length ? `<details class="decisions"><summary>${icon('chevron', 'chev')}<span>Recent decisions</span><span class="count">${m.decisions!.length}</span><span class="muted ell grow">Last: ${esc(DECIDED[m.decisions![0].status] ?? m.decisions![0].status)} · ${esc(m.decisions![0].title)}</span></summary><ul>${m.decisions!.map(d => `<li><span class="chip ${d.status === 'failed' ? 'bad' : d.status === 'rejected' ? 'mute' : 'ok'}">${esc(DECIDED[d.status] ?? d.status)}</span><span class="grow ell" title="${esc(d.title)}">${esc(d.title)}</span><span class="tag">${esc(d.agent)}</span><span class="muted nowrap">${stamp(d.at, ago(d.at))}</span></li>`).join('')}</ul></details>` : '';
  const tasks = m.tasks ?? [];
  const openTasks = tasks.length ? `<h2>Tasks in progress<span class="count">${tasks.length}</span></h2>${tasks.map(taskCard).join('')}` : '';
  const problems = m.runs.filter(r => PROBLEMS.has(r.status)).length;
  const filter = m.runs.length ? `<label class="filter"><span class="muted">Show</span><select data-filter aria-label="Filter runs"><option value="all">All runs (${m.runs.length})</option><option value="problems">Problems (${problems})</option><option value="done">Done</option></select></label>` : '';
  const runs = m.runs.length ? `<div class="runs">${m.runs.map(r => runCard(r, blocked.filter(b => b.chainId === r.chainId))).join('')}</div><div class="empty hidden" data-filter-empty>No runs match this filter.</div>`
    : empty('clock', 'No runs yet', 'Press Start mates, or use “Give a task” to run a mate now.');
  const agents = m.agents.length ? m.agents.map(a => agentRow(a, m.copilot === 0, m.outputs?.[a.name])).join('')
    : getStartedCard(m.copilot === 0);
  const stoppedWithWork = !m.running && todos > 0;
  const stoppedNote = stoppedWithWork ? `<div class="alert warn" role="status">${icon('alert')}<span><b>Nothing will run until you press Start mates.</b></span></div>` : '';
  const item = (cmd: string, title: string, sub: string, kind = '') => `<button class="menuitem ${kind}" data-cmd="${cmd}"><span class="mi-title">${esc(title)}</span><span class="mi-sub">${esc(sub)}</span></button>`;
  const tools = hasAgents ? `<div class="tabrow">${renderTabs(m)}<details class="toolmenu"><summary class="btn secondary" aria-haspopup="menu"><span>Check &amp; tools</span><span class="caret" aria-hidden="true"></span></summary><div class="menu" role="menu">${m.running ? item('stopTeam', 'Stop all mates', 'Nothing new runs until you press Start mates. Work in progress is kept') : ''}${item('runDoctor', 'Check mates', 'Confirm every mate can run, and run their pre-checks once')}${item('showHealth', 'Health report', 'How each mate has been doing, and what to improve')}${item('getStarted', 'Add a mate', 'Start from a ready-made mate, or describe one')}${item('cleanUp', 'Clean up', 'Delete finished work you no longer need. Asks first')}<div class="mi-foot">Or ask <code>@mate</code> in Chat for anything here.</div></div></details></div>` : '';
  const copilotChip = m.copilot === undefined ? '' : m.copilot > 0 ? `<span class="chip ok" title="${m.copilot} Copilot model${m.copilot > 1 ? 's' : ''} available">${icon('check')}<span>Copilot ready</span></span>` : `<span class="chip warn">${icon('alert')}<span>Copilot not signed in</span></span>`;
  const copilotNote = m.copilot === 0 ? `<div class="alert warn" role="alert">${icon('alert')}<span><b>GitHub Copilot is not signed in.</b> Agents use your Copilot models, so none can run until you sign in to GitHub Copilot in VS Code (Accounts menu, bottom left).</span></div>` : '';
  const note = m.note ? `<div class="alert ${m.note.tone}" role="alert">${icon(m.note.tone === 'bad' ? 'x' : 'alert')}<span>${esc(m.note.text)}</span></div>` : '';
  return `<header class="bar"><div class="brand">Harbor Mate Console</div>${state}${copilotChip}<span class="grow"></span><span class="muted updated">Updated <time data-updated datetime="${esc(m.updatedAt)}">${esc(new Date(m.updatedAt).toLocaleTimeString())}</time></span><div class="row">${actions}</div></header>
    ${note}${hasAgents ? copilotNote : ''}${stoppedNote}${tools}${m.tab === 'chat' && m.chat ? renderChat(m) : `<div class="cols"><main><h2>Needs you${todos ? `<span class="count warn">${todos}</span>` : ''}</h2>${needs}
    ${decisions}${openTasks}<h2>Recent runs<span class="grow"></span>${filter}</h2>${runs}</main><aside><h2>Mates</h2>${agents}</aside></div>`}`;
}

const STYLE = `
:root{--warn-text:color-mix(in srgb,var(--vscode-editorWarning-foreground,var(--vscode-charts-orange)) 62%,var(--vscode-foreground));--gap:12px;--r:6px;--ok:var(--vscode-testing-iconPassed,var(--vscode-charts-green));--bad:var(--vscode-errorForeground,var(--vscode-charts-red));--warn:var(--vscode-editorWarning-foreground,var(--vscode-charts-orange));--info:var(--vscode-charts-blue);--cb:var(--vscode-contrastBorder,transparent);--cab:var(--vscode-contrastActiveBorder,var(--vscode-focusBorder))}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 32px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);line-height:1.45}
.mono,code,pre{font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.start-wrap{margin-top:12px;padding:24px 20px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);display:flex;flex-direction:column;gap:16px}.start-head{display:flex;flex-direction:column;align-items:center;gap:4px;text-align:center}.start-head .empty-title{font-size:1.25em}.steps{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px 18px;margin:0;padding:0;list-style:none;counter-reset:s}.steps li{counter-increment:s;display:block;position:relative;padding:3px 0 3px 36px;min-height:30px;line-height:1.5;font-size:1.02em}.steps li:before{content:counter(s);position:absolute;left:0;top:3px;flex:none;width:24px;height:24px;border-radius:50%;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);display:inline-flex;align-items:center;justify-content:center;font-size:.85em}.starters{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}.starter{display:flex;flex-direction:column;gap:6px;padding:14px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);background:var(--vscode-sideBar-background)}.starter .btn{margin-top:auto;align-self:flex-start}.starter .tiny{margin:0}.starter-title{font-weight:600;font-size:1.05em}.hintbox{display:flex;gap:8px;align-items:flex-start;padding:8px 10px;margin:0 0 8px;border-radius:var(--r);background:var(--vscode-textCodeBlock-background);border-left:3px solid var(--info)}.hintbox.warn{border-left-color:var(--warn)}.hintbox .ic{flex:none;margin-top:2px}.decisions{margin:10px 0 4px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:6px 10px}.decisions summary{cursor:pointer;display:flex;gap:8px;align-items:center;list-style:none}.decisions ul{list-style:none;margin:8px 0 2px;padding:0;display:flex;flex-direction:column;gap:6px}.decisions li{display:flex;gap:8px;align-items:center;min-width:0}.ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.toolmenu{position:relative;margin-bottom:6px}.toolmenu[open]::before{content:'';position:fixed;inset:0;background:rgba(0,0,0,.28);z-index:4}.toolmenu>summary{position:relative;z-index:6}.toolmenu>summary{list-style:none;cursor:pointer;display:inline-flex;gap:6px;align-items:center}.toolmenu>summary::-webkit-details-marker{display:none}.toolmenu>summary .caret{width:0;height:0;border-left:4px solid transparent;border-right:4px solid transparent;border-top:5px solid currentColor;margin-top:1px}.toolmenu[open]>summary .caret{transform:rotate(180deg)}.menu{position:absolute;right:0;top:calc(100% + 4px);z-index:5;min-width:320px;padding:6px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);background:var(--vscode-editor-background);box-shadow:0 6px 18px rgba(0,0,0,.35);display:flex;flex-direction:column;gap:2px}.menuitem{all:unset;box-sizing:border-box;display:flex;flex-direction:column;gap:1px;padding:7px 10px;border-radius:4px;cursor:pointer}.menuitem:hover,.menuitem:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder)}.mi-title{font-weight:600}.mi-sub{color:var(--vscode-descriptionForeground);font-size:.9em}.menuitem.danger .mi-title{color:var(--bad)}.mi-foot{padding:6px 10px 2px;color:var(--vscode-descriptionForeground);font-size:.9em;border-top:1px solid var(--vscode-panel-border);margin-top:4px}.tabrow{display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap}.tabrow .tabs{flex:1}.tools{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:0 0 6px}.tools .btn{padding:3px 9px;font-size:.92em}.tools-label{font-size:.8em;text-transform:uppercase;letter-spacing:.05em;margin-right:4px}.agent-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.agent-actions .btn{padding:3px 9px;font-size:.92em}.agent.paused{opacity:.75}.trigs{display:flex;flex-direction:column;gap:2px}.trig{display:inline-flex;gap:5px;align-items:center}.trig .ic{width:12px;height:12px;flex:none}.iconbtn{padding:4px 8px}.btn[disabled]{opacity:.5;cursor:not-allowed}.run-sum{white-space:normal!important;display:-webkit-box!important;-webkit-line-clamp:2;-webkit-box-orient:vertical}.tools-help{font-size:.92em;margin:8px 2px 4px}.tools-help b{font-weight:600}.alert .btn{margin-left:auto}.pinned{all:unset;box-sizing:border-box;position:sticky;top:-16px;z-index:2;margin:-16px -16px 4px;padding:8px 16px;display:flex;gap:8px;align-items:center;cursor:pointer;background:color-mix(in srgb,var(--warn) 16%,var(--vscode-editor-background));border-bottom:1px solid color-mix(in srgb,var(--warn) 50%,transparent)}.pinned .pin-go{margin-left:auto;font-weight:600;color:var(--vscode-textLink-foreground)}.pinned:focus-visible{outline:1px solid var(--vscode-focusBorder)}.ch-facts{font-size:.88em;margin-top:2px}.ch-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.ch-actions .btn{padding:3px 9px;font-size:.92em}.chips-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:6px 6px 0}.chip-btn{all:unset;box-sizing:border-box;cursor:pointer;padding:2px 9px;border-radius:999px;border:1px solid var(--vscode-panel-border);color:var(--vscode-textLink-foreground);font-size:.88em}.chip-btn:hover,.chip-btn:focus-visible{background:var(--vscode-list-hoverBackground);outline:1px solid var(--vscode-focusBorder)}.tab-main{display:inline-flex;gap:6px;align-items:center}.tab-sub{display:block;font-size:.78em;color:var(--vscode-descriptionForeground);font-weight:400}.tabs .tab{line-height:1.25}.state.wait{all:unset;box-sizing:border-box;cursor:pointer;display:inline-flex;gap:6px;align-items:center;padding:3px 10px;border-radius:999px;border:1px solid color-mix(in srgb,var(--warn) 70%,transparent);color:var(--warn-text);font-weight:600;font-size:.92em}.state.wait:hover,.state.wait:focus-visible{background:color-mix(in srgb,var(--warn) 16%,transparent);outline:1px solid var(--vscode-focusBorder)}.btn.ready{box-shadow:0 0 0 2px var(--vscode-focusBorder)}.turn{position:relative}.turn.working{padding:0 2px 0 38px;min-height:30px;display:flex;align-items:center}.turn.working .turn-av{top:2px}.working-text{display:flex;gap:8px;align-items:center}.gates-head{padding:4px 0 6px 38px;min-height:32px;display:flex;align-items:center}.gates-head .turn-av{top:2px}.gh-text{font-size:.98em}.rquiet{border-left:3px solid var(--vscode-panel-border)}.turn-av{position:absolute;left:3px;top:3px;display:inline-flex}.rfold>summary,.rsup>summary{color:var(--vscode-foreground);opacity:.82}.rfold>summary:hover,.rsup>summary:hover{opacity:1}.mi-sub,.mi-foot{opacity:.95}.daysep{display:flex;align-items:center;gap:10px;color:var(--vscode-descriptionForeground);font-size:.85em;margin:4px 0}.daysep:before,.daysep:after{content:'';flex:1;border-top:1px solid var(--vscode-panel-border)}.working{display:flex;gap:8px;align-items:center;color:var(--vscode-descriptionForeground);padding:6px 2px}.needs-banner .btn{margin-left:0}.btn.danger{border:1px solid color-mix(in srgb,var(--bad) 60%,transparent)}.btn.danger .ic{color:var(--bad)}.needs-banner span:first-of-type{margin-right:6px}textarea{border:1px solid var(--vscode-input-border,var(--vscode-panel-border))}.muted{color:var(--vscode-descriptionForeground)}.grow{flex:1;min-width:0}.nowrap{white-space:nowrap}.wrap-text{overflow-wrap:anywhere}.hidden{display:none!important}
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
.needlist{display:flex;flex-direction:column;border:1px solid var(--vscode-panel-border);border-left:3px solid var(--warn);border-radius:var(--r);background:var(--vscode-sideBar-background,transparent);margin-bottom:var(--gap)}
.needrow{all:unset;box-sizing:border-box;display:flex;align-items:center;gap:10px;padding:8px 12px;cursor:pointer;min-width:0}.needrow+.needrow{border-top:1px solid var(--vscode-panel-border)}.needrow:hover,.needrow:focus-visible{background:var(--vscode-list-hoverBackground)}.needrow:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}.needrow .lead{margin-top:0}
.card.queued{display:flex;align-items:center;gap:10px;padding:8px 14px;border-left:3px solid var(--warn);opacity:.85}.card.queued .lead{margin-top:0}
.row.actions{justify-content:flex-end;margin-top:10px}.body.brief{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;max-height:none;cursor:pointer}.body.brief.open{-webkit-line-clamp:unset}
.gatefiles{margin-top:10px}.gatefiles>summary{color:var(--vscode-descriptionForeground);padding:2px 0;width:fit-content}.gatefiles>.note{margin:6px 0 0}
.lastout{font-size:.88em;margin-top:2px}.agent .lastout{margin-top:8px}
.run>summary .run-extra{flex-basis:100%;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding-left:26px}.run-extra .deliv{max-width:100%}.run-extra .btn{padding:3px 9px;font-size:.92em}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
@media (max-width:820px){.cols{grid-template-columns:1fr}}
h2{display:flex;align-items:center;gap:8px;margin:22px 0 10px;font-size:.82em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.count{padding:0 7px;border-radius:999px;font-size:.95em;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}.count.warn{background:var(--warn);color:var(--vscode-editor-background)}
.card{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:14px;margin-bottom:var(--gap);background:var(--vscode-sideBar-background,transparent)}
.card.attention{border-left:3px solid var(--warn)}
.card-head{display:flex;gap:10px}.card-title{font-weight:600;font-size:1.05em;overflow-wrap:anywhere}.lead.warn{color:var(--warn-text)}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.88em;color:var(--vscode-descriptionForeground)}.meta>*+*::before{content:"·";margin-right:8px}
.tag{padding:0 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.meta .tag::before{content:none;margin:0}
.body{margin:10px 0;white-space:pre-wrap;overflow-wrap:anywhere;max-height:9em;overflow:auto}.label{margin:12px 0 4px;font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}
.note{margin:8px 0;font-size:.92em;color:var(--vscode-foreground);opacity:.86}
.alert{display:flex;gap:8px;align-items:flex-start;margin:8px 0;padding:8px 10px;border-radius:4px;border:1px solid currentColor}.alert.bad{color:var(--bad)}.alert.info,.alert.warn{color:var(--warn-text)}.alert>span{color:var(--vscode-foreground)}
.code{margin:0 0 6px;padding:10px;border-radius:4px;background:var(--vscode-textCodeBlock-background);white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto}.code.cmd{border-left:3px solid var(--info);flex:1}
.cmdrow{display:flex;gap:6px;align-items:flex-start}
details>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;border-radius:4px}details>summary::-webkit-details-marker{display:none}
.chev{transition:transform .12s}details[open]>summary>.chev{transform:rotate(90deg)}
.file{margin:8px 0}.file>summary{padding:4px 0;color:var(--vscode-descriptionForeground)}
.filechip{display:inline-flex;align-items:center;gap:6px;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:999px;color:var(--vscode-textLink-foreground);text-decoration:none;overflow-wrap:anywhere}.filechip:hover{background:var(--vscode-list-hoverBackground)}
a{color:var(--vscode-textLink-foreground)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:.88em;font-weight:600;white-space:nowrap;border:1px solid currentColor}
.chip.ok{color:var(--ok)}.chip.bad{color:var(--bad)}.chip.warn{color:var(--warn-text)}.chip.info{color:var(--info)}.chip.mute{color:var(--vscode-descriptionForeground)}
.run{border:1px solid var(--vscode-panel-border);border-radius:var(--r);margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.run>summary{padding:10px 12px;flex-wrap:wrap}.run>summary .run-sum{flex:1 1 100px;min-width:100px}.run-why{flex-basis:100%;padding-left:26px;font-size:.88em;color:var(--warn-text)}.run>summary:hover{background:var(--vscode-list-hoverBackground)}.run-agent{font-weight:600}.run-sum{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-body{padding:0 14px 12px 36px}
.timeline{list-style:none;margin:6px 0 10px;padding:0}
.step{display:flex;gap:10px;padding:5px 0;position:relative}.step:not(:last-child)::before{content:"";position:absolute;left:7px;top:22px;bottom:-4px;width:1px;background:var(--vscode-panel-border)}
.node{color:var(--vscode-descriptionForeground);margin-top:1px}.step.bad .node{color:var(--bad)}.result-bad{color:var(--bad)}.step-title{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;overflow-wrap:anywhere}
.kind{font-size:.75em;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground)}
.agent{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:12px;margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.agent-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agent-name{font-weight:600;flex:1;text-decoration:none}.agent-name:hover{text-decoration:underline}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:10px 0 0;font-size:.92em}.kv dt{color:var(--vscode-descriptionForeground)}.kv dd{margin:0;overflow-wrap:anywhere}

.empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px 12px;text-align:center;border:1px dashed color-mix(in srgb,var(--vscode-foreground) 30%,transparent);border-radius:var(--r);color:var(--vscode-descriptionForeground)}.empty-title{color:var(--vscode-foreground);font-weight:600}
.stale{margin:8px 0}.link{font-size:.9em}
.tabs{display:flex;gap:4px;margin:12px 0 0;border-bottom:1px solid var(--vscode-panel-border)}
.tab{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:transparent;color:var(--vscode-descriptionForeground);border:0;border-bottom:2px solid transparent;font:inherit;cursor:pointer}
.tab.on{color:var(--vscode-foreground);border-bottom-color:var(--vscode-focusBorder)}.tab:focus-visible{outline:1px solid var(--vscode-focusBorder)}
.chat{display:grid;grid-template-columns:280px minmax(0,1fr);gap:0;margin-top:12px;height:calc(100vh - 170px);min-height:400px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);overflow:hidden}
@media (max-width:760px){.chat{grid-template-columns:1fr;height:auto}.roster{max-height:220px;border-right:0;border-bottom:1px solid var(--vscode-panel-border)}}
.roster{display:flex;flex-direction:column;overflow:auto;background:var(--vscode-sideBar-background,transparent);border-right:1px solid var(--vscode-panel-border)}
.roster-row{display:flex;align-items:center;gap:12px;padding:10px 14px;text-align:left;background:transparent;color:var(--vscode-foreground);border:0;border-bottom:1px solid var(--vscode-panel-border);font:inherit;cursor:pointer;width:100%}
.roster-row:hover{background:var(--vscode-list-hoverBackground)}.roster-row.on{background:color-mix(in srgb,var(--vscode-list-activeSelectionBackground,var(--vscode-list-hoverBackground)) 45%,transparent);box-shadow:inset 3px 0 0 var(--vscode-focusBorder)}
.roster-row:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:-1px}
.rr-main{display:flex;flex-direction:column;min-width:0;flex:1;gap:2px}.rr-top{display:flex;align-items:baseline;gap:8px}.rr-name{font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rr-time{font-size:.8em;white-space:nowrap}
.rr-line{font-size:.88em;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow-wrap:anywhere}.rr-line.warn{color:var(--warn-text)}.rr-line.bad{color:var(--bad)}
.unread{width:9px;height:9px;border-radius:50%;background:var(--vscode-focusBorder);flex:none}
.av{position:relative;display:inline-flex;flex:none;width:var(--sz);height:var(--sz);border-radius:50%}
.av::after{content:"";position:absolute;inset:-3px;border-radius:50%;border:2px solid transparent;pointer-events:none}
.av.working::after{border-color:var(--info) transparent var(--info) transparent;animation:sp 1.4s linear infinite}
.av.waiting::after{border-color:var(--warn-text);animation:pulse 1.4s ease-in-out infinite}
.av.blocked::after{border-color:var(--bad)}
.av.done::after{border-color:var(--ok)}.av.done::before{content:"✓";position:absolute;right:-4px;bottom:-4px;width:15px;height:15px;border-radius:50%;background:var(--ok);color:var(--vscode-editor-background);font-size:10px;font-weight:700;line-height:15px;text-align:center;z-index:1}
.av.working .pupil{animation:look 1.6s ease-in-out infinite}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.35;transform:scale(1.08)}}@keyframes look{0%,100%{transform:translateX(-1px)}50%{transform:translateX(1px)}}
@media (prefers-reduced-motion:reduce){.av.working::after,.av.waiting::after,.av.working .pupil{animation:none}}
.chat-main{display:flex;flex-direction:column;min-width:0;min-height:0;background:var(--vscode-editor-background)}
.chat-head{display:flex;align-items:center;gap:12px;padding:10px 16px;border-bottom:1px solid var(--vscode-panel-border)}.ch-name{font-weight:600;font-size:1.05em}.ch-sub{font-size:.88em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.thread{flex:1;min-height:0;overflow-y:auto;padding:16px;-webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 16px);mask-image:linear-gradient(to bottom,transparent 0,#000 16px);display:flex;flex-direction:column;gap:12px}.center{text-align:center}
/* A short conversation sits against the input box, so what you are asked and where you answer are never a screen apart. */
.thread>:first-child{margin-top:auto}
.msg{display:flex;gap:10px;max-width:100%}.msg.human{justify-content:flex-end}.msg.bot{justify-content:flex-start;align-items:flex-start}
.bubble{max-width:78%;padding:8px 14px;border-radius:18px;overflow-wrap:anywhere}
.human .bubble{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border-bottom-right-radius:5px}
.human .bubble .mmeta{color:inherit;opacity:.8}.human .bubble.answer{background:var(--vscode-input-background);color:var(--vscode-foreground);border:1px solid var(--cab)}
.bot .bubble{background:var(--vscode-input-background);border-bottom-left-radius:5px}
.mtext{white-space:pre-wrap}.mkind{font-size:.85em;opacity:.8;margin-bottom:2px}.mmeta{font-size:.78em;color:var(--vscode-descriptionForeground);margin-top:3px}
.small{font-size:.86em}
.steps{display:block;width:calc(100% - 38px);margin-left:38px;padding:0;color:var(--vscode-descriptionForeground);font-size:.88em;min-width:0}.steps>summary{padding:1px 0;min-width:0}.steps .timeline{margin:4px 0 4px 6px}
.steps-sum{min-width:0;overflow-wrap:anywhere}.steps-sum.ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bad-count{color:var(--warn-text);white-space:nowrap;flex:none}
.steps.flat{display:flex;align-items:center;gap:8px}.chev-pad{width:16px;flex:none}
.steps.badcall{display:flex;gap:8px;align-items:flex-start;color:var(--vscode-foreground)}.steps.badcall .node{color:var(--bad);flex:none}.ell-inline{display:inline-block;max-width:100%;vertical-align:bottom;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
time{font-weight:400}
.rcard{margin-left:38px;padding:2px 0 2px 12px;border-left:3px solid var(--vscode-panel-border);font-size:.92em;min-width:0}
.rcard.done{border-color:color-mix(in srgb,var(--ok) 60%,transparent)}.rcard.open{border-color:var(--info)}.rcard.warn{border-color:var(--warn-text)}.rcard.bad{border-color:var(--bad)}
.rtop{display:flex;align-items:center;gap:8px;min-width:0}.rtop .chip{font-size:.82em;padding:0 7px;font-weight:500;flex:none}.rtop .chip.info,.rtop .chip.ok{color:var(--vscode-descriptionForeground)}
.rgoal{flex:1;min-width:0;color:var(--vscode-descriptionForeground)}.rgoal.ell,.rcard .ell{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.rtop .stime{margin-left:auto;font-size:.88em;color:var(--vscode-descriptionForeground)}
.rquiet{margin-left:38px;padding-left:12px;font-size:.88em;min-width:0}.rprob{margin-top:3px;color:var(--warn-text);font-size:.9em}
.rfold{margin-top:6px;color:var(--vscode-descriptionForeground);font-size:.95em}.rfold>summary{padding:3px 10px 3px 6px;width:fit-content;max-width:100%;display:flex;gap:8px;align-items:center;border:1px solid var(--vscode-panel-border);border-radius:999px;cursor:pointer}.rfold>summary:hover{background:var(--vscode-list-hoverBackground)}.fold-label{color:var(--vscode-foreground);font-weight:600}.fold-gist{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}.rfold-body{display:flex;flex-direction:column;gap:12px;margin:8px 0 4px -50px;padding-left:0;color:var(--vscode-foreground);font-size:1.08em}
.rsum{margin-top:4px;white-space:pre-wrap}.rline{margin-top:3px;color:var(--vscode-descriptionForeground)}.rline .rk{color:var(--vscode-foreground)}
.rdelivs{display:flex;flex-direction:column;gap:4px;margin-top:6px}.deliv{display:flex;align-items:flex-start;gap:8px;min-width:0;padding:5px 8px;border-radius:6px;background:var(--vscode-input-background);color:var(--vscode-foreground);text-decoration:none}.deliv:hover{background:var(--vscode-list-hoverBackground)}.deliv svg{margin-top:2px;color:var(--vscode-textLink-foreground);flex:none}
.dtext{display:flex;flex-direction:column;min-width:0;flex:1}.dline{display:flex;gap:8px;align-items:baseline;min-width:0}.dname{font-weight:600;color:var(--vscode-textLink-foreground);flex:none;max-width:70%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.ddir{color:var(--vscode-descriptionForeground);font-size:.88em;min-width:0}.dprev{color:var(--vscode-descriptionForeground);font-size:.92em}
.rsup{margin-top:4px;color:var(--vscode-descriptionForeground);font-size:.9em}.rsup>summary{padding:1px 0;width:fit-content}
.rfiles{display:flex;flex-wrap:wrap;gap:2px 6px;margin-top:4px}.rfiles .filechip{max-width:100%;min-width:0;margin:0}
.sline{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;margin-left:38px;font-size:.88em;color:var(--vscode-descriptionForeground)}
.sline .chip.info{color:var(--vscode-descriptionForeground)}.sline .chip{font-size:.82em;padding:0 7px;font-weight:500}.sline .sdetail{color:var(--vscode-foreground);min-width:0;flex:1 1 200px}.sline .stime{margin-left:auto;font-size:.9em}
.thread-gates{width:100%;margin-top:6px}.thread-gates .card{margin-bottom:8px}
.composer{padding:10px 16px 12px}.composer .hint{font-size:.85em;margin:0 6px 6px}.tiny{font-size:.9em;margin:6px 6px 0}.row.wrap{margin-bottom:8px}
.inputbar{display:flex;align-items:flex-end;gap:8px;border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:24px;background:var(--vscode-input-background);padding:6px 8px 6px 16px}
.inputbar:focus-within{border-color:var(--vscode-focusBorder)}
.inputbar textarea{flex:1;border:0;background:transparent;color:var(--vscode-input-foreground);resize:none;padding:6px 0;max-height:160px;outline:none;font:inherit}
.roundbtn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-width:34px;height:34px;border-radius:17px;border:1px solid var(--cb);cursor:pointer;font:inherit;padding:0 8px;flex:none}
.roundbtn.send{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.roundbtn.send:hover{background:var(--vscode-button-hoverBackground)}
.roundbtn.stop{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.roundbtn.stop .stoplabel{display:none}.roundbtn.stop[data-armed] .stoplabel{display:inline}
.roundbtn.ready{box-shadow:0 0 0 2px var(--vscode-focusBorder)}.roundbtn:disabled{opacity:.4;cursor:not-allowed}
.roundbtn:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
.composer:not(.running) .stop,.composer.running textarea:not(:placeholder-shown) ~ .stop{display:none}
.composer.running textarea:placeholder-shown ~ .send{display:none}
`;

const SCRIPT = `
const vs = acquireVsCodeApi(); const app = document.getElementById('app');
const q = id => '[data-gate="' + CSS.escape(id) + '"]';
// The one text box is the composer at the bottom of the chat: it answers a question or gives the reason for a rejection.
const composer = () => document.querySelector('textarea[data-chat-input]');
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
  document.querySelectorAll('details.run').forEach(d => { d.classList.toggle('hidden', !(filter === 'all' || (filter === 'done' ? d.dataset.status === 'done' : !['done','running','waiting','nothing_to_do','cancelled','open'].includes(d.dataset.status)))); });
  const empty = document.querySelector('[data-filter-empty]');
  if (empty) empty.classList.toggle('hidden', !document.querySelectorAll('details.run').length || [...document.querySelectorAll('details.run')].some(d => !d.classList.contains('hidden')));
  const sel = document.querySelector('[data-filter]'); if (sel) sel.value = filter;
  updatePinned();
}
/** The pinned "waiting for you" bar is only for when the card it points to is out of view. */
function updatePinned() {
  const th = document.querySelector('.thread'); if (!th) return;
  const p = th.querySelector('.pinned'), g = th.querySelector('.thread-gates'); if (!p || !g) return;
  const top = g.getBoundingClientRect().top - th.getBoundingClientRect().top, inView = th.clientHeight > 0 && top >= 0 && top < th.clientHeight - 80;
  p.classList.toggle('hidden', inView);
}
document.addEventListener('scroll', e => { if (e.target && e.target.classList && e.target.classList.contains('thread')) updatePinned(); }, true);
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
  if (target === agent && ta.dataset.approvalFor) return;  // an approval is decided with its buttons; the box only holds a rejection reason
  if (target === agent && ta.dataset.answerFor) { vs.postMessage({ type:'answer', id: ta.dataset.answerFor, text }); ta.value = ''; autosize(ta); return; }
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
  if (!e.target.closest('.toolmenu') || e.target.closest('.menuitem')) document.querySelectorAll('details.toolmenu[open]').forEach(d => { d.open = false; });
  const brief = e.target.closest('.body.brief'); if (brief && !e.target.closest('a,button')) brief.classList.toggle('open');
  const t = e.target.closest('[data-open],[data-open-abs],[data-cmd],[data-pick],[data-approve],[data-reject],[data-ack],[data-copy],[data-tab],[data-agent],[data-chat-send],[data-chat-cancel],[data-close-task],[data-allow-agent],[data-dismiss-agent],[data-jump],[data-insert]'); if (!t) return;
  e.preventDefault(); const d = t.dataset;
  if (d.insert) { const ta = document.querySelector('textarea[data-chat-input]'); if (ta) { ta.value = (ta.value ? ta.value + ' ' : '') + d.insert; ta.focus(); autosize(ta); } }
  else if (d.jump) { const el = document.querySelector(d.jump); if (el) el.scrollIntoView({ block:'start', behavior:'smooth' }); }
  else if (d.allowAgent) vs.postMessage({ type:'allowCommand', agent:d.allowAgent, command:d.allowCmd, rerun: d.rerun === '1' });
  else if (d.dismissAgent) vs.postMessage({ type:'dismissBlock', agent:d.dismissAgent, command:d.dismissCmd });
  else if (d.open) vs.postMessage({ type:'open', path:d.open });
  else if (d.openAbs) vs.postMessage({ type:'openAbs', path:d.openAbs });
  else if (d.cmd) vs.postMessage({ type:'cmd', name:d.cmd, arg:d.arg });
  else if (d.pick) { const ta = composer(); if (ta) { ta.value = d.text; ta.focus(); autosize(ta); } document.querySelectorAll(q(d.pick) + ' [data-pick]').forEach(b => b.classList.toggle('picked', b === t)); const sb = document.querySelector('[data-chat-send]'); if (sb) sb.classList.add('ready'); }
  else if (d.approve) { if (busy.has(d.approve) || t.disabled) return; busy.add(d.approve); const ta = composer(); if (ta && ta.dataset.approvalFor === d.approve) { ta.value = ''; autosize(ta); } scan(); vs.postMessage({ type:'approve', id:d.approve, seen:hashes(d.approve) }); }
  else if (d.reject) { const ta = composer(); vs.postMessage({ type:'reject', id:d.reject, feedback: ta ? ta.value.trim() : '' }); if (ta) { ta.value = ''; autosize(ta); } }
  else if (d.ack) { reviewed[d.ack] = hashes(d.ack); scan(); }
  else if (d.closeTask) vs.postMessage({ type:'closeTask', id:d.closeTask });
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
  // A new question puts the cursor in the answer box, once; later refreshes leave the cursor where the reader put it.
  const af = document.querySelector('textarea[data-answer-for]');
  if (!fk && af && af.dataset.answerFor !== window.answerFocused) { window.answerFocused = af.dataset.answerFor; af.focus(); }
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
<title>Harbor Mate Console</title><style>${STYLE}</style></head><body><div id="app">${renderBody(m)}</div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
