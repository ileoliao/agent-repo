// What waits on the person: blocked commands as to-dos, where the console opens, the slim approval card, files first. Needs `tsc` first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');
const OUT = path.join(__dirname, '..', 'out');
const { consoleModel, renderBody } = require(`${OUT}/console.js`);
const Q = require(`${OUT}/queue.js`);
const { planAllowCommand } = require(`${OUT}/policyEdit.js`);
const { applyChange } = require(`${OUT}/manage.js`);
const { dismissBlock, setUiFlag } = require(`${OUT}/maintenance.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const dom = html => new JSDOM(`<body>${html}</body>`).window.document;
const w = (R, rel, t) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const agentFile = name => `---\nname: ${name}\ndescription: ${name} does things\nloop:\n  schedule: "0 9 * * *"\n  task: Go.\n---\nYou do careful work and finish with a summary.\n`;
const CMD = 'harbor status --json';
const REFUSED = { type: 'tool', agent: 'beta', step: 1, name: 'run_command', input: { command: CMD }, result: 'REFUSED by policy (no allow rule matched). Retrying will fail the same way.' };

/** alpha is quiet; beta's newest run ended blocked on a command no rule allows. */
function world() {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-'));
  for (const a of ['alpha', 'beta']) { w(R, `.github/agents/${a}.agent.md`, agentFile(a)); }
  Q.audit(R, 'cb', { type: 'start', agent: 'beta', from: 'schedule', task: 'Check' });
  Q.audit(R, 'cb', { ...REFUSED });
  Q.audit(R, 'cb', { type: 'end', agent: 'beta', step: 2, status: 'blocked', summary: 'harbor is not allowed', outputs: [] });
  return R;
}
const model = (R, extra = {}) => consoleModel(R, { running: true, ...extra });

console.log('a blocked command is a to-do, and counts everywhere');
{
  const R = world();
  const m = model(R);
  ok(m.blocked.length === 1 && m.blocked[0].agent === 'beta' && m.blocked[0].command === CMD, 'the refused command of the newest blocked run is a to-do');
  const html = renderBody(m);
  const d = dom(html);
  ok(/1 waiting on you/.test(d.querySelector('.state.wait').textContent), 'the status pill counts it');
  ok(d.querySelector('.tab[data-tab="chat"] .count').textContent === '1', 'so does the Chat tab badge');
  ok(d.querySelector('.roster-row[data-agent="beta"] .count').textContent === '1' && !d.querySelector('.roster-row[data-agent="alpha"] .count'), 'and the badge on that mate in the list');
  const card = d.querySelector('[data-blocked]');
  ok(card && /beta/.test(card.textContent) && card.querySelector('pre.cmd').textContent === CMD && card.querySelector('[data-allow-agent="beta"][data-allow-cmd="harbor status --json"]') && card.querySelector('[data-dismiss-agent="beta"]'), 'its card shows the mate, the exact command, and Allow and Dismiss');
  const ov = dom(renderBody(model(R, { tab: 'overview' })));
  const row = ov.querySelector('.needlist .needrow');
  ok(ov.querySelectorAll('.needrow').length === 1 && row.dataset.agent === 'beta' && /harbor status/.test(row.textContent) && /beta was blocked/.test(row.textContent), 'the Overview lists it as one compact row that opens that mate\'s Chat');
  ok(!ov.querySelector('[data-blocked]') && !ov.querySelector('[data-approve]') && !ov.querySelector('.tile') && /1 waiting on you/.test(ov.querySelector('.state.wait').textContent), 'with no full cards and no stat tiles on the Overview');
}

console.log('allowed or dismissed: not a to-do any more');
{
  const R = world();
  for (const c of planAllowCommand(R, 'beta', CMD).changes) { applyChange(R, c); }
  ok(model(R).blocked.length === 0 && !/data-blocked/.test(renderBody(model(R))), 'once allowed, it is gone from the to-dos');
  ok(!/Allow and rerun/.test(renderBody(model(R, { tab: 'overview' }))), 'and its run no longer offers Allow and rerun');
  const R2 = world();
  dismissBlock(R2, 'beta', CMD);
  ok(model(R2).blocked.length === 0 && JSON.parse(fs.readFileSync(path.join(R2, '.loop/ui-state.json'), 'utf8')).dismissed.length === 1, 'a dismissed command stays gone, and that is saved with the other console state');
  ok(!/Allow and rerun/.test(renderBody(model(R2, { tab: 'overview' }))) && !/waiting on you/.test(renderBody(model(R2))), 'a dismissed one is no count and no button');
  // a later run of that mate that did not end blocked: the old refusal is history
  const R3 = world();
  Q.audit(R3, 'cb2', { type: 'start', agent: 'beta', from: 'schedule', task: 'Check' });
  Q.audit(R3, 'cb2', { type: 'end', agent: 'beta', step: 1, status: 'done', summary: 'fine', outputs: [] });
  const t = Date.now() / 1000 + 5; fs.utimesSync(path.join(R3, '.loop/runs', new Date().toISOString().slice(0, 10), 'cb2.jsonl'), t, t);
  ok(model(R3).blocked.length === 0, 'a newer run that did not end blocked retires an old refusal');
  // a deny rule is never a one-click to-do
  const R4 = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-')); w(R4, '.github/agents/beta.agent.md', agentFile('beta'));
  Q.audit(R4, 'cd', { type: 'start', agent: 'beta', from: 'schedule', task: 'x' });
  Q.audit(R4, 'cd', { ...REFUSED, input: { command: 'curl https://x' }, result: 'REFUSED by policy (\\bcurl\\b). Retrying will fail the same way.' });
  Q.audit(R4, 'cd', { type: 'end', agent: 'beta', step: 2, status: 'blocked', summary: 'no', outputs: [] });
  ok(model(R4).blocked.length === 0, 'a command a deny rule blocks is not offered for a click');
}

console.log('Recent runs: one entry for a blocked command');
{
  const R = world();
  const ov = dom(renderBody(model(R, { tab: 'overview' })));
  const b = ov.querySelector('details.run summary [data-agent="beta"]');
  ok(b && /Decide in Chat/.test(b.textContent) && !ov.querySelector('[data-rerun]') && !ov.querySelector('details.run summary [data-allow-agent]'), 'a run blocked by a command points to the card in Chat, with no second Allow on its row');
  ok(!/tell it what it needs/.test(ov.querySelector('details.run').textContent), 'and no longer says to tell it what it needs');
  Q.audit(R, 'cx', { type: 'start', agent: 'alpha', from: 'schedule', task: 'x' });
  Q.audit(R, 'cx', { type: 'end', agent: 'alpha', step: 1, status: 'blocked', summary: 'needs a secret', outputs: [] });
  const ov2 = dom(renderBody(model(R, { tab: 'overview' })));
  const rows = [...ov2.querySelectorAll('details.run')];
  ok(rows.length === 2 && rows.filter(r => /Decide in Chat/.test(r.querySelector('summary').textContent)).length === 1, 'a Blocked run for any other reason keeps its old row');
}

console.log('where the console opens');
{
  const R = world();
  ok(model(R).chat.selected === 'beta' && model(R).tab === 'chat', 'with a to-do, the Chat opens on the mate behind it');
  ok(model(R, { agent: 'alpha' }).chat.selected === 'alpha', 'a mate the person picked is kept, even while another has a to-do');
  const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-')); for (const a of ['alpha', 'beta']) { w(quiet, `.github/agents/${a}.agent.md`, agentFile(a)); }
  ok(model(quiet).chat.selected === 'alpha', 'with nothing waiting it opens as before');
  Q.saveGate(quiet, { id: 'gq', kind: 'question', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Which?', body: 'b', options: ['x'], files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
  ok(model(quiet).chat.selected === 'beta', 'a question counts the same way');
}

console.log('the approval card fits one screen');
{
  const R = world();
  w(R, '.loop/outbox/d.md', '# draft\nbody');
  Q.saveGate(R, { id: 'ap1', kind: 'approval', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Publish the report', body: 'Posts the report to the channel.', command: 'bash post.sh', files: ['.loop/outbox/d.md'], resume: true, status: 'pending', createdAt: new Date().toISOString() });
  const card = () => dom(renderBody(model(R, { agent: 'beta' }))).querySelector('[data-gate="ap1"]');
  const c = card();
  const order = [...c.querySelectorAll('.card-title, .body, pre.cmd, [data-reject], [data-approve], details.gatefiles')].map(x => x.matches('.card-title') ? 'title' : x.matches('.body') ? 'body' : x.matches('pre.cmd') ? 'cmd' : x.matches('[data-reject]') ? 'reject' : x.matches('[data-approve]') ? 'approve' : 'files');
  ok(order.join() === 'title,body,cmd,files,reject,approve', 'title, short note, exact command, the one line naming the files, then both buttons');
  ok(!c.querySelector('textarea') && c.querySelector('[data-copy="bash post.sh"]') && /beta/.test(c.querySelector('.meta').textContent), 'no text box, a copy button for the command, and the mate\'s name');
  const fold = c.querySelector('details.gatefiles');
  ok(!fold.open && /Approving also covers this file: d\.md/.test(fold.querySelector('summary').textContent) && !/Nothing but this exact command/.test(c.textContent) && fold.querySelector('[data-hash-for=".loop/outbox/d.md"]') && fold.querySelector('[data-open=".loop/outbox/d.md"]') && /covers the files shown/.test(fold.textContent), 'the files are named in one line and folded, with their hash kept, and say what approval covers');
  ok(/Runs as you, not in a sandbox/.test(c.textContent) && !/Runs as you/.test(fold.textContent), 'the first approval carries the one-time note about running as you, outside the fold');
  setUiFlag(R, 'approvalNoteSeen');
  ok(model(R).firstApproval === false && !/Runs as you/.test(card().textContent), 'once an approval was decided the note is not shown again');
  Q.saveGate(R, { id: 'ap2', kind: 'approval', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Second', body: 'b', command: 'x', files: [], resume: true, status: 'pending', createdAt: new Date(Date.now() - 60000).toISOString() });
  const d2 = dom(renderBody(model(R, { agent: 'beta' })));
  ok(d2.querySelector('[data-gate="ap1"]') && !d2.querySelector('[data-gate="ap2"]') && d2.querySelector('[data-queued="ap2"]') && !d2.querySelector('[data-gate="ap1"] details.gatefiles[open]'), 'with two (newest first, as the lists show them), the first is the card and the second waits behind it');
}

console.log('results first');
{
  const R = world();
  w(R, '.loop/outbox/alpha/today.md', '# Daily report\nx');
  Q.audit(R, 'ca', { type: 'start', agent: 'alpha', from: 'schedule', task: 'Report' });
  Q.audit(R, 'ca', { type: 'end', agent: 'alpha', step: 2, status: 'done', summary: 'Report written', outputs: ['.loop/outbox/alpha/today.md', 'src/x.ts'] });
  const m = model(R, { tab: 'overview' });
  ok(m.outputs.alpha.path === '.loop/outbox/alpha/today.md' && !m.outputs.beta && m.latest.agent === 'alpha', 'the model knows each mate\'s latest output and the newest of all');
  const d = dom(renderBody(m));
  const run = [...d.querySelectorAll('details.run')].find(r => /alpha/.test(r.querySelector('.run-agent').textContent));
  const link = run.querySelector('summary a.deliv[data-open=".loop/outbox/alpha/today.md"]');
  ok(link && link.querySelector('.dname').textContent === 'today.md' && /alpha/.test(link.querySelector('.ddir').textContent), 'a finished run lists its file under its summary: name, folder, one click to open');
  const mate = [...d.querySelectorAll('.agent')].find(a => /alpha/.test(a.querySelector('.agent-name').textContent));
  ok(/Latest output: today\.md/.test(mate.textContent) && mate.querySelector('.lastout [data-open=".loop/outbox/alpha/today.md"]') && !/Latest output/.test([...d.querySelectorAll('.agent')].find(a => /beta/.test(a.querySelector('.agent-name').textContent)).textContent), 'a mate card says its latest output, and says nothing for a mate with none');
  ok(/Latest: alpha · today\.md/.test(d.querySelector('.bar').textContent) && d.querySelector('.bar [data-open=".loop/outbox/alpha/today.md"]'), 'the top button says where the file comes from');
  ok(!/Latest:/.test(dom(renderBody(model(world(), { tab: 'overview' }))).querySelector('.bar').textContent), 'with no output yet the button is hidden');
  const chat = dom(renderBody(model(R, { agent: 'alpha' })));
  ok(/Latest output: today\.md/.test(chat.querySelector('.chat-head').textContent) && chat.querySelector('.rcard .rdelivs [data-open=".loop/outbox/alpha/today.md"]'), 'the conversation head and the run block in it show the file too');
  Q.audit(R, 'cs', { type: 'start', agent: 'alpha', from: 'schedule', task: 'Code' });
  Q.audit(R, 'cs', { type: 'end', agent: 'alpha', step: 1, status: 'done', summary: 'Edited', outputs: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'] });
  const t = Date.now() / 1000 + 5; fs.utimesSync(path.join(R, '.loop/runs', new Date().toISOString().slice(0, 10), 'cs.jsonl'), t, t);
  const d2 = dom(renderBody(model(R, { agent: 'alpha' })));
  const names = [...d2.querySelectorAll('.rdelivs .dname')].map(x => x.textContent);
  ok(['a.ts', 'b.ts', 'c.ts'].every(f => names.includes(f)) && !names.includes('d.ts') && /1 supporting file/.test(d2.body.textContent), 'a run that declared nothing shows the first few files it wrote directly, and folds the rest');
}
console.log(`${n} attention checks passed`);
