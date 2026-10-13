import * as fs from 'fs';
import * as path from 'path';
import { loadAllAgents, loadSkills, policyPathFor, skillsFor, validateTeam, loadAgents } from './team';
import { decideCommand, loadPolicy, skillScriptRule } from './policy';
import { exec } from './exec';
import { designWarnings } from './manage';

/**
 * "Can this agent run?" answered without a model: the things that break a first run are almost always the
 * environment (a missing skill, an interpreter that is not installed, a probe that cannot run, a policy that does
 * not parse), and all of them can be checked up front. Each finding says what is wrong and what to do about it.
 */
export type Level = 'ok' | 'warn' | 'fail';
export interface Check { agent: string; level: Level; what: string; fix?: string }
export interface DoctorReport { checks: Check[]; ready: string[]; blocked: string[] }
export interface DoctorOptions {
  agent?: string;
  /** Run each wakeIf probe once, as a scheduled wake would. Probes are skill scripts the agent is already allowed to run. */
  runProbes?: boolean;
  secrets?: Record<string, string>;
  /** Fallback policy file when an agent names none. */
  policyFile?: string;
  /** Test hook: where interpreters are looked up. */
  pathEnv?: string;
}

const INTERPRETER: Record<string, string[]> = { '.py': ['python3', 'python', 'py'], '.js': ['node'], '.mjs': ['node'], '.cjs': ['node'], '.sh': ['bash', 'sh'], '.ps1': ['pwsh', 'powershell'] };

export function onPath(cmds: string[], pathEnv = process.env.PATH ?? ''): string | undefined {
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const c of cmds) {
    for (const d of pathEnv.split(path.delimiter).filter(Boolean)) {
      for (const e of exts) { try { fs.accessSync(path.join(d, c + e), fs.constants.X_OK); return c; } catch { /* next */ } }
    }
  }
  return undefined;
}

export async function runDoctor(root: string, o: DoctorOptions = {}): Promise<DoctorReport> {
  const all = loadAllAgents(root);
  const skills = loadSkills(root);
  const team = loadAgents(root);
  const targets = [...all.values()].filter(a => a.inLoop && (!o.agent || a.name === o.agent));
  const checks: Check[] = [];
  const add = (agent: string, level: Level, what: string, fix?: string) => checks.push({ agent, level, what, fix });

  if (o.agent && !targets.length) {
    add(o.agent, 'fail', all.has(o.agent) ? `${o.agent} has no loop: block, so it does not run unattended.` : `There is no agent named ${o.agent}.`, 'Use list_agents to see the team.');
    return { checks, ready: [], blocked: [o.agent] };
  }
  if (!targets.length) { add('team', 'fail', 'No agent has a loop: block yet, so nothing can run unattended.', 'Create one (propose_agent) or run Get Started.'); }

  // Config problems found by the same validator Reload uses, attributed to their agent.
  const problems = validateTeam(team, skills, all);
  for (const t of targets) { for (const p of problems.filter(x => x.startsWith(`${t.name}:`))) { add(t.name, 'fail', p.slice(t.name.length + 2), 'Fix the agent file (propose_role_edit, propose_schedule, propose_skills).'); } }

  for (const a of targets) {
    const mySkills = skillsFor(a).map(n => skills.get(n)).filter((s): s is NonNullable<typeof s> => !!s);
    const needed = new Map<string, string[]>();
    for (const s of mySkills) {
      const dir = path.join(root, s.relDir, 'scripts');
      for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) { const c = INTERPRETER[path.extname(f).toLowerCase()]; if (c) { needed.set(c[0], c); } }
    }
    for (const [name, cands] of needed) {
      if (!onPath(cands, o.pathEnv)) { add(a.name, 'fail', `A script of its skills needs ${cands.join(' or ')}, which is not on PATH.`, `Install ${name}, or make sure VS Code is started from a shell where it is available.`); }
    }

    // Policy: it must parse, and a named file must exist.
    const polRel = policyPathFor(a, undefined, o.policyFile ?? '.loop/policy.json');
    let policy;
    try {
      policy = loadPolicy(root, polRel);
      if (a.policy && !fs.existsSync(path.join(root, a.policy))) { add(a.name, 'warn', `Its policy file ${a.policy} does not exist, so the default policy applies.`, 'Create the file, or remove loop.policy.'); }
    } catch (e: any) { add(a.name, 'fail', `Its policy file ${polRel} cannot be read: ${e?.message ?? e}`, 'Fix the JSON in that file.'); }

    // Probes: allowed by policy, and (when asked) actually runnable.
    for (const g of a.goals.filter(x => x.wakeIf)) {
      const label = g.id === 'default' ? 'Its wakeIf probe' : `The wakeIf probe of goal "${g.id}"`;
      if (!policy) { continue; }
      const extra = skillsFor(a, g.id).map(n => skills.get(n)).filter((s): s is NonNullable<typeof s> => !!s).map(s => skillScriptRule(s.relDir));
      const gate = decideCommand(policy, g.wakeIf!, extra);
      if (gate.decision !== 'allow') { add(a.name, 'fail', `${label} would be refused by policy: ${g.wakeIf}`, 'The probe must be a script inside a skill the agent lists, run as python3 .github/skills/<skill>/scripts/<file>.'); continue; }
      if (!o.runProbes) { continue; }
      const r = await exec(g.wakeIf!, { cwd: root, timeoutSec: Math.min(policy.commandTimeoutSec, 60), maxOutputBytes: policy.maxOutputBytes, secrets: o.secrets ?? {} });
      if (r.code === 0 || r.code === 1) { add(a.name, 'ok', `${label} ran: exit ${r.code} (${r.code === 0 ? 'would wake the agent' : 'nothing to do'}).`); }
      else { add(a.name, 'fail', `${label} is broken: ${r.code === null ? 'timed out' : `exit ${r.code}`}. ${r.text.slice(0, 300).replace(/\s+/g, ' ')}`, 'A probe exits 0 (work), 1 (nothing) or 2 (could not check). Fix the script; a broken probe stops scheduled runs.'); }
    }

    for (const w of designWarnings(a)) { add(a.name, 'warn', w); }
  }

  // Skills nobody uses are not an error, but a typo in a skill name shows up as a missing one above.
  const names = new Set(targets.map(t => t.name));
  const blocked = [...names].filter(n => checks.some(c => c.agent === n && c.level === 'fail'));
  return { checks, ready: [...names].filter(n => !blocked.includes(n)), blocked };
}

const ICON: Record<Level, string> = { ok: '✅', warn: '⚠️', fail: '❌' };
export function doctorMarkdown(r: DoctorReport): string {
  const head = r.blocked.length ? `**${r.blocked.length} agent${r.blocked.length > 1 ? 's' : ''} cannot run yet:** ${r.blocked.join(', ')}.` : r.ready.length ? `**${r.ready.join(', ')} ${r.ready.length > 1 ? 'are' : 'is'} ready to run.**` : '**Nothing to check yet.**';
  const by = new Map<string, Check[]>();
  for (const c of r.checks) { by.set(c.agent, [...(by.get(c.agent) ?? []), c]); }
  const body = [...by.entries()].map(([a, cs]) => `**${a}**\n${cs.map(c => `- ${ICON[c.level]} ${c.what}${c.fix ? `\n  - ${c.fix}` : ''}`).join('\n')}`).join('\n\n');
  return body ? `${head}\n\n${body}` : head;
}
