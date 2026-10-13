// Launches headless VS Code twice: park the team, then restart and finish.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const WS = path.join(os.tmpdir(), 'loop-sim-ws');
const USER_DATA = path.join(os.tmpdir(), 'loop-sim-user');
const EXT_DIR = path.join(os.tmpdir(), 'loop-sim-ext');
const REPORT = path.join(os.tmpdir(), 'loop-sim-report.json');

function write(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function buildWorkspace() {
  fs.rmSync(WS, { recursive: true, force: true });
  const { minuteKey } = require(path.join(ROOT, 'out', 'cron.js'));
  const now = new Date(2026, 9, 12, 11, 30, 0, 0);
  const last = new Date(2026, 9, 12, 8, 0, 0, 0);
  const later = new Date(2026, 9, 12, 12, 0, 0, 0);

  write(path.join(WS, '.github', 'agents', 'scout.agent.md'), `---
name: scout
description: Reads the note and hands it to the clerk.
handoffs:
  - label: Clerk
    agent: clerk
loop:
  skills: [sim-probe]
  schedule: "0 * * * *"
  wakeIf: node .github/skills/sim-probe/scripts/wake.js
  task: The pre-check fired. Read note.txt, write the draft, hand off to clerk.
  maxSteps: 8
---
Follow the scripted tool calls.
`);
  write(path.join(WS, '.github', 'agents', 'clerk.agent.md'), `---
name: clerk
description: Asks one question and then finishes.
loop:
  skills: []
  maxSteps: 8
---
Ask, then finish.
`);
  write(path.join(WS, '.github', 'skills', 'sim-probe', 'SKILL.md'), `---
name: sim-probe
description: Simulation wake check.
---
Exit 0.
`);
  write(path.join(WS, '.github', 'skills', 'sim-probe', 'scripts', 'wake.js'), `const fs = require('fs');
fs.mkdirSync('.loop', { recursive: true });
fs.appendFileSync('.loop/wake-hits.txt', new Date().toISOString() + '\\n');
console.log('wake ok');
process.exit(0);
`);
  write(path.join(WS, '.github', 'skills', 'notify-test', 'SKILL.md'), `---
name: notify-test
description: Records notifications.
---
Append the event.
`);
  write(path.join(WS, '.github', 'skills', 'notify-test', 'scripts', 'send.sh'), `#!/bin/bash
mkdir -p .loop
printf '%s\\n' "$LOOP_EVENT_KIND|$LOOP_EVENT_TITLE" >> .loop/notified.log
`);
  write(path.join(WS, '.loop', 'policy.json'), JSON.stringify({
    allowCommands: [],
    denyCommands: ['\\brm\\b', '\\b(curl|wget|ssh)\\b'],
    writablePaths: ['note.txt'],
    protectedPaths: ['.git/**', '.github/**'],
    commandTimeoutSec: 30,
    maxOutputBytes: 8000
  }, null, 2));
  write(path.join(WS, 'note.txt'), 'SIM_NOTE_42\n');
  write(path.join(WS, '.loop', 'sim-now.txt'), now.toISOString());
  write(path.join(WS, '.loop', 'schedule-state.json'), JSON.stringify({ scout: minuteKey(last) }, null, 2));
  write(path.join(WS, '.loop', 'sim-script.json'), JSON.stringify({
    scout: [
      { rejectRequired: true, calls: [{ name: 'read_file', input: { path: 'note.txt' } }] },
      { calls: [{ name: 'write_file', input: { path: '.loop/outbox/scout/note.md', content: 'draft from note' } }] },
      { calls: [{ name: 'handoff', input: { to: 'clerk', task: 'Ask which colour, then finish.', context: 'draft: .loop/outbox/scout/note.md' } }] },
      { calls: [{ name: 'finish', input: { status: 'done', summary: 'handed to clerk' } }] }
    ],
    clerk: [
      { calls: [{ name: 'ask_human', input: { question: 'Which colour?', context: 'sim park', options: ['blue', 'green'] } }] },
      { calls: [{ name: 'finish', input: { status: 'done', summary: 'colour was green' } }] }
    ]
  }, null, 2));
  return {
    nowKey: minuteKey(now),
    later: later.toISOString()
  };
}

function seedUserSettings() {
  write(path.join(USER_DATA, 'User', 'settings.json'), JSON.stringify({
    'harborMate.notifyCommand': 'bash .github/skills/notify-test/scripts/send.sh',
    'security.workspace.trust.enabled': false
  }, null, 2));
}

function launch(exe, clock, resultFile) {
  const env = {
    ...process.env,
    LOOP_RUNNER_SIM: '1',
    LOOP_RUNNER_SIM_PAUSE_MS: '400',
    LOOP_SIM_WS: WS,
    LOOP_SIM_RESULT: resultFile,
    LOOP_SIM_SUITE: path.join(__dirname, 'suite.js'),
    LOOP_SIM_NOW_KEY: clock.nowKey,
    LOOP_SIM_LATER: clock.later
  };
  const args = [
    WS,
    `--user-data-dir=${USER_DATA}`,
    `--extensions-dir=${EXT_DIR}`,
    `--extensionDevelopmentPath=${ROOT}`,
    '--disable-workspace-trust',
    '--disable-gpu',
    '--no-sandbox',
    '--disable-updates',
    '--skip-welcome',
    '--skip-release-notes'
  ];
  return new Promise(resolve => {
    const child = spawn(exe, args, { env, stdio: 'inherit' });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve({ code: null, timeout: true });
    }, 90_000);
    child.on('exit', code => {
      clearTimeout(timer);
      resolve({ code, timeout: false });
    });
  });
}

function readResult(resultFile, exit) {
  if (fs.existsSync(resultFile)) return { ...JSON.parse(fs.readFileSync(resultFile, 'utf8')), exit };
  const why = exit.timeout ? 'VS Code did not exit within 90s' : `VS Code exited ${exit.code} before writing a result`;
  return { phase: 'unknown', failures: [why], evidence: [], parkFailures: [], parkEvidence: [], exit };
}

async function main() {
  const compiled = spawnSync('npx', ['tsc', '-p', './'], { cwd: ROOT, stdio: 'inherit' });
  if (compiled.status !== 0) process.exit(compiled.status || 1);
  const { downloadAndUnzipVSCode } = require('@vscode/test-electron');
  const exe = await downloadAndUnzipVSCode({ version: '1.96.4' });
  fs.rmSync(USER_DATA, { recursive: true, force: true });
  fs.rmSync(EXT_DIR, { recursive: true, force: true });
  const clock = buildWorkspace();
  seedUserSettings();
  const resultFile = path.join(os.tmpdir(), 'loop-sim-result.json');
  fs.rmSync(resultFile, { force: true });
  const parkExit = await launch(exe, clock, resultFile);
  let result = readResult(resultFile, parkExit);
  const parkFailed = (result.failures || []).length > 0 || (result.parkFailures || []).length > 0 || result.phase === 'park' && (result.failures || []).length > 0;
  const phaseAdvanced = fs.existsSync(path.join(WS, '.loop', 'sim-phase')) && fs.readFileSync(path.join(WS, '.loop', 'sim-phase'), 'utf8').trim() === 'resume';
  if (phaseAdvanced && !parkFailed) {
    fs.rmSync(resultFile, { force: true });
    const resumeExit = await launch(exe, clock, resultFile);
    result = readResult(resultFile, resumeExit);
  } else if (!phaseAdvanced && !(result.failures || []).length) {
    result.failures = [`park process ended without scheduling the restart (exit ${parkExit.code}, timeout=${parkExit.timeout})`];
  }
  const scenarios = [
    ...(result.parkEvidence || []).map(e => ({ phase: 'park', ...e })),
    ...((result.phase === 'resume' ? result.evidence : []) || []).map(e => ({ phase: 'resume', ...e }))
  ];
  const report = {
    ok: (result.failures || []).length === 0 && (result.parkFailures || []).length === 0 && scenarios.length > 0 && scenarios.every(s => s.pass),
    failures: result.failures || [],
    parkFailures: result.parkFailures || [],
    scenarios
  };
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log('\n==== headless simulation ====');
  for (const s of scenarios) console.log(`${s.pass ? 'PASS' : 'FAIL'}  [${s.phase}] ${s.name}`);
  if (report.parkFailures.length) console.log('\npark failures:\n' + report.parkFailures.join('\n'));
  if (report.failures.length) console.log('\nfailures:\n' + report.failures.join('\n'));
  console.log(`\nreport: ${REPORT}`);
  process.exit(report.ok ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
