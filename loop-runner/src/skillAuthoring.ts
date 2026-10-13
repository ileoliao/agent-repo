import * as fs from 'fs';
import * as path from 'path';
import { Change, quoted } from './manage';
import { SKILL_DIRS, loadSkills } from './team';

/**
 * Creating a skill for agents to use unattended. A skill is code the runtime pre-approves for every agent that lists it, so a
 * proposal shows the human every file in full and is checked here first. The checks catch common slips and unsafe habits; they
 * are not a sandbox, which is why a human reads the code before it is written. Pure and vscode-free.
 */
export interface SkillFile { name: string; content: string }
export interface NewSkill { name: string; description: string; instructions: string; scripts?: SkillFile[]; references?: SkillFile[] }

export type SkillProposed = { changes: Change[]; summary: string; notes: string } | { error: string };

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const RESERVED = ['loop-memory', 'loop-team-authoring', 'loop-skill-authoring'];
const SCRIPT_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(py|js|mjs|cjs|sh|ps1)$/;
const REF_FILE = /^[A-Za-z0-9][A-Za-z0-9_.-]*\.(md|txt|json|csv)$/;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_BODY_LINES = 500;
const MAX_DESCRIPTION = 1024;

const isStr = (v: unknown): v is string => typeof v === 'string';

/** Secrets pasted into a script would be committed and shown to the model; they come from the environment instead. */
const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/, 'a GitHub token'],
  [/\bAKIA[0-9A-Z]{16}\b/, 'an AWS access key'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'a private key'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/, 'a Slack token'],
  [/\bsk-[A-Za-z0-9_-]{20,}/, 'an API key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'a bearer token']
];

/** Files that define the team or hold runtime state. A script must not touch them: that is how an agent would change its own rules. */
const DEFINITION_PATH = /\.github\/(agents|skills)\b|\.loop\/(policies|policy\.json|queue|gates|checkpoints|tasks|runs|chat|memory)\b/;

export interface Finding { level: 'error' | 'warning'; file: string; text: string }

/** What is wrong, or worth a second look, in one script. */
export function lintScript(file: string, content: string): Finding[] {
  const out: Finding[] = [];
  const at = (level: Finding['level'], text: string) => out.push({ level, file, text });
  const py = file.endsWith('.py'), js = /\.(js|mjs|cjs)$/.test(file), sh = file.endsWith('.sh'), ps = file.endsWith('.ps1');
  for (const [re, what] of SECRET_PATTERNS) { if (re.test(content)) { at('error', `contains what looks like ${what}. Read it from an environment variable instead.`); } }
  if (DEFINITION_PATH.test(content)) { at('error', 'refers to agent definitions or runtime state (.github/agents, .github/skills, .loop/policies, queue, gates, ...). A script must not touch the files that define the team; write results to .loop/outbox/.'); }
  else if (/\.loop\/(?!outbox\b)/.test(content)) { at('warning', 'refers to .loop/ outside .loop/outbox/. Scripts should write only under .loop/outbox/.'); }
  if (py && /(^|[^\w.])input\s*\(/.test(content)) { at('error', 'calls input(). Scripts run with stdin closed and would fail; take values from arguments or the environment.'); }
  if (js && /require\(['"](node:)?readline['"]\)|from ['"](node:)?readline['"]|\bcreateInterface\s*\(|\bprompt\s*\(/.test(content)) { at('error', 'reads from the terminal. Scripts run with stdin closed; take values from arguments or the environment.'); }
  if ((sh && /(^|[\n;&|])\s*read\s+(-\w+\s+)*\w+/.test(content)) || (ps && /\bRead-Host\b/.test(content))) { at('warning', 'reads from the terminal. Scripts run with stdin closed.'); }
  if ((py && /shell\s*=\s*True|os\.system\s*\(/.test(content)) || (js && /child_process[\s\S]{0,200}\b(exec|execSync)\s*\(/.test(content))) { at('warning', 'runs a shell command built from text. Prefer an argument list so data cannot become commands.'); }
  if ((py && /(^|[^\w.])(eval|exec)\s*\(/.test(content)) || (js && /(^|[^\w.])eval\s*\(|new Function\s*\(/.test(content))) { at('warning', 'evaluates text as code.'); }
  if ((py && /print\s*\(\s*(dict\()?os\.environ\b/.test(content)) || (js && /JSON\.stringify\(\s*process\.env\b|console\.log\(\s*process\.env\s*\)/.test(content))) { at('warning', 'prints the whole environment, which can include secrets.'); }
  if ((py && /\b(import requests|from urllib|import urllib|import http\.client|import socket|import httpx|import aiohttp)\b/.test(content)) || (js && /\bfetch\s*\(|require\(['"]https?['"]\)|from ['"]node:https?['"]/.test(content)) || (sh && /\b(curl|wget)\b/.test(content)) || (ps && /Invoke-(WebRequest|RestMethod)/.test(content))) {
    at('warning', 'uses the network. Say so in SKILL.md, and keep tokens in environment variables.');
  }
  return out;
}

/** Everything wrong with a proposed skill before a file is written. Errors block; warnings are shown to the human. */
export function lintSkill(root: string, s: NewSkill): Finding[] {
  const out: Finding[] = [];
  const add = (level: Finding['level'], file: string, text: string) => out.push({ level, file, text });
  const scripts = s.scripts ?? [], refs = s.references ?? [];
  if (!NAME.test(s.name)) { add('error', 'SKILL.md', 'The name must be lowercase letters, digits and hyphens, at most 63 characters, for example "release-report".'); }
  if (RESERVED.includes(s.name) || [...loadSkills(root).keys()].includes(s.name) || SKILL_DIRS.some(d => fs.existsSync(path.join(root, d, s.name)))) { add('error', 'SKILL.md', `A skill named "${s.name}" already exists. Creating a skill never overwrites one.`); }
  if (!s.description.trim()) { add('error', 'SKILL.md', 'A description is needed: what the skill does and when an agent should use it. It is the only part an agent sees before deciding to read the rest.'); }
  if (s.description.length > MAX_DESCRIPTION) { add('error', 'SKILL.md', `The description is ${s.description.length} characters; keep it under ${MAX_DESCRIPTION}.`); }
  else if (s.description.trim() && !/\b(when|whenever|if)\b/i.test(s.description)) { add('warning', 'SKILL.md', 'The description does not say when to use the skill. Name the situations (for example "Use when ..."), because that is what makes an agent pick it.'); }
  if (!s.instructions.trim()) { add('error', 'SKILL.md', 'The instructions are empty: say how to use the skill.'); }
  const lines = s.instructions.split('\n').length;
  if (lines > MAX_BODY_LINES) { add('error', 'SKILL.md', `The instructions are ${lines} lines; keep SKILL.md under ${MAX_BODY_LINES} and move detail into a references/ file.`); }
  if (scripts.length + refs.length > MAX_FILES) { add('error', 'SKILL.md', `A skill has at most ${MAX_FILES} files besides SKILL.md.`); }
  const seen = new Set<string>();
  let total = Buffer.byteLength(s.instructions);
  for (const [kind, list, ok] of [['scripts', scripts, SCRIPT_FILE], ['references', refs, REF_FILE]] as const) {
    for (const f of list) {
      const rel = `${kind}/${f.name}`;
      if (!ok.test(f.name)) { add('error', rel, kind === 'scripts' ? 'A script name is a plain file name ending in .py, .js, .mjs, .cjs, .sh or .ps1 (no folders).' : 'A reference name is a plain file name ending in .md, .txt, .json or .csv (no folders).'); continue; }
      if (seen.has(rel)) { add('error', rel, 'This file is listed twice.'); }
      seen.add(rel);
      const bytes = Buffer.byteLength(f.content); total += bytes;
      if (bytes > MAX_FILE_BYTES) { add('error', rel, `This file is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB. Split it.`); }
      if (!f.content.trim()) { add('error', rel, 'This file is empty.'); }
      if (kind === 'scripts') { out.push(...lintScript(f.name, f.content)); }
      if (kind === 'scripts' && !s.instructions.includes(f.name)) { add('warning', 'SKILL.md', `The instructions never mention ${f.name}. Say when to run it and with what arguments; an agent only knows what SKILL.md tells it.`); }
      if (kind === 'references' && !s.instructions.includes(f.name)) { add('warning', 'SKILL.md', `The instructions never mention ${f.name}. Say when to read it.`); }
    }
  }
  if (total > MAX_TOTAL_BYTES) { add('error', 'SKILL.md', `The skill is ${Math.round(total / 1024)} KB in total; the limit is ${MAX_TOTAL_BYTES / 1024} KB.`); }
  return out;
}

const clean = (v: string) => v.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

/** Create `.github/skills/<name>/` with SKILL.md and its files. Never overwrites. Returns one Change per file. */
export function proposeSkill(root: string, input: NewSkill): SkillProposed {
  const i: any = input;
  if (!i || typeof i !== 'object') { return { error: 'Give the skill a name, a description and instructions.' }; }
  for (const k of ['name', 'description', 'instructions']) { if (i[k] !== undefined && !isStr(i[k])) { return { error: `${k} must be text.` }; } }
  for (const k of ['scripts', 'references']) {
    if (i[k] !== undefined && (!Array.isArray(i[k]) || i[k].some((f: any) => !f || typeof f !== 'object' || !isStr(f.name) || !isStr(f.content)))) { return { error: `${k} must be a list of { name, content }.` }; }
  }
  const spec: NewSkill = {
    name: String(i.name ?? '').trim(),
    description: clean(String(i.description ?? '')).replace(/\s+/g, ' ').trim(),
    instructions: clean(String(i.instructions ?? '')).trim(),
    scripts: (i.scripts ?? []).map((f: SkillFile) => ({ name: f.name.trim(), content: clean(f.content).replace(/\s*$/, '\n') })),
    references: (i.references ?? []).map((f: SkillFile) => ({ name: f.name.trim(), content: clean(f.content).replace(/\s*$/, '\n') }))
  };
  const findings = lintSkill(root, spec);
  const errors = findings.filter(f => f.level === 'error');
  if (errors.length) { return { error: `Not written, fix these first:\n${errors.map(f => `- ${f.file}: ${f.text}`).join('\n')}` }; }
  const desc = quoted(spec.description);
  if (desc === undefined) { return { error: 'The description cannot be written safely (it has both kinds of quote). Reword it.' }; }
  const dir = `.github/skills/${spec.name}`;
  const skillMd = `---\nname: ${spec.name}\ndescription: ${desc}\n---\n\n${spec.instructions}\n`;
  const changes: Change[] = [
    { file: `${dir}/SKILL.md`, before: null, after: skillMd, summary: `Create skill ${spec.name}` },
    ...spec.scripts!.map(f => ({ file: `${dir}/scripts/${f.name}`, before: null, after: f.content, summary: `Create skill ${spec.name}` })),
    ...spec.references!.map(f => ({ file: `${dir}/references/${f.name}`, before: null, after: f.content, summary: `Create skill ${spec.name}` }))
  ];
  const warnings = findings.filter(f => f.level === 'warning');
  const notes = [
    `**New skill \`${spec.name}\`: ${changes.length} file${changes.length === 1 ? '' : 's'}.** ${spec.scripts!.length ? `Its ${spec.scripts!.length} script${spec.scripts!.length === 1 ? '' : 's'} will run unattended, pre-approved, for every agent that lists this skill, and are not checked by policy. Read the code below before you press Apply.` : 'It has no scripts, so it only gives instructions.'}`,
    warnings.length ? `Worth a look:\n${warnings.map(f => `- ${f.file}: ${f.text}`).join('\n')}` : 'No warnings from the automatic checks (they catch common slips; they do not replace reading the code).'
  ].join('\n\n');
  return { changes, summary: `Create skill ${spec.name}`, notes };
}
