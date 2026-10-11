import * as fs from 'fs';
import { Gate, listGates } from './queue';
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

export interface ConsoleModel {
  running: boolean;
  active?: string;
  next?: { agent: string; at: string };
  pending: Gate[];
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
    pending: listGates(root).filter(g => g.status === 'pending'),
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
const STATUS_ICON: Record<string, string> = { done: '✔', running: '⟳', waiting: '🔔', error: '✖', retry: '↻', max_steps: '⚠', stalled: '⚠', blocked: '⚠' };

function gateCard(g: Gate): string {
  const files = g.files.map(f => `<a href="#" data-open="${esc(f)}">${esc(f)}</a>`).join(' ');
  const head = `<div class="card-head"><b>${g.kind === 'question' ? '❓' : '✅'} ${esc(g.title)}</b><span class="muted">${esc(g.agent)} · ${esc(ago(g.createdAt))}</span></div>`;
  const body = g.body ? `<div class="body">${esc(g.body)}</div>` : '';
  const filesRow = files ? `<div class="muted">Drafts: ${files}</div>` : '';
  if (g.kind === 'question') {
    const opts = (g.options ?? []).map(o => `<button class="secondary" data-answer="${esc(g.id)}" data-text="${esc(o)}">${esc(o)}</button>`).join('');
    return `<div class="card attention" data-gate="${esc(g.id)}">${head}${body}${filesRow}
      <div class="row">${opts}</div>
      <div class="row"><textarea rows="2" placeholder="Type an answer…" data-input="${esc(g.id)}"></textarea><button data-send="${esc(g.id)}">Send answer</button></div></div>`;
  }
  return `<div class="card attention" data-gate="${esc(g.id)}">${head}${body}${filesRow}
    <div class="muted">This exact command runs when you approve:</div><pre>${esc(g.command ?? '')}</pre>
    <div class="row"><textarea rows="1" placeholder="Feedback if you reject (optional)" data-input="${esc(g.id)}"></textarea>
    <button data-approve="${esc(g.id)}">Approve and run</button><button class="secondary" data-reject="${esc(g.id)}">Reject</button></div></div>`;
}

function runCard(r: ConsoleRun): string {
  const steps = r.steps.map(s => `<li class="${s.ok ? '' : 'bad'}"><span class="step">${s.step || ''}</span><span class="k">${esc(s.kind)}</span> ${esc(s.title)}${s.detail ? `<div class="muted">${esc(s.detail)}</div>` : ''}</li>`).join('');
  const outs = r.outputs.map(o => `<a href="#" data-open="${esc(o)}">📄 ${esc(o)}</a>`).join('<br>');
  return `<details class="run"><summary><span class="st st-${esc(r.status)}">${STATUS_ICON[r.status] ?? '•'}</span> <b>${esc(r.agent)}</b>
    <span class="muted">${esc(r.status)} · ${r.step} step${r.step === 1 ? '' : 's'} · ${esc(time(r.started))}</span>${r.summary ? `<div class="sum">${esc(clip(r.summary, 160))}</div>` : ''}</summary>
    ${outs ? `<div class="outs">${outs}</div>` : ''}<ol>${steps || '<li class="muted">No steps recorded.</li>'}</ol>
    <a href="#" data-open-abs="${esc(r.file)}" class="muted">Open raw log</a></details>`;
}

/** Console body (the part that is re-rendered when data changes). */
export function renderBody(m: ConsoleModel): string {
  const active = m.running && m.active;
  const state = !m.running ? '<span class="pill off">Stopped</span>'
    : active ? `<span class="pill on">Running · ${esc(m.active)}</span>`
    : `<span class="pill idle">Idle${m.next ? ` · next wake ${esc(time(m.next.at))} (${esc(m.next.agent)})` : ''}</span>`;
  const controls = `${m.running ? '<button class="secondary" data-cmd="stopTeam">Stop</button>' : '<button data-cmd="startTeam">Start team</button>'}
    <button class="secondary" data-cmd="runAgent">Give a task…</button><button class="secondary" data-cmd="openLatestResult">Latest result</button>`;
  const needs = m.pending.length
    ? `<h2>Needs you <span class="badge">${m.pending.length}</span></h2>${m.pending.map(gateCard).join('')}`
    : `<h2>Needs you</h2><div class="empty">Nothing is waiting for you.</div>`;
  const agents = m.agents.length
    ? `<table><tr><th>Agent</th><th>State</th><th>Next wake</th><th>Last check</th></tr>${m.agents.map(a => `<tr>
      <td><a href="#" data-open="${esc(a.file)}">${esc(a.name)}</a><div class="muted">${esc(a.model ?? '')}</div></td>
      <td>${a.state === 'running' ? '⟳ running' : a.state === 'waiting' ? '🔔 waiting on you' : '○ idle'}</td>
      <td>${a.next ? esc(time(a.next.toISOString())) : '<span class="muted">manual</span>'}</td>
      <td>${a.lastWake ? `${a.lastWake.wake ? 'found work' : 'nothing to do'} <span class="muted">${esc(time(a.lastWake.at))}</span>` : '<span class="muted">none yet</span>'}</td></tr>`).join('')}</table>`
    : '<div class="empty">No agents have joined the team. Add a <code>loop:</code> block to a <code>.github/agents/*.agent.md</code> file, then reload.</div>';
  const runs = m.runs.length ? m.runs.map(runCard).join('') : '<div class="empty">No runs yet. Start the team, or use “Give a task…”.</div>';
  return `<div class="top">${state}<span class="grow"></span>${controls}</div>${needs}<h2>Agents</h2>${agents}<h2>Recent runs</h2>${runs}`;
}

const STYLE = `
body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);padding:12px 18px;max-width:900px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.05em;opacity:.8;margin:22px 0 8px}
.top{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.grow{flex:1}
.pill{padding:3px 10px;border-radius:12px;font-weight:600}.on{background:var(--vscode-charts-green);color:#000}.idle{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground)}.off{background:var(--vscode-input-background)}
.badge{background:var(--vscode-badge-background);color:var(--vscode-badge-foreground);border-radius:9px;padding:0 7px}
.card,.run{border:1px solid var(--vscode-panel-border);border-radius:6px;padding:10px 12px;margin:8px 0}.attention{border-color:var(--vscode-charts-orange)}
.card-head{display:flex;justify-content:space-between;gap:8px}.body{margin:6px 0;white-space:pre-wrap}
.muted{opacity:.7;font-size:12px}.empty{opacity:.7;padding:8px 0}
.row{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}textarea{flex:1;min-width:200px;background:var(--vscode-input-background);color:var(--vscode-input-foreground);border:1px solid var(--vscode-input-border,transparent);padding:4px}
button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:0;border-radius:3px;padding:5px 12px;cursor:pointer}button.secondary{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
pre{background:var(--vscode-textCodeBlock-background);padding:8px;overflow:auto;white-space:pre-wrap}
table{border-collapse:collapse;width:100%}th,td{text-align:left;padding:5px 8px;border-bottom:1px solid var(--vscode-panel-border);vertical-align:top}th{font-weight:600;opacity:.7}
summary{cursor:pointer}.sum{margin:2px 0 0 22px;opacity:.85}.outs{margin:8px 0}ol{padding-left:0;list-style:none;margin:8px 0}li{padding:3px 0;border-left:2px solid var(--vscode-panel-border);padding-left:8px;margin-bottom:2px}li.bad{border-color:var(--vscode-charts-red)}
.step{display:inline-block;min-width:22px;opacity:.6}.k{opacity:.6;font-size:11px;margin-right:4px}.st-done{color:var(--vscode-charts-green)}.st-error{color:var(--vscode-charts-red)}
a{color:var(--vscode-textLink-foreground)}`;

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
  else if (d.approve) vs.postMessage({ type:'approve', id:d.approve });
  else if (d.reject) vs.postMessage({ type:'reject', id:d.reject, feedback:val(d.reject) });
});
window.addEventListener('message', ev => {
  if (ev.data.type !== 'body') return;
  // Never overwrite something the user is typing.
  if ([...document.querySelectorAll('textarea')].some(x => x.value || x === document.activeElement)) return;
  const keep = new Set([...document.querySelectorAll('details.run[open] summary b')].map(b => b.parentElement.textContent));
  app.innerHTML = ev.data.html;
  document.querySelectorAll('details.run').forEach(d => { if (keep.has(d.querySelector('summary').textContent)) d.open = true; });
});
vs.postMessage({ type:'ready' });`;

/** Full page. The script is the only inline code and carries the nonce; everything shown is escaped. */
export function renderPage(m: ConsoleModel, nonce: string, cspSource: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${STYLE}</style></head><body><div id="app">${renderBody(m)}</div><script nonce="${nonce}">${SCRIPT}</script></body></html>`;
}
