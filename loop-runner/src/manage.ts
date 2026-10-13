import * as fs from 'fs';
import * as path from 'path';
import { createTwoFilesPatch } from 'diff';
import { parseFrontmatter } from './frontmatter';
import { validateCron } from './cron';
import { AgentDef, agentFromText, loadAllAgents, problemsIfWritten } from './team';

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
  /** What the human most needs to know before applying (for example whether it will run on its own), shown above the diff. */
  notes?: string;
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

// ---- goals, skills and new agents: lists and nested blocks in the loop: block ----

interface LoopSpan { lines: string[]; nl: string; loopAt: number; blockEnd: number }

/** Where the `loop:` block is, or undefined when the file has none. */
function loopSpan(text: string): LoopSpan | undefined {
  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const fm = frontmatterRange(lines);
  if (!fm) { return undefined; }
  const loopAt = lines.findIndex((l, i) => i > fm[0] && i < fm[1] && /^loop:\s*$/.test(l));
  if (loopAt < 0) { return undefined; }
  let blockEnd = loopAt + 1;
  while (blockEnd < fm[1] && (/^\s+\S/.test(lines[blockEnd]) || lines[blockEnd].trim() === '')) { blockEnd++; }
  return { lines, nl, loopAt, blockEnd };
}

/**
 * One past the last line that belongs to the key at `keyAt`: its indented lines, and block-list items that sit at the
 * key's own indent. Blank lines and comments at the key's indent belong to the next key unless more of this key follows.
 */
function keyEnd(lines: string[], keyAt: number, blockEnd: number): number {
  let last = keyAt;
  for (let j = keyAt + 1; j < blockEnd; j++) {
    const l = lines[j];
    if (/^\s{3,}\S/.test(l) || /^  -(\s|$)/.test(l)) { last = j; continue; }
    if (l.trim() === '' || /^\s*#/.test(l)) { continue; }
    break;
  }
  return last + 1;
}

/**
 * Replace (or, with undefined, remove) one key of the `loop:` block with the given lines. The first line is the key
 * itself; later lines are indented relative to it. Everything else stays byte-identical. Returns undefined when there
 * is no loop block.
 */
export function setLoopBlock(text: string, key: string, block: string[] | undefined): string | undefined {
  const s = loopSpan(text);
  if (!s) { return undefined; }
  const { lines, nl, loopAt, blockEnd } = s;
  const keyAt = lines.findIndex((l, i) => i > loopAt && i < blockEnd && new RegExp(`^  ${key}:`).test(l));
  const fresh = block ? block.map((l, i) => (i === 0 ? `  ${l}` : `    ${l}`)) : [];
  if (keyAt >= 0) { lines.splice(keyAt, keyEnd(lines, keyAt, blockEnd) - keyAt, ...fresh); }
  else if (fresh.length) {
    // A new key goes at the end of the block, before any trailing blank lines.
    let at = blockEnd;
    while (at > loopAt + 1 && lines[at - 1].trim() === '') { at--; }
    lines.splice(at, 0, ...fresh);
  }
  return lines.join(nl);
}

// ---- values: what may be written, and how ----

const isStr = (v: unknown): v is string => typeof v === 'string';
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isStrList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
/** A name that is safe to write bare: a skill, an agent, a goal id. */
const BARE = /^[A-Za-z0-9][A-Za-z0-9_.\-]*$/;

/** A string as a one-line quoted YAML scalar; undefined when it cannot be written without escapes. */
function quoted(v: string): string | undefined {
  if (/[\r\n]/.test(v)) { return undefined; }
  if (!v.includes('"')) { return `"${v}"`; }
  if (!v.includes("'")) { return `'${v}'`; }
  return undefined;
}

/** A list of strings on one line, each quoted unless it is a plain name. */
function listYaml(v: string[]): string | undefined {
  const q = v.map(x => (BARE.test(x) ? x : quoted(x)));
  return q.every(x => x !== undefined) ? `[${q.join(', ')}]` : undefined;
}

/** `key: value` for one field, as lines relative to the key's own indent. Long or quote-heavy text becomes a block scalar. */
function fieldLines(key: string, v: unknown): string[] | undefined {
  if (typeof v === 'number' || typeof v === 'boolean') { return [`${key}: ${v}`]; }
  if (isStr(v)) {
    const q = quoted(v);
    return q !== undefined ? [`${key}: ${q}`] : [`${key}: |`, ...v.replace(/\r\n?/g, '\n').split('\n').map(l => `  ${l}`)];
  }
  if (isStrList(v)) { const y = listYaml(v); return y === undefined ? undefined : [`${key}: ${y}`]; }
  return undefined;
}

const GOAL_KEYS = ['id', 'text', 'schedule', 'wakeIf', 'task', 'skills', 'policy', 'urgent', 'maxSilence', 'maxRunsPerDay'];

/** One goal as the lines of a list item (`- id: ...`), indented by `ind`. */
function goalItem(g: Record<string, unknown>, ind: string): { lines: string[] } | { error: string } {
  const keys = [...GOAL_KEYS.filter(k => g[k] !== undefined), ...Object.keys(g).filter(k => !GOAL_KEYS.includes(k) && g[k] !== undefined)];
  const out: string[] = [];
  for (const [i, k] of keys.entries()) {
    const f = fieldLines(k, g[k]);
    if (!f) { return { error: `Goal "${String(g.id)}": the value of ${k} cannot be written safely. Reword it.` }; }
    out.push(...f.map((l, j) => (j === 0 ? `${ind}${i === 0 ? '- ' : '  '}${l}` : `${ind}  ${l}`)));
  }
  return { lines: out };
}

/** What a goal's fields must look like. Applies to everything chat sends, because a wrong type can read back as something else. */
function goalTypeError(g: Record<string, unknown>): string | undefined {
  for (const k of ['text', 'schedule', 'wakeIf', 'task', 'policy', 'maxSilence']) { if (g[k] !== undefined && !isStr(g[k])) { return `${k} must be text.`; } }
  if (g.skills !== undefined && !isStrList(g.skills)) { return 'skills must be a list of skill names.'; }
  if (g.urgent !== undefined && typeof g.urgent !== 'boolean') { return 'urgent must be true or false.'; }
  if (g.maxRunsPerDay !== undefined && !isPosInt(g.maxRunsPerDay)) { return 'maxRunsPerDay must be a whole number of at least 1.'; }
  return undefined;
}

/** A policy given by the human or the chat must be an existing .json file under .loop/policies. */
function policyError(root: string, policy: string): string | undefined {
  if (!/^\.loop\/policies\/[A-Za-z0-9_.\-\/]+\.json$/.test(policy) || policy.split('/').includes('..')) { return `policy must be a .json path under .loop/policies/, not "${policy}".`; }
  try { if (fs.statSync(path.join(root, policy)).isFile()) { return undefined; } } catch { /* falls through */ }
  return `The policy file ${policy} does not exist. Policies are written by hand; chat does not create them.`;
}

/** When and how the agent will run, in the words the human needs before pressing Apply. */
function runNotes(a: AgentDef): string {
  const sched = a.goals.filter(g => g.schedule);
  const when = sched.length
    ? `**Will run on its own:** ${sched.map(g => `\`${g.schedule}\` (${g.id === 'default' ? 'task' : `goal ${g.id}`}: ${g.task.length > 80 ? g.task.slice(0, 79) + '…' : g.task})`).join('; ')}.`
    : '**Will not run on its own.** It runs only when you give it a task.';
  return `${when}\nPolicy: ${a.policy ?? 'default'}.${a.goals.some(g => g.policy) ? ' Some goals use their own policy.' : ''}`;
}

const policiesOf = (a: AgentDef) => [a.policy, ...a.goals.map(g => g.policy)].filter((p): p is string => !!p);

/** The checks every proposed agent file passes before a diff is shown. */
function checked(root: string, file: string, before: string | null, after: string, summary: string, expect?: (a: ReturnType<typeof agentFromText>) => string | undefined): Proposed {
  const base = path.posix.basename(file);
  const read = agentFromText(base, after);
  if (!read.inLoop) { return { error: 'The file would have no loop: block, so the agent would not join the team.' }; }
  const bad = expect?.(read);
  if (bad) { return { error: bad }; }
  // Read back what will really apply: a policy that is new in this change must be an existing file under .loop/policies.
  const had = new Set(before === null ? [] : policiesOf(agentFromText(base, before)));
  for (const p of policiesOf(read).filter(x => !had.has(x))) { const e = policyError(root, p); if (e) { return { error: e }; } }
  const problems = problemsIfWritten(root, base, after);
  if (problems.length) { return { error: `This would leave the team with problems, so nothing is proposed:\n${problems.join('\n')}` }; }
  return { change: { file, before, after, summary, notes: runNotes(read) } };
}

export interface GoalInput {
  id: string;
  text?: string; schedule?: string; wakeIf?: string; task?: string; skills?: string[]; policy?: string;
  urgent?: boolean; maxSilence?: string; maxRunsPerDay?: number;
}

/**
 * Add, change or remove one item of `loop.goals`, rewriting only that item. Other goals keep their exact text, comments
 * and layout. Returns the new file text.
 */
function editGoalItem(text: string, op: 'add' | 'update' | 'remove', index: number, goal: Record<string, unknown> | undefined): string | { error: string } {
  const s = loopSpan(text);
  if (!s) { return { error: 'Could not find the loop: block to edit.' }; }
  const { lines, nl, loopAt, blockEnd } = s;
  const keyAt = lines.findIndex((l, i) => i > loopAt && i < blockEnd && /^  goals:/.test(l));
  if (keyAt < 0) {
    if (op !== 'add' || !goal) { return { error: 'This agent has no goals.' }; }
    const item = goalItem(goal, '');
    if ('error' in item) { return item; }
    return setLoopBlock(text, 'goals', ['goals:', ...item.lines])!;
  }
  if (lines[keyAt].replace(/^  goals:/, '').replace(/#.*$/, '').trim()) { return { error: 'The goals of this agent are written on one line; edit the file by hand to change them.' }; }
  const end = keyEnd(lines, keyAt, blockEnd);
  const first = lines.findIndex((l, i) => i > keyAt && i < end && /^\s*-(\s|$)/.test(l));
  if (first < 0) { return { error: 'Could not read how the goals of this agent are laid out; edit the file by hand.' }; }
  const indent = lines[first].match(/^\s*/)![0];
  const starts = lines.map((l, i) => (i > keyAt && i < end && l.startsWith(indent + '-') && /^\s*-(\s|$)/.test(l) && l.match(/^\s*/)![0] === indent ? i : -1)).filter(i => i >= 0);
  // Each item ends at its last real line: blank lines and comments in between belong to the next item.
  const stops = starts.map((st, k) => {
    const bound = k + 1 < starts.length ? starts[k + 1] : end;
    let last = st;
    for (let j = st + 1; j < bound; j++) { if (lines[j].trim() !== '' && !(/^\s*#/.test(lines[j]) && lines[j].match(/^\s*/)![0].length <= indent.length)) { last = j; } }
    return last + 1;
  });
  if (op === 'add') {
    const item = goalItem(goal!, indent);
    if ('error' in item) { return item; }
    lines.splice(stops[stops.length - 1], 0, ...item.lines);
  } else if (op === 'remove' && starts.length === 1) {
    return setLoopBlock(text, 'goals', undefined)!;
  } else if (op === 'remove') {
    lines.splice(starts[index], stops[index] - starts[index]);
  } else {
    const item = goalItem(goal!, indent);
    if ('error' in item) { return item; }
    lines.splice(starts[index], stops[index] - starts[index], ...item.lines);
  }
  return lines.join(nl);
}

/** Add, change or remove one goal in `loop.goals`. The legacy single schedule (the goal "default") is changed with proposeSchedule. */
export function proposeGoals(root: string, name: string, op: 'add' | 'update' | 'remove', g: GoalInput): Proposed {
  if (!['add', 'update', 'remove'].includes(op)) { return { error: 'op must be add, update or remove.' }; }
  if (!g || typeof g !== 'object') { return { error: 'A goal needs an id.' }; }
  const r = readAgent(root, name);
  if (!r.ok) { return { error: r.error }; }
  if (!r.agent.inLoop) { return { error: `${name} has no loop: block, so it does not run unattended. Add one first.` }; }
  if (!isStr(g.id) || !g.id.trim()) { return { error: 'A goal needs an id.' }; }
  const id = g.id.trim();
  if (id === 'default') { return { error: 'The goal "default" is the single schedule in the loop block; change it with propose_schedule.' }; }
  const typeError = goalTypeError(g as unknown as Record<string, unknown>);
  if (typeError) { return { error: typeError }; }
  const raw = parseFrontmatter(r.text).meta.loop?.goals;
  const goals: Record<string, unknown>[] = Array.isArray(raw) ? raw.map((x: any) => ({ ...x })) : [];
  const at = goals.findIndex(x => String(x.id) === id);
  // An empty string clears a field on update; on add it is simply left out.
  const patch: Record<string, unknown> = {};
  const clear: string[] = [];
  for (const k of GOAL_KEYS) {
    const v = (g as any)[k];
    if (k === 'id' || v === undefined) { continue; }
    if (isStr(v) && !v.trim()) { clear.push(k); } else { patch[k] = v; }
  }
  if (isStr(patch.policy)) { const e = policyError(root, patch.policy); if (e) { return { error: e }; } }
  const names = `Goals: ${goals.map(x => String(x.id)).join(', ') || 'none'}.`;
  let goal: Record<string, unknown> | undefined;
  if (op === 'add') {
    if (at >= 0) { return { error: `${name} already has a goal "${id}". Use update.` }; }
    if (!isStr(patch.text) || !patch.text.trim()) { return { error: 'A new goal needs text: what the agent is responsible for.' }; }
    goal = { id, ...patch };
  } else if (at < 0) {
    return { error: `${name} has no goal "${id}". ${names}` };
  } else if (op === 'update') {
    if (!Object.keys(patch).length && !clear.length) { return { error: 'Nothing to change: give at least one field.' }; }
    goal = { ...goals[at], ...patch };
    for (const k of clear) { delete goal[k]; }
  }
  const out = editGoalItem(r.text, op, at, goal);
  if (!isStr(out)) { return { error: out.error }; }
  const want = op === 'add' ? [...goals.map(x => String(x.id)), id] : op === 'remove' ? goals.filter((_, i) => i !== at).map(x => String(x.id)) : goals.map(x => String(x.id));
  return checked(root, r.file, r.text, out, `${name}: goal "${id}" ${op === 'add' ? 'added' : op === 'update' ? 'changed' : 'removed'}`, a => {
    const got = a.goals.filter(x => x.id !== 'default').map(x => x.id);
    if (got.join('|') !== want.join('|')) { return 'Could not write the goals safely.'; }
    const mine = a.goals.find(x => x.id === id);
    if (op === 'remove') { return mine ? 'Could not remove the goal safely.' : undefined; }
    if (!mine || (isStr(patch.text) && mine.text !== patch.text) || (isStr(patch.schedule) && mine.schedule !== patch.schedule) || (isPosInt(patch.maxRunsPerDay) && mine.maxRunsPerDay !== patch.maxRunsPerDay)
      || (typeof patch.urgent === 'boolean' && (mine.urgent === true) !== patch.urgent)) { return 'The goal did not read back as asked; try simpler wording.'; }
    return undefined;
  });
}

/** Add or remove skills in `loop.skills`. A skill must already exist; chat does not write skills. */
export function proposeSkills(root: string, name: string, p: { add?: string[]; remove?: string[] }): Proposed {
  const r = readAgent(root, name);
  if (!r.ok) { return { error: r.error }; }
  if (!r.agent.inLoop) { return { error: `${name} has no loop: block, so it does not run unattended. Add one first.` }; }
  if ((p?.add !== undefined && !isStrList(p.add)) || (p?.remove !== undefined && !isStrList(p.remove))) { return { error: 'add and remove must be lists of skill names.' }; }
  const add = [...new Set((p.add ?? []).map(s => s.trim()).filter(Boolean))];
  const remove = [...new Set((p.remove ?? []).map(s => s.trim()).filter(Boolean))];
  const both = add.filter(s => remove.includes(s));
  if (both.length) { return { error: `${both.join(', ')} is in both add and remove.` }; }
  const missing = remove.filter(s => !r.agent.skills.includes(s));
  if (missing.length) { return { error: `${name} does not have the skill ${missing.join(', ')}. It has: ${r.agent.skills.join(', ') || 'none'}.` }; }
  const next = [...r.agent.skills.filter(s => !remove.includes(s)), ...add.filter(s => !r.agent.skills.includes(s))];
  if (next.join('|') === r.agent.skills.join('|')) { return { error: 'Nothing to change.' }; }
  const y = listYaml(next);
  if (y === undefined) { return { error: 'Those skill names cannot be written safely.' }; }
  const after = setLoopBlock(r.text, 'skills', [`skills: ${y}`]);
  if (after === undefined) { return { error: 'Could not find the loop: block to edit.' }; }
  const shown = [...add.filter(s => !r.agent.skills.includes(s)).map(s => `+${s}`), ...remove.map(s => `-${s}`)].join(' ');
  return checked(root, r.file, r.text, after, `${name}: skills ${shown}`, a => (a.skills.join('|') === next.join('|') ? undefined : 'Could not write the skills safely.'));
}

const RESERVED_NAMES = ['loop', 'chief-of-staff'];

export interface NewAgent {
  name: string; description: string; instructions: string;
  skills?: string[]; handoffs?: string[]; model?: string; maxSteps?: number; maxRunsPerDay?: number; policy?: string;
  schedule?: string; task?: string; goals?: GoalInput[];
}

const AGENT_TOP_KEYS = ['name', 'description', 'model', 'handoffs', 'loop'];
const AGENT_LOOP_KEYS = ['skills', 'schedule', 'task', 'policy', 'maxSteps', 'maxRunsPerDay', 'goals'];

/**
 * Create `.github/agents/<name>.agent.md`. With no schedule and no goals the agent is manual: it runs only when given a task,
 * so writing the file never starts anything unattended by surprise.
 */
export function proposeAgent(root: string, a: NewAgent): Proposed {
  if (!a || typeof a !== 'object') { return { error: 'Give the agent a name, a description and role instructions.' }; }
  for (const k of ['name', 'description', 'instructions', 'schedule', 'task', 'policy', 'model'] as const) {
    if (a[k] !== undefined && !isStr(a[k])) { return { error: `${k} must be text.` }; }
  }
  if (a.skills !== undefined && !isStrList(a.skills)) { return { error: 'skills must be a list of skill names.' }; }
  if (a.handoffs !== undefined && !isStrList(a.handoffs)) { return { error: 'handoffs must be a list of agent names.' }; }
  if (a.goals !== undefined && (!Array.isArray(a.goals) || a.goals.some(g => !g || typeof g !== 'object' || Array.isArray(g)))) { return { error: 'goals must be a list of goal objects.' }; }
  for (const k of ['maxSteps', 'maxRunsPerDay'] as const) { if (a[k] !== undefined && !isPosInt(a[k])) { return { error: `${k} must be a whole number of at least 1.` }; } }
  const name = String(a.name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) { return { error: 'The name must be lowercase letters, digits and hyphens, for example "release-watch".' }; }
  if (RESERVED_NAMES.includes(name)) { return { error: `"${name}" is a reserved name.` }; }
  const file = `.github/agents/${name}.agent.md`;
  if (loadAllAgents(root).has(name) || fs.existsSync(path.join(root, file))) { return { error: `An agent named "${name}" already exists. Use the edit tools to change it.` }; }
  const description = String(a.description ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!description) { return { error: 'A description is needed: one sentence on what the agent does. Teammates read it when deciding to hand off.' }; }
  const instructions = String(a.instructions ?? '').replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim();
  if (!instructions) { return { error: 'Role instructions are needed: how the agent should work.' }; }
  if (a.policy) { const e = policyError(root, a.policy); if (e) { return { error: e }; } }
  if (a.schedule && !a.task?.trim()) { return { error: 'A schedule needs a task: what the agent does on each run.' }; }
  const hand = [...new Set((a.handoffs ?? []).map(h => h.trim()).filter(Boolean))];
  const badHand = hand.find(h => !BARE.test(h));
  if (badHand !== undefined) { return { error: `"${badHand}" is not an agent name.` }; }
  const skillNames = [...new Set((a.skills ?? []).map(s => s.trim()).filter(Boolean))];
  const goals: Record<string, unknown>[] = [];
  for (const g of a.goals ?? []) {
    const gg = g as unknown as Record<string, unknown>;
    if (!isStr(gg.id) || !gg.id.trim()) { return { error: 'Every goal needs an id.' }; }
    const te = goalTypeError(gg); if (te) { return { error: `Goal "${gg.id}": ${te}` }; }
    if (isStr(gg.policy)) { const e = policyError(root, gg.policy); if (e) { return { error: e }; } }
    goals.push({ id: gg.id.trim(), ...Object.fromEntries(GOAL_KEYS.filter(k => k !== 'id' && gg[k] !== undefined && !(isStr(gg[k]) && !(gg[k] as string).trim())).map(k => [k, gg[k]])) });
  }
  const q = (v: string, what: string): { error: string } | { v: string } => { const o = quoted(v); return o === undefined ? { error: `${what} cannot be written safely (a line break, or both kinds of quote). Reword it.` } : { v: o }; };
  const out = ['---', `name: ${name}`];
  const d = q(description, 'The description'); if ('error' in d) { return { error: d.error }; } out.push(`description: ${d.v}`);
  if (a.model?.trim()) { const m = q(a.model.trim(), 'The model'); if ('error' in m) { return { error: m.error }; } out.push(`model: [${m.v}]`); }
  if (hand.length) { out.push('handoffs:', ...hand.flatMap(h => [`  - label: Hand to ${h}`, `    agent: ${h}`, '    prompt: Continue with the work described above.'])); }
  out.push('loop:');
  const skills = listYaml(skillNames);
  if (skills === undefined) { return { error: 'Those skill names cannot be written safely.' }; }
  out.push(`  skills: ${skills}`);
  if (a.schedule) { const s = q(a.schedule.trim(), 'The schedule'); if ('error' in s) { return { error: s.error }; } out.push(`  schedule: ${s.v}`); }
  if (a.task?.trim()) { const t = q(a.task.trim(), 'The task'); if ('error' in t) { return { error: t.error }; } out.push(`  task: ${t.v}`); }
  if (a.policy) { out.push(`  policy: ${a.policy}`); }
  if (a.maxSteps !== undefined) { out.push(`  maxSteps: ${a.maxSteps}`); }
  if (a.maxRunsPerDay !== undefined) { out.push(`  maxRunsPerDay: ${a.maxRunsPerDay}`); }
  if (goals.length) {
    out.push('  goals:');
    for (const g of goals) { const it = goalItem(g, '    '); if ('error' in it) { return { error: it.error }; } out.push(...it.lines); }
  }
  out.push('---', '', instructions, '');
  const after = out.join('\n');
  return checked(root, file, null, after, `Create agent ${name}`, got => {
    // The file must contain exactly the keys this function meant to write, and nothing a value could have smuggled in.
    const meta = parseFrontmatter(after).meta;
    const loop = meta.loop && typeof meta.loop === 'object' ? meta.loop : {};
    if (Object.keys(meta).some(k => !AGENT_TOP_KEYS.includes(k)) || Object.keys(loop).some(k => !AGENT_LOOP_KEYS.includes(k))) { return 'The file would contain fields that were not asked for.'; }
    if (got.name !== name) { return 'The name did not read back as asked.'; }
    if (got.handoffs.join('|') !== hand.join('|')) { return 'The handoffs did not read back as asked.'; }
    if (got.skills.join('|') !== skillNames.join('|')) { return 'The skills did not read back as asked.'; }
    if (got.goals.filter(x => x.id !== 'default').length !== goals.length) { return 'Could not write the goals safely.'; }
    if (a.schedule && got.schedule !== a.schedule.trim()) { return 'Could not write that schedule safely.'; }
    if ((got.policy ?? '') !== (a.policy ?? '')) { return 'The policy did not read back as asked.'; }
    return undefined;
  });
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
