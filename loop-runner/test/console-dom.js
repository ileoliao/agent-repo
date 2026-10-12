// Runs the console page's own script in jsdom: double click, changed drafts, filter, typed text. Run: npm test
const { JSDOM } = require('jsdom');
const path = require('path');
const OUT = path.join(__dirname, '..', 'out');
const { renderPage, renderBody, consoleModel } = require(OUT + '/console.js');
const now = new Date().toISOString();
const gate = (hash, text) => ({ id: 'g1', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', command: 'echo hi', files: ['d.md'], resume: true, status: 'pending', createdAt: now, previews: [{ path: 'd.md', text, sha256: hash, truncated: false }] });
const base = { running: true, active: undefined, pending: [gate('h1', 'v1')], agents: [], updatedAt: now,
  runs: [{ chainId: 'r1', agent: 'a', status: 'done', summary: 's', started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] },
         { chainId: 'r2', agent: 'a', status: 'error', summary: 'e', started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] }] };
const sent = [];
const dom = new JSDOM(renderPage(base, 'n', 'x').replace(/<meta http[^>]*>/, '').replace('<script nonce="n">', '<script>'), { runScripts: 'dangerously', pretendToBeVisual: true,
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
// filter
w.dispatchEvent(new w.MessageEvent('message', { data: { type: 'idle', id: 'g1' } }));
const sel = d.querySelector('[data-filter]'); sel.value = 'problems'; sel.dispatchEvent(new w.Event('change', { bubbles: true }));
const vis = [...d.querySelectorAll('details.run')].filter(x => !x.classList.contains('hidden')).map(x => x.dataset.status);
ok(vis.join() === 'error', 'the Problems filter shows only failing runs');
post(renderBody(base));
ok(d.querySelector('[data-filter]').value === 'problems', 'the filter survives a refresh');
// typing is kept across a refresh
const q = base.pending[0];
d.querySelector('[data-input]').value = 'my reason';
post(renderBody({ ...base, pending: [gate('h2', 'v2 CHANGED')] }));
ok(d.querySelector('[data-input]').value === 'my reason', 'typed text survives a refresh');
// reject carries the text
d.querySelector('[data-reject]').click();
ok(sent.at(-1).type === 'reject' && sent.at(-1).feedback === 'my reason', 'reject sends the typed reason');
// a hostile id cannot break selectors
post(renderBody({ ...base, pending: [{ ...gate('h', 'x'), id: 'a"b' }] }));
let threw = false; try { d.querySelector('[data-approve]').click(); } catch { threw = true; }
ok(!threw, 'an id with a quote does not throw');

// ---- the chat page ----
{
  const evts = [
    { kind: 'status', ts: now, label: 'Scheduled run started', tone: 'info', chainId: 'c', detail: 'do it' },
    { kind: 'human', ts: now, id: 'h1', text: 'hello', status: 'delivered', via: 'turn' },
    { kind: 'agent', ts: now, text: 'On it.', step: 1 },
    { kind: 'steps', ts: now, steps: [{ step: 1, kind: 'tool', title: 'run_command · ls', detail: '[exit 0]', ok: true }, { step: 2, kind: 'tool', title: 'read_file · x', detail: 'REFUSED', ok: false }] }
  ];
  const chatModel = (selected, events = evts, gates = []) => ({ ...base, tab: 'chat', pending: gates,
    chat: { agents: [{ name: 'a', state: 'running', pendingMessages: 0, needsYou: 0 }, { name: 'b', state: 'idle', pendingMessages: 0, needsYou: 0 }], selected, events, hidden: 0, gates } });
  const sent2 = [];
  const dom2 = new JSDOM(renderPage(chatModel('a'), 'n', 'x').replace(/<meta http[^>]*>/, '').replace('<script nonce="n">', '<script>'), { runScripts: 'dangerously', pretendToBeVisual: true,
    beforeParse(w2) {
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
  ok(!!d2.querySelector('[data-thread="a"]') && d2.querySelectorAll('.msg').length >= 3 && d2.querySelector('.tab.on').dataset.tab === 'chat', 'the chat page shows the conversation with the selected agent');
  ok(d2.querySelector('[data-thread]').scrollTop === 1000, 'it opens on the newest message');
  d2.querySelector('[data-tab="overview"]').click();
  ok(sent2.at(-1).type === 'view' && sent2.at(-1).tab === 'overview', 'the Overview tab asks the host for the overview');
  d2.querySelector('[data-agent="b"]').click();
  ok(sent2.at(-1).type === 'view' && sent2.at(-1).tab === 'chat' && sent2.at(-1).agent === 'b', 'picking another agent asks for that conversation');
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
  // an agent's question sits in the thread and can be answered there
  const q = { id: 'gq', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 'Which?', body: 'two', options: ['red', 'blue'], files: [], resume: true, status: 'pending', createdAt: now, previews: [] };
  post2(renderBody(chatModel('a', evts, [q])));
  d2.querySelector('[data-pick="gq"][data-text="blue"]').click();
  d2.querySelector('[data-send="gq"]').click();
  ok(sent2.at(-1).type === 'answer' && sent2.at(-1).id === 'gq' && sent2.at(-1).text === 'blue', 'a question in the conversation can be answered right there');
  w2.close();
}
console.log(`${n} console page checks passed`);
