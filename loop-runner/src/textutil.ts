/** Small text helpers shared by the console and the chat thread. No vscode. */
export const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);
export const firstLine = (s: string): string => s.split('\n').find(l => l.trim()) ?? '';

/** The agent(s) with a run in progress: one name, or several now that more than one run can be live. */
export type Active = string | readonly string[] | undefined;
export const isActive = (active: Active, agent: string): boolean => (Array.isArray(active) ? active.includes(agent) : active === agent);

/** One short phrase about what a tool call touched: its path, command, pattern or first string argument. */
export function brief(input: unknown): string {
  if (!input || typeof input !== 'object') { return ''; }
  const o = input as Record<string, unknown>;
  const v = o.path ?? o.command ?? o.pattern ?? o.title ?? Object.values(o).find(x => typeof x === 'string');
  return typeof v === 'string' ? clip(firstLine(v), 90) : '';
}

/** A tool call in plain words, for display only. Generic: it knows paths and argument shapes, never a particular skill. */
export interface Humanized { phrase: string; routine: boolean; /** What it folds under: a skill name, or 'read' / 'list'. */ fam?: string; famKind?: 'skill' | 'read' | 'list' }

const SKILL_SCRIPT = /\.github\/skills\/([\w.-]+)\/scripts\/([^\s'"]+)/;
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() || p;

export function humanize(name: string, input: unknown): Humanized {
  const o = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  switch (name) {
    case 'read_file': return { phrase: `Read ${base(s(o.path)) || 'a file'}`, routine: true, fam: 'read', famKind: 'read' };
    // list_dir is no longer a tool; old audit logs still contain it, so it keeps rendering.
    case 'list_dir': return { phrase: `Listed ${base(s(o.path) || '.') || '.'}`, routine: true, fam: 'list', famKind: 'list' };
    case 'write_file': return { phrase: `Wrote ${s(o.path)}`.trim(), routine: false };
    case 'edit_file': return { phrase: `Edited ${s(o.path)}`.trim(), routine: false };
    case 'handoff': return { phrase: `Handed to ${s(o.to) || '?'}${s(o.task) ? `: ${clip(firstLine(s(o.task)), 140)}` : ''}`, routine: false };
    case 'run_command': {
      const cmd = firstLine(s(o.command)).trim();
      const m = SKILL_SCRIPT.exec(cmd);
      if (m) {
        const rest = cmd.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean);
        const script = base(m[2]).replace(/\.\w+$/, '');
        const sub = (rest[0] && !rest[0].startsWith('-') ? rest[0] : (script !== m[1] ? script : '')).replace(/^['"]|['"]$/g, '');
        return { phrase: sub ? `${m[1]} · ${clip(sub, 40)}` : m[1], routine: true, fam: m[1], famKind: 'skill' };
      }
      const toks = cmd.split(/\s+/).filter(t => t && !/^\w+=/.test(t));
      const prog = base(toks[0] ?? '') || 'command';
      const rest = toks.slice(1).join(' ');
      return { phrase: `Ran ${rest ? `${prog} ${clip(rest, 48)}` : prog}`, routine: false };
    }
    default: return { phrase: `${name}${brief(input) ? ` · ${clip(brief(input), 48)}` : ''}`, routine: false };
  }
}

/** A `run_command` that policy refused, with the rule that did it. Both the run list and the chat thread read it from the audit. */
export function refusalOf(name: unknown, input: any, result: string): { command: string; rule: string } | undefined {
  if (name !== 'run_command' || typeof input?.command !== 'string') { return undefined; }
  const m = /^REFUSED by policy \((.+?)\)/.exec(result);
  return m ? { command: String(input.command).slice(0, 500), rule: m[1] } : undefined;
}
