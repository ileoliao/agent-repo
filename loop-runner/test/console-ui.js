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
ok(/Set up your first agent/.test(fresh) && /data-arg="daily-report"/.test(fresh) && /data-cmd="describeAgent"/.test(fresh) && /Copilot/.test(fresh), 'a new workspace offers starters, describing one, and mentions Copilot');
ok(!/data-cmd="startTeam"/.test(fresh) && !/data-tab=/.test(fresh), 'and no team controls or tabs that would do nothing');
const stopped = renderBody({ ...base, running: false, pending: [{ id: 'g', kind: 'question', agent: 'a', itemId: 'i', chainId: 'c', title: 't', body: 'b', files: [], resume: true, status: 'pending', createdAt: now, previews: [] }] });
ok(/team is stopped/i.test(stopped) && (stopped.match(/data-cmd="startTeam"/g) || []).length === 1, 'stopped with work waiting says so, with a single Start control');
ok(/data-cmd="runDoctor"/.test(renderBody(base)) && /data-cmd="showHealth"/.test(renderBody(base)) && /data-cmd="cleanUp"/.test(renderBody(base)), 'tools are reachable from the console');

console.log('plain schedules');
ok(plainCron('0 9 * * 1-5') === 'weekdays at 09:00' && plainCron('*/30 * * * *') === 'every 30 minutes' && plainCron('15 8 * * *') === 'every day at 08:15' && plainCron('0 */2 * * 3') === '0 */2 * * 3', 'common cron shapes read as words, others are left as written');
console.log(`${n} console wording checks passed`);
