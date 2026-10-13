import * as fs from 'fs';
import * as path from 'path';
import { Change, GoalInput, Proposed, applyChange, diffOf, memoryFor, proposeAgent, proposeAgentRemove, proposeForget, proposeGoals, proposeRemember, proposeRoleEdit, proposeSchedule, proposeSkills } from './manage';
import { proposeSkill, proposeSkillEdit } from './skillAuthoring';
import { loadAllAgents, loadSkills } from './team';
import { listGates } from './queue';
import { DEFAULT_RETENTION, cancelQueued, describeResult, listQueue, pausedAgents, planCleanup, runCleanup, setPaused, storageUsage, Retention } from './maintenance';
import { recentRuns } from './runs';
import { agentRows } from './status';
import { closeTaskByHuman, getTask, listTasks } from './tasks';
import { Active } from './textutil';

/**
 * The tools behind `@mate` in the Chat window. Reading tools answer at once. Everything that changes something
 * returns a Proposal: the human sees what would happen (a diff, a task, an answer) and presses Apply.
 * The chat model never changes a file, runs an agent or answers a gate by itself.
 * Pure over a small host interface, so the whole thing is tested without VS Code.
 */
export interface ChatHost {
  root: string;
  state(): { running: boolean; active?: Active };
  /** Queue a task for a team agent. */
  submit(agent: string, task: string): void;
  /** Answer a pending question gate. */
  answer(gateId: string, text: string): void;
  /** Start or stop the team. */
  power(on: boolean): Promise<void>;
  /** Re-read agent files; returns config problems. */
  reload(): Promise<string[]>;
  /** Stop the agent's running item for good. Returns false when it is not running. */
  cancel?(agent: string): boolean;
  /** How long finished work is kept (the user's settings). Defaults to `DEFAULT_RETENTION`. */
  retention?: Retention;
  /** The agent authoring guide shipped with the extension. Defaults to guides/authoring.md next to out/. */
  guidePath?: string;
  /** The skill authoring guide. Defaults to guides/skill-authoring.md next to out/. */
  skillGuidePath?: string;
}

export interface Proposal {
  title: string;
  /** Markdown shown with the Apply button. */
  detail: string;
  apply(): Promise<string>;
}

export interface ToolResult { text: string; proposal?: Proposal }

export interface ChatTool { name: string; description: string; inputSchema: object }

const obj = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required });
const str = (description: string) => ({ type: 'string', description });

export const CHAT_TOOLS: ChatTool[] = [
  { name: 'list_agents', description: 'List every agent with whether it runs unattended, its state, schedule, task text, model and next wake. Use before changing anything.', inputSchema: obj({}, []) },
  { name: 'get_agent', description: "Read an agent file (its loop: settings and role instructions).", inputSchema: obj({ agent: str('Agent name') }, ['agent']) },
  { name: 'list_pending', description: 'List the questions and approvals waiting for the human, with their ids.', inputSchema: obj({}, []) },
  { name: 'recent_runs', description: 'Recent runs with status, summary, steps and the files they wrote.', inputSchema: obj({ agent: str('Only this agent (optional)') }, []) },
  { name: 'list_tasks', description: 'List the tasks agents have in progress: who holds each, what each holder will do next, and the last update.', inputSchema: obj({ agent: str('Only tasks this agent holds (optional)') }, []) },
  { name: 'get_memory', description: "Read the standing notes the human has given an agent (or 'all').", inputSchema: obj({ agent: str("Agent name or 'all'") }, ['agent']) },
  {
    name: 'propose_schedule',
    description: "Propose a new schedule and/or task text for an agent. schedule is a 5-field cron in LOCAL time (minute hour day-of-month month day-of-week), e.g. '*/30 9-18 * * 1-5' = every 30 minutes, 09:00-18:30, weekdays. Set off=true to stop scheduled runs. The human must apply it.",
    inputSchema: obj({ agent: str('Agent name'), schedule: str('Cron expression'), task: str('What the agent does on each scheduled run'), wakeIf: str('Optional zero-token pre-check: a command from a skill the agent lists, for example python3 .github/skills/<skill>/scripts/check.py. Exit 0 wakes the agent, 1 means nothing to do, 2 means the check is broken. An empty string removes it.'), off: { type: 'boolean', description: 'Turn scheduling off' } }, ['agent'])
  },
  {
    name: 'propose_role_edit',
    description: "Propose a change to an agent's role instructions: replace exactly one occurrence of old_text with new_text. Read the agent first and quote old_text exactly.",
    inputSchema: obj({ agent: str('Agent name'), old_text: str('Exact existing text'), new_text: str('Replacement') }, ['agent', 'old_text', 'new_text'])
  },
  {
    name: 'propose_goals',
    description: "Propose adding, changing or removing one goal (a standing responsibility with its own schedule) of an agent. op is add, update or remove. For add, give id (lowercase letters, digits, hyphens) and text; schedule is a 5-field cron in LOCAL time; wakeIf is a zero-token pre-check command (needs a schedule). update changes only the fields you give. The single top-level schedule of an agent is changed with propose_schedule, not here. Call get_authoring_guide first. The human must apply it.",
    inputSchema: obj({ agent: str('Agent name'), op: { type: 'string', enum: ['add', 'update', 'remove'] }, id: str('Goal id'), text: str('What the agent is responsible for'), schedule: str('Cron expression'), wakeIf: str('Pre-check command'), task: str('What a run does (defaults to text)'),
      skills: { type: 'array', items: { type: 'string' }, description: 'Extra skills for runs of this goal only' }, policy: str('Existing file under .loop/policies/'), urgent: { type: 'boolean', description: 'Tell the human as soon as the pre-check finds something' }, maxSilence: str('For example 2h: tell the human if no pre-check ran for this long'), maxRunsPerDay: { type: 'number', description: 'Whole number, at least 1' } }, ['agent', 'op', 'id'])
  },
  {
    name: 'propose_skills',
    description: "Propose adding or removing skills in an agent's loop.skills. A skill must already exist in the workspace (list them by reading an agent's file or the authoring guide); this tool does not create skills. The human must apply it.",
    inputSchema: obj({ agent: str('Agent name'), add: { type: 'array', items: { type: 'string' } }, remove: { type: 'array', items: { type: 'string' } } }, ['agent'])
  },
  {
    name: 'propose_agent',
    description: "Propose creating a new agent file. Call get_authoring_guide and list_agents first. The new agent does NOT run on its own unless you give it a schedule or goals; leave them out unless the human asked for automatic runs. Skills and the policy must already exist (policy is a file under .loop/policies/; this tool cannot create skills or policies). The human must apply it.",
    inputSchema: obj({ name: str('Lowercase letters, digits and hyphens'), description: str('One sentence: what it does (teammates read this to decide handoffs)'), instructions: str('The role instructions: how the agent works'),
      skills: { type: 'array', items: { type: 'string' } }, handoffs: { type: 'array', items: { type: 'string' }, description: 'Names of existing team agents it may hand work to' }, model: str('Optional VS Code model display name'),
      schedule: str('Optional cron (LOCAL time); needs task'), task: str('What a scheduled run does'), goals: { type: 'array', items: { type: 'object' }, description: 'Optional goals, same fields as propose_goals' },
      policy: str('Existing file under .loop/policies/'), maxSteps: { type: 'number' }, maxRunsPerDay: { type: 'number' } }, ['name', 'description', 'instructions'])
  },
  {
    name: 'propose_skill',
    description: "Propose creating a new skill (a folder with SKILL.md and optional scripts and reference files) that agents can list in loop.skills. Read get_authoring_guide with topic 'skills' first. It never overwrites an existing skill. The scripts run unattended and are pre-approved for every agent that uses the skill, so the human reads all the code before applying: write small, plain scripts. The human must apply it.",
    inputSchema: obj({ name: str('Lowercase letters, digits and hyphens'), description: str('What the skill does AND when an agent should use it (this is what makes an agent pick it)'), instructions: str('The SKILL.md body: how to use the skill; mention every script and reference file by name'),
      scripts: { type: 'array', items: { type: 'object', properties: { name: str('File name, for example report.py'), content: str('The full file') }, required: ['name', 'content'] }, description: 'Files for scripts/ (.py .js .mjs .cjs .sh .ps1)' },
      references: { type: 'array', items: { type: 'object', properties: { name: str('File name, for example fields.md'), content: str('The full file') }, required: ['name', 'content'] }, description: 'Files for references/ (.md .txt .json .csv)' } }, ['name', 'description', 'instructions'])
  },
  {
    name: 'propose_skill_edit',
    description: "Propose a change to an existing skill under .github/skills: a new description, an edit to the instructions, and edits to its scripts and reference files. Read the skill's files first (get_skill) and quote text exactly. Each edit is { file, old_text + new_text } (replace exactly one occurrence), or { file, content } (replace or add a whole file), or { file, delete: true }. file is SKILL.md, scripts/<name> or references/<name>. The card names the agents that use the skill, because the change reaches their next unattended run. Read get_authoring_guide with topic 'skills' first. The human must apply it.",
    inputSchema: obj({ skill: str('Skill name'), description: str('New description (what it does and when to use it)'),
      edits: { type: 'array', items: { type: 'object', properties: { file: str('SKILL.md, scripts/<name> or references/<name>'), old_text: str('Exact text to replace (one occurrence)'), new_text: str('Replacement'), content: str('Whole new file content'), delete: { type: 'boolean' } }, required: ['file'] } } }, ['skill'])
  },
  { name: 'get_skill', description: "Read one skill's files: SKILL.md, scripts and reference files, and which agents use it. Use before changing a skill.", inputSchema: obj({ skill: str('Skill name') }, ['skill']) },
  { name: 'get_authoring_guide', description: "The reference for writing agents and goals for Harbor Mate (topic 'agents', the default) or skills (topic 'skills'): file format, every field, conventions. Read it before proposing a new agent, goal or skill.", inputSchema: obj({ topic: { type: 'string', enum: ['agents', 'skills'] } }, []) },
  { name: 'propose_remember', description: "Propose a standing note that every new run of an agent (or 'all' agents) is told. Use for lasting preferences and rules, not one-off tasks.", inputSchema: obj({ agent: str("Agent name or 'all'"), note: str('One short sentence') }, ['agent', 'note']) },
  { name: 'propose_forget', description: 'Propose removing the one standing note that contains the given text.', inputSchema: obj({ agent: str("Agent name or 'all'"), match: str('Text that identifies the note') }, ['agent', 'match']) },
  { name: 'propose_run', description: 'Propose giving a team agent a one-off task to run now.', inputSchema: obj({ agent: str('Agent name'), task: str('The task') }, ['agent', 'task']) },
  { name: 'propose_answer', description: 'Propose answering a pending question with the human\'s words. Never invent an answer the human did not give.', inputSchema: obj({ gate_id: str('Id from list_pending'), answer: str('The answer') }, ['gate_id', 'answer']) },
  { name: 'list_queue', description: 'List work that has not finished: queued items, items parked on a question or approval, and what is running now. Ids are for propose_cancel.', inputSchema: obj({}, []) },
  { name: 'storage_usage', description: "How much finished work Harbor Mate keeps (items, run logs, questions, tasks) and what a cleanup would remove under the current retention. Use before propose_cleanup.", inputSchema: obj({}, []) },
  { name: 'get_run', description: 'The step-by-step record of one run (tool calls, results, how it ended). Get chain ids from recent_runs.', inputSchema: obj({ chain_id: str('Chain id from recent_runs') }, ['chain_id']) },
  { name: 'propose_cleanup', description: "Propose deleting finished work: done items, run logs, answered questions and approvals, closed tasks. Shows exactly what would go; the human must apply it. Never touches pending questions, queued or parked items, or open tasks; failed or blocked runs stay unless include_problems is true. Defaults follow the retention settings (14 days for items, questions and approvals, 30 for run logs and tasks); older_than_days overrides them, 0 means everything finished.", inputSchema: obj({ agent: str('Only this agent'), older_than_days: { type: 'number', description: 'Replace the retention age for every kind' }, include_problems: { type: 'boolean', description: 'Also remove runs that ended blocked, error, max_steps or stalled' } }, []) },
  { name: 'propose_cancel', description: "Propose cancelling work that has not finished. Give the id from list_queue to cancel a queued or parked item, or just the agent name to stop what it is running now.", inputSchema: obj({ id: str('Item id from list_queue'), agent: str('Agent whose current run to stop') }, []) },
  { name: 'propose_task_close', description: 'Propose closing an open task that no agent should keep working on (it is marked dropped). Get ids from list_tasks.', inputSchema: obj({ id: str('Task id from list_tasks') }, ['id']) },
  { name: 'propose_pause', description: "Propose pausing or resuming an agent's scheduled wakes without touching its file. A paused agent still runs tasks given to it by hand.", inputSchema: obj({ agent: str('Agent name'), paused: { type: 'boolean', description: 'true to pause, false to resume' } }, ['agent', 'paused']) },
  { name: 'propose_agent_remove', description: 'Propose removing an agent from the team. Its file is moved to .loop/archive/agents/ (not deleted), so it can be restored by moving it back. Refused while it has unfinished work or other agents hand off to it.', inputSchema: obj({ agent: str('Agent name') }, ['agent']) },
  { name: 'propose_team_power', description: 'Propose starting or stopping the unattended team.', inputSchema: obj({ on: { type: 'boolean', description: 'true to start, false to stop' } }, ['on']) }
];

const json = (v: unknown) => JSON.stringify(v, null, 1);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function fromChange(p: Proposed, host: ChatHost): ToolResult {
  if ('error' in p) { return { text: `Not proposed: ${p.error}` }; }
  const c: Change = p.change;
  return {
    text: `Proposal ready: "${c.summary}". It is shown to the human with an Apply button; nothing has changed yet. Tell them briefly what it does${c.notes ? ` (${c.notes.replace(/\*\*/g, '').replace(/\n/g, ' ')})` : ''} and wait.`,
    proposal: {
      title: c.summary,
      detail: `${c.notes ? c.notes + '\n\n' : ''}` + '```diff\n' + diffOf(c) + '\n```',
      apply: async () => {
        applyChange(host.root, c);
        const problems = c.file.startsWith('.github/') ? await host.reload() : [];
        return problems.length ? `Applied ${c.file}, but the team now has config problems:\n${problems.join('\n')}` : `Applied ${c.file}.${c.file.startsWith('.github/') ? ' Team reloaded.' : ' New runs will use it.'}`;
      }
    }
  };
}

/** A multi-file proposal (a skill): every file in full on the card, all-or-nothing on Apply. */
function changeSet(p: { changes: Change[]; summary: string; notes: string } | { error: string }, host: ChatHost, verb: 'created' | 'changed'): ToolResult {
  if ('error' in p) { return { text: `Not proposed: ${p.error}` }; }
  const root = host.root;
  return {
    text: `Proposal ready: "${p.summary}" (${p.changes.length} files). It is shown to the human with an Apply button, with every file in full; nothing has been written. Tell them briefly what ${verb === 'created' ? 'the skill does' : 'changes'}, any warnings, and that scripts run unattended; then wait.\n\n${p.notes.replace(/\*\*/g, '')}`,
    proposal: {
      title: p.summary,
      detail: `${p.notes}\n\n` + p.changes.map(c => `**${c.file}**${c.delete ? ' (deleted)' : ''}\n\n\`\`\`diff\n${diffOf(c)}\n\`\`\``).join('\n\n'),
      apply: async () => {
        // All or nothing: every file is checked against what was proposed, and what was written is taken back if a later write fails.
        const undo: { file: string; before: string | null }[] = [];
        try { for (const c of p.changes) { applyChange(root, c); undo.push({ file: c.file, before: c.before }); } }
        catch (e) { for (const u of undo) { const f = path.join(root, u.file); if (u.before === null) { fs.rmSync(f, { force: true }); } else { fs.writeFileSync(f, u.before); } } throw e; }
        const problems = await host.reload();
        return problems.length ? `Applied ${p.changes.length} files, but the team has config problems:\n${problems.join('\n')}` : `${p.summary} done (${p.changes.length} files). Team reloaded.`;
      }
    }
  };
}

export async function runChatTool(name: string, input: any, host: ChatHost): Promise<ToolResult> {
  // Whatever the model sends, a tool answers with text; an exception would end the whole chat turn and hide the cause.
  try { return await runTool(name, input && typeof input === 'object' ? input : {}, host); }
  catch (e: any) { return { text: `Not proposed: that input could not be used (${e?.message ?? e}). Check the tool's parameters and try again.` }; }
}

async function runTool(name: string, input: any, host: ChatHost): Promise<ToolResult> {
  const root = host.root;
  const agents = loadAllAgents(root);
  switch (name) {
    case 'list_agents': {
      const rows = new Map(agentRows(root, host.state().active).map(r => [r.name, r]));
      return { text: json({ teamRunning: host.state().running, agents: [...agents.values()].map(a => ({
        name: a.name, description: a.description, runsUnattended: a.inLoop, paused: pausedAgents(root).has(a.name) || undefined, state: rows.get(a.name)?.state, schedule: a.schedule, task: a.task && clip(a.task, 200), goals: a.goals.map(g => ({ id: g.id, text: clip(g.text, 150), schedule: g.schedule, urgent: g.urgent })),
        model: a.modelFamily ?? a.models[0], nextWake: rows.get(a.name)?.next?.toLocaleString(), file: a.file })) }) };
    }
    case 'get_agent': {
      const a = agents.get(String(input.agent));
      return { text: a ? clip(fs.readFileSync(path.join(root, a.file), 'utf8'), 6000) : `No agent named "${input.agent}".` };
    }
    case 'list_pending':
      return { text: json(listGates(root).filter(g => g.status === 'pending').map(g => ({ id: g.id, kind: g.kind, agent: g.agent, title: g.title, body: clip(g.body, 500), options: g.options, command: g.command, files: g.files }))) };
    case 'recent_runs': {
      const runs = recentRuns(root, 12).filter(r => !input.agent || r.agent === input.agent);
      return { text: json(runs.map(r => ({ agent: r.agent, status: r.status, summary: clip(r.summary, 200), steps: r.step, started: r.started, outputs: r.outputs }))) };
    }
    case 'list_tasks':
      return { text: json(listTasks(root).filter(t => t.state === 'open' && (!input.agent || t.holders.includes(String(input.agent)))).map(t => ({
        id: t.id, title: t.title, holders: t.holders, next: t.next, updated: t.updatedAt, recent: t.log.slice(-3).map(e => ({ agent: e.agent, event: e.event, status: e.status, text: e.text && clip(e.text, 150) })) }))) };
    case 'get_memory':
      return { text: memoryFor(root, String(input.agent)) || '(nothing remembered)' };
    case 'list_queue':
      { const act = host.state().active; return { text: json({ running: act === undefined ? [] : Array.isArray(act) ? act : [act], items: listQueue(root) }) }; }
    case 'storage_usage': {
      const ret = host.retention ?? DEFAULT_RETENTION;
      const would = planCleanup(root, ret);
      return { text: json({ keeps: storageUsage(root), retention: ret, wouldRemoveNow: would.length, wouldFree: `${(would.reduce((n, v) => n + v.bytes, 0) / 1024).toFixed(0)} KB` }) };
    }
    case 'get_run': {
      const id = String(input.chain_id ?? '');
      if (!/^[A-Za-z0-9_-]+$/.test(id)) { return { text: 'That is not a chain id. Use recent_runs.' }; }
      const runs = path.join(root, '.loop', 'runs');
      const files = fs.existsSync(runs) ? fs.readdirSync(runs).map(d => path.join(runs, d, `${id}.jsonl`)).filter(f => fs.existsSync(f)) : [];
      if (!files.length) { return { text: `No run ${id}. It may have been cleaned up.` }; }
      return { text: clip(files.map(f => fs.readFileSync(f, 'utf8')).join('').split('\n').filter(Boolean).map(l => clip(l, 400)).join('\n'), 8000) };
    }
    case 'propose_cleanup': {
      const ret = host.retention ?? DEFAULT_RETENTION;
      const victims = planCleanup(root, ret, new Date(), { agent: input.agent ? String(input.agent) : undefined, olderThanDays: typeof input.older_than_days === 'number' ? input.older_than_days : undefined, includeProblems: input.include_problems === true });
      if (!victims.length) { return { text: 'Nothing to clean up under those rules.' }; }
      const by = victims.reduce<Record<string, number>>((m, v) => { m[v.kind] = (m[v.kind] ?? 0) + 1; return m; }, {});
      const title = `Clean up ${victims.length} finished file${victims.length > 1 ? 's' : ''}`;
      return {
        text: `Proposal ready: "${title}" (${Object.entries(by).map(([k, n]) => `${n} ${k}`).join(', ')}). It is shown to the human with an Apply button; nothing has been deleted. Tell them briefly what goes and wait.`,
        proposal: {
          title,
          detail: `Deleted for good (the audit trail of anything still open is kept):\n\n` + victims.slice(0, 40).map(v => `- ${v.label}, ${v.ageDays} days old`).join('\n') + (victims.length > 40 ? `\n- and ${victims.length - 40} more` : ''),
          apply: async () => describeResult(runCleanup(root, victims, 'human'))
        }
      };
    }
    case 'propose_cancel': {
      if (input.id) {
        const row = listQueue(root).find(r => r.id === String(input.id));
        if (!row) { return { text: `No queued or waiting item ${input.id}. Use list_queue.` }; }
        const title = `Cancel ${row.agent}'s ${row.state} item`;
        return { text: `Proposal ready: "${title}". Nothing has been cancelled; tell the human briefly and wait for Apply.`, proposal: { title, detail: `${row.task}\n\nIt moves to the finished list as cancelled${row.state === 'waiting' ? ', and the question or approval it is parked on is closed' : ''}.`, apply: async () => cancelQueued(root, row.id) } };
      }
      const agent = String(input.agent ?? '');
      if (!agent) { return { text: 'Give an item id from list_queue, or an agent name to stop its current run.' }; }
      if (!host.cancel) { return { text: 'Stopping a running agent is not available here.' }; }
      const title = `Stop ${agent}'s current run`;
      return { text: `Proposal ready: "${title}". Nothing has stopped yet; tell the human briefly and wait for Apply.`, proposal: { title, detail: 'The run is closed as cancelled and is not retried.', apply: async () => (host.cancel!(agent) ? `Stopped ${agent}'s run.` : `${agent} is not running anything right now.`) } };
    }
    case 'propose_task_close': {
      const t = getTask(root, String(input.id ?? ''));
      if (!t) { return { text: `No task ${input.id}. Use list_tasks.` }; }
      if (t.state !== 'open') { return { text: `Task ${t.id} is already ${t.state}.` }; }
      const title = `Close task "${clip(t.title, 60)}"`;
      return { text: `Proposal ready: "${title}". Nothing is closed yet; tell the human briefly and wait for Apply.`, proposal: { title, detail: `Held by ${t.holders.join(', ') || 'nobody'}. It is marked dropped and no agent holds it any more.`, apply: async () => (closeTaskByHuman(root, t.id) ? `Closed task ${t.id}.` : `Task ${t.id} could not be closed.`) } };
    }
    case 'propose_pause': {
      const a = agents.get(String(input.agent));
      if (!a || !a.inLoop) { return { text: `${input.agent} is not an unattended team agent. Use list_agents.` }; }
      const on = input.paused === true;
      if (pausedAgents(root).has(a.name) === on) { return { text: `${a.name} is already ${on ? 'paused' : 'running its schedule'}.` }; }
      const title = `${on ? 'Pause' : 'Resume'} ${a.name}'s schedule`;
      return { text: `Proposal ready: "${title}". Nothing has changed yet; tell the human briefly and wait for Apply.`, proposal: { title, detail: on ? 'Its scheduled wakes are skipped until resumed. Its file is untouched, and a task given by hand still runs.' : 'Its schedule runs again from the next matching minute.', apply: async () => { setPaused(root, a.name, on); return `${a.name} ${on ? 'paused' : 'resumed'}.`; } } };
    }
    case 'propose_agent_remove':
      return changeSet(proposeAgentRemove(root, String(input.agent ?? '')), host, 'changed');
    case 'propose_schedule':
      return fromChange(proposeSchedule(root, String(input.agent), { schedule: input.off ? null : input.schedule, task: input.task, wakeIf: input.wakeIf }), host);
    case 'propose_role_edit':
      return fromChange(proposeRoleEdit(root, String(input.agent), String(input.old_text ?? ''), String(input.new_text ?? '')), host);
    case 'propose_goals':
      return fromChange(proposeGoals(root, String(input.agent), String(input.op) as 'add' | 'update' | 'remove', input as GoalInput), host);
    case 'propose_skills':
      return fromChange(proposeSkills(root, String(input.agent), { add: input.add, remove: input.remove }), host);
    case 'propose_agent':
      return fromChange(proposeAgent(root, input), host);
    case 'propose_skill':
      return changeSet(proposeSkill(root, input), host, 'created');
    case 'propose_skill_edit': {
      const p = proposeSkillEdit(root, input);
      return changeSet(p, host, 'changed');
    }
    case 'get_skill': {
      const sk = loadSkills(root).get(String(input.skill));
      if (!sk) { return { text: `No skill named "${input.skill}". Skills: ${[...loadSkills(root).keys()].join(', ') || 'none'}.` }; }
      const base = path.join(root, sk.relDir);
      const files = ['SKILL.md', ...['scripts', 'references'].flatMap(d => (fs.existsSync(path.join(base, d)) ? fs.readdirSync(path.join(base, d)).filter(f => fs.statSync(path.join(base, d, f)).isFile()).map(f => `${d}/${f}`) : []))];
      const users = [...agents.values()].filter(a => a.inLoop && (a.skills.includes(sk.name) || a.goals.some(g => g.skills.includes(sk.name)))).map(a => a.name);
      return { text: `Skill ${sk.name} (${sk.relDir}). Used by: ${users.join(', ') || 'no agent yet'}.\n\n` + files.map(f => `===== ${f} =====\n${clip(fs.readFileSync(path.join(base, f), 'utf8'), 12000)}`).join('\n\n') };
    }
    case 'get_authoring_guide': {
      const skills = input.topic === 'skills';
      try { return { text: fs.readFileSync(skills ? host.skillGuidePath ?? path.join(__dirname, '..', 'guides', 'skill-authoring.md') : host.guidePath ?? path.join(__dirname, '..', 'guides', 'authoring.md'), 'utf8') }; }
      catch { return { text: 'The authoring guide could not be read. Say so, and work from get_agent on an existing agent instead.' }; }
    }
    case 'propose_remember':
      return fromChange(proposeRemember(root, String(input.agent), String(input.note ?? '')), host);
    case 'propose_forget':
      return fromChange(proposeForget(root, String(input.agent), String(input.match ?? '')), host);
    case 'propose_run': {
      const a = agents.get(String(input.agent));
      if (!a || !a.inLoop) { return { text: `Not proposed: ${input.agent} is not a team agent. Team agents: ${[...agents.values()].filter(x => x.inLoop).map(x => x.name).join(', ') || 'none'}.` }; }
      if (!String(input.task ?? '').trim()) { return { text: 'Not proposed: the task is empty.' }; }
      const task = String(input.task).trim();
      return { text: 'Proposal ready; shown to the human with an Apply button. Nothing has run yet.', proposal: {
        title: `Run ${a.name} now`, detail: `**${a.name}** will be given this task:\n\n> ${task.replace(/\n/g, '\n> ')}${host.state().running ? '' : '\n\nThe team is stopped; start it for the task to run.'}`,
        apply: async () => { host.submit(a.name, task); return `Queued for ${a.name}.${host.state().running ? '' : ' The team is stopped, so it will wait until you start it.'}`; } } };
    }
    case 'propose_answer': {
      const g = listGates(root).find(x => x.id === String(input.gate_id));
      if (!g || g.status !== 'pending') { return { text: `Not proposed: no pending gate ${input.gate_id}. Use list_pending.` }; }
      if (g.kind !== 'question') { return { text: 'Not proposed: that is an approval. Approvals are decided in the Harbor Mate Console, where the exact command and files are shown.' }; }
      const answer = String(input.answer ?? '').trim();
      if (!answer) { return { text: 'Not proposed: the answer is empty.' }; }
      return { text: 'Proposal ready; shown to the human with an Apply button. Nothing has been sent yet.', proposal: {
        title: `Answer: ${g.title}`, detail: `**${g.agent}** asked: ${g.title}\n\nAnswer to send:\n\n> ${answer.replace(/\n/g, '\n> ')}`,
        apply: async () => { host.answer(g.id, answer); return `Answered. ${g.agent} will continue.`; } } };
    }
    case 'propose_team_power': {
      const on = !!input.on;
      if (on === host.state().running) { return { text: `The team is already ${on ? 'running' : 'stopped'}.` }; }
      return { text: 'Proposal ready; shown to the human with an Apply button.', proposal: {
        title: on ? 'Start the team' : 'Stop the team', detail: on ? 'Start unattended runs and scheduled wakes.' : 'Stop the current run and all scheduled wakes.',
        apply: async () => { await host.power(on); return on ? 'Team started.' : 'Team stopped.'; } } };
    }
    default:
      return { text: `Unknown tool ${name}.` };
  }
}
