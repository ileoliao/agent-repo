import * as fs from 'fs';
import { Gate, listGates } from './queue';
import { fileSha256 } from './gates';
import * as path from 'path';
import { RunSummary, recentRuns } from './runs';
import { AgentRow, agentRows, nextWake } from './status';

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
    let text = '';
    try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { text = '(file is missing)'; }
    return { path: f, text: text.slice(0, PREVIEW_CHARS), sha256: fileSha256(root, f), truncated: text.length > PREVIEW_CHARS };
  });
}

export interface ConsoleModel {
  running: boolean;
  active?: string;
  next?: { agent: string; at: string };
  pending: GateView[];
  agents: AgentRow[];
  runs: ConsoleRun[];
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const firstLine = (s: string) => s.split('\n').find(l => l.trim()) ?? '';

function brief(input: unknown): string {
  if (!input || typeof input !== 'object') { return ''; }
  const o = input as Record<string, unknown>;
  const v = o.path ?? o.command ?? o.pattern ?? o.title ?? Object.values(o).find(x => typeof x === 'string');
  return typeof v === 'string' ? clip(firstLine(v), 90) : '';
}

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
export function consoleModel(root: string, state: { running: boolean; active?: string }, now = new Date(), runLimit = 10): ConsoleModel {
  const agents = agentRows(root, state.active, now);
  const nw = nextWake(agents);
  return {
    running: state.running,
    active: state.active,
    next: nw ? { agent: nw.agent, at: nw.at.toISOString() } : undefined,
    pending: listGates(root).filter(g => g.status === 'pending').map(g => ({ ...g, previews: previewsOf(root, g) })),
    agents,
    runs: recentRuns(root, runLimit).map(r => ({ ...r, steps: stepsOf(r.file) }))
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const time = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); };
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
  dot: 'M8 6a2 2 0 100 4 2 2 0 000-4z'
};
const icon = (name: string, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] ?? ICONS.dot}"/></svg>`;

const STATUS: Record<string, { label: string; tone: string; ic: string }> = {
  done: { label: 'Done', tone: 'ok', ic: 'check' }, running: { label: 'Running', tone: 'info', ic: 'spin' },
  waiting: { label: 'Waiting for you', tone: 'warn', ic: 'bell' }, error: { label: 'Error', tone: 'bad', ic: 'x' },
  retry: { label: 'Will retry', tone: 'warn', ic: 'clock' }, blocked: { label: 'Blocked', tone: 'warn', ic: 'alert' },
  max_steps: { label: 'Step limit', tone: 'warn', ic: 'alert' }, stalled: { label: 'Stalled', tone: 'bad', ic: 'alert' },
  nothing_to_do: { label: 'Nothing to do', tone: 'mute', ic: 'check' }, cancelled: { label: 'Cancelled', tone: 'mute', ic: 'stop' }
};
const chip = (status: string) => { const s = STATUS[status] ?? { label: status, tone: 'mute', ic: 'dot' }; return `<span class="chip ${s.tone}">${icon(s.ic)}<span>${esc(s.label)}</span></span>`; };
const btn = (label: string, attrs: string, kind = '', ic = '') => `<button class="btn ${kind}" ${attrs}>${ic ? icon(ic) : ''}<span>${esc(label)}</span></button>`;

function gateCard(g: GateView): string {
  const isQ = g.kind === 'question';
  const head = `<div class="card-head">${icon(isQ ? 'help' : 'bell', 'lead warn')}<div class="grow"><div class="card-title">${esc(g.title)}</div>
    <div class="meta"><span class="tag">${esc(g.agent)}</span><span>${esc(isQ ? 'Question' : 'Approval needed')}</span><span>${esc(ago(g.createdAt))}</span></div></div></div>`;
  const body = g.body ? `<p class="body">${esc(g.body)}</p>` : '';
  const files = (g.previews ?? []).map(p => `<details class="file" open data-k="f-${esc(g.id)}-${esc(p.path)}"><summary>${icon('chevron', 'chev')}${icon('file')}<span class="mono grow">${esc(p.path)}</span>${p.truncated ? '<span class="muted">first part shown</span>' : ''}</summary>
    <pre class="code" data-hash-for="${esc(p.path)}" data-hash="${esc(p.sha256)}">${esc(p.text)}</pre></details>`).join('')
    + (g.files.length && !(g.previews ?? []).length ? g.files.map(f => `<a class="filechip" href="#" data-open="${esc(f)}">${icon('file')}${esc(f)}</a>`).join('') : '');
  if (isQ) {
    const opts = (g.options ?? []).map(o => btn(o, `data-answer="${esc(g.id)}" data-text="${esc(o)}"`, 'secondary')).join('');
    return `<section class="card attention" data-gate="${esc(g.id)}" aria-label="Question from ${esc(g.agent)}">${head}${body}${files}
      ${opts ? `<div class="row wrap">${opts}</div>` : ''}
      <div class="row"><textarea rows="2" placeholder="Type an answer…" aria-label="Your answer" data-input="${esc(g.id)}"></textarea>${btn('Send answer', `data-send="${esc(g.id)}"`, 'primary', 'send')}</div></section>`;
  }
  return `<section class="card attention" data-gate="${esc(g.id)}" aria-label="Approval requested by ${esc(g.agent)}">${head}${body}
    <div class="label">This exact command runs when you approve</div><pre class="code cmd">${esc(g.command ?? '')}</pre>${files}
    ${(g.previews ?? []).length ? '<div class="note">Your approval covers the file contents shown above. If a file changes before it runs, nothing runs and you review again.</div>' : ''}
    <div class="row"><textarea rows="1" placeholder="Reason, if you reject (optional)" aria-label="Feedback for the agent" data-input="${esc(g.id)}"></textarea>
    ${btn('Reject', `data-reject="${esc(g.id)}"`, 'secondary', 'x')}${btn('Approve and run', `data-approve="${esc(g.id)}"`, 'primary', 'check')}</div></section>`;
}

function runCard(r: ConsoleRun): string {
  const steps = r.steps.map(s => `<li class="step ${s.ok ? '' : 'bad'}"><span class="node">${icon(s.kind === 'end' ? 'check' : s.ok ? 'dot' : 'x')}</span>
    <div class="grow"><div class="step-title"><span class="kind">${esc(s.kind)}</span>${s.step ? `<span class="muted">#${s.step}</span>` : ''}<span class="${s.kind === 'tool' || s.kind === 'gate' ? 'mono' : ''}">${esc(s.title)}</span></div>${s.detail ? `<div class="muted wrap-text">${esc(s.detail)}</div>` : ''}</div></li>`).join('');
  const outs = r.outputs.map(o => `<a class="filechip" href="#" data-open="${esc(o)}">${icon('file')}${esc(o)}</a>`).join('');
  return `<details class="run" data-k="r-${esc(r.chainId)}"><summary>${icon('chevron', 'chev')}${chip(r.status)}<span class="run-agent">${esc(r.agent)}</span>
    <span class="grow run-sum">${esc(clip(r.summary, 110))}</span><span class="muted nowrap">${r.step} step${r.step === 1 ? '' : 's'} · ${esc(ago(r.started))}</span></summary>
    <div class="run-body">${outs ? `<div class="label">Files written</div><div class="row wrap">${outs}</div>` : ''}
    <div class="label">What happened</div><ol class="timeline">${steps || '<li class="muted">No steps recorded.</li>'}</ol>
    <a class="link muted" href="#" data-open-abs="${esc(r.file)}">Open raw log</a></div></details>`;
}

function agentRow(a: AgentRow): string {
  const state = a.state === 'running' ? 'running' : a.state === 'waiting' ? 'waiting' : 'nothing_to_do';
  const label = a.state === 'running' ? 'Running' : a.state === 'waiting' ? 'Waiting on you' : 'Idle';
  const s = STATUS[state];
  return `<div class="agent"><div class="agent-top">${icon('bot', 'lead')}<a class="agent-name" href="#" data-open="${esc(a.file)}">${esc(a.name)}</a>
    <span class="chip ${a.state === 'idle' ? 'mute' : s.tone}">${icon(a.state === 'idle' ? 'dot' : s.ic)}<span>${label}</span></span></div>
    <dl class="kv"><dt>Model</dt><dd class="mono">${esc(a.model ?? 'default')}</dd>
    <dt>Next wake</dt><dd>${a.next ? esc(time(a.next.toISOString())) : '<span class="muted">manual only</span>'}</dd>
    <dt>Last check</dt><dd>${a.lastWake ? `${a.lastWake.wake ? 'found work' : 'nothing to do'} <span class="muted">${esc(ago(a.lastWake.at))}</span>` : '<span class="muted">none yet</span>'}</dd></dl></div>`;
}

const empty = (ic: string, title: string, hint: string) => `<div class="empty">${icon(ic, 'big')}<div class="empty-title">${esc(title)}</div><div class="muted">${hint}</div></div>`;

/** Console body (the part that is re-rendered when data changes). */
export function renderBody(m: ConsoleModel): string {
  const live = m.runs.find(r => r.status === 'running' && r.agent === m.active);
  const state = !m.running ? `<span class="state off">${icon('stop')}Stopped</span>`
    : m.active ? `<span class="state on">${icon('spin', 'spin')}Running · ${esc(m.active)}${live ? ` · step ${live.step}` : ''}</span>`
    : `<span class="state idle">${icon('clock')}Idle${m.next ? ` · next wake ${esc(time(m.next.at))}` : ''}</span>`;
  const actions = (m.running ? btn('Stop', 'data-cmd="stopTeam"', 'secondary', 'stop') : btn('Start team', 'data-cmd="startTeam"', 'primary', 'play'))
    + btn('Give a task', 'data-cmd="runAgent"', 'secondary', 'send') + btn('Latest result', 'data-cmd="openLatestResult"', 'secondary', 'file');
  const last = m.runs.find(r => r.status !== 'running');
  const tiles = [
    { k: 'Needs you', v: String(m.pending.length), tone: m.pending.length ? 'warn' : '', sub: m.pending.length ? 'waiting for your decision' : 'all clear' },
    { k: 'Agents', v: String(m.agents.length), tone: '', sub: `${m.agents.filter(a => a.state === 'running').length} running · ${m.agents.filter(a => a.state === 'waiting').length} waiting` },
    { k: 'Last run', v: last ? (STATUS[last.status]?.label ?? last.status) : '—', tone: last ? (STATUS[last.status]?.tone ?? '') : '', sub: last ? `${last.agent} · ${ago(last.started)}` : 'no runs yet' },
    { k: 'Next wake', v: m.next ? time(m.next.at) : '—', tone: '', sub: m.next ? m.next.agent : 'nothing scheduled' }
  ].map(t => `<div class="tile ${t.tone}"><div class="tile-k">${esc(t.k)}</div><div class="tile-v">${esc(t.v)}</div><div class="muted">${esc(t.sub)}</div></div>`).join('');
  const needs = m.pending.length ? m.pending.map(gateCard).join('') : empty('check', 'Nothing is waiting for you', 'Questions and approvals from agents show up here.');
  const runs = m.runs.length ? m.runs.map(runCard).join('') : empty('clock', 'No runs yet', 'Press Start team, or use “Give a task” to run an agent now.');
  const agents = m.agents.length ? m.agents.map(agentRow).join('')
    : empty('bot', 'No agents on the team', 'Add a <code>loop:</code> block to a <code>.github/agents/*.agent.md</code> file, then reload.');
  return `<header class="bar"><div class="brand">Loop Console</div>${state}<span class="grow"></span><div class="row">${actions}</div></header>
    <div class="tiles">${tiles}</div>
    <div class="cols"><main><h2>Needs you${m.pending.length ? `<span class="count warn">${m.pending.length}</span>` : ''}</h2>${needs}
    <h2>Recent runs</h2>${runs}</main><aside><h2>Agents</h2>${agents}</aside></div>`;
}

const STYLE = `
:root{--gap:12px;--r:6px}
*{box-sizing:border-box}
body{margin:0;padding:0 20px 32px;font-family:var(--vscode-font-family);font-size:var(--vscode-font-size);color:var(--vscode-foreground);line-height:1.45}
.mono,code,pre{font-family:var(--vscode-editor-font-family,monospace);font-size:.92em}
.muted{color:var(--vscode-descriptionForeground)}.grow{flex:1;min-width:0}.nowrap{white-space:nowrap}.wrap-text{overflow-wrap:anywhere}
.ic{flex:none}.big{width:28px;height:28px}.lead{width:18px;height:18px;margin-top:2px}.spin{animation:sp 1.2s linear infinite}@keyframes sp{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.bar{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:var(--gap);flex-wrap:wrap;padding:12px 0;margin-bottom:4px;background:var(--vscode-editor-background);border-bottom:1px solid var(--vscode-panel-border)}
.brand{font-size:1.25em;font-weight:600;margin-right:4px}
.state{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-weight:600;font-size:.92em;border:1px solid var(--vscode-panel-border)}
.state.on{color:var(--vscode-charts-green);border-color:var(--vscode-charts-green)}.state.idle{color:var(--vscode-foreground)}.state.off{color:var(--vscode-descriptionForeground)}
.row{display:flex;gap:8px;align-items:flex-start}.row.wrap{flex-wrap:wrap}.row>textarea{flex:1}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;padding:5px 12px;border:1px solid transparent;border-radius:2px;font:inherit;cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--vscode-button-background);color:var(--vscode-button-foreground)}.btn.primary:hover{background:var(--vscode-button-hoverBackground)}
.btn.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}.btn.secondary:hover{background:var(--vscode-button-secondaryHoverBackground)}
.btn:focus-visible,a:focus-visible,summary:focus-visible,textarea:focus-visible{outline:1px solid var(--vscode-focusBorder);outline-offset:1px}
textarea{background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,var(--vscode-panel-border));border-radius:2px;padding:6px 8px;font:inherit;resize:vertical;min-width:0}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:var(--gap);margin:16px 0 8px}
.tile{padding:10px 12px;border:1px solid var(--vscode-panel-border);border-radius:var(--r);background:var(--vscode-sideBar-background,transparent)}
.tile-k{font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}.tile-v{font-size:1.5em;font-weight:600;margin:2px 0}
.tile.warn{border-color:var(--vscode-charts-orange)}.tile.warn .tile-v{color:var(--vscode-charts-orange)}.tile.ok .tile-v{color:var(--vscode-charts-green)}.tile.bad .tile-v{color:var(--vscode-charts-red)}.tile.info .tile-v{color:var(--vscode-charts-blue)}
.cols{display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:24px;align-items:start}
@media (max-width:820px){.cols{grid-template-columns:1fr}}
h2{display:flex;align-items:center;gap:8px;margin:22px 0 10px;font-size:.82em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--vscode-descriptionForeground)}
.count{padding:0 7px;border-radius:999px;font-size:.95em;color:var(--vscode-badge-foreground);background:var(--vscode-badge-background)}.count.warn{background:var(--vscode-charts-orange);color:#000}
.card{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:14px;margin-bottom:var(--gap);background:var(--vscode-sideBar-background,transparent)}
.card.attention{border-left:3px solid var(--vscode-charts-orange)}
.card-head{display:flex;gap:10px}.card-title{font-weight:600;font-size:1.05em}.lead.warn{color:var(--vscode-charts-orange)}
.meta{display:flex;gap:8px;flex-wrap:wrap;align-items:center;font-size:.88em;color:var(--vscode-descriptionForeground)}.meta>*+*::before{content:"·";margin-right:8px}
.tag{padding:0 6px;border-radius:3px;background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.meta .tag::before{content:none;margin:0}
.body{margin:10px 0;white-space:pre-wrap}.label{margin:12px 0 4px;font-size:.8em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground)}
.note{margin:8px 0;font-size:.9em;color:var(--vscode-descriptionForeground)}
.code{margin:0 0 6px;padding:10px;border-radius:4px;background:var(--vscode-textCodeBlock-background);white-space:pre-wrap;overflow-wrap:anywhere;max-height:280px;overflow:auto}.code.cmd{border-left:3px solid var(--vscode-charts-blue)}
details>summary{display:flex;align-items:center;gap:8px;cursor:pointer;list-style:none;border-radius:4px}details>summary::-webkit-details-marker{display:none}
.chev{transition:transform .12s}details[open]>summary>.chev{transform:rotate(90deg)}
.file{margin:8px 0}.file>summary{padding:4px 0;color:var(--vscode-descriptionForeground)}
.filechip{display:inline-flex;align-items:center;gap:6px;margin:2px 6px 2px 0;padding:2px 8px;border:1px solid var(--vscode-panel-border);border-radius:999px;color:var(--vscode-textLink-foreground);text-decoration:none;overflow-wrap:anywhere}.filechip:hover{background:var(--vscode-list-hoverBackground)}
a{color:var(--vscode-textLink-foreground)}
.chip{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:.88em;font-weight:600;white-space:nowrap;border:1px solid currentColor}
.chip.ok{color:var(--vscode-charts-green)}.chip.bad{color:var(--vscode-charts-red)}.chip.warn{color:var(--vscode-charts-orange)}.chip.info{color:var(--vscode-charts-blue)}.chip.mute{color:var(--vscode-descriptionForeground)}
.run{border:1px solid var(--vscode-panel-border);border-radius:var(--r);margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.run>summary{padding:10px 12px}.run>summary:hover{background:var(--vscode-list-hoverBackground)}.run-agent{font-weight:600}.run-sum{color:var(--vscode-descriptionForeground);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.run-body{padding:0 14px 12px 36px}
.timeline{list-style:none;margin:6px 0 10px;padding:0}
.step{display:flex;gap:10px;padding:5px 0;position:relative}.step:not(:last-child)::before{content:"";position:absolute;left:7px;top:22px;bottom:-4px;width:1px;background:var(--vscode-panel-border)}
.node{color:var(--vscode-descriptionForeground);margin-top:1px}.step.bad .node{color:var(--vscode-charts-red)}.step-title{display:flex;gap:8px;flex-wrap:wrap;align-items:baseline;overflow-wrap:anywhere}
.kind{font-size:.75em;text-transform:uppercase;letter-spacing:.05em;color:var(--vscode-descriptionForeground)}
.agent{border:1px solid var(--vscode-panel-border);border-radius:var(--r);padding:12px;margin-bottom:8px;background:var(--vscode-sideBar-background,transparent)}
.agent-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.agent-name{font-weight:600;flex:1;text-decoration:none}.agent-name:hover{text-decoration:underline}
.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:10px 0 0;font-size:.92em}.kv dt{color:var(--vscode-descriptionForeground)}.kv dd{margin:0;overflow-wrap:anywhere}
.empty{display:flex;flex-direction:column;align-items:center;gap:4px;padding:22px 12px;text-align:center;border:1px dashed var(--vscode-panel-border);border-radius:var(--r);color:var(--vscode-descriptionForeground)}.empty-title{color:var(--vscode-foreground);font-weight:600}
.link{font-size:.9em}`;

const SCRIPT = `
const vs = acquireVsCodeApi(); const app = document.getElementById('app');
const val = id => (document.querySelector('[data-input="'+id+'"]')||{}).value || '';
document.addEventListener('click', e => {
  const t = e.target.closest('[data-open],[data-open-abs],[data-cmd],[data-answer],[data-send],[data-approve],[data-reject]'); if (!t) return;
  e.preventDefault(); const d = t.dataset;
  if (d.open) vs.postMessage({ type:'open', path:d.open });
  else if (d.openAbs) vs.postMessage({ type:'openAbs', path:d.openAbs });
  else if (d.cmd) vs.postMessage({ type:'cmd', name:d.cmd });
  else if (d.answer) vs.postMessage({ type:'answer', id:d.answer, text:d.text });
  else if (d.send) { const text = val(d.send).trim(); if (text) vs.postMessage({ type:'answer', id:d.send, text }); }
  else if (d.approve) { const seen = {}; document.querySelectorAll('[data-gate="'+d.approve+'"] [data-hash-for]').forEach(x => seen[x.dataset.hashFor] = x.dataset.hash); vs.postMessage({ type:'approve', id:d.approve, seen }); }
  else if (d.reject) vs.postMessage({ type:'reject', id:d.reject, feedback:val(d.reject) });
});
// Re-render without losing what the user is doing: open sections, typed text, focus and scroll.
window.addEventListener('message', ev => {
  if (ev.data.type !== 'body') return;
  const open = new Set([...document.querySelectorAll('details[open]')].map(d => d.dataset.k));
  const closed = new Set([...document.querySelectorAll('details:not([open])')].map(d => d.dataset.k));
  const typed = {}; document.querySelectorAll('textarea[data-input]').forEach(t => { typed[t.dataset.input] = t.value; });
  const f = document.activeElement; const focus = f && f.dataset && f.dataset.input;
  const sel = f && f.selectionStart;
  app.innerHTML = ev.data.html;
  document.querySelectorAll('details').forEach(d => { if (closed.has(d.dataset.k)) d.open = false; else if (open.has(d.dataset.k)) d.open = true; });
  document.querySelectorAll('textarea[data-input]').forEach(t => { if (typed[t.dataset.input]) t.value = typed[t.dataset.input]; });
  if (focus) { const t = document.querySelector('[data-input="'+focus+'"]'); if (t) { t.focus(); if (sel != null) t.setSelectionRange(sel, sel); } }
});
vs.postMessage({ type:'ready' });`;

/** Full page. The script is the only inline code and carries the nonce; everything shown is escaped. */
export function renderPage(m: ConsoleModel, nonce: string, cspSource: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>Loop Console</title><style>${STYLE}</style></head><body><div id="app">${renderBody(m)}</div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
