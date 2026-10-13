import * as fs from 'fs';
import * as path from 'path';
import { AgentDef, GoalDef, SkillDef, skillsFor } from './team';
import { cronMatches, minuteKey, missedSince } from './cron';
import { Policy, skillScriptRule } from './policy';
import { audit, enqueue, hasOpenScheduled, newId, scheduledToday } from './queue';
import { checkWake } from './wake';
import { LoopEvent } from './gates';
import { clip } from './textutil';

/**
 * Scheduling per goal, pure of `vscode`: when a goal is due, the zero-token wake check, the daily cap, the alert for an
 * urgent probe and the "silent goal" watchdog. `extension.ts` supplies the I/O (alerts, secrets, policies).
 */
export const goalKey = (agent: string, g: GoalDef): string => (g.id === 'default' ? agent : `${agent}#${g.id}`);

export interface GoalIO {
  /** goalKey -> UTC minute of the last slot handled (schedule-state.json). */
  lastFired: Map<string, string>;
  save(): void;
  /** The policy for runs of this goal (also what its wakeIf must pass). */
  policy(agent: AgentDef, goal: GoalDef): Policy;
  skills: Map<string, SkillDef>;
  secrets(): Promise<Record<string, string>>;
  alert(ev: LoopEvent): Promise<void>;
  /** goalKey -> last wake error already alerted, so a broken probe alerts once. */
  wakeErrors: Map<string, string>;
  log(line: string): void;
  /** goalKey -> probe output of the last `alert` sent (in memory), so an unchanged finding is not announced again while its run is still open. */
  lastAlert?: Map<string, string>;
}

/** Goals that should fire now. `catchUp` lists only those that missed a slot while the team was not running. */
export function goalsDue(team: Iterable<AgentDef>, lastFired: Map<string, string>, now: Date, catchUp: boolean): { agent: AgentDef; goal: GoalDef; missed: boolean }[] {
  const out: { agent: AgentDef; goal: GoalDef; missed: boolean }[] = [];
  const minute = minuteKey(now);
  for (const agent of team) {
    for (const goal of agent.goals) {
      if (!goal.schedule || !goal.task) { continue; }
      const last = lastFired.get(goalKey(agent.name, goal));
      const missed = missedSince(goal.schedule, last, now);
      if (catchUp ? !missed : last === minute || (!cronMatches(goal.schedule, now) && !missed)) { continue; }
      out.push({ agent, goal, missed: !cronMatches(goal.schedule, now) });
    }
  }
  return out;
}

/** Run one goal's wake check and, if it says so, enqueue the run. An urgent probe tells the human first. */
export async function fireGoal(root: string, agent: AgentDef, goal: GoalDef, now: Date, io: GoalIO): Promise<void> {
  const key = goalKey(agent.name, goal);
  const day = now.toISOString().slice(0, 10);
  io.lastFired.set(key, minuteKey(now));
  io.save();
  // An urgent goal's probe keeps running while its previous item is open (parked overnight on a question, say): telling
  // the human must not depend on the model pipeline. Such a probe must be idempotent: it must not consume events.
  const probeAnyway = !!goal.urgent && !!goal.wakeIf;
  const open = hasOpenScheduled(root, agent.name, goal.id);
  if (open && !probeAnyway) {
    // Not a gap in monitoring: the goal is being handled. Recorded as a check so `maxSilence` does not fire.
    audit(root, `wake-${day}`, { type: 'wake', agent: agent.name, goal: goal.id, wake: false, open: true });
    return;
  }
  const capped = goal.maxRunsPerDay !== undefined && scheduledToday(root, agent.name, now, goal.id) >= goal.maxRunsPerDay;
  if (capped && !probeAnyway) {
    audit(root, `wake-${day}`, { type: 'wake', agent: agent.name, goal: goal.id, wake: false, capped: goal.maxRunsPerDay });
    return;
  }
  const extraAllow = skillsFor(agent, goal.id).map(s => io.skills.get(s)).filter((s): s is SkillDef => !!s).map(s => skillScriptRule(s.relDir));
  const w = await checkWake(root, goal, io.policy(agent, goal), extraAllow, await io.secrets());
  audit(root, `wake-${day}`, { type: 'wake', agent: agent.name, goal: goal.id, wake: w.wake, error: w.error });
  const label = goal.id === 'default' ? agent.name : `${agent.name}/${goal.id}`;
  if (w.error) {
    if (io.wakeErrors.get(key) !== w.error) {
      io.wakeErrors.set(key, w.error);
      await io.alert({ kind: 'error', agent: agent.name, title: `${label}: wakeIf check is failing`, detail: w.error });
    }
    return;
  }
  if (io.wakeErrors.delete(key)) { io.log(`${label}: wakeIf recovered.`); }
  if (!w.wake) { return; }
  // The human hears about it even if the model is rate-limited or slow.
  if (probeAnyway) {
    const out = w.context ?? '';
    if (!(open && io.lastAlert?.get(key) === out)) {
      io.lastAlert?.set(key, out);
      await io.alert({ kind: 'alert', agent: agent.name, title: `${label}: probe found something`, detail: clip(out, 500) });
    }
  }
  // One item per goal at a time, and the daily cap limits runs (not probes).
  if (open) { return; }
  if (capped) {
    audit(root, `wake-${day}`, { type: 'wake', agent: agent.name, goal: goal.id, wake: false, capped: goal.maxRunsPerDay });
    return;
  }
  enqueue(root, {
    id: newId(), agent: agent.name, task: goal.task, context: w.context, from: 'schedule', chainId: newId(), hop: 0, createdAt: now.toISOString(),
    ...(goal.id === 'default' && !agent.goals.some(g => g.id !== 'default') ? {} : { goal: goal.id }), ...(goal.urgent ? { urgent: true } : {})
  });
}

/** When the latest wake check that actually ran (found something or not) for this goal happened. Capped and broken checks do not count. */
export function lastCheck(root: string, agent: string, goalId: string): Date | undefined {
  const dir = path.join(root, '.loop', 'runs');
  let days: string[] = [];
  try { days = fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort().reverse(); } catch { return undefined; }
  for (const day of days) {
    let best = '';
    let names: string[] = [];
    try { names = fs.readdirSync(path.join(dir, day)).filter(n => n.startsWith('wake-') && n.endsWith('.jsonl')); } catch { continue; }
    for (const n of names) {
      for (const l of fs.readFileSync(path.join(dir, day, n), 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(l);
          if (e.type === 'wake' && e.agent === agent && (e.goal ?? 'default') === goalId && !e.error && e.capped === undefined && typeof e.ts === 'string' && e.ts > best) { best = e.ts; }
        } catch { /* a torn line is ignored */ }
      }
    }
    if (best) { return new Date(best); }
  }
  return undefined;
}

/**
 * Tell the human once when a goal with `maxSilence` has had no wake check for that long (measured from the team's start
 * if none ran yet). `notified` remembers which goals were announced; a check that runs again clears the mark.
 */
export async function checkSilence(root: string, team: Iterable<AgentDef>, startedAt: Date, now: Date, notified: Set<string>, alert: (ev: LoopEvent) => Promise<void>): Promise<void> {
  for (const agent of team) {
    for (const goal of agent.goals) {
      if (!goal.maxSilenceMs || !goal.schedule) { continue; }
      const key = goalKey(agent.name, goal);
      const last = lastCheck(root, agent.name, goal.id) ?? startedAt;
      const silent = now.getTime() - last.getTime() > goal.maxSilenceMs;
      if (!silent) { notified.delete(key); continue; }
      if (notified.has(key)) { continue; }
      notified.add(key);
      const mins = Math.round((now.getTime() - last.getTime()) / 60000);
      await alert({ kind: 'goal_silent', agent: agent.name, title: `${agent.name}/${goal.id}: no wake check for ${mins} minutes`, detail: `${goal.text}. Its probe has not run or has been failing since ${last.toISOString()}.` });
    }
  }
}
