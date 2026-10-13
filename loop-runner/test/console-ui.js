// Console wording that explains itself: why a run ended and what to do, the decision history, first-run screen.
const path = require('path');
const assert = require('assert');
const OUT = path.join(__dirname, '..', 'out');
const { renderBody, plainCron } = require(`${OUT}/console.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const now = new Date().toISOString();
const run = (status, summary = 's') => ({ chainId: `c-${status}`, agent: 'a', status, summary, started: now, updated: now, file: 'f', outputs: [], step: 1, steps: [] });
const agent = { name: 'a', description: 'd', state: 'idle', file: 'a.md' };
const base = { running: true, pending: [], agents: [agent], runs: [], updatedAt: now, tab: 'overview', tasks: [] };

console.log('statuses explain themselves');
for (const s of ['blocked', 'error', 'stalled', 'max_steps', 'interrupted', 'retry']) {
  const html = renderBody({ ...base, runs: [run(s)] });
  ok(/class="hintbox/.test(html), `a ${s} run says why and what to do`);
}
ok(!/class="hintbox/.test(renderBody({ ...base, runs: [run('done')] })), 'a finished run needs no explanation');
ok(/Checked, nothing found/.test(renderBody({ ...base, runs: [run('nothing_to_do')] })), 'nothing_to_do reads as a result, not a failure');

console.log('decision history');
const dec = (status, title) => ({ id: title, kind: 'approval', agent: 'a', title, status, at: now });
const html = renderBody({ ...base, decisions: [dec('executed', 'Roll back'), dec('rejected', 'Delete <b>x</b>'), dec('failed', 'Deploy'), dec('answered', 'Who owns it')] });
ok(/Recent decisions/.test(html) && /Approved, ran/.test(html) && /Rejected/.test(html) && /Approved, failed/.test(html) && /Answered/.test(html), 'settled approvals and answers are listed with what was decided');
ok(!/<b>x<\/b>/.test(html) && /&lt;b&gt;x&lt;\/b&gt;/.test(html), 'their titles are escaped');
ok(!/Recent decisions/.test(renderBody({ ...base, decisions: [] })), 'with none, the section is absent');

console.log('first run and stopped');
const fresh = renderBody({ ...base, running: false, agents: [], tab: 'chat', chat: { agents: [], events: [], hidden: 0, gates: [] } });
ok(/Set up your first mate/.test(fresh) && /data-arg="daily-report"/.test(fresh) && /data-cmd="describeAgent"/.test(fresh) && /Copilot/.test(fresh), 'a new workspace offers starters, describing one, and mentions Copilot');
ok(!/data-cmd="startTeam"/.test(fresh) && !/data-tab=/.test(fresh), 'and no team controls or tabs that would do nothing');
const stopped = renderBody({ ...base, running: false, pending: [{ id: 'g', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now, previews: [] }] });
ok(/mates are off/i.test(stopped) && (stopped.match(/data-cmd="startTeam"/g) || []).length === 1, 'stopped with work waiting says so, with a single Start control');
ok(/data-cmd="runDoctor"/.test(renderBody(base)) && /data-cmd="showHealth"/.test(renderBody(base)) && /data-cmd="cleanUp"/.test(renderBody(base)), 'tools are reachable from the console');

console.log('copilot, why-in-the-row, the thread');
ok(/Copilot ready/.test(renderBody({ ...base, copilot: 3 })) && !/not signed in/.test(renderBody({ ...base, copilot: 3 })), 'a ready Copilot shows a quiet chip');
const off = renderBody({ ...base, copilot: 0 });
ok(/Copilot not signed in/.test(off) && /none can run until you sign in/.test(off), 'no Copilot models: a chip and a banner say agents cannot run');
ok(!/Copilot/.test(renderBody({ ...base })), 'unknown Copilot state shows nothing');
ok(/class="run-why"/.test(renderBody({ ...base, runs: [run('blocked')] })) && !/class="run-why"/.test(renderBody({ ...base, runs: [run('done')] })), 'a blocked run says why on its collapsed row');
const interrupted = renderBody({ ...base, runs: [run('interrupted')] });
ok(/Last run/.test(interrupted) && !/tile warn"><div class="tile-k">Last run/.test(interrupted), 'an interrupted run does not raise an alarm tile');
ok(!/tile-k">Needs you/.test(renderBody({ ...base })), 'needs-you is not repeated as a tile');
const chat = (extra, gates = []) => renderBody({ ...base, tab: 'chat', chat: { agents: [{ name: 'a', description: 'd', state: extra.state, avatar: 'working', line: 'read app.js', pendingMessages: 0, needsYou: gates.length }], selected: 'a', events: [], hidden: 0, gates } });
ok(/class="working"[^]*is working: read app.js/.test(chat({ state: 'running' })) && !/class="working"/.test(chat({ state: 'idle' })), 'a running agent is visibly working in its thread');
const gate = kind => ({ id: 'g', kind, agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now, previews: [] });
ok(/use the buttons above/.test(chat({ state: 'waiting' }, [gate('approval')])) && /Answer the question above/.test(chat({ state: 'waiting' }, [gate('question')])), 'the message box says whether it answers the approval or question');

console.log('agent cards act');
const card = (over = {}) => renderBody({ ...base, agents: [{ ...agent, triggers: [{ kind: 'schedule', text: '0 9 * * 1-5' }, { kind: 'webhook', text: 'deploy' }, { kind: 'file', text: 'reports/*.md' }], ...over }] });
const c1 = card();
ok(/weekdays at 09:00/.test(c1) && /webhook “deploy”/.test(c1) && /new file appears in reports\/\*\.md/.test(c1), 'a card says what wakes the agent, in words');
ok(/data-cmd="runAgent" data-arg="a"/.test(c1) && /data-cmd="pauseAgent" data-arg="a"/.test(c1), 'a card can run the agent now and pause it');
const c2 = card({ paused: true });
ok(/data-cmd="resumeAgent"/.test(c2) && !/data-cmd="pauseAgent"/.test(c2) && /Paused/.test(c2), 'a paused agent shows Paused and offers Resume');
ok(!/data-cmd="pauseAgent"/.test(card({ triggers: [] })), 'an agent with nothing to pause has no Pause button');
ok(/disabled title="Sign in to GitHub Copilot first"/.test(renderBody({ ...base, copilot: 0, agents: [agent] })), 'Run now is disabled while Copilot is signed out');
ok(/disabled/.test(renderBody({ ...base, running: false, agents: [], runs: [], copilot: 0, tab: 'chat', chat: { agents: [], events: [], hidden: 0, gates: [] } })), 'so are the starters');
const hostile = renderBody({ ...base, agents: [{ ...agent, name: 'a"><img src=x>', triggers: [{ kind: 'schedule', text: '0 9 * * *' }] }] });
ok(!/<img src=x>/.test(hostile), 'an agent name cannot break out of the card');

console.log('wording and refusals');
ok(/Mates on · 1 waiting on you/.test(renderBody({ ...base, pending: [{ id: 'g', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now, previews: [] }] })) && /Mates on · idle/.test(renderBody(base)), 'the status pill says why it is not simply idle');
ok(/data-cmd="stopTeam"[^>]*><[^]*Stop mates/.test(renderBody(base)) && !/Start team|Stop team/.test(renderBody({ ...base, running: false })), 'one vocabulary: agents');
const step = (cmd, rule) => ({ step: 1, kind: 'tool', title: 'run_command', detail: `REFUSED by policy (${rule}).`, ok: false, refused: { command: cmd, rule } });
const refused = renderBody({ ...base, runs: [{ ...run('blocked', 'Could not reach the API.'), steps: [step('harbor status --json', 'no allow rule matched')] }] });
ok(/data-allow-agent="a" data-allow-cmd="harbor status --json"/.test(refused) && /Allow for a/.test(refused) && /exact command for a only/.test(refused), 'a command no rule allowed gets a one-click Allow for that mate');
const denied = renderBody({ ...base, runs: [{ ...run('blocked'), steps: [step('curl https://x', '\\b(curl|wget)\\b')] }] });
ok(!/data-allow-agent/.test(denied) && /matches the deny rule/.test(denied) && /data-open="\.loop\/policy\.json"/.test(denied), 'a deny rule gets an explanation and the policy file, never a one-click Allow');
ok(!/data-allow-agent/.test(renderBody({ ...base, runs: [run('blocked')] })), 'other blocked runs offer no Allow');
const hostileCmd = renderBody({ ...base, runs: [{ ...run('blocked'), steps: [step('x" onclick="boom', 'no allow rule matched')] }] });
ok(!/onclick="boom/.test(hostileCmd), 'a hostile command text cannot break out of the button');
ok(!/see run log/.test(renderBody({ ...base, pending: [{ id: 'g', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', command: 'x', files: [], resume: true, status: 'pending', createdAt: now, previews: [] }] })), 'no text that looks like a link but is not one');
ok(/The Add buttons are off because GitHub Copilot is not signed in/.test(renderBody({ ...base, running: false, agents: [], copilot: 0, tab: 'chat', chat: { agents: [], events: [], hidden: 0, gates: [] } })), 'disabled starters say why');

console.log('plain schedules');
ok(plainCron('0 9 * * 1-5') === 'weekdays at 09:00' && plainCron('*/30 * * * *') === 'every 30 minutes' && plainCron('15 8 * * *') === 'every day at 08:15' && plainCron('0 */2 * * 3') === '0 */2 * * 3', 'common cron shapes read as words, others are left as written');
console.log(`${n} console wording checks passed`);
