// Console wording that explains itself: the one-screen layout, the header, vocabulary, first-run screen, refusals. Needs `tsc` first.
const path = require('path');
const assert = require('assert');
const OUT = path.join(__dirname, '..', 'out');
const { renderBody, plainCron } = require(`${OUT}/console.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const now = new Date().toISOString();
const run = (status, summary = 's') => ({ chainId: `c-${status}`, agent: 'a', status, summary, started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] });
const row = (over = {}) => ({ name: 'a', description: 'd', file: '.github/agents/a.agent.md', state: 'idle', avatar: 'idle', line: 'x', pendingMessages: 0, needsYou: 0, ...over });
const chatOf = (agents = [row()], selected = agents[0]?.name, events = [], gates = []) => ({ agents, selected, events, hidden: 0, gates });
const agent = { name: 'a', description: 'd', state: 'idle', file: 'a.md' };
const base = { running: true, pending: [], agents: [agent], runs: [], updatedAt: now, tasks: [], chat: chatOf() };
const gate = (kind, over = {}) => ({ id: 'g', kind, agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now, previews: [], ...over });
const empty = { agents: [], events: [], hidden: 0, gates: [] };
const bar = h => (h.match(/<header class="bar">[^]*?<\/header>/) || [''])[0];

console.log('one screen: no tabs, no second page');
{
  const html = renderBody(base);
  ok(!/data-tab=|role="tablist"|class="tabs"|Overview|Recent runs|Recent decisions|data-filter/.test(html), 'there are no tabs, no Overview, no run list or filter');
  ok(/class="roster"/.test(html) && /class="chat-main"/.test(html), 'the roster and the conversation are the whole page');
  ok(/<div class="brand">Harbor Mate<\/div>/.test(html) && !/Console/.test(html), 'the title is "Harbor Mate"');
}

console.log('the header');
{
  const running = bar(renderBody(base)), off = bar(renderBody({ ...base, running: false }));
  ok(!/class="btn primary"/.test(running) && !/class="btn secondary"/.test(running.replace(/<summary[^>]*>/, '')) && /class="toolmenu"/.test(running), 'while running there is no button at all, only the menu');
  ok(/class="btn primary" data-cmd="startTeam"/.test(off) && (off.match(/class="btn primary"/g) || []).length === 1 && /class="state off">Off</.test(off), 'while off: one primary Start mates button, and the pill says Off');
  ok(!/Nothing will run until you press Start/i.test(renderBody({ ...base, running: false, pending: [gate('question')] })), 'the yellow "Nothing will run" banner is gone');
  const items = running.match(/class="menuitem"[^>]*>([^<]*)</g).map(x => x.replace(/.*>([^<]*)</, '$1'));
  ok(items.join() === 'Add a mate,Check mates,Clean up finished work,Set a secret,Stop all mates', 'the ⋯ menu: add, check, clean up, secret, and Stop all mates (health is part of Check mates)');
  ok(/data-cmd="stopTeam"/.test(running) && !/data-cmd="startTeam"/.test(running) && /data-cmd="startTeam"[^>]*>Start mates</.test(off), 'the last item is Stop all mates while running and Start mates while off');
  ok(!/showHealth/.test(running), 'there is no separate Health report item');
  for (const c of ['getStarted', 'runDoctor', 'cleanUp', 'setSecret']) { ok(new RegExp(`data-cmd="${c}"`).test(running), `${c} is in the menu`); }
  ok(!/Check &amp; tools/.test(running) && /aria-label="More"/.test(running), 'the old "Check & tools" dropdown is replaced by an icon menu');
  ok(!/<header[^>]*>[^]*(Run now|Pause)/.test(running), 'mate actions are not in the header');
}

console.log('the pill');
{
  const pill = h => (bar(h).match(/<(button|span) class="state[^"]*"[^>]*>[^]*?<\/\1>/) || [''])[0];
  const two = [gate('question', { id: 'g1', agent: 'b', createdAt: '2026-10-14T09:00:00Z' }), gate('approval', { id: 'g2', agent: 'a', createdAt: '2026-10-14T10:00:00Z' })];
  const waiting = pill(renderBody({ ...base, pending: two }));
  ok(/^<button class="state wait" data-agent="b" data-scroll="1"/.test(waiting) && /2 need you/.test(waiting), 'with things waiting the pill is a button to the mate waiting longest: "2 need you"');
  ok(/1 needs you/.test(pill(renderBody({ ...base, pending: [two[0]] }))), 'and says "1 needs you" for one');
  const withBlocked = pill(renderBody({ ...base, pending: two, blocked: [{ id: 'b1', agent: 'a', command: 'x', chainId: 'c', at: '2026-10-14T08:00:00Z' }] }));
  ok(/data-agent="a"/.test(withBlocked) && /3 need you/.test(withBlocked), 'a blocked command counts, and if it is the oldest its mate is the target');
  ok(/class="state on"[^>]*>[^]*a working/.test(pill(renderBody({ ...base, active: ['a'] }))) && /a, b working/.test(pill(renderBody({ ...base, active: ['a', 'b'] }))), 'nothing needs you and a mate runs: "a working"');
  ok(/All quiet · next/.test(pill(renderBody({ ...base, next: { agent: 'a', at: new Date(Date.now() + 3600e3).toISOString() } }))) && />All quiet</.test(pill(renderBody(base))), 'running and idle: "All quiet · next 09:00", or just "All quiet"');
  ok(/class="state off">Off</.test(pill(renderBody({ ...base, running: false }))), 'mates off: "Off"');
  ok(pill(renderBody({ ...base, running: false, agents: [], chat: empty })) === '', 'a new workspace has no pill at all');
}

console.log('statuses use one vocabulary');
{
  const TH = require(`${OUT}/thread.js`);
  const label = s => TH.END_LABEL[s][0];
  ok(label('done') === 'Done' && label('nothing_to_do') === 'Nothing new' && label('blocked') === 'Blocked', 'Done, Nothing new, Blocked');
  ok(['error', 'max_steps', 'stalled'].every(s => label(s) === 'Failed') && ['cancelled', 'interrupted'].every(s => label(s) === 'Stopped'), 'Failed covers error, step limit and stalled; Stopped covers cancelled and interrupted');
  ok(TH.END_LABEL.stalled[2] && TH.END_LABEL.max_steps[2], 'the specific reason is kept as hover text');
  const card = o => renderBody({ ...base, chat: chatOf([row()], 'a', [{ kind: 'result', ts: now, chainId: 'c1', status: 'stalled', label: 'Failed', why: 'It went in circles <b>', tone: 'bad', detail: 'x', deliverables: [], supporting: [], fold: [], stepCount: 0, problems: { refused: 0, error: 0, failed: 0 }, ...o }]) });
  ok(/<span class="chip bad" title="It went in circles &lt;b&gt;">Failed<\/span>/.test(card()), 'the chip says Failed and explains on hover, escaped');
  ok(!/Finished|Waiting for you|Waiting on you|waiting on you|has a question for you|asks for your approval|decisions/.test(renderBody({ ...base, pending: [gate('approval')], chat: chatOf([row({ state: 'waiting', avatar: 'waiting', needsYou: 1, line: 'Needs you: t' })], 'a', [], [gate('approval')]) })), 'the old phrasings are gone');
}

console.log('first run');
{
  const fresh = renderBody({ ...base, running: false, agents: [], chat: empty });
  ok(/Set up your first mate/.test(fresh) && /data-arg="daily-report"/.test(fresh) && /data-arg="folder-watch"/.test(fresh) && /data-cmd="describeAgent"/.test(fresh), 'a new workspace offers the starters, and describing one');
  ok(!/<ol/.test(fresh) && !/appears at the top/.test(fresh) && !/data-cmd="startTeam"/.test(fresh) && !/class="toolmenu"/.test(fresh), 'no numbered steps, no Start button, no menu');
  ok(/Mates use your GitHub Copilot models\. Anything risky waits for your approval\./.test(fresh), 'the one-line note at the bottom');
  ok(/disabled/.test(renderBody({ ...base, running: false, agents: [], copilot: 0, chat: empty })) && /Sign in to GitHub Copilot to let mates run/.test(renderBody({ ...base, running: false, agents: [], copilot: 0, chat: empty })), 'starters are disabled when Copilot is signed out, and say why');
  ok((renderBody({ ...base, running: false, agents: [], copilot: 0, chat: empty }).match(/Sign in to GitHub Copilot to let mates run\.<\/span>/g) || []).length === 1, 'and say it once');
}

console.log('copilot');
{
  ok(!/Copilot/.test(renderBody({ ...base, copilot: 3 })) && !/Copilot/.test(renderBody({ ...base })), 'a ready or unknown Copilot says nothing');
  const off = renderBody({ ...base, copilot: 0 });
  ok(/Sign in to GitHub Copilot to let mates run\./.test(off) && !/class="chip warn"/.test(bar(off)), 'no Copilot models: one banner says mates cannot run, and the header has no second note');
  ok(/disabled title="Sign in to GitHub Copilot to let mates run\."/.test(off), 'Run now is disabled while Copilot is signed out');
}

console.log('the composer');
{
  const chat = (state, gates = [], extra = {}) => renderBody({ ...base, chat: chatOf([row({ state, avatar: state === 'running' ? 'working' : 'idle', line: 'read app.js', needsYou: gates.length, ...extra })], 'a', [], gates) });
  ok(/class="turn working"[^]*is working: read app.js/.test(chat('running')) && !/class="turn working"/.test(chat('idle')), 'a running mate is visibly working in its thread');
  ok(/placeholder="Message a…"/.test(chat('idle')) && /placeholder="Message a…"/.test(chat('waiting', [gate('approval')])) && /placeholder="Answer a…"/.test(chat('waiting', [gate('question')])), 'the box says "Message a…", or "Answer a…" when the oldest waiting item is a question');
  ok(!/Reason if you reject/i.test(chat('waiting', [gate('approval')])) && !/data-approval-for/.test(chat('waiting', [gate('approval')])) && !/data-chat-send="a" disabled/.test(chat('waiting', [gate('approval')])), 'the box never asks for a rejection reason, and Send stays on');
  const two = [gate('question', { id: 'q1' }), gate('approval', { id: 'a1' })];
  ok(/data-answer-for="q1"/.test(chat('waiting', two)) && /data-gate="q1"/.test(chat('waiting', two)) && /data-queued="a1"/.test(chat('waiting', two)), 'with two waiting, the first (oldest) is the card and the box answers it; the second waits behind it');
  ok(!/class="chips-row"|data-insert|ask for status|class="chip-btn"/.test(chat('running')) && !/class="chips-row"/.test(chat('idle')), 'no @-mention chips, no /stop chip, no status chip under the box');
  ok(/data-chat-cancel="a"/.test(chat('running')) && /class="composer running"/.test(chat('running')), 'the Stop button stays while the mate works');
  ok(!/class="muted hint"/.test(chat('idle')) && /class="muted hint">a reads this at its next step\./.test(chat('running')), 'the hint is gone when idle and says something useful when it works');
  ok(/class="muted hint">a reads this once you have decided/.test(chat('waiting', [gate('approval')])) && !/class="muted hint"/.test(chat('waiting', [gate('question')])), 'an approval waiting says when the message is read; a question needs no hint');
  ok(/The mates are off\. This is saved/.test(renderBody({ ...base, running: false })) && /a has work queued and reads this when it starts\./.test(chat('queued')), 'the hint still says when the mates are off or the work is queued');
  ok(/Message it below/.test(renderBody({ ...base, runs: [run('done')] })) && /No runs yet\. Runs only when you give it a task|No runs yet\. Runs when you message it/.test(renderBody(base)), 'an empty conversation says so in one line; a mate that never ran says No runs yet');
}

console.log('cards say who needs you');
{
  const gated = (gates, extra = {}) => renderBody({ ...base, chat: chatOf([row({ state: 'waiting', avatar: 'waiting', needsYou: gates.length, line: 'x' })], 'a', [], gates), ...extra });
  ok(/class="turn gates-head"[^]*<b>a<\/b> needs you</.test(gated([gate('approval')])) && /<b>a<\/b> needs you</.test(gated([gate('question')])) && /<b>a<\/b> needs you</.test(gated([gate('question', { id: 'x' }), gate('approval', { id: 'y' })])), 'one header for all: "a needs you", never "needs 2 decisions" or "has a question for you"');
  ok(/class="pinned" data-jump="\.thread-gates"[^]*<b>a<\/b> needs you: t/.test(gated([gate('approval')])) && !/class="pinned"/.test(renderBody(base)), 'with something waiting, a bar pinned to the top of the thread jumps to it');
  const blockedOnly = renderBody({ ...base, chat: { ...chatOf([row({ needsYou: 1 })]), blocked: [{ id: 'b1', agent: 'a', command: 'harbor status', chainId: 'c', at: now }] } });
  ok(/<b>a<\/b> needs you/.test(blockedOnly) && /Blocked from running a command/.test(blockedOnly), 'a blocked command is the same kind of to-do');
  const ap = gated([gate('approval', { command: 'echo hi' })]);
  ok(/data-reject-open="g"/.test(ap) && /data-reject="g"/.test(ap) && /Why\? The mate reads this \(optional\)/.test(ap) && /data-reject-cancel="g"/.test(ap), 'an approval card carries its own reject reason field, with Reject and Cancel');
  ok(!/Overview/.test(ap), 'and mentions no second page');
}

console.log('mates in the roster and header');
{
  const rows = [row({ name: 'a', triggers: [{ kind: 'schedule', text: '0 9 * * 1-5' }, { kind: 'webhook', text: 'deploy' }], next: new Date(Date.now() + 86400e3).toISOString() }), row({ name: 'b', file: undefined })];
  const head = renderBody({ ...base, runs: [run('done')], chat: chatOf(rows, 'a') });
  ok(/Runs weekdays at 09:00 · on webhook “deploy”/.test(head) && /· next /.test(head), 'the header says what wakes the mate, and when next');
  ok(/class="ch-actions"[^]*data-cmd="runAgent" data-arg="a"[^]*data-cmd="pauseAgent" data-arg="a"/.test(head) && /class="link"[^>]*data-open="\.github\/agents\/a\.agent\.md"[^>]*>Edit file/.test(head), 'Run now and Pause are buttons; Edit file is a link in the facts line');
  const paused = renderBody({ ...base, chat: chatOf([row({ paused: true, triggers: [{ kind: 'schedule', text: '0 9 * * *' }] })]) });
  ok(/data-cmd="resumeAgent"/.test(paused) && !/data-cmd="pauseAgent"/.test(paused) && /ch-sub[^>]*>Paused</.test(paused) && /Paused · x/.test(paused) && !/ · next /.test(paused), 'a paused mate says Paused (header and roster), offers Resume, and shows no next run');
  ok(/Runs only when you give it a task/.test(renderBody({ ...base, chat: chatOf([row()]) })) && !/data-cmd="pauseAgent"/.test(renderBody({ ...base, chat: chatOf([row()]) })), 'a mate with no triggers says it runs on request, with nothing to pause');
  ok(/ch-sub[^>]*>Needs you</.test(renderBody({ ...base, chat: chatOf([row({ state: 'waiting', avatar: 'waiting', needsYou: 1 })]) })) && /ch-sub[^>]*>Working · x/.test(renderBody({ ...base, chat: chatOf([row({ state: 'running', avatar: 'working' })]) })), 'the header state is Needs you, Working, Paused, Queued or Idle');
  const hostile = renderBody({ ...base, chat: chatOf([row({ name: 'a"><img src=x>', triggers: [{ kind: 'schedule', text: '0 9 * * *' }] })]) });
  ok(!/<img src=x>/.test(hostile), 'a mate name cannot break out of the markup');
  const latest = renderBody({ ...base, outputs: { a: { agent: 'a', path: '.loop/outbox/a/today.md', at: now } } });
  ok(/Latest output: <span[^>]*>today\.md/.test(latest), 'the header still shows the latest output');
}

console.log('refusals and the thread');
{
  const step = (cmd, rule) => ({ step: 1, kind: 'tool', title: 'run_command', phrase: 'ran a command', routine: false, detail: `REFUSED by policy (${rule}).`, ok: false, refused: { command: cmd, rule } });
  const threadRun = steps => ({ kind: 'result', ts: now, chainId: 'c1', status: 'blocked', label: 'Blocked', tone: 'warn', detail: 'Could not reach the API', deliverables: [], supporting: [], fold: [{ kind: 'steps', ts: now, steps }], stepCount: steps.length, problems: { refused: 1, error: 0, failed: 0 } });
  const inChat = ev => renderBody({ ...base, chat: chatOf([row({ avatar: 'blocked' })], 'a', [ev]) });
  const allowed = inChat(threadRun([step('harbor status --json', 'no allow rule matched')]));
  ok(!/data-allow-agent/.test(allowed) && !/was not allowed\./.test(allowed) && /1 refused/.test(allowed), 'a blocked result only counts the refusal: the command and Allow live once, on the to-do card');
  const denied = inChat(threadRun([step('curl https://x', '\\bcurl\\b')]));
  ok(!/data-allow-agent/.test(denied) && /matches the deny rule/.test(denied) && /data-open="\.loop\/policy\.json"/.test(denied), 'a deny rule is explained, with the policy file and never a one-click Allow');
  ok(!/onclick="boom/.test(inChat(threadRun([step('x" onclick="boom', '\\bcurl\\b')]))), 'a hostile command text cannot break out');
  ok(/class="daysep"[^]*Today/.test(inChat({ kind: 'status', ts: now, label: 'x', tone: 'info', chainId: 'c' })), 'the thread marks the day');
  const old = new Date(Date.now() - 3 * 86_400_000).toISOString();
  const twoDays = renderBody({ ...base, chat: chatOf([row()], 'a', [{ kind: 'status', ts: old, label: 'x', tone: 'info', chainId: 'c1' }, { kind: 'status', ts: now, label: 'y', tone: 'info', chainId: 'c2' }]) });
  ok((twoDays.match(/class="daysep"/g) || []).length === 2, 'and again when the day changes, not between events of one day');
  ok(/class="turn"><span class="turn-av">/.test(allowed), 'a result card carries its mate\'s avatar');
  const withSteps = renderBody({ ...base, chat: chatOf([row()], 'a', [{ kind: 'result', ts: now, chainId: 'c1', status: 'done', label: 'Done', tone: 'ok', detail: 'Write the report', deliverables: [], supporting: [], fold: [{ kind: 'steps', ts: now, steps: [{ step: 1, kind: 'tool', title: 'run_command', phrase: 'ran git log', routine: false, ok: true }, { step: 2, kind: 'tool', title: 'write_file', phrase: 'wrote today.md', routine: false, ok: true }] }], stepCount: 2, problems: { refused: 0, error: 0, failed: 0 } }]) });
  ok(/class="fold-label">Show 2 steps<\/span><span class="fold-gist">ran git log · wrote today\.md/.test(withSteps), 'a folded run says what it did before you open it');
  const answers = [{ kind: 'answer', ts: now, title: 'Roll back', text: 'The command ran.', tone: 'ok', decision: 'executed' }, { kind: 'answer', ts: now, title: 'Post it', text: 'too risky', tone: 'warn', decision: 'rejected' }, { kind: 'answer', ts: now, title: 'Which?', text: 'blue', tone: 'info', decision: 'answered' }];
  const dec = renderBody({ ...base, chat: chatOf([row()], 'a', answers) });
  ok(/You approved “Roll back”/.test(dec) && /You rejected “Post it”/.test(dec) && /too risky/.test(dec) && /You answered “Which\?”/.test(dec), 'a settled question or approval reads as what you did');
}

console.log('the one status bar item');
{
  const { statusBar } = require(`${OUT}/status.js`), { needsYouCount } = require(`${OUT}/console.js`);
  const t = o => statusBar({ running: true, pending: 0, active: [], ...o }).text;
  ok(t({ pending: 3 }) === '$(bell-dot) 3 need you' && t({ pending: 1 }) === '$(bell-dot) 1 needs you', 'something waiting: the bell and how many');
  ok(t({ pending: 2, active: ['daily-report'], step: 4 }) === '$(bell-dot) 2 need you · daily-report working', 'and the mate that is working, if one is');
  ok(t({ pending: 2, active: ['a', 'b'] }) === '$(bell-dot) 2 need you · a, b working', 'or several');
  ok(t({ active: ['daily-report'], step: 4 }) === '$(sync~spin) daily-report · step 4' && t({ active: ['daily-report'] }) === '$(sync~spin) daily-report', 'a mate working: its name and step');
  ok(t({ active: ['a', 'b'], step: 4 }) === '$(sync~spin) a, b', 'several working: a comma list, no single step');
  ok(t({ next: '09:00' }) === '$(check) Mates · next 09:00' && t({}) === '$(check) Mates', 'on and quiet: when the next wake is');
  ok(t({ running: false }) === '$(circle-slash) Mates off', 'off');
  ok(t({ running: false, pending: 1 }) === '$(bell-dot) 1 needs you', 'waiting beats off: a question needs you even with the mates stopped');
  ok(statusBar({ running: true, pending: 2, active: [] }).tooltip.split('.').filter(Boolean).length === 1 && !/\n/.test(statusBar({ running: false, pending: 0, active: [] }).tooltip), 'the tooltip is one sentence');
  const fs = require('fs'), os = require('os'), Q = require(`${OUT}/queue.js`);
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'bar-'));
  Q.saveGate(R, { id: 'p1', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now });
  Q.saveGate(R, { id: 'p2', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', command: 'x', files: [], resume: true, status: 'executed', createdAt: now });
  ok(needsYouCount(R) === 1, 'the count comes straight from the gates on disk (settled ones do not count)');
}

console.log('round three: live run, quiet actions, off, first run');
{
  const live = (extra = {}) => renderBody({ ...base, runs: [{ ...run('running'), step: 3 }], chat: chatOf([row({ state: 'running', avatar: 'working', line: 'Read app.js' })], 'a', [{ kind: 'live', ts: now, chainId: 'c1', goal: 'Write the report.', stepCount: 2, last: 'Read app.js', fold: [{ kind: 'steps', ts: now, steps: [{ step: 1, kind: 'tool', title: 'run_command · git log', phrase: 'Ran git log', routine: false, ok: true }, { step: 2, kind: 'tool', title: 'read_file · app.js', phrase: 'Read app.js', routine: false, ok: true }] }], ...extra }]) });
  const d = new (require('jsdom').JSDOM)(`<body>${live()}</body>`).window.document;
  ok(d.querySelectorAll('.rcard.live').length === 1 && !d.querySelector('.turn.working') && d.querySelector('.rcard.live .rgoal').textContent === 'Write the report.', 'a live run is one card with its task line, and no separate "is working" row');
  ok(d.querySelector('.rcard.live details.rfold') && !d.querySelector('.rcard.live details.rfold').open && /Show 2 steps/.test(d.querySelector('.rfold summary').textContent) && /Read app\.js/.test(d.querySelector('.fold-gist').textContent), 'its steps are one collapsed fold that shows the last step');
  ok(/working · step 3 · /.test(d.querySelector('.rcard.live .live-line').textContent), 'and it ends with "working · step N · time"');
  ok(/Ran git log/.test(d.querySelector('.rfold-body').textContent) && !/run_command|read_file/.test(d.querySelector('.rfold-body').textContent.replace(/\s+/g, ' ')), 'steps use human verbs, not tool names');
  ok(!/live-line/.test(renderBody({ ...base, chat: chatOf([row({ state: 'waiting', avatar: 'waiting', needsYou: 1 })], 'a', [{ kind: 'live', ts: now, chainId: 'c1', fold: [], stepCount: 0 }]) })), 'a run parked on a gate has no spinner line');
  const TU = require(`${OUT}/textutil.js`);
  ok(TU.humanize('write_file', { path: 'x.md' }).phrase === 'Wrote x.md' && TU.humanize('edit_file', { path: 'x.md' }).phrase === 'Edited x.md' && TU.humanize('list_dir', { path: 'a/b' }).phrase === 'Listed b' && TU.humanize('handoff', { to: 'bob' }).phrase === 'Handed to bob', 'wrote, edited, listed, handed');
  const blocked = renderBody({ ...base, chat: { ...chatOf([row({ needsYou: 1 })]), blocked: [{ id: 'b1', agent: 'a', command: 'x', chainId: 'c', at: now }] } });
  ok(/class="btn ghost"[^>]*data-dismiss-agent|class="btn ghost" data-dismiss-agent/.test(blocked) && /class="btn primary" data-allow-agent/.test(blocked), 'in a blocked-command card Dismiss is a quiet text button and Allow is the button');
  const pill = h => (bar(h).match(/<(button|span) class="state[^"]*"[^>]*>[^]*?<\/\1>/) || [''])[0];
  ok(/Off · 1 needs you/.test(pill(renderBody({ ...base, running: false, pending: [gate('question')] }))) && /data-agent="a"/.test(pill(renderBody({ ...base, running: false, pending: [gate('question')] }))), 'with the mates off and something waiting the pill says so and still jumps');
  ok(/All quiet · next/.test(pill(renderBody({ ...base, next: { agent: 'a', at: new Date(Date.now() + 7200e3).toISOString() } }))), 'all quiet renders');
  const first = renderBody({ ...base, chat: chatOf([row({ triggers: [{ kind: 'schedule', text: '0 9 * * 1-5' }] })]) });
  ok(/No runs yet\. Runs weekdays at 09:00\./.test(first) && (first.match(/data-cmd="runAgent"/g) || []).length === 1, 'a mate that never ran says when it runs, with one Run now button (not two)');
}

console.log('plain schedules');
ok(plainCron('0 9 * * 1-5') === 'weekdays at 09:00' && plainCron('*/30 * * * *') === 'every 30 minutes' && plainCron('15 8 * * *') === 'every day at 08:15' && plainCron('0 */2 * * 3') === '0 */2 * * 3', 'common cron shapes read as words, others are left as written');
console.log(`${n} console wording checks passed`);
