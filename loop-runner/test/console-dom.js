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
console.log(`${n} console page checks passed`);
