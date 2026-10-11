import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { parseFrontmatter } from './frontmatter';
import { validateCron } from './cron';
import { loadAllAgents } from './team';

/**
 * Changes the human asks for in conversation (schedule, task text, role instructions, standing memory).
 * Pure and vscode-free: a Change is computed, shown as a diff, and written only by `applyChange`.
 * Nothing here runs an agent or touches `.loop/` state other than the memory files.
 */
export interface Change {
  /** Workspace-relative file. */
  file: string;
  /** Exact current content the change was computed from, or null when the file does not exist yet. */
  before: string | null;
  after: string;
  summary: string;
}

export type Proposed = { change: Change } | { error: string };

const MEMORY_DIR = '.loop/memory';
const MEMORY_LIMIT = 8000;

// ---- frontmatter patching: edit one line of the `loop:` block, leave everything else byte-identical ----

/** Lines that follow `key:` for a value. Quoted scalars have no escapes in our parser, so pick a quote the text does not contain. */
function valueLines(value: string | number, pad: string): { inline?: string; block?: string[] } {
  if (typeof value === 'number') { return { inline: String(value) }; }
  if (!value.includes('\n') && !value.includes('"')) { return { inline: `"${value}"` }; }
  if (!value.includes('\n') && !value.includes("'")) { return { inline: `'${value}'` }; }
  return { block: value.split('\n').map(l => `${pad}  ${l}`) };
}

function frontmatterRange(lines: string[]): [number, number] | undefined {
  if (lines[0]?.trim() !== '---') { return undefined; }
  const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
  return end > 0 ? [0, end] : undefined;
}

/** Set (or, with undefined, remove) one field of the `loop:` block. Returns undefined when there is no loop block. */
export function setLoopField(text: string, key: string, value: string | number | undefined): string | undefined {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fm = frontmatterRange(lines);
  if (!fm) { return undefined; }
  const loopAt = lines.findIndex((l, i) => i > fm[0] && i < fm[1] && /^loop:\s*$/.test(l));
  if (loopAt < 0) { return undefined; }
  let blockEnd = loopAt + 1;
  while (blockEnd < fm[1] && (/^\s+\S/.test(lines[blockEnd]) || lines[blockEnd].trim() === '')) { blockEnd++; }
  const pad = '  ';
  const keyAt = lines.findIndex((l, i) => i > loopAt && i < blockEnd && new RegExp(`^${pad}${key}:`).test(l));
  let oldEnd = keyAt + 1;
  if (keyAt >= 0) { while (oldEnd < blockEnd && /^\s{3,}\S/.test(lines[oldEnd])) { oldEnd++; } }
  let fresh: string[] = [];
  if (value !== undefined) {
    const v = valueLines(value, pad);
    fresh = v.block ? [`${pad}${key}: |`, ...v.block] : [`${pad}${key}: ${v.inline}`];
  }
  if (keyAt >= 0) { lines.splice(keyAt, oldEnd - keyAt, ...fresh); } else { lines.splice(loopAt + 1, 0, ...fresh); }
  return lines.join(nl);
}

type Agent = ReturnType<typeof loadAllAgents> extends Map<string, infer A> ? A : never;
type Read = { ok: false; error: string } | { ok: true; agent: Agent; file: string; text: string };
/** Turn a live single-line field into a comment (`  # key: value`), so switching it back on can restore it. */
function commentOutLoopField(text: string, key: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fm = frontmatterRange(lines);
  if (!fm) { return text; }
  const at = lines.findIndex((l, i) => i > fm[0] && i < fm[1] && new RegExp(`^  ${key}:`).test(l));
  if (at < 0) { return text; }
  let end = at + 1;
  while (end < fm[1] && /^\s{3,}\S/.test(lines[end])) { end++; }
  lines.splice(at, end - at, ...lines.slice(at, end).map(l => `  # ${l.slice(2)}`));
  return lines.join(nl);
}

/** Inverse of commentOutLoopField for a single-line field. Returns the text unchanged when there is nothing to restore. */
function uncommentLoopField(text: string, key: string): string {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fm = frontmatterRange(lines);
  if (!fm) { return text; }
  const at = lines.findIndex((l, i) => i > fm[0] && i < fm[1] && new RegExp(`^  # ${key}:`).test(l));
  if (at < 0 || /^  #\s{3,}\S/.test(lines[at + 1] ?? '')) { return text; }
  lines[at] = `  ${lines[at].slice(4)}`;
  return lines.join(nl);
}

const readAgent = (root: string, name: string): Read => {
  const a = loadAllAgents(root).get(name);
  if (!a) { return { ok: false, error: `No agent named "${name}". Agents: ${[...loadAllAgents(root).keys()].join(', ') || 'none'}.` }; }
  return { ok: true, agent: a, file: a.file, text: fs.readFileSync(path.join(root, a.file), 'utf8') };
};

/** Change an agent's cron schedule and/or scheduled task text. `schedule: null` turns scheduling off. */
export function proposeSchedule(root: string, name: string, p: { schedule?: string | null; task?: string }): Proposed {
  const r = readAgent(root, name);
  if (!r.ok) { return { error: r.error }; }
  if (!r.agent.inLoop) { return { error: `${name} has no loop: block, so it does not run unattended. Add one first.` }; }
  let after = r.text;
  const notes: string[] = [];
  if (p.schedule === null) {
    // Commented out, not deleted: wakeIf is invalid without a schedule, and turning scheduling back on should bring it back.
    after = commentOutLoopField(commentOutLoopField(after, 'schedule'), 'wakeIf');
    notes.push('scheduling off (schedule and wakeIf kept as comments)');
  } else if (p.schedule !== undefined) {
    const err = validateCron(p.schedule.trim());
    if (err) { return { error: `Not a valid 5-field cron expression: ${err}` }; }
    const hadWakeIf = !!parseFrontmatter(after).meta.loop?.wakeIf;
    after = uncommentLoopField(after, 'schedule');
    after = setLoopField(after, 'schedule', p.schedule.trim())!;
    if (!hadWakeIf) { const restored = uncommentLoopField(after, 'wakeIf'); if (restored !== after) { after = restored; notes.push('wakeIf restored'); } }
    notes.unshift(`schedule \`${p.schedule.trim()}\``);
  }
  if (p.task !== undefined) {
    if (!p.task.trim()) { return { error: 'The task text cannot be empty.' }; }
    after = setLoopField(after, 'task', p.task.trim())!;
    notes.push('task text');
  }
  if (!notes.length) { return { error: 'Nothing to change: give a schedule, a task, or both.' }; }
  // A schedule needs a task to run; check the result, not the request.
  const fm = parseFrontmatter(after).meta.loop ?? {};
  if (fm.schedule && !fm.task) { return { error: `${name} has no task text, and a schedule needs one. Give a task too.` }; }
  const check = verify(after, p, fm);
  if (check) { return { error: check }; }
  return { change: { file: r.file, before: r.text, after, summary: `${name}: ${notes.join(', ')}` } };
}

/** The patched file must read back as exactly what was asked, or nothing is proposed. */
function verify(after: string, p: { schedule?: string | null; task?: string }, loop: any): string | undefined {
  if (typeof p.schedule === 'string' && String(loop.schedule) !== p.schedule.trim()) { return 'Could not write that schedule safely.'; }
  if (p.schedule === null && loop.schedule) { return 'Could not turn the schedule off safely.'; }
  if (p.task !== undefined && String(loop.task) !== p.task.trim()) { return 'Could not write that task text safely; try simpler wording.'; }
  return parseFrontmatter(after).body === undefined ? 'The agent file would no longer parse.' : undefined;
}

/** Replace exactly one occurrence of `oldText` in an agent's role instructions (the body, never the frontmatter). */
export function proposeRoleEdit(root: string, name: string, oldText: string, newText: string): Proposed {
  const r = readAgent(root, name);
  if (!r.ok) { return { error: r.error }; }
  const lines = r.text.split(/\r?\n/);
  const fm = frontmatterRange(lines);
  const nl = r.text.includes('\r\n') ? '\r\n' : '\n';
  const head = fm ? lines.slice(0, fm[1] + 1).join(nl) + nl : '';
  const body = fm ? lines.slice(fm[1] + 1).join(nl) : r.text;
  if (!oldText) { return { error: 'oldText is empty.' }; }
  const n = body.split(oldText).length - 1;
  if (n !== 1) { return { error: n === 0 ? 'That text was not found in the role instructions.' : `That text appears ${n} times; quote more of it so it is unique.` }; }
  const after = head + body.replace(oldText, () => newText);
  return { change: { file: r.file, before: r.text, after, summary: `${name}: role instructions edited` } };
}

// ---- standing memory: plain text the runtime puts in the prompt of every new run ----

export const memoryPath = (agent: string) => `${MEMORY_DIR}/${agent === 'all' ? '_all' : agent}.md`;

export function readMemory(root: string, agent: string): string {
  try { return fs.readFileSync(path.join(root, memoryPath(agent)), 'utf8'); } catch { return ''; }
}

/** What a new run for this agent is told to remember: everyone's notes first, then its own. */
export function memoryFor(root: string, agent: string): string {
  return [readMemory(root, 'all'), readMemory(root, agent)].map(s => s.trim()).filter(Boolean).join('\n');
}

export function proposeRemember(root: string, agent: string, text: string, now = new Date()): Proposed {
  const t = text.trim().replace(/\s*\n\s*/g, ' ');
  if (!t) { return { error: 'Nothing to remember.' }; }
  if (agent !== 'all' && !loadAllAgents(root).has(agent)) { return { error: `No agent named "${agent}". Use "all" for every agent.` }; }
  const file = memoryPath(agent);
  const abs = path.join(root, file);
  const before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  const lines = (before ?? '').split('\n').filter(Boolean);
  if (lines.some(l => l.replace(/^- (\d{4}-\d{2}-\d{2}: )?/, '') === t)) { return { error: 'That is already remembered.' }; }
  const after = [...lines, `- ${now.toISOString().slice(0, 10)}: ${t}`].join('\n') + '\n';
  if (after.length > MEMORY_LIMIT) { return { error: `Memory for ${agent} would exceed ${MEMORY_LIMIT} characters. Forget something first.` }; }
  return { change: { file, before, after, summary: `${agent}: remember "${t.length > 60 ? t.slice(0, 57) + '…' : t}"` } };
}

export function proposeForget(root: string, agent: string, match: string): Proposed {
  const file = memoryPath(agent);
  const before = readMemory(root, agent);
  const lines = before.split('\n').filter(Boolean);
  const hit = lines.filter(l => l.toLowerCase().includes(match.trim().toLowerCase()));
  if (!match.trim() || hit.length === 0) { return { error: `Nothing in ${agent}'s memory matches "${match}".` }; }
  if (hit.length > 1) { return { error: `${hit.length} lines match; be more specific:\n${hit.join('\n')}` }; }
  const rest = lines.filter(l => l !== hit[0]);
  return { change: { file, before, after: rest.length ? rest.join('\n') + '\n' : '', summary: `${agent}: forget "${hit[0].replace(/^- (\d{4}-\d{2}-\d{2}: )?/, '')}"` } };
}

// ---- show and apply ----

export function diffOf(c: Change): string {
  return createTwoFilesPatch(c.file, c.file, c.before ?? '', c.after, '', '', { context: 2 }).split('\n').slice(2).join('\n').trimEnd();
}

/** Write the change, but only if the file is still exactly what it was computed from. */
export function applyChange(root: string, c: Change): void {
  const abs = path.join(root, c.file);
  const now = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
  if (now !== c.before) { throw new Error(`${c.file} changed since this was proposed. Ask again so the change is built on the current file.`); }
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (c.after === '' && c.file.startsWith(MEMORY_DIR)) { fs.rmSync(abs, { force: true }); } else { fs.writeFileSync(abs, c.after); }
}
