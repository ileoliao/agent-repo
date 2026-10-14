import { pausedAgents } from './maintenance';
import * as fs from 'fs';
import * as path from 'path';
import { loadAllAgents } from './team';
import { nextMatch } from './cron';
import { listGates } from './queue';
import { Active, isActive } from './textutil';

export interface AgentRow {
  name: string;
  description: string;
  /** running: this agent holds the worker; waiting: a gate of its own is open; idle: neither. */
  state: 'running' | 'waiting' | 'idle';
  model?: string;
  schedule?: string;
  /** Next scheduled wake, if the agent has a schedule. */
  next?: Date;
  /** Latest wake check: whether it found work, and when. */
  lastWake?: { wake: boolean; at: string; capped?: number };
  /** What wakes it besides a person: `schedule` text and `on:` triggers, one entry per goal that has one. */
  triggers?: { kind: 'schedule' | 'webhook' | 'file'; text: string }[];
  /** The same wakes grouped by goal: an agent may look after several things, each on its own clock or event. */
  goals?: { id: string; text: string; triggers: { kind: 'schedule' | 'webhook' | 'file'; text: string }[] }[];
  /** Its scheduled and event wakes are skipped (a task given by hand still runs). */
  paused?: boolean;
  /** Workspace-relative path of the agent file. */
  file: string;
}

/** Latest wake check per agent, from the newest `wake-<date>.jsonl` files (the last two days). */
function lastWakes(root: string): Map<string, { wake: boolean; at: string; capped?: number }> {
  const out = new Map<string, { wake: boolean; at: string; capped?: number }>();
  const dir = path.join(root, '.loop', 'runs');
  if (!fs.existsSync(dir)) { return out; }
  const days = fs.readdirSync(dir).filter(d => fs.statSync(path.join(dir, d)).isDirectory()).sort().slice(-2);
  for (const day of days) {
    const d = path.join(dir, day);
    for (const name of fs.readdirSync(d).filter(n => n.startsWith('wake-') && n.endsWith('.jsonl')).sort()) {
      for (const line of fs.readFileSync(path.join(d, name), 'utf8').split('\n').filter(Boolean)) {
        try {
          const e = JSON.parse(line);
          if (e.type === 'wake' && typeof e.agent === 'string') { out.set(e.agent, { wake: !!e.wake, at: String(e.ts ?? ''), capped: typeof e.capped === 'number' ? e.capped : undefined }); }
        } catch { /* a torn line is ignored */ }
      }
    }
  }
  return out;
}

/** One row per agent that has joined the unattended team. Read-only. */
export function agentRows(root: string, activeAgent?: Active, now = new Date()): AgentRow[] {
  const wakes = lastWakes(root);
  const gates = listGates(root).filter(g => g.status === 'pending');
  const paused = pausedAgents(root);
  return [...loadAllAgents(root).values()].filter(a => a.inLoop).map(a => ({
    name: a.name,
    description: a.description,
    state: isActive(activeAgent, a.name) ? 'running' : gates.some(g => g.agent === a.name) ? 'waiting' : 'idle',
    model: a.models[0] ?? a.modelFamily,
    schedule: a.goals.find(g => g.schedule)?.schedule,
    next: a.goals.flatMap(g => (g.schedule ? [nextMatch(g.schedule, now)] : [])).filter((d): d is Date => !!d).sort((x, y) => x.getTime() - y.getTime())[0],
    lastWake: wakes.get(a.name),
    triggers: a.goals.flatMap(g => [...(g.schedule ? [{ kind: 'schedule' as const, text: g.schedule }] : []), ...(g.on ? [{ kind: (g.on.startsWith('webhook:') ? 'webhook' : 'file') as 'webhook' | 'file', text: g.on.replace(/^(webhook|file):/, '') }] : [])]),
    goals: a.goals.map(g => ({ id: g.id, text: g.text, triggers: [...(g.schedule ? [{ kind: 'schedule' as const, text: g.schedule }] : []), ...(g.on ? [{ kind: (g.on.startsWith('webhook:') ? 'webhook' : 'file') as 'webhook' | 'file', text: g.on.replace(/^(webhook|file):/, '') }] : [])] })),
    paused: paused.has(a.name) || undefined,
    file: a.file
  }));
}

/** Earliest upcoming wake across all scheduled agents. */
export function nextWake(rows: AgentRow[]): { agent: string; at: Date } | undefined {
  return rows.filter(r => r.next).map(r => ({ agent: r.name, at: r.next! })).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}

export interface BarState {
  running: boolean;
  /** Questions and approvals waiting on the human. */
  pending: number;
  /** Mates with a run in progress, in the order they started. */
  active: string[];
  /** The step the single running mate is on. */
  step?: number;
  /** The next scheduled wake, as HH:MM. */
  next?: string;
}

/**
 * The one status bar item. In priority: something needs you; a mate is working; mates are on and quiet; mates are off.
 * Pure, so the wording is tested without VS Code.
 */
export function statusBar(s: BarState): { text: string; tooltip: string } {
  const names = s.active.join(', ');
  if (s.pending > 0) {
    return {
      text: `$(bell-dot) ${s.pending} ${s.pending === 1 ? 'needs' : 'need'} you${names ? ` · ${names} working` : ''}`,
      tooltip: `${s.pending === 1 ? 'One thing needs' : `${s.pending} things need`} you: click to open Harbor Mate.`
    };
  }
  if (s.active.length) {
    return {
      text: `$(sync~spin) ${names}${s.active.length === 1 && s.step ? ` · step ${s.step}` : ''}`,
      tooltip: `${names} ${s.active.length === 1 ? 'is' : 'are'} working: click to open Harbor Mate.`
    };
  }
  if (s.running) {
    return { text: `$(check) Mates${s.next ? ` · next ${s.next}` : ''}`, tooltip: `Mates are on and nothing needs you${s.next ? `; the next wake is at ${s.next}` : ''}: click to open Harbor Mate.` };
  }
  return { text: '$(circle-slash) Mates off', tooltip: 'Mates are off: click to open Harbor Mate and start them.' };
}
