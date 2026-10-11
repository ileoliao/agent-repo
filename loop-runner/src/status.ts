import * as fs from 'fs';
import * as path from 'path';
import { loadAllAgents } from './team';
import { nextMatch } from './cron';
import { listGates } from './queue';

export interface AgentRow {
  name: string;
  /** running: this agent holds the worker; waiting: a gate of its own is open; idle: neither. */
  state: 'running' | 'waiting' | 'idle';
  model?: string;
  schedule?: string;
  /** Next scheduled wake, if the agent has a schedule. */
  next?: Date;
  /** Latest wake check: whether it found work, and when. */
  lastWake?: { wake: boolean; at: string; capped?: number };
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
export function agentRows(root: string, activeAgent?: string, now = new Date()): AgentRow[] {
  const wakes = lastWakes(root);
  const gates = listGates(root).filter(g => g.status === 'pending');
  return [...loadAllAgents(root).values()].filter(a => a.inLoop).map(a => ({
    name: a.name,
    state: a.name === activeAgent ? 'running' : gates.some(g => g.agent === a.name) ? 'waiting' : 'idle',
    model: a.models[0] ?? a.modelFamily,
    schedule: a.schedule,
    next: a.schedule ? nextMatch(a.schedule, now) : undefined,
    lastWake: wakes.get(a.name),
    file: a.file
  }));
}

/** Earliest upcoming wake across all scheduled agents. */
export function nextWake(rows: AgentRow[]): { agent: string; at: Date } | undefined {
  return rows.filter(r => r.next).map(r => ({ agent: r.name, at: r.next! })).sort((a, b) => a.at.getTime() - b.at.getTime())[0];
}
