// Runs the console page's own script in jsdom: double click, changed drafts, rejecting with a reason, typed text. Run: npm test
const { JSDOM } = require('jsdom');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { renderPage, renderBody: renderBody0, consoleModel } = require(OUT + '/console.js');
const now = new Date().toISOString();
const gate = (hash, text) => ({ id: 'g1', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', command: 'echo hi', files: ['d.md'], resume: true, status: 'pending', createdAt: now, previews: [{ path: 'd.md', text, sha256: hash, truncated: false }] });
// The page is one screen, the roster and the open mate's conversation, where questions and approvals are decided: keep the open mate's gates in step with `pending`.
const chatOf = gates => ({ agents: [{ name: 'a', description: 'd', state: 'waiting', avatar: 'waiting', line: 'x', pendingMessages: 0, needsYou: gates.length }], selected: 'a', events: [], hidden: 0, gates });
const base = { running: true, active: undefined, chat: chatOf([gate('h1', 'v1')]), pending: [gate('h1', 'v1')], agents: [], updatedAt: now,
  runs: [{ chainId: 'r1', agent: 'a', status: 'done', summary: 's', started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] },
         { chainId: 'r2', agent: 'a', status: 'error', summary: 'e', started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] }] };
const renderBody = m => renderBody0(m.chat === base.chat ? { ...m, chat: chatOf(m.pending) } : m);
const sent = [];
const dom = new JSDOM(renderPage({ ...base }, 'n', 'x').replace(/<meta http[^>]*>/, '').replace('<script nonce="n">', '<script>'), { runScripts: 'dangerously', pretendToBeVisual: true,
  beforeParse(w) { w.acquireVsCodeApi = () => ({ postMessage: m => sent.push(m) }); w.CSS = { escape: s => String(s).replace(/"/g, '\\"') }; w.scrollTo = () => {}; } });
const w = dom.window, d = w.document; let n = 0; const ok = (c, m) => { if (!c) { console.log('FAIL', m); process.exitCode = 1; } else { n++; console.log('  ✓', m); } };
const post = html => w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'body', html } }));
const ap = () => d.querySelector('[data-approve]');
ok(sent[0]?.type === 'ready', 'page announces itself');
ok(!ap().disabled, 'approve starts enabled');
ap().click(); ap().click();
ok(sent.filter(m => m.type === 'approve').length === 1, 'a double click sends one approval');
ok(sent.find(m => m.type === 'approve').seen['d.md'] === 'h1', 'the approval carries the hash of what was shown');
ok(ap().disabled && ap().getAttribute('aria-busy') === 'true' && /Running/.test(ap().textContent), 'the button shows it is running');
post(renderBody({ ...base }));
ok(ap().disabled, 'still disabled after a refresh redraws the card');
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'idle', id: 'g1' } }));
ok(!ap().disabled, 'enabled again once the host says it finished');
post(renderBody({ ...base, pending: [gate('h2', 'v2 CHANGED')] }));
ok(ap().disabled && d.querySelector('.stale'), 'a draft that changed under the reader disables approve and says why');
d.querySelector('[data-ack]').click();
ok(!ap().disabled && !d.querySelector('.stale'), 'confirming the new version enables approve again');
ap().click();
ok(sent.filter(m => m.type === 'approve').at(-1).seen['d.md'] === 'h2', 'the new approval is bound to the new hash');
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'idle', id: 'g1' } }));
// typing is kept across a refresh
const q = base.pending[0];
post(renderBody({ ...base, pending: [gate('h2', 'v2 CHANGED')] }));
ok(!!d.querySelector('.card[data-gate] [data-reject-box] textarea') && d.querySelector('[data-reject-box]').classList.contains('hidden'), 'the reason field is on the approval card, and hidden until you reject');
const box = () => d.querySelector('[data-chat-input]');
ok(box().dataset.approvalFor === undefined && box().placeholder === 'Message a…' && !/Reason if you reject/.test(d.body.innerHTML) && !d.querySelector('[data-chat-send]').disabled, 'the one box at the bottom only messages the mate, whatever is waiting');
d.querySelector('[data-reject-open]').click();
ok(!d.querySelector('[data-reject-box]').classList.contains('hidden') && d.querySelector('[data-actions]').classList.contains('hidden') && /Why\? The mate reads this \(optional\)/.test(d.querySelector('[data-reject-box] textarea').placeholder), 'Reject opens a small "Why? The mate reads this (optional)" field with Reject and Cancel');
ok(!sent.some(m => m.type === 'reject'), 'and nothing is sent yet');
d.querySelector('[data-reject-box] textarea').value = 'my reason';
post(renderBody({ ...base, pending: [gate('h2', 'v2 CHANGED')] }));
ok(!d.querySelector('[data-reject-box]').classList.contains('hidden') && d.querySelector('[data-reject-box] textarea').value === 'my reason', 'the open field and what you typed survive a refresh');
d.querySelector('[data-reject-cancel]').click();
ok(d.querySelector('[data-reject-box]').classList.contains('hidden') && !d.querySelector('[data-actions]').classList.contains('hidden') && d.querySelector('[data-reject-box] textarea').value === '' && !sent.some(m => m.type === 'reject'), 'Cancel closes it and sends nothing');
d.querySelector('[data-reject-open]').click();
d.querySelector('[data-reject-box] textarea').value = '  too risky  ';
d.querySelector('[data-reject]').click();
ok(sent.at(-1).type === 'reject' && sent.at(-1).id === 'g1' && sent.at(-1).feedback === 'too risky', 'confirming sends the reject message with the reason');
post(renderBody({ ...base, pending: [gate('h2', 'v2 CHANGED')] }));
d.querySelector('[data-reject-open]').click();
d.querySelector('[data-reject]').click();
ok(sent.at(-1).type === 'reject' && sent.at(-1).feedback === '', 'the reason is optional');
box().value = 'unused words';
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'idle', id: 'g1' } }));
d.querySelector('[data-approve]').click();
ok(sent.at(-1).type === 'approve' && sent.at(-1).feedback === undefined && box().value === 'unused words', 'approve sends no reason and leaves the message box alone');
box().value = 'a note for later';
d.querySelector('[data-chat-send]').click();
ok(sent.at(-1).type === 'chatSend' && sent.at(-1).agent === 'a' && sent.at(-1).text === 'a note for later', 'with an approval waiting, the box sends an ordinary message to the mate');
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'idle', id: 'g1' } }));
// a hostile id cannot break selectors
post(renderBody({ ...base, pending: [{ ...gate('h', 'x'), id: 'a"b' }] }));
let threw = false; try { d.querySelector('[data-approve]').click(); } catch { threw = true; }
ok(!threw, 'an id with a quote does not throw');

// ---- open tasks in the mate's header ----
{
  const task = { id: 't"1', title: '<b>Watch backlog</b>', state: 'open', holders: ['a', 'b'], next: { a: 'wait for <i>b</i>' }, createdAt: now, updatedAt: now, log: [] };
  const other = { ...task, id: 't2', title: 'Only for b', holders: ['b'] };
  post(renderBody({ ...base, tasks: [task, other] }));
  const line = d.querySelector('.ch-tasks [data-task]');
  ok(line && !line.querySelector('b') && !line.querySelector('i') && /Working on: <b>Watch backlog<\/b> — next: wait for <i>b<\/i>/.test(line.textContent), 'the selected mate\'s open task is one compact line in its header, escaped, with its next step');
  ok(d.querySelectorAll('[data-task]').length === 1, 'and only the tasks that mate holds');
  const drop = line.querySelector('[data-close-task]');
  ok(/^Drop task$/.test(drop.textContent.trim()), 'with a small Drop task button');
  const before = sent.length;
  drop.click();
  ok(sent.length === before && /^Confirm drop$/.test(drop.textContent.trim()), 'the first click only asks to confirm');
  drop.click();
  ok(sent.at(-1).type === 'closeTask' && sent.at(-1).id === 't"1', 'the second click sends the task id');
  post(renderBody({ ...base }));
  ok(!d.querySelector('[data-task]'), 'no tasks, no line (and a model without the field still renders)');
}

// ---- the chat page ----
{
  const evts = [
    { kind: 'status', ts: now, label: 'Scheduled run started', tone: 'info', chainId: 'c', detail: 'do it' },
    { kind: 'human', ts: now, id: 'h1', text: 'hello', status: 'delivered', via: 'turn' },
    { kind: 'agent', ts: now, text: 'On it.', step: 1 },
    { kind: 'steps', ts: now, steps: [{ step: 1, kind: 'tool', title: 'run_command · ls', phrase: 'ls', routine: false, detail: '[exit 0]', ok: true }, { step: 2, kind: 'tool', title: 'read_file · x', phrase: 'read x', routine: true, fam: 'read', famKind: 'read', detail: 'REFUSED', ok: false }] }
  ];
  const chatModel = (selected, events = evts, gates = []) => ({ ...base, pending: gates,
    chat: { agents: [{ name: 'a', description: 'agent a', state: 'running', avatar: 'working', line: 'ls', pendingMessages: 0, needsYou: 0 }, { name: 'b', description: 'agent b', state: 'idle', avatar: 'idle', line: 'agent b', pendingMessages: 0, needsYou: 0 }], selected, events, hidden: 0, gates } });
  const sent2 = [], scrolled = [];
  const dom2 = new JSDOM(renderPage(chatModel('a'), 'n', 'x').replace(/<meta http[^>]*>/, '').replace('<script nonce="n">', '<script>'), { runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w2) {
      w2.Element.prototype.scrollIntoView = function () { scrolled.push(this.className); };
      w2.acquireVsCodeApi = () => ({ postMessage: m => sent2.push(m) }); w2.CSS = { escape: x => String(x).replace(/"/g, '\\"') }; w2.scrollTo = () => {};
      // jsdom has no layout: give elements a scrollable box so "stay at the bottom" can be observed.
      const tops = new WeakMap();
      Object.defineProperty(w2.Element.prototype, 'scrollTop', { get() { return tops.get(this) ?? 0; }, set(v) { tops.set(this, v); }, configurable: true });
      Object.defineProperty(w2.Element.prototype, 'scrollHeight', { get() { return 1000; }, configurable: true });
      Object.defineProperty(w2.Element.prototype, 'clientHeight', { get() { return 300; }, configurable: true });
    } });
  const w2 = dom2.window, d2 = w2.document;
  const post2 = html => w2.dispatchEvent(new w2.MessageEvent('message', { data: { type: 'body', html } }));
  const box = () => d2.querySelector('[data-input^="chat:"]');
  const key = (type, init) => { const e = new w2.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init }); box().dispatchEvent(e); return e; };
  ok(!!d2.querySelector('[data-thread="a"]') && d2.querySelectorAll('.msg').length >= 3 && !d2.querySelector('[data-tab]') && !d2.querySelector('[role=tablist]'), 'the page shows the conversation with the selected mate, and has no tabs');
  ok(d2.querySelector('[data-thread]').scrollTop === 1000, 'it opens on the newest message');
  d2.querySelector('[data-agent="b"]').click();
  ok(sent2.at(-1).type === 'view' && sent2.at(-1).agent === 'b', 'picking another mate asks for that conversation');
  // the header pill: to the mate waiting longest, and to its card
  {
    const gb = { id: 'gp', kind: 'question', agent: 'b', itemId: 'i', chainId: 'c', title: 'Which?', body: 'x', options: [], files: [], resume: true, status: 'pending', createdAt: now, previews: [] };
    const waitingB = { ...chatModel('a'), pending: [gb] };
    post2(renderBody(waitingB));
    const pill = d2.querySelector('button.state.wait');
    ok(pill && /1 needs you/.test(pill.textContent) && pill.dataset.agent === 'b', 'the header pill names the count and targets the mate that is waiting');
    pill.click();
    ok(sent2.at(-1).type === 'view' && sent2.at(-1).agent === 'b' && !scrolled.length, 'clicking it selects that mate (the card is not on this page yet)');
    const chatB = chatModel('b', [], [gb]); chatB.pending = [gb]; chatB.chat.agents[1] = { ...chatB.chat.agents[1], state: 'waiting', avatar: 'waiting', needsYou: 1 };
    post2(renderBody(chatB));
    ok(scrolled.some(c => /thread-gates/.test(c)), 'and once the page for that mate is drawn it scrolls to the card');
    scrolled.length = 0;
    const again = d2.querySelector('button.state.wait'); again.click();
    ok(scrolled.some(c => /thread-gates/.test(c)), 'when that mate is already open it scrolls straight away');
    post2(renderBody(chatModel('a')));
  }
  const count = () => sent2.filter(m => m.type === 'chatSend').length;
  box().value = '   ';
  d2.querySelector('[data-chat-send]').click();
  ok(count() === 0, 'an empty message is not sent');
  box().value = 'please stop the docs part';
  d2.querySelector('[data-chat-send]').click();
  ok(count() === 1 && sent2.at(-1).agent === 'a' && sent2.at(-1).text === 'please stop the docs part' && box().value === '', 'Send posts the message for that agent and clears the box');
  box().value = 'line one';
  const shift = key('keydown', { key: 'Enter', shiftKey: true });
  ok(count() === 1 && !shift.defaultPrevented, 'Shift+Enter is a new line, not a send');
  const ime = key('keydown', { key: 'Enter', isComposing: true });
  ok(count() === 1 && !ime.defaultPrevented, 'Enter that confirms an input-method composition (Chinese, Japanese) does not send');
  const ime2 = key('keydown', { key: 'Enter', keyCode: 229 });
  ok(count() === 1 && !ime2.defaultPrevented, 'nor does the legacy composition key code');
  const enter = key('keydown', { key: 'Enter' });
  ok(count() === 2 && enter.defaultPrevented && sent2.at(-1).text === 'line one' && box().value === '', 'Enter sends');
  // cancel needs two clicks
  const cancel = () => d2.querySelector('[data-chat-cancel]');
  const before = sent2.length;
  cancel().click();
  ok(sent2.length === before && /Click again/.test(cancel().textContent), 'Cancel this run asks for a second click first');
  cancel().click();
  ok(sent2.at(-1).type === 'chatCancel' && sent2.at(-1).agent === 'a', 'the second click cancels');
  // refreshes
  box().value = 'half-written thought';
  box().focus();
  post2(renderBody(chatModel('a', [...evts, { kind: 'agent', ts: now, text: 'Another thing.', step: 2 }])));
  ok(box().value === 'half-written thought' && d2.activeElement === box(), 'a refresh keeps what you were typing and where you were typing it');
  ok(d2.querySelector('[data-thread]').scrollTop === 1000, 'and keeps a reader at the bottom with the newest message');
  d2.querySelector('[data-thread]').scrollTop = 100;
  post2(renderBody(chatModel('a', [...evts, { kind: 'agent', ts: now, text: 'Yet another.', step: 3 }])));
  ok(d2.querySelector('[data-thread]').scrollTop === 100, 'but does not pull someone who scrolled up to read earlier messages');
  post2(renderBody(chatModel('b', [{ kind: 'agent', ts: now, text: 'b here', step: 1 }])));
  ok(d2.querySelector('[data-thread="b"]').scrollTop === 1000, 'a different conversation starts at its newest message');
  // writing to another agent, stopping, and sending from anywhere
  post2(renderBody(chatModel('a')));
  const cs = () => sent2.filter(m => m.type === 'chatSend');
  box().value = '@b please look at the backlog';
  d2.querySelector('[data-chat-send]').click();
  ok(cs().at(-1).agent === 'b' && cs().at(-1).text === 'please look at the backlog' && sent2.at(-1).type === 'view' && sent2.at(-1).agent === 'b', '@name writes to that agent instead, and opens its conversation');
  box().value = '@nobody hello there';
  d2.querySelector('[data-chat-send]').click();
  ok(cs().at(-1).agent === 'a' && cs().at(-1).text === '@nobody hello there', 'an @name that is not an agent is just text for this one');
  box().value = '/stop';
  d2.querySelector('[data-chat-send]').click();
  ok(sent2.at(-1).type === 'chatCancel' && sent2.at(-1).agent === 'a' && box().value === '', '/stop ends the current run, like telling it to stop');
  box().value = 'sent from the keyboard shortcut';
  d2.body.dispatchEvent(new w2.KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
  ok(cs().at(-1).text === 'sent from the keyboard shortcut', 'Cmd/Ctrl+Enter sends from anywhere on the page');
  ok(d2.querySelector('.composer').classList.contains('running') && d2.querySelector('.roster-row.on .av.working') && d2.querySelector('.roster-row[data-agent="b"] .av.idle'), 'the composer, and each avatar, show what the agent is doing');
  // an agent's question sits in the thread and can be answered there
  const q = { id: 'gq', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 'Which?', body: 'two', options: ['red', 'blue'], files: [], resume: true, status: 'pending', createdAt: now, previews: [] };
  post2(renderBody(chatModel('a', evts, [q])));
  ok(!d2.querySelector('[data-gate="gq"] textarea') && d2.querySelector('[data-chat-input]').dataset.answerFor === 'gq' && d2.querySelector('[data-chat-input]').placeholder === 'Answer a…', 'a question card has no text box; the one box answers it');
  d2.querySelector('[data-pick="gq"][data-text="blue"]').click();
  ok(d2.querySelector('[data-chat-send]').classList.contains('ready') && box().value === 'blue', 'picking a suggestion fills the one box and lights up Send');
  d2.querySelector('[data-chat-send]').click();
  ok(sent2.at(-1).type === 'answer' && sent2.at(-1).id === 'gq' && sent2.at(-1).text === 'blue' && box().value === '', 'sending with a question open answers it right there');
  box().value = 'typed answer';
  d2.querySelector('[data-chat-send]').click();
  ok(sent2.at(-1).type === 'answer' && sent2.at(-1).text === 'typed answer' && !sent2.slice(-2).some(m => m.type === 'chatSend'), 'a typed answer is an answer, not a message');
  box().value = '/stop';
  d2.querySelector('[data-chat-send]').click();
  ok(sent2.at(-1).type === 'chatCancel', '/stop still stops the run while a question is open');
  // several to-dos: the first is handled, the rest wait their turn
  const q2 = { ...q, id: 'gq2', title: 'Second?' };
  post2(renderBody(chatModel('a', evts, [q, q2])));
  ok(d2.querySelector('[data-chat-input]').dataset.answerFor === 'gq' && d2.querySelector('[data-gate="gq"]') && !d2.querySelector('[data-gate="gq2"]') && d2.querySelector('[data-queued="gq2"]'), 'with two to-dos the box answers the first and the second waits behind it');
  w2.close();
}
// ---- humanized tool calls, folding, nothing important hidden ----
{
  const { humanize } = require(OUT + '/textutil.js');
  const h = (name, input) => humanize(name, input);
  ok(h('run_command', { command: 'python3 .github/skills/loop-memory/scripts/mem.py check --key a' }).phrase === 'loop-memory · check', 'a skill script reads as skill · subcommand');
  ok(h('run_command', { command: 'python3 .github/skills/loop-memory/scripts/mem.py track --key a' }).routine && h('run_command', { command: 'git -C repos/x log' }).phrase === 'Ran git -C repos/x log' && !h('run_command', { command: 'git status' }).routine, 'other commands show the program and a clip, and are not routine');
  ok(h('read_file', { path: 'a/b/c.md' }).phrase === 'Read c.md' && h('list_dir', { path: 'a/b' }).routine, 'reads and listings are routine');
  const st = (title, input, name, detail, ok2 = true) => ({ step: 1, kind: 'tool', title: `${name} · ${title}`, ...h(name, input), detail, ok: ok2 });
  const mem = c => st(`python3 .github/skills/loop-memory/scripts/mem.py ${c} --key k`, { command: `python3 .github/skills/loop-memory/scripts/mem.py ${c} --key k` }, 'run_command', '[exit 0]');
  const steps = [mem('recall'), mem('check'), mem('track'), mem('note'), st('a.md', { path: 'a.md' }, 'read_file', 'text'), st('b.md', { path: 'b.md' }, 'read_file', 'text'),
    st('rm <x>', { command: 'rm <x>' }, 'run_command', 'REFUSED: not allowed <b>x</b>', false), st('d', { path: 'd' }, 'list_dir', 'ERROR: <i>nope</i>', false),
    { step: 9, kind: 'tool', title: 'handoff · techlead', ...h('handoff', { to: 'techlead', task: 'Find the <u>root cause</u>' }), detail: 'Handed off', ok: true }];
  const gate0 = { id: 'g9', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: 'Post', body: 'b', command: 'bash post.sh "<q>"', files: ['out/<f>.md'], resume: true, status: 'pending', createdAt: now, previews: [{ path: 'out/<f>.md', text: 'T', sha256: 'hh', truncated: false }] };
  const model = { ...base, pending: [gate0], chat: { agents: [{ name: 'a', description: 'd', state: 'running', avatar: 'working', line: 'loop-memory · check', pendingMessages: 0, needsYou: 1 }], selected: 'a', events: [{ kind: 'steps', ts: now, steps }], hidden: 0, gates: [gate0] } };
  const html = renderBody(model);
  const dm = new JSDOM(`<body>${html}</body>`).window.document;
  const lines = [...dm.querySelectorAll('.steps')].map(x => x.textContent.replace(/\s+/g, ' ').trim());
  ok(lines.some(t => /^loop-memory ×4/.test(t)), 'consecutive skill calls fold into one line: ' + lines[0]);
  ok(/Read 2 files/.test(lines[0]) && !/python3|mem\.py/.test(dm.querySelector('details.steps > summary').textContent), 'reads fold in, and no raw command in the folded line');
  ok(/1 refused/.test(lines[0]) || lines.some(t => /refused/.test(t)), 'the group line counts refused calls');
  ok(/REFUSED: not allowed/.test(dm.querySelector('.badcall').textContent) && /ERROR: /.test(dm.querySelectorAll('.badcall')[1].textContent), 'REFUSED and ERROR results stay visible without opening anything');
  ok(!dm.querySelector('.badcall b') && !dm.querySelector('.badcall i') && !dm.querySelector('.steps u') && !dm.querySelector('.steps-sum x'), 'tool text is escaped');
  ok(/Handed to techlead: Find the <u>root cause<\/u>/.test(dm.querySelector('.steps:last-of-type, .steps:last-child').textContent) || lines.some(t => /Handed to techlead: Find the <u>root cause<\/u>/.test(t)), 'a handoff shows whom and the task on one line');
  ok(dm.querySelector('details.steps').open === false && /mem\.py recall/.test(dm.querySelector('details.steps').innerHTML), 'the full command is one click away');
  ok(/bash post\.sh &quot;&lt;q&gt;&quot;|bash post\.sh "<q>"/.test(dm.querySelector('.cmd').textContent) || dm.querySelector('.cmd').textContent === 'bash post.sh "<q>"', 'a gate still shows the exact command');
  ok(dm.querySelector('[data-hash-for="out/<f>.md"]') && /out\/<f>\.md/.test(dm.querySelector('.file').textContent), 'and the files, escaped');
  ok(!dm.querySelector('.msg.agent') && dm.querySelectorAll('.bubble .bubble').length === 0, 'no extra frame around an agent message');
}
// ---- the result card ----
{
  const card = (o) => ({ kind: 'result', ts: now, chainId: 'c', status: 'done', label: 'Done', tone: 'ok', fold: [], deliverables: [], supporting: [], stepCount: 0, problems: { refused: 0, error: 0, failed: 0 }, ...o });
  const view = evs => { const m = { ...base, pending: [], chat: { agents: [{ name: 'a', description: 'd', state: 'idle', avatar: 'idle', line: 'x', pendingMessages: 0, needsYou: 0 }], selected: 'a', events: evs, hidden: 0, gates: [] } };
    return new JSDOM(`<body>${renderBody(m)}</body>`).window.document; };
  const long = 'Timeouts come from one slow inventory shard; retries make it worse. '.repeat(6) + '<img src=x onerror=1>';
  let dc = view([card({ goal: 'Find the <b>cause</b>', detail: long, deliverables: [{ path: '.loop/outbox/<x>.md', preview: 'Title <b>x</b>' }], supporting: ['.loop/outbox/<s>.json', 'a/b.log'], approvals: ['You approved: Post brief'] })]);
  ok(dc.querySelector('.rsum').textContent === long && !dc.querySelector('.rcard img') && !dc.querySelector('.rcard b'), 'the result card shows the full finish summary, escaped');
  ok(/^Timeouts come from one slow inventory shard/.test(dc.querySelector('.rgoal').textContent) && dc.querySelector('.rgoal').classList.contains('ell') && dc.querySelector('.rsum').textContent === long && !dc.querySelector('.rgoalline'), 'its title line is the outcome (the summary), ellipsized; the task text is not repeated');
  ok(dc.querySelector('.rdelivs [data-open=".loop/outbox/<x>.md"]') && dc.querySelector('.dname').textContent === '<x>.md' && dc.querySelector('.dprev').textContent === 'Title <b>x</b>' && !dc.querySelector('.dprev b'), 'a deliverable is a prominent row: name, folder, a one-line preview, escaped');
  ok(!dc.querySelector('.rsup').open && /2 supporting files/.test(dc.querySelector('.rsup summary').textContent) && dc.querySelector('.rsup [data-open="a/b.log"]') && dc.querySelector('.rsup [data-open=".loop/outbox/<s>.json"]'), 'supporting files fold behind a quiet entry');
  ok(/You approved: Post brief/.test(dc.querySelector('.rcard').textContent), 'the files it produced open from the card, and a decision you made during the run is one line on it');
  ok(dc.querySelectorAll('.rcard time').length === 1 && !dc.querySelector('.sline'), 'one timestamp and no separate status line');
  dc = view([card({ status: 'open', label: 'Continues later', tone: 'info', detail: 'waiting', next: 'Check again at 14:00', handoff: { to: 'techlead', task: 'Find <i>it</i>' } })]);
  ok(/Next: Check again at 14:00/.test(dc.querySelector('.rcard').textContent) && /Handed to techlead: Find <i>it<\/i>/.test(dc.querySelector('.rcard').textContent) && !dc.querySelector('.rcard i'), 'an open run says its next step, and a handoff says to whom and what');
  ok(view([card({ status: 'blocked', tone: 'warn', label: 'Blocked' })]).querySelector('.rcard.warn') && view([card({ status: 'error', tone: 'bad', label: 'Failed' })]).querySelector('.rcard.bad'), 'blocked is a warning accent, an error is red');
  ok(view([card({ status: 'nothing_to_do', label: 'Nothing new', tone: 'mute' })]).querySelector('.rquiet') && !view([card({ status: 'nothing_to_do', label: 'Nothing new', tone: 'mute' })]).querySelector('.rcard'), 'nothing to do stays a quiet line');
  // a folded run
  const inner = [{ kind: 'agent', ts: now, text: 'thinking <b>x</b>', step: 1 }, { kind: 'steps', ts: now, steps: [{ step: 1, kind: 'tool', title: 'run_command · rm', phrase: 'rm', routine: false, detail: 'REFUSED by policy', ok: false }, { step: 2, kind: 'tool', title: 'run_command · x', phrase: 'x', routine: false, detail: 'ERROR: boom', ok: false }] }];
  dc = view([{ kind: 'human', ts: now, id: 'h', text: 'please do it', status: 'delivered', via: 'turn' }, card({ detail: 'Done well', fold: inner, stepCount: 2, problems: { refused: 1, error: 1, failed: 0 } })]);
  ok(dc.querySelector('details.rfold') && !dc.querySelector('details.rfold').open && /Show 2 steps/.test(dc.querySelector('.rfold summary').textContent) && /thinking <b>x<\/b>/.test(dc.querySelector('.rfold-body').textContent) && !dc.querySelector('.rfold b'), 'an ended run folds behind its card, and the expander holds the detailed view, escaped');
  ok(/1 refused · 1 error/.test(dc.querySelector('.rprob').textContent), 'the card says what went wrong inside the fold');
  ok(/please do it/.test(dc.querySelector('.msg.human').textContent) && !dc.querySelector('.rfold .human'), 'the human message stays outside the fold');
  ok(!view([{ kind: 'agent', ts: now, text: 'live', step: 1 }, { kind: 'steps', ts: now, steps: inner[1].steps }]).querySelector('.rfold'), 'a run in progress is not folded');
  // from the audit: the same data is not repeated beside the card
  const fs = require('fs'), os = require('os');
  const Q = require(OUT + '/queue.js'), TH = require(OUT + '/thread.js');
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  Q.audit(R, 'ch', { type: 'start', agent: 'a', from: 'schedule', task: 'Watch things' });
  Q.audit(R, 'ch', { type: 'tool', agent: 'a', step: 1, name: 'write_file', input: { path: 'out/r.md' }, result: 'wrote', wrote: ['out/r.md'] });
  Q.audit(R, 'ch', { type: 'tool', agent: 'a', step: 2, name: 'handoff', input: { to: 'b', task: 'T' }, result: 'Handed off' });
  Q.audit(R, 'ch', { type: 'tool', agent: 'a', step: 3, name: 'finish', input: { status: 'open', summary: 'S', next: 'N' }, result: 'ok' });
  Q.audit(R, 'ch', { type: 'end', agent: 'a', step: 3, status: 'open', summary: 'S', outputs: ['out/r.md'] });
  const evs = TH.buildThread(R, 'a').events;
  const r = evs.find(x => x.kind === 'result');
  { const sp = TH.splitOutputs(undefined, ['.loop/outbox/inc/a.md', '.loop/outbox/b.json', '.loop/outbox/.tmp/c.md', 'src/d.md', '.loop/outbox/e.PDF']);
    ok(sp.deliverables.join() === '.loop/outbox/inc/a.md,.loop/outbox/e.PDF' && sp.supporting.length === 3, 'with nothing declared, documents in the outbox are the deliverables');
    const sd = TH.splitOutputs(['out/rep.md'], ['out/rep.md', 'out/n.txt']);
    ok(sd.deliverables.join() === 'out/rep.md' && sd.supporting.join() === 'out/n.txt', 'declared deliverables win over the guess'); }
  fs.mkdirSync(path.join(R, 'out'), { recursive: true }); fs.writeFileSync(path.join(R, 'out/r.md'), '\n# The <i>report</i>\nbody');
  Q.audit(R, 'ch2', { type: 'start', agent: 'a', from: 'schedule', task: 'Report' });
  Q.audit(R, 'ch2', { type: 'end', agent: 'a', step: 1, status: 'done', summary: 'S2', outputs: ['out/r.md', 'out/n.log'], deliverables: ['out/r.md'] });
  { const r2 = TH.buildThread(R, 'a').events.find(x => x.kind === 'result' && x.chainId === 'ch2');
    ok(r2.deliverables[0].path === 'out/r.md' && r2.deliverables[0].preview === 'The <i>report</i>' && r2.supporting.join() === 'out/n.log', 'a declared deliverable gets the first heading as its preview'); }
  ok(r && r.goal === 'Watch things' && r.next === 'N' && r.handoff.to === 'b' && r.supporting[0] === 'out/r.md' && r.deliverables.length === 0 && evs.filter(x => x.kind !== 'human').length === 1 && r.fold.length >= 2 && r.stepCount === 2, 'the thread builds one card for an ended run, with its process folded in');
}
{
  const fs = require('fs'), os = require('os'), Q = require(OUT + '/queue.js'), TH = require(OUT + '/thread.js');
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  Q.audit(R, 'lv', { type: 'start', agent: 'a', from: 'schedule', task: 'Write the report.' });
  Q.audit(R, 'lv', { type: 'tool', agent: 'a', step: 1, name: 'run_command', input: { command: 'git log --stat' }, result: '[exit 0]' });
  Q.audit(R, 'lv', { type: 'tool', agent: 'a', step: 2, name: 'read_file', input: { path: 'src/app.js' }, result: 'x' });
  const ev = TH.buildThread(R, 'a').events;
  const lv = ev.find(x => x.kind === 'live');
  ok(ev.length === 1 && lv && lv.goal === 'Write the report.' && lv.stepCount === 2 && lv.last === 'Read app.js' && !ev.some(x => x.kind === 'steps' || x.kind === 'status'), 'a run that has not ended is one live event with its steps folded inside');
  Q.audit(R, 'lv', { type: 'end', agent: 'a', step: 2, status: 'done', summary: 'ok', outputs: [] });
  ok(!TH.buildThread(R, 'a').events.some(x => x.kind === 'live'), 'and when it ends it becomes the result card');
}
console.log(`${n} console page checks passed`);
