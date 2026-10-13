import * as fs from 'fs';
import * as path from 'path';
import { parseFrontmatter } from './frontmatter';
import { validateCron } from './cron';

/** A capability. Loop Runner never knows what a skill does; it only loads and exposes it. */
export interface SkillDef {
  name: string;
  description: string;
  relDir: string;
  body: string;
}

/**
 * One standing responsibility of an agent, with its own trigger. The agent's single `schedule`/`wakeIf`/`task`/
 * `maxRunsPerDay` is read as one goal with the id `default`.
 */
export interface GoalDef {
  id: string;
  text: string;
  schedule?: string;
  wakeIf?: string;
  /** What the run is asked to do; defaults to `text`. */
  task: string;
  /** Added to the agent's skills for runs of this goal only. */
  skills: string[];
  /** Overrides the agent's policy for runs of this goal. */
  policy?: string;
  /** The human is told as soon as the probe finds something, and the run may use the reserved worker. */
  urgent?: boolean;
  /** Milliseconds without a wake check that ran before the human is told. */
  maxSilenceMs?: number;
  maxRunsPerDay?: number;
}

/**
 * A role, defined in VS Code's own custom-agent format (.github/agents/*.agent.md) so the same file
 * works interactively in Copilot Chat and unattended in Loop Runner. Native fields are reused
 * (name, description, model, handoffs); loop-only settings live under a `loop:` block, which
 * VS Code does not use. Only agents with a `loop:` block join the team.
 */
export interface AgentDef {
  name: string;
  description: string;
  body: string;
  /** Native `handoffs[].agent`: who this agent may pass work to. */
  handoffs: string[];
  /** Native `model`: VS Code display names, in priority order. */
  models: string[];
  // ---- loop: block ----
  skills: string[];
  schedule?: string;
  task?: string;
  /** Command run before a scheduled wake-up: exit 0 = wake (stdout becomes context), 1 = nothing to do. */
  wakeIf?: string;
  /** Copilot model family override for unattended runs (e.g. claude-sonnet-4.5). */
  modelFamily?: string;
  maxSteps?: number;
  /** Scheduled wakes allowed per local day (all outcomes count). Unset = no cap. */
  maxRunsPerDay?: number;
  policy?: string;
  /** Standing responsibilities: `loop.goals`, plus the legacy single schedule as `default`. */
  goals: GoalDef[];
  file: string;
}

export const SKILL_DIRS = ['.github/skills', '.agents/skills', '.claude/skills', '.loop/skills'];
export const AGENT_DIR = '.github/agents';

export function loadSkills(root: string): Map<string, SkillDef> {
  const skills = new Map<string, SkillDef>();
  for (const base of SKILL_DIRS) {
    const abs = path.join(root, base);
    if (!fs.existsSync(abs)) { continue; }
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (!d.isDirectory()) { continue; }
      const f = path.join(abs, d.name, 'SKILL.md');
      if (!fs.existsSync(f)) { continue; }
      const { meta, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
      const name = String(meta.name ?? d.name);
      if (!skills.has(name)) {
        skills.set(name, { name, description: String(meta.description ?? ''), relDir: path.posix.join(base, d.name), body });
      }
    }
  }
  return skills;
}

/** Every agent in .github/agents, team member or not. */
export function loadAllAgents(root: string): Map<string, AgentDef & { inLoop: boolean }> {
  const agents = new Map<string, AgentDef & { inLoop: boolean }>();
  const abs = path.join(root, AGENT_DIR);
  if (!fs.existsSync(abs)) { return agents; }
  for (const f of fs.readdirSync(abs).filter(x => x.endsWith('.md')).sort()) {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(abs, f), 'utf8'));
    const loop = meta.loop && typeof meta.loop === 'object' && !Array.isArray(meta.loop) ? meta.loop : undefined;
    const name = String(meta.name ?? f.replace(/(\.agent)?\.md$/, ''));
    const task = loop?.task ? String(loop.task) : undefined;
    const goals = [
      ...(loop?.schedule ? [{ id: 'default', text: task ?? '', schedule: String(loop.schedule), wakeIf: loop.wakeIf ? String(loop.wakeIf) : undefined, task: task ?? '', skills: [],
        maxRunsPerDay: typeof loop.maxRunsPerDay === 'number' ? loop.maxRunsPerDay : undefined } as GoalDef] : []),
      ...list(loop?.goals).map(readGoal)
    ];
    agents.set(name, {
      name,
      description: String(meta.description ?? ''),
      body,
      handoffs: list(meta.handoffs).map((h: any) => (typeof h === 'object' && h ? String(h.agent ?? '') : String(h))).filter(Boolean),
      models: list(meta.model).map(String),
      skills: list(loop?.skills).map(String),
      schedule: loop?.schedule ? String(loop.schedule) : undefined,
      task: loop?.task ? String(loop.task) : undefined,
      wakeIf: loop?.wakeIf ? String(loop.wakeIf) : undefined,
      modelFamily: loop?.model ? String(loop.model) : undefined,
      maxSteps: typeof loop?.maxSteps === 'number' ? loop.maxSteps : undefined,
      maxRunsPerDay: typeof loop?.maxRunsPerDay === 'number' ? loop.maxRunsPerDay : undefined,
      policy: loop?.policy ? String(loop.policy) : undefined,
      goals,
      file: path.posix.join(AGENT_DIR, f),
      inLoop: !!loop
    });
  }
  return agents;
}

function readGoal(g: any): GoalDef {
  const o = g && typeof g === 'object' ? g : {};
  const text = String(o.text ?? '');
  return {
    id: String(o.id ?? ''), text,
    schedule: o.schedule ? String(o.schedule) : undefined,
    wakeIf: o.wakeIf ? String(o.wakeIf) : undefined,
    task: o.task ? String(o.task) : text,
    skills: list(o.skills).map(String),
    policy: o.policy ? String(o.policy) : undefined,
    urgent: o.urgent === true || o.urgent === 'true' ? true : undefined,
    maxSilenceMs: o.maxSilence !== undefined ? parseSilence(String(o.maxSilence)) ?? NaN : undefined,
    maxRunsPerDay: typeof o.maxRunsPerDay === 'number' ? o.maxRunsPerDay : undefined
  };
}

/** `30m` or `2h` as milliseconds. */
export function parseSilence(s: string): number | undefined {
  const m = /^(\d+)\s*([mh])$/.exec(s.trim());
  return m && Number(m[1]) > 0 ? Number(m[1]) * (m[2] === 'h' ? 3600_000 : 60_000) : undefined;
}

/** Skills for a run: the agent's, plus the triggering goal's own. */
export function skillsFor(agent: AgentDef, goalId?: string): string[] {
  const g = goalId ? agent.goals.find(x => x.id === goalId) : undefined;
  return [...new Set([...agent.skills, ...(g?.skills ?? [])])];
}

/** Policy file for a run: the goal's, else the agent's, else the setting's default. */
export function policyPathFor(agent: AgentDef, goalId: string | undefined, fallback: string): string {
  return agent.goals.find(x => x.id === goalId)?.policy ?? agent.policy ?? fallback;
}

/** The team: agents that opted in with a `loop:` block. */
export function loadAgents(root: string): Map<string, AgentDef> {
  const team = new Map<string, AgentDef>();
  for (const [k, a] of loadAllAgents(root)) {
    if (a.inLoop) { team.set(k, a); }
  }
  return team;
}

export function validateTeam(team: Map<string, AgentDef>, skills: Map<string, SkillDef>, all?: Map<string, AgentDef>): string[] {
  const errors: string[] = [];
  for (const a of team.values()) {
    for (const s of a.skills) {
      if (!skills.has(s)) { errors.push(`${a.name}: skill "${s}" not found in ${SKILL_DIRS.join(', ')}`); }
    }
    for (const h of a.handoffs) {
      if (h === a.name) { errors.push(`${a.name}: cannot hand off to itself`); }
      else if (!team.has(h)) {
        errors.push(all?.has(h)
          ? `${a.name}: handoff target "${h}" exists but has no loop: block, so it cannot run unattended`
          : `${a.name}: handoff target "${h}" is not an agent in ${AGENT_DIR}`);
      }
    }
    if (a.schedule) {
      const e = validateCron(a.schedule);
      if (e) { errors.push(`${a.name}: ${e}`); }
      if (!a.task) { errors.push(`${a.name}: loop.schedule is set but loop.task is missing`); }
    }
    if (a.maxRunsPerDay !== undefined && (!Number.isInteger(a.maxRunsPerDay) || a.maxRunsPerDay < 1)) { errors.push(`${a.name}: loop.maxRunsPerDay must be a whole number of at least 1`); }
    const seen = new Set<string>(a.schedule ? ['default'] : []);
    for (const g of a.goals.filter(x => !(x.id === 'default' && a.schedule && x === a.goals[0]))) {
      const w = `${a.name}: goal "${g.id}"`;
      if (!/^[a-z0-9-]+$/.test(g.id)) { errors.push(`${a.name}: goal id "${g.id}" must match [a-z0-9-]+`); continue; }
      if (seen.has(g.id)) { errors.push(`${w}: id is used twice (or clashes with the legacy schedule, which is the goal "default")`); }
      seen.add(g.id);
      if (!g.text.trim()) { errors.push(`${w}: text is missing`); }
      if (g.schedule) { const e = validateCron(g.schedule); if (e) { errors.push(`${w}: ${e}`); } }
      if (g.wakeIf && !g.schedule) { errors.push(`${w}: wakeIf only applies to scheduled runs; add schedule`); }
      if (g.maxSilenceMs !== undefined && !(g.maxSilenceMs > 0)) { errors.push(`${w}: maxSilence must look like 30m or 2h`); }
      if (g.maxSilenceMs !== undefined && !g.schedule) { errors.push(`${w}: maxSilence needs a schedule`); }
      if (g.maxRunsPerDay !== undefined && (!Number.isInteger(g.maxRunsPerDay) || g.maxRunsPerDay < 1)) { errors.push(`${w}: maxRunsPerDay must be a whole number of at least 1`); }
      for (const s of g.skills) { if (!skills.has(s)) { errors.push(`${w}: skill "${s}" not found in ${SKILL_DIRS.join(', ')}`); } }
    }
    if (a.wakeIf && !a.schedule) { errors.push(`${a.name}: loop.wakeIf only applies to scheduled runs; add loop.schedule`); }
  }
  return errors;
}

export interface ModelInfo { id: string; name: string; family: string }

/**
 * Pick the model for an unattended run:
 *   1. loop.model  -> match by family
 *   2. native model (display names, in order) -> match by name, ignoring a " (copilot)" suffix and case
 *   3. the default family setting, else the first available
 */
export function pickModel<T extends ModelInfo>(models: T[], agent: AgentDef, defaultFamily: string): T | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/\s*\(copilot\)\s*$/, '').trim();
  if (agent.modelFamily) {
    return models.find(m => m.family === agent.modelFamily);
  }
  for (const want of agent.models) {
    const hit = models.find(m => norm(m.name) === norm(want) || m.family === want || m.id === want);
    if (hit) { return hit; }
  }
  if (defaultFamily) {
    const hit = models.find(m => m.family === defaultFamily);
    if (hit) { return hit; }
  }
  return models[0];
}

function list(v: unknown): any[] {
  if (Array.isArray(v)) { return v.filter(x => x !== null && x !== undefined && x !== ''); }
  if (v === null || v === undefined || v === '') { return []; }
  return [v];
}
