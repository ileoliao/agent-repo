// Renders the Harbor Mate console with a realistic demo workspace and screenshots it (dark and light themes).
// Usage: node scripts/ui-shots.js <outDir>      (needs `npm run compile` first, and Playwright: PLAYWRIGHT_DIR=/path/with/playwright)
const fs = require('fs');
const os = require('os');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { consoleModel, renderPage } = require(`${OUT}/console.js`);
const Q = require(`${OUT}/queue.js`);
const { postHumanMessage } = require(`${OUT}/thread.js`);
const { chromium } = require(require.resolve('playwright', { paths: [process.env.PLAYWRIGHT_DIR || '/tmp/pw'] }));

const outDir = path.resolve(process.argv[2] || 'ui-shots');
fs.mkdirSync(outDir, { recursive: true });
const w = (R, rel, text) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof text === 'string' ? text : JSON.stringify(text)); };
const now = new Date();
const ago = min => new Date(now.getTime() - min * 60_000).toISOString();
const day = ago(0).slice(0, 10);

const TASKS = { 'daily-report': 'Write the report.', 'release-watch': 'Check release health.', triage: 'Triage new issues.' };

function demo() {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-demo-'));
  const agent = (n, d, loop) => w(R, `.github/agents/${n}.agent.md`, `---\nname: ${n}\ndescription: ${d}\nloop:\n${loop}---\nYou do this work carefully. Ask the human with ask_human when a call depends on risk. Finish with done or blocked.\n`);
  agent('daily-report', 'Writes the morning report of what changed in the repository.', '  schedule: "0 9 * * 1-5"\n  task: Write the report.\n');
  agent('release-watch', 'Watches release health and raises problems early.', '  schedule: "*/30 * * * *"\n  task: Check release health.\n');
  agent('triage', 'Sorts new issues and proposes owners.', '  goals:\n    - id: new-issue\n      text: Triage new issues.\n      on: "webhook:issue"\n');
  const run = (chain, name, startMin, status, steps, summary, outputs = []) => {
    const ev = [{ type: 'start', agent: name, ts: ago(startMin), step: 0, from: 'schedule', hop: 0, task: TASKS[name] ?? 'Do the work.' }];
    steps.forEach((s, i) => ev.push({ type: 'tool', agent: name, ts: ago(startMin - i - 1), step: i + 1, name: s.name, input: s.input, decision: s.decision ?? 'allow', result: s.result ?? 'ok' }));
    if (status) { ev.push({ type: 'end', agent: name, ts: ago(startMin - steps.length - 1), step: steps.length, status, summary, outputs }); }
    w(R, `.loop/runs/${day}/${chain}.jsonl`, ev.map(e => JSON.stringify({ chainId: chain, ...e })).join('\n') + '\n');
  };
  const q = (chain, name, status, summary, min) => Q.complete(R, { id: chain, agent: name, task: TASKS[name], from: 'schedule', chainId: chain, hop: 0, createdAt: ago(min) }, status, summary);
  w(R, 'src/app.js', 'x');
  run('c1', 'daily-report', 190, 'done', [{ name: 'run_command', input: { command: 'git log --since="1 day ago" --stat' }, result: '[exit 0]\n12 commits' }, { name: 'write_file', input: { path: '.loop/outbox/daily-report/today.md' }, result: 'Wrote .loop/outbox/daily-report/today.md.' }], 'Report written: 12 commits across 3 areas.', ['.loop/outbox/daily-report/today.md']);
  w(R, '.loop/outbox/daily-report/today.md', '# Daily report\n\n- Payments: retry logic reworked (3 commits)\n- Docs: onboarding guide updated\n');
  run('c2', 'release-watch', 60, 'nothing_to_do', [{ name: 'run_command', input: { command: 'harbor status --json' } }], 'All releases healthy.');
  run('c3', 'release-watch', 30, 'blocked', [{ name: 'run_command', input: { command: 'curl https://api.example.com' }, decision: 'deny', result: 'REFUSED by policy (denyCommands). Retrying will fail the same way.' }], 'Could not reach the release API: curl is refused by policy.');
  run('c4', 'daily-report', 3, null, [{ name: 'run_command', input: { command: 'git log --since="1 day ago" --stat' }, result: '[exit 0]' }, { name: 'read_file', input: { path: 'src/app.js' } }], '');
  q('c1', 'daily-report', 'done', 'Report written', 190); q('c2', 'release-watch', 'nothing_to_do', 'healthy', 60); q('c3', 'release-watch', 'blocked', 'refused', 30);
  Q.saveGate(R, { id: 'g1', kind: 'approval', agent: 'release-watch', itemId: 'i9', chainId: 'c9', title: 'Roll back payments-service to v1.4.2', body: 'Error rate on payments-service rose from 0.2% to 6% after the v1.5.0 rollout 14 minutes ago. Rolling back is the documented fix.', command: 'harbor rollback payments-service --to v1.4.2', files: ['.loop/outbox/release-watch/rollback-plan.md'], resume: true, status: 'pending', createdAt: ago(8) });
  w(R, '.loop/outbox/release-watch/rollback-plan.md', '# Rollback plan\n\n1. Roll back payments-service to v1.4.2\n2. Watch error rate for 10 minutes\n3. Post status to #releases\n');
  Q.saveGate(R, { id: 'g2', kind: 'question', agent: 'triage', itemId: 'i8', chainId: 'c8', title: 'Who owns the new "login timeout" issue?', body: 'Three teams touched the auth code in the last month. I cannot tell which one should own issue #482.', options: ['Platform', 'Identity', 'Mobile'], files: [], resume: true, status: 'pending', createdAt: ago(25) });
  Q.saveGate(R, { id: 'g0', kind: 'approval', agent: 'release-watch', itemId: 'i0', chainId: 'c0', title: 'Restart the staging worker', body: 'x', command: 'harbor restart staging-worker', files: [], resume: true, status: 'executed', createdAt: ago(300), resolvedAt: ago(290) });
  Q.saveGate(R, { id: 'g00', kind: 'question', agent: 'triage', itemId: 'i00', chainId: 'c00', title: 'Which label for issue #471?', body: 'x', files: [], resume: true, status: 'answered', createdAt: ago(200), resolvedAt: ago(180) });
  Q.saveGate(R, { id: 'g000', kind: 'approval', agent: 'daily-report', itemId: 'i000', chainId: 'c000', title: 'Post the report to #eng', body: 'x', command: 'harbor post', files: [], resume: true, status: 'rejected', createdAt: ago(500), resolvedAt: ago(480) });
  w(R, '.loop/tasks/t1.json', { id: 't1', title: 'Investigate payments error-rate spike', state: 'open', holders: ['release-watch'], next: { 'release-watch': 'Wait for the rollback decision, then confirm the error rate recovers.' }, createdAt: ago(20), updatedAt: ago(8), log: [{ ts: ago(20), agent: 'release-watch', event: 'start' }] });
  postHumanMessage(R, 'release-watch', 'Keep an eye on payments after the rollback and tell me if errors do not drop.', new Date(now.getTime() - 40 * 60_000));
  return R;
}

const THEMES = {
  dark: { '--vscode-foreground': '#cccccc', '--vscode-descriptionForeground': '#9d9d9d', '--vscode-editor-background': '#1f1f1f', '--vscode-sideBar-background': '#181818', '--vscode-panel-border': '#2b2b2b', '--vscode-focusBorder': '#0078d4', '--vscode-list-hoverBackground': '#2a2d2e', '--vscode-list-activeSelectionBackground': '#04395e', '--vscode-input-background': '#313131', '--vscode-input-foreground': '#cccccc', '--vscode-input-border': '#3c3c3c', '--vscode-textLink-foreground': '#4daafc', '--vscode-button-background': '#0078d4', '--vscode-button-foreground': '#ffffff', '--vscode-button-hoverBackground': '#026ec1', '--vscode-button-secondaryBackground': '#313131', '--vscode-button-secondaryForeground': '#cccccc', '--vscode-badge-background': '#616161', '--vscode-badge-foreground': '#ffffff', '--vscode-textCodeBlock-background': '#2b2b2b', '--vscode-testing-iconPassed': '#73c991', '--vscode-errorForeground': '#f85149', '--vscode-editorWarning-foreground': '#cca700', '--vscode-charts-red': '#f14c4c', '--vscode-toolbar-hoverBackground': '#383a3d', '--vscode-font-family': '-apple-system, "Segoe UI", sans-serif', '--vscode-font-size': '13px', '--vscode-editor-font-family': 'Menlo, monospace' },
  light: { '--vscode-foreground': '#3b3b3b', '--vscode-descriptionForeground': '#717171', '--vscode-editor-background': '#ffffff', '--vscode-sideBar-background': '#f8f8f8', '--vscode-panel-border': '#e5e5e5', '--vscode-focusBorder': '#005fb8', '--vscode-list-hoverBackground': '#f2f2f2', '--vscode-list-activeSelectionBackground': '#e8e8e8', '--vscode-input-background': '#ffffff', '--vscode-input-foreground': '#3b3b3b', '--vscode-input-border': '#cecece', '--vscode-textLink-foreground': '#005fb8', '--vscode-button-background': '#005fb8', '--vscode-button-foreground': '#ffffff', '--vscode-button-hoverBackground': '#0258a8', '--vscode-button-secondaryBackground': '#e5e5e5', '--vscode-button-secondaryForeground': '#3b3b3b', '--vscode-badge-background': '#cccccc', '--vscode-badge-foreground': '#3b3b3b', '--vscode-textCodeBlock-background': '#f0f0f0', '--vscode-testing-iconPassed': '#388a34', '--vscode-errorForeground': '#f85149', '--vscode-editorWarning-foreground': '#bf8803', '--vscode-charts-red': '#e51400', '--vscode-toolbar-hoverBackground': '#e0e0e0', '--vscode-font-family': '-apple-system, "Segoe UI", sans-serif', '--vscode-font-size': '13px', '--vscode-editor-font-family': 'Menlo, monospace' }
};

(async () => {
  const R = demo();
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-empty-'));
  const scenes = [
    ['chat-needs-you', R, { running: true, active: undefined, tab: 'chat', agent: 'release-watch' }],
    ['chat-question', R, { running: true, active: undefined, tab: 'chat', agent: 'triage' }],
    ['overview', R, { running: true, active: undefined, tab: 'overview' }],
    ['chat-running', R, { running: true, active: 'daily-report', tab: 'chat', agent: 'daily-report' }],
    ['stopped', R, { running: false, tab: 'overview' }],
    ['copilot-off', empty, { running: false, tab: 'chat' }],
    ['empty-workspace', empty, { running: false, tab: 'chat' }]
  ];
  const browser = await chromium.launch();
  const shots = [];
  for (const [theme, vars] of Object.entries(THEMES)) {
    const ctx = await browser.newContext({ viewport: { width: 900, height: 1400 } });
    for (const [name, root, st] of scenes) {
      const page = await ctx.newPage();
      const model = { ...consoleModel(root, st, now), copilot: name === 'copilot-off' ? 0 : 3 };
      let html = renderPage(model, 'n', 'x').replace(/<meta http[^>]*>/, '').replace('<script nonce="n">', '<script>');
      html = html.replace('<head>', `<head><style>:root{${Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';')}} body{background:${vars['--vscode-editor-background']}}</style><script>window.acquireVsCodeApi=()=>({postMessage(){}});</script>`);
      await page.setContent(html);
      const f = path.join(outDir, `${name}.${theme}.png`);
      await page.screenshot({ path: f, fullPage: true });
      shots.push(f);
      await page.close();
    }
    await ctx.close();
  }
  await browser.close();
  console.log(shots.join('\n'));
})().catch(e => { console.error(e); process.exit(1); });
