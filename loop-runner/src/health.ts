import * as fs from 'fs';
import * as path from 'path';
import { loadAllAgents } from './team';
import { recentRuns } from './runs';
import { PROBLEM_STATUSES } from './maintenance';

/**
 * Is each agent earning its keep? Computed from the audit files alone, with no model. The numbers are facts; the
 * findings are rules over them, each with the change that would help, so `@mate` can explain and propose it.
 */
export interface AgentHealth {
  agent: string;
  runs: number;
  byStatus: Record<string, number>;
  avgSteps: number;
  /** Tool calls refused by policy, and the command that was refused most. */
  refused: number;
  topRefused?: string;
  /** Questions and approvals the agent put to the human. */
  asked: number;
  /** Runs that wrote at least one file. */
  withOutput: number;
  /** Scheduled wake checks: how many woke the model, how many found nothing, how many were broken. */
  wakes: { woke: number; skipped: number; broken: number };
}

export interface Finding { agent: string; severity: 'high' | 'medium' | 'low'; what: string; fix: string }
export interface HealthReport { days: number; agents: AgentHealth[]; findings: Finding[] }

const readLines = (f: string): any[] => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }); } catch { return []; } };

export function healthReport(root: string, now = new Date(), days = 14): HealthReport {
  const since = now.getTime() - days * 86_400_000;
  const agents = loadAllAgents(root);
  const stats = new Map<string, AgentHealth>();
  const get = (name: string): AgentHealth => {
    let h = stats.get(name);
    if (!h) { h = { agent: name, runs: 0, byStatus: {}, avgSteps: 0, refused: 0, asked: 0, withOutput: 0, wakes: { woke: 0, skipped: 0, broken: 0 } }; stats.set(name, h); }
    return h;
  };
  const refusedBy = new Map<string, Map<string, number>>();
  const steps = new Map<string, number>();

  for (const r of recentRuns(root, 2000)) {
    if (Date.parse(r.started) < since || r.status === 'running') { continue; }
    const h = get(r.agent);
    h.runs++;
    h.byStatus[r.status] = (h.byStatus[r.status] ?? 0) + 1;
    steps.set(r.agent, (steps.get(r.agent) ?? 0) + r.step);
    if (r.outputs.length) { h.withOutput++; }
    for (const e of readLines(r.file)) {
      if (e.type !== 'tool') { continue; }
      if (e.decision === 'deny') {
        h.refused++;
        const key = String(e.input?.command ?? e.input?.path ?? e.name).slice(0, 80);
        const m = refusedBy.get(r.agent) ?? new Map<string, number>();
        m.set(key, (m.get(key) ?? 0) + 1); refusedBy.set(r.agent, m);
      }
      if (e.name === 'ask_human' || e.name === 'request_approval') { h.asked++; }
    }
  }
  for (const [a, m] of refusedBy) { get(a).topRefused = [...m.entries()].sort((x, y) => y[1] - x[1])[0][0]; }
  for (const [a, n] of steps) { const h = get(a); h.avgSteps = h.runs ? Math.round((n / h.runs) * 10) / 10 : 0; }

  const runsDir = path.join(root, '.loop', 'runs');
  for (const day of fs.existsSync(runsDir) ? fs.readdirSync(runsDir) : []) {
    if (Date.parse(day) < since - 86_400_000) { continue; }
    for (const e of readLines(path.join(runsDir, day, `wake-${day}.jsonl`))) {
      if (e.type !== 'wake' || !e.agent) { continue; }
      const w = get(String(e.agent)).wakes;
      if (e.error) { w.broken++; } else if (e.wake) { w.woke++; } else if (!e.open && !e.capped) { w.skipped++; }
    }
  }

  const findings: Finding[] = [];
  for (const h of [...stats.values()].filter(x => agents.has(x.agent))) {
    const bad = Object.entries(h.byStatus).filter(([s]) => PROBLEM_STATUSES.has(s)).reduce((n, [, c]) => n + c, 0);
    const idle = h.byStatus.nothing_to_do ?? 0;
    if (h.runs >= 5 && idle / h.runs >= 0.8) {
      findings.push({ agent: h.agent, severity: 'medium', what: `${idle} of its last ${h.runs} runs found nothing to do, and each one still called the model.`, fix: 'Lower the schedule frequency, or add a wakeIf probe (propose_schedule with wakeIf) so those runs cost nothing.' });
    }
    if (h.runs >= 3 && bad / h.runs >= 0.5) {
      findings.push({ agent: h.agent, severity: 'high', what: `${bad} of its last ${h.runs} runs ended blocked, errored, stalled or ran out of steps.`, fix: 'Read a failed run (get_run) to see where it gets stuck, then fix the instructions (propose_role_edit) or give it the missing skill.' });
    }
    if (h.refused >= 3) {
      findings.push({ agent: h.agent, severity: 'high', what: `Policy refused ${h.refused} of its actions${h.topRefused ? `, most often: ${h.topRefused}` : ''}.`, fix: 'Either it should not be doing that (fix its instructions), or it needs a skill script that does it safely. A looser policy is a human decision; say so rather than proposing one.' });
    }
    if (h.runs >= 4 && h.asked / h.runs >= 1) {
      findings.push({ agent: h.agent, severity: 'medium', what: `It asked the human ${h.asked} times in ${h.runs} runs, which is about once per run.`, fix: 'Look at what it asks (recent_runs, get_run). If the answer is always the same, make it a standing note (propose_remember) or a skill that fetches it.' });
    }
    if (h.runs >= 5 && h.withOutput === 0 && (h.byStatus.done ?? 0) >= 3) {
      findings.push({ agent: h.agent, severity: 'low', what: `${h.runs} runs and none left a file. If it is meant to produce reports, nobody has anything to read.`, fix: 'Check its instructions say where to write the result, or consider pausing it if nobody needs it (propose_pause).' });
    }
    if (h.wakes.broken >= 2) {
      findings.push({ agent: h.agent, severity: 'high', what: `Its wakeIf probe was broken ${h.wakes.broken} times, so scheduled runs did not happen.`, fix: 'Run the probe by hand (run_doctor) and fix the script.' });
    }
  }
  const order = { high: 0, medium: 1, low: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return { days, agents: [...stats.values()].sort((a, b) => b.runs - a.runs), findings };
}

export function healthMarkdown(r: HealthReport): string {
  if (!r.agents.length) { return `No runs in the last ${r.days} days yet, so there is nothing to judge.`; }
  const rows = r.agents.map(a => `| ${a.agent} | ${a.runs} | ${Object.entries(a.byStatus).map(([s, n]) => `${s} ${n}`).join(', ') || '—'} | ${a.avgSteps} | ${a.asked} | ${a.refused} | ${a.wakes.skipped}/${a.wakes.woke + a.wakes.skipped} |`);
  const table = `| Agent | Runs | Outcomes | Avg steps | Asked you | Refused | Probe skipped |\n|---|---|---|---|---|---|---|\n${rows.join('\n')}`;
  const f = r.findings.length ? r.findings.map(x => `- **${x.agent}** (${x.severity}): ${x.what}\n  - ${x.fix}`).join('\n') : '- Nothing stands out.';
  return `**Last ${r.days} days**\n\n${table}\n\n**Worth a look**\n\n${f}`;
}
