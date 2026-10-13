import * as fs from 'fs';
import * as path from 'path';
import { Change, Proposed, applyChange, diffOf, memoryFor, proposeForget, proposeRemember, proposeRoleEdit, proposeSchedule } from './manage';
import { loadAllAgents } from './team';
import { listGates } from './queue';
import { recentRuns } from './runs';
import { agentRows } from './status';
import { listTasks } from './tasks';
import { Active } from './textutil';

/**
 * The tools behind `@loop` in the Chat window. Reading tools answer at once. Everything that changes something
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
    inputSchema: obj({ agent: str('Agent name'), schedule: str('Cron expression'), task: str('What the agent does on each scheduled run'), off: { type: 'boolean', description: 'Turn scheduling off' } }, ['agent'])
  },
  {
    name: 'propose_role_edit',
    description: "Propose a change to an agent's role instructions: replace exactly one occurrence of old_text with new_text. Read the agent first and quote old_text exactly.",
    inputSchema: obj({ agent: str('Agent name'), old_text: str('Exact existing text'), new_text: str('Replacement') }, ['agent', 'old_text', 'new_text'])
  },
  { name: 'propose_remember', description: "Propose a standing note that every new run of an agent (or 'all' agents) is told. Use for lasting preferences and rules, not one-off tasks.", inputSchema: obj({ agent: str("Agent name or 'all'"), note: str('One short sentence') }, ['agent', 'note']) },
  { name: 'propose_forget', description: 'Propose removing the one standing note that contains the given text.', inputSchema: obj({ agent: str("Agent name or 'all'"), match: str('Text that identifies the note') }, ['agent', 'match']) },
  { name: 'propose_run', description: 'Propose giving a team agent a one-off task to run now.', inputSchema: obj({ agent: str('Agent name'), task: str('The task') }, ['agent', 'task']) },
  { name: 'propose_answer', description: 'Propose answering a pending question with the human\'s words. Never invent an answer the human did not give.', inputSchema: obj({ gate_id: str('Id from list_pending'), answer: str('The answer') }, ['gate_id', 'answer']) },
  { name: 'propose_team_power', description: 'Propose starting or stopping the unattended team.', inputSchema: obj({ on: { type: 'boolean', description: 'true to start, false to stop' } }, ['on']) }
];

const json = (v: unknown) => JSON.stringify(v, null, 1);
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function fromChange(p: Proposed, host: ChatHost): ToolResult {
  if ('error' in p) { return { text: `Not proposed: ${p.error}` }; }
  const c: Change = p.change;
  return {
    text: `Proposal ready: "${c.summary}". It is shown to the human with an Apply button; nothing has changed yet. Tell them briefly what it does and wait.`,
    proposal: {
      title: c.summary,
      detail: '```diff\n' + diffOf(c) + '\n```',
      apply: async () => {
        applyChange(host.root, c);
        const problems = c.file.startsWith('.github/') ? await host.reload() : [];
        return problems.length ? `Applied ${c.file}, but the team now has config problems:\n${problems.join('\n')}` : `Applied ${c.file}.${c.file.startsWith('.github/') ? ' Team reloaded.' : ' New runs will use it.'}`;
      }
    }
  };
}

export async function runChatTool(name: string, input: any, host: ChatHost): Promise<ToolResult> {
  const root = host.root;
  const agents = loadAllAgents(root);
  switch (name) {
    case 'list_agents': {
      const rows = new Map(agentRows(root, host.state().active).map(r => [r.name, r]));
      return { text: json({ teamRunning: host.state().running, agents: [...agents.values()].map(a => ({
        name: a.name, description: a.description, runsUnattended: a.inLoop, state: rows.get(a.name)?.state, schedule: a.schedule, task: a.task && clip(a.task, 200), goals: a.goals.map(g => ({ id: g.id, text: clip(g.text, 150), schedule: g.schedule, urgent: g.urgent })),
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
    case 'propose_schedule':
      return fromChange(proposeSchedule(root, String(input.agent), { schedule: input.off ? null : input.schedule, task: input.task }), host);
    case 'propose_role_edit':
      return fromChange(proposeRoleEdit(root, String(input.agent), String(input.old_text ?? ''), String(input.new_text ?? '')), host);
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
      if (g.kind !== 'question') { return { text: 'Not proposed: that is an approval. Approvals are decided in the Loop Console, where the exact command and files are shown.' }; }
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
