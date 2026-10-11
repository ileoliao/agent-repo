import * as fs from 'fs';
import * as path from 'path';

export interface RunSummary {
  chainId: string;
  agent: string;
  /** Final state of the chain: the last end, error, park or retry event decides it. */
  status: string;
  summary: string;
  /** ISO time of the chain's first event. */
  started: string;
  /** Audit file (`.loop/runs/<date>/<chainId>.jsonl`). */
  file: string;
}

/**
 * Newest audit chains, read from the existing `.loop/runs/<date>/<chainId>.jsonl` files. Wake checks are skipped.
 * Read-only; the runtime's data contract is unchanged.
 */
export function recentRuns(root: string, limit = 15): RunSummary[] {
  const dir = path.join(root, '.loop', 'runs');
  if (!fs.existsSync(dir)) { return []; }
  const files: { file: string; mtime: number }[] = [];
  for (const day of fs.readdirSync(dir)) {
    const d = path.join(dir, day);
    if (!fs.statSync(d).isDirectory()) { continue; }
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.jsonl') || name.startsWith('wake-')) { continue; }
      const file = path.join(d, name);
      files.push({ file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  files.sort((a, b) => b.mtime - a.mtime);
  const out: RunSummary[] = [];
  for (const { file } of files.slice(0, limit)) {
    const events = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
    if (events.length === 0) { continue; }
    const first = events[0];
    const last = [...events].reverse().find(e => ['end', 'error', 'park', 'retry'].includes(e.type));
    const status = !last ? 'running'
      : last.type === 'end' ? String(last.status ?? 'done')
      : last.type === 'park' ? 'waiting'
      : last.type === 'retry' ? 'retry' : 'error';
    out.push({
      chainId: String(first.chainId ?? path.basename(file, '.jsonl')),
      agent: String(events.find(e => e.agent)?.agent ?? '?'),
      status,
      summary: String(last?.summary ?? last?.message ?? last?.reason ?? ''),
      started: String(first.ts ?? ''),
      file
    });
  }
  return out;
}
