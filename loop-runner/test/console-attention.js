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
  ok(/1 needs you/.test(d.querySelector('.state.wait').textContent) && d.querySelector('.state.wait').dataset.agent === 'beta' && d.querySelector('.state.wait').dataset.scroll === '1', 'the status pill counts it, and is a button to that mate and its card');
  ok(d.querySelector('.roster-row[data-agent="beta"] .count').textContent === '1' && !d.querySelector('.roster-row[data-agent="alpha"] .count'), 'and the badge on that mate in the list');
  const card = d.querySelector('[data-blocked]');
  ok(card && /beta/.test(card.textContent) && card.querySelector('pre.cmd').textContent === CMD && card.querySelector('[data-allow-agent="beta"][data-allow-cmd="harbor status --json"]') && card.querySelector('[data-dismiss-agent="beta"]'), 'its card shows the mate, the exact command, and Allow and Dismiss');
}

console.log('allowed or dismissed: not a to-do any more');
{
  const R = world();
  for (const c of planAllowCommand(R, 'beta', CMD).changes) { applyChange(R, c); }
  ok(model(R).blocked.length === 0 && !/data-blocked/.test(renderBody(model(R))), 'once allowed, it is gone from the to-dos');
    const R2 = world();
  dismissBlock(R2, 'beta', CMD);
  ok(model(R2).blocked.length === 0 && JSON.parse(fs.readFileSync(path.join(R2, '.loop/ui-state.json'), 'utf8')).dismissed.length === 1, 'a dismissed command stays gone, and that is saved with the other console state');
  ok(!/need you|needs you<\/button>/.test(renderBody(model(R2))) && !/data-blocked/.test(renderBody(model(R2))), 'a dismissed one is no count and no card');
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

console.log('an agent with several goals');
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-goals-'));
  w(R, '.github/agents/multi.agent.md', '---\nname: multi\ndescription: looks after several things\nloop:\n  goals:\n    - id: report\n      text: Write the morning report\n      schedule: "0 9 * * 1-5"\n      task: Report.\n    - id: health\n      text: Watch release health\n      schedule: "*/30 * * * *"\n      task: Check.\n    - id: issues\n      text: Triage new issues\n      on: "webhook:issue"\n      task: Triage.\n---\nCareful.\n');
  w(R, '.github/agents/solo.agent.md', agentFile('solo'));
  const chatOf = name => dom(renderBody(model(R, { agent: name }))).querySelector('.ch-facts');
  const facts = chatOf('multi');
  const items = [...facts.querySelectorAll('.goalfold li')];
  ok(/3 goals/.test(facts.querySelector('summary').textContent) && !/Runs /.test(facts.textContent), 'the chat header counts the goals instead of listing every schedule');
  ok(items.length === 3 && /Write the morning report/.test(items[0].textContent) && /weekdays at 09:00/.test(items[0].textContent) && /Triage new issues/.test(items[2].textContent) && /webhook/.test(items[2].textContent), 'and unfolding says which goal runs when');
  ok(/Runs every day at 09:00/.test(chatOf('solo').textContent) && !chatOf('solo').querySelector('.goalfold'), 'one goal keeps the plain line');
}

console.log('where the console opens, and how the roster is ordered');
{
  const R = world();
  ok(model(R).chat.selected === 'beta' && model(R).tab === undefined, 'with a to-do, the console opens on the mate behind it');
  ok(model(R, { agent: 'alpha' }).chat.selected === 'alpha', 'a mate the person picked is kept, even while another has a to-do');
  const quiet = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-')); for (const a of ['alpha', 'beta']) { w(quiet, `.github/agents/${a}.agent.md`, agentFile(a)); }
  ok(model(quiet).chat.selected === 'alpha' && model(quiet).chat.agents.map(a => a.name).join() === 'alpha,beta', 'with nothing to go on it opens on the first mate, in name order');
  Q.saveGate(quiet, { id: 'gq', kind: 'question', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Which?', body: 'b', options: ['x'], files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
  ok(model(quiet).chat.selected === 'beta', 'a question counts the same way');
  // the most recently active one, when nothing waits and nothing runs
  const recent = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-')); for (const a of ['alpha', 'beta', 'gamma']) { w(recent, `.github/agents/${a}.agent.md`, agentFile(a)); }
  const endRun = (chain, agent, minutesAgo) => { Q.audit(recent, chain, { type: 'start', agent, from: 'schedule', task: 'x', ts: new Date(Date.now() - (minutesAgo + 1) * 60000).toISOString() }); Q.audit(recent, chain, { type: 'end', agent, step: 1, status: 'done', summary: 'ok', outputs: [], ts: new Date(Date.now() - minutesAgo * 60000).toISOString() }); };
  endRun('r1', 'alpha', 300); endRun('r2', 'gamma', 10); endRun('r3', 'beta', 120);
  ok(model(recent).chat.agents.map(a => a.name).join() === 'gamma,beta,alpha' && model(recent).chat.selected === 'gamma', 'with nothing waiting or working, the rest are by latest activity and the newest is opened');
  // working goes before idle; needing you goes before working, the longest wait first
  const rows = model(recent, { active: ['beta'] }).chat;
  ok(rows.agents[0].name === 'beta' && rows.selected === 'beta', 'a working mate is first, and opened, when nothing waits');
  const stamp = min => new Date(Date.now() - min * 60000).toISOString();
  Q.saveGate(recent, { id: 'old', kind: 'question', agent: 'alpha', itemId: 'i', chainId: 'c', title: 'Old one', body: 'b', files: [], resume: true, status: 'pending', createdAt: stamp(90) });
  Q.saveGate(recent, { id: 'new', kind: 'approval', agent: 'gamma', itemId: 'i', chainId: 'c', title: 'New one', body: 'b', command: 'x', files: [], resume: true, status: 'pending', createdAt: stamp(5) });
  const m2 = model(recent, { active: ['beta'] });
  ok(m2.chat.agents.map(a => a.name).join() === 'alpha,gamma,beta' && m2.chat.selected === 'alpha', 'mates that need you come first (waiting longest on top), then working ones, then the rest');
  ok(m2.pending.map(g => g.id).join() === 'old,new' && dom(renderBody(m2)).querySelector('.state.wait').dataset.agent === 'alpha' && /2 need you/.test(dom(renderBody(m2)).querySelector('.state.wait').textContent), 'the header pill goes to the mate with the oldest wait');
  ok(model(recent, { agent: 'gamma' }).chat.selected === 'gamma' && model(recent, { agent: 'nobody' }).chat.selected === 'alpha', 'a choice is kept; an unknown one falls back to the opening rule');
  Q.saveGate(recent, { id: 'old2', kind: 'question', agent: 'alpha', itemId: 'i', chainId: 'c', title: 'Second for alpha', body: 'b', files: [], resume: true, status: 'pending', createdAt: stamp(60) });
  ok(model(recent).chat.gates.map(g => g.id).join() === 'old,old2', 'a mate\'s waiting items are in the order they were asked');
}

console.log('tasks in the mate header');
{
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-attn-')); for (const a of ['alpha', 'beta']) { w(R, `.github/agents/${a}.agent.md`, agentFile(a)); }
  w(R, '.loop/tasks/t1.json', JSON.stringify({ id: 't1', title: 'Investigate payments error-rate spike', state: 'open', holders: ['alpha'], next: { alpha: 'Wait for the rollback decision' }, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), log: [] }));
  const head = name => dom(renderBody(model(R, { agent: name }))).querySelector('.chat-head');
  ok(/Working on: Investigate payments error-rate spike — next: Wait for the rollback decision/.test(head('alpha').querySelector('.ch-task').textContent) && head('alpha').querySelector('.ch-task [data-close-task="t1"]'), 'the mate holding a task shows one line for it, with the next step and a Drop button');
  ok(!head('beta').querySelector('.ch-task'), 'a mate without an open task shows nothing');
}

console.log('the approval card fits one screen');
{
  const R = world();
  w(R, '.loop/outbox/d.md', '# draft\nbody');
  Q.saveGate(R, { id: 'ap1', kind: 'approval', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Publish the report', body: 'Posts the report to the channel.', command: 'bash post.sh', files: ['.loop/outbox/d.md'], resume: true, status: 'pending', createdAt: new Date().toISOString() });
  const card = () => dom(renderBody(model(R, { agent: 'beta' }))).querySelector('[data-gate="ap1"]');
  const c = card();
  const order = [...c.querySelectorAll('.card-title, .body, pre.cmd, [data-reject-open], [data-approve], details.gatefiles')].map(x => x.matches('.card-title') ? 'title' : x.matches('.body') ? 'body' : x.matches('pre.cmd') ? 'cmd' : x.matches('[data-reject-open]') ? 'reject' : x.matches('[data-approve]') ? 'approve' : 'files');
  ok(order.join() === 'title,body,cmd,files,reject,approve', 'title, short note, exact command, the one line naming the files, then both buttons');
  ok(c.querySelectorAll('textarea').length === 1 && c.querySelector('[data-reject-box] textarea') && c.querySelector('[data-reject-box]').classList.contains('hidden') && c.querySelector('[data-copy="bash post.sh"]') && /beta/.test(c.querySelector('.meta').textContent), 'the only text field is the hidden reject reason; a copy button for the command, and the mate\'s name');
  const fold = c.querySelector('details.gatefiles');
  ok(!fold.open && /Also covers: d\.md/.test(fold.querySelector('summary').textContent) && !/Nothing but this exact command/.test(c.textContent) && fold.querySelector('[data-hash-for=".loop/outbox/d.md"]') && fold.querySelector('[data-open=".loop/outbox/d.md"]') && /covers the files shown/.test(fold.textContent), 'the files are named in one line and folded, with their hash kept, and say what approval covers');
  ok(/Runs as you, not in a sandbox/.test(c.textContent) && !/Runs as you/.test(fold.textContent), 'the first approval carries the one-time note about running as you, outside the fold');
  setUiFlag(R, 'approvalNoteSeen');
  ok(model(R).firstApproval === false && !/Runs as you/.test(card().textContent), 'once an approval was decided the note is not shown again');
  Q.saveGate(R, { id: 'ap2', kind: 'approval', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Second', body: 'b', command: 'x', files: [], resume: true, status: 'pending', createdAt: new Date(Date.now() - 60000).toISOString() });
  const d2 = dom(renderBody(model(R, { agent: 'beta' })));
  ok(d2.querySelector('[data-gate="ap2"]') && !d2.querySelector('[data-gate="ap1"]') && d2.querySelector('[data-queued="ap1"]') && !d2.querySelector('[data-gate="ap2"] details.gatefiles[open]'), 'with two, the one asked first is the card and the later one waits behind it');
}

console.log('results first');
{
  const R = world();
  w(R, '.loop/outbox/alpha/today.md', '# Daily report\nx');
  Q.audit(R, 'ca', { type: 'start', agent: 'alpha', from: 'schedule', task: 'Report' });
  Q.audit(R, 'ca', { type: 'end', agent: 'alpha', step: 2, status: 'done', summary: 'Report written', outputs: ['.loop/outbox/alpha/today.md', 'src/x.ts'] });
  const m = model(R);
  ok(m.outputs.alpha.path === '.loop/outbox/alpha/today.md' && !m.outputs.beta && m.latest.agent === 'alpha', 'the model knows each mate\'s latest output and the newest of all');
  const bar = dom(renderBody(m)).querySelector('.bar');
  ok(!/Latest/.test(bar.textContent) && !bar.querySelector('[data-open]'), 'the top bar carries no Latest button: the file is in the mate\'s header');
  ok(!/Latest output/.test(dom(renderBody(model(R, { agent: 'beta' }))).querySelector('.chat-head').textContent), 'a mate with no output says nothing about one');
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
