import * as fs from 'fs';
import * as path from 'path';

/**
 * Starter agents for the first five minutes. Each one follows the authoring guide (instructions that say when to
 * ask, when to stop and where to write), needs no secret, and runs under the default policy, so it works as installed.
 * Nothing here is special at runtime: the result is an ordinary agent file, plus a skill when the agent has a probe.
 */
export interface Template { id: string; label: string; detail: string; agent: string; files: Record<string, string> }

const DAILY_REPORT = `---
name: daily-report
description: Writes a short report of what changed in this repository since the last working day. Use for a morning summary of commits.
loop:
  schedule: "0 9 * * 1-5"
  task: Write the daily report for the last 24 hours.
  maxRunsPerDay: 1
  maxSteps: 12
---
You write a short morning report of what changed in this repository in the last day, for the people who work in it.

1. Run \`git log --since="1 day ago" --stat --no-merges\`. If there are no commits, finish with status nothing_to_do and say so.
2. Group the work by theme, not by commit. For each theme give one plain sentence: what changed and why it matters. Name the files or areas, and the authors.
3. Add a short "Worth a look" list for anything risky: large changes, edits to configuration or build files, commits with no tests.
4. Write the report to \`.loop/outbox/daily-report/<YYYY-MM-DD>.md\` with write_file, using today's date. Keep it under one page.
5. Finish with status done and a one-line summary that includes the file path.

You only read the repository. If a command is refused, do not look for a way around it: finish with status blocked and say which command you needed.
`;

const FOLDER_WATCH_AGENT = `---
name: folder-watch
description: Summarises each new file dropped into the drop/ folder. Use when documents or notes arrive and someone should get a short digest.
loop:
  skills: [drop-folder-probe]
  schedule: "*/10 * * * *"
  wakeIf: node .github/skills/drop-folder-probe/scripts/check.js
  task: New files arrived in drop/. Summarise each one.
  maxRunsPerDay: 24
  maxSteps: 20
---
You summarise files that people drop into the \`drop/\` folder. The pre-check (the drop-folder-probe skill) has already found them; its output in your context lists the new file names.

For each listed file:
1. Read it with read_file. If it is longer than a few pages, read the start and the headings, and say that you did.
2. Write a summary of at most eight lines to \`.loop/outbox/folder-watch/<file name>.summary.md\`: what it is, the key points, and anything that needs a decision.
3. Append the file name on its own line to \`.loop/outbox/folder-watch/processed.txt\` (create it if it does not exist). The pre-check uses that list so a file is only handled once.

If you cannot read a file, ask the human with ask_human what to do with it, and do not add it to processed.txt. When every listed file is handled, finish with status done and a summary that names the files.
`;

const FOLDER_WATCH_SKILL = `---
name: drop-folder-probe
description: Use to find files in drop/ that have not been summarised yet. Prints their names; exit 0 when there are some, 1 when there are none.
---
Run \`node .github/skills/drop-folder-probe/scripts/check.js\`. It lists files in \`drop/\` that are not yet in \`.loop/outbox/folder-watch/processed.txt\`.

Exit codes: 0 = new files (names printed, one per line), 1 = nothing new, 2 = could not check.
`;

const FOLDER_WATCH_SCRIPT = `#!/usr/bin/env node
// Exit 0: new files in drop/ (printed). 1: nothing new. 2: could not check.
const fs = require('fs');
const path = require('path');
const drop = 'drop';
const done = path.join('.loop', 'outbox', 'folder-watch', 'processed.txt');
try {
  if (!fs.existsSync(drop)) { fs.mkdirSync(drop, { recursive: true }); }
  const seen = new Set(fs.existsSync(done) ? fs.readFileSync(done, 'utf8').split('\\n').map(s => s.trim()).filter(Boolean) : []);
  const fresh = fs.readdirSync(drop).filter(n => !n.startsWith('.') && fs.statSync(path.join(drop, n)).isFile() && !seen.has(n));
  if (!fresh.length) { process.exit(1); }
  console.log(fresh.join('\\n'));
  process.exit(0);
} catch (e) {
  console.error('could not check: ' + e.message);
  process.exit(2);
}
`;

export const TEMPLATES: Template[] = [
  { id: 'daily-report', label: 'Daily report', detail: 'Every weekday at 09:00, summarises yesterday\'s commits into a one-page report. Reads only; no setup.', agent: 'daily-report', files: { '.github/agents/daily-report.agent.md': DAILY_REPORT } },
  { id: 'folder-watch', label: 'Folder watch', detail: 'Checks drop/ every 10 minutes at no model cost, and summarises each new file. Shows how a pre-check works.', agent: 'folder-watch', files: {
    '.github/agents/folder-watch.agent.md': FOLDER_WATCH_AGENT,
    '.github/skills/drop-folder-probe/SKILL.md': FOLDER_WATCH_SKILL,
    '.github/skills/drop-folder-probe/scripts/check.js': FOLDER_WATCH_SCRIPT
  } }
];

/** Write a template into the workspace. Refuses to overwrite anything. */
export function installTemplate(root: string, id: string): { ok: true; agent: string; files: string[] } | { ok: false; error: string } {
  const t = TEMPLATES.find(x => x.id === id);
  if (!t) { return { ok: false, error: `No template named ${id}.` }; }
  const clash = Object.keys(t.files).find(f => fs.existsSync(path.join(root, f)));
  if (clash) { return { ok: false, error: `${clash} already exists, so ${t.label} is probably already set up.` }; }
  for (const [f, text] of Object.entries(t.files)) {
    const abs = path.join(root, f);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return { ok: true, agent: t.agent, files: Object.keys(t.files) };
}
