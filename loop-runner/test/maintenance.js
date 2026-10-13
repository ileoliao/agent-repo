// Housekeeping: retention, cleanup, pause, cancel and the chat tools built on them. Needs `tsc` first (npm test does it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const OUT = path.join(__dirname, '..', 'out');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const M = require(`${OUT}/maintenance.js`);
const { runChatTool } = require(`${OUT}/chatTools.js`);

const now = new Date('2026-10-14T12:00:00Z');
const daysAgo = n => new Date(now.getTime() - n * 86_400_000).toISOString();
const j = (root, rel, v) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, typeof v === 'string' ? v : JSON.stringify(v)); };
const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const item = (id, agent, status, finished, chain = `c-${id}`) => ({ id, agent, task: `task ${id}`, from: 'user', chainId: chain, hop: 0, createdAt: finished, status, finishedAt: finished });

function world() {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-maint-'));
  // finished items
  j(R, '.loop/queue/_done/old-done.json', item('old-done', 'a', 'done', daysAgo(20)));
  j(R, '.loop/queue/_done/new-done.json', item('new-done', 'a', 'done', daysAgo(2)));
  j(R, '.loop/queue/_done/old-err.json', item('old-err', 'a', 'error', daysAgo(40)));
  j(R, '.loop/queue/_done/b-old.json', item('b-old', 'b', 'done', daysAgo(20)));
  // live work
  j(R, '.loop/queue/a/queued.json', item('queued', 'a', undefined, daysAgo(60)));
  j(R, '.loop/queue/_waiting/parked.json', item('parked', 'a', 'waiting', daysAgo(60)));
  // gates
  j(R, '.loop/gates/g-old.json', { id: 'g-old', kind: 'question', agent: 'a', itemId: 'old-done', chainId: 'c-old-done', title: 'old q', body: '', files: [], resume: true, status: 'answered', createdAt: daysAgo(30), resolvedAt: daysAgo(20) });
  j(R, '.loop/gates/g-pending.json', { id: 'g-pending', kind: 'question', agent: 'a', itemId: 'parked', chainId: 'c-parked', title: 'open q', body: '', files: [], resume: true, status: 'pending', createdAt: daysAgo(90) });
  // checkpoints
  j(R, '.loop/checkpoints/old-done.json', { itemId: 'old-done' });
  fs.utimesSync(path.join(R, '.loop/checkpoints/old-done.json'), new Date(daysAgo(20)), new Date(daysAgo(20)));
  j(R, '.loop/checkpoints/parked.json', { itemId: 'parked' });
  fs.utimesSync(path.join(R, '.loop/checkpoints/parked.json'), new Date(daysAgo(90)), new Date(daysAgo(90)));
  // tasks
  const task = (id, state, upd) => ({ id, title: `t ${id}`, state, holders: state === 'open' ? ['a'] : [], createdAt: upd, updatedAt: upd, log: [{ ts: upd, agent: 'a', event: 'start' }] });
  j(R, '.loop/tasks/t-done.json', task('t-done', 'done', daysAgo(45)));
  j(R, '.loop/tasks/t-open.json', task('t-open', 'open', daysAgo(45)));
  j(R, '.loop/tasks/t-recent.json', task('t-recent', 'dropped', daysAgo(3)));
  // run logs
  const runDay = n => daysAgo(n).slice(0, 10);
  j(R, `.loop/runs/${runDay(40)}/c-old-done.jsonl`, '{"type":"end"}\n');
  j(R, `.loop/runs/${runDay(40)}/c-old-err.jsonl`, '{"type":"end"}\n');
  j(R, `.loop/runs/${runDay(40)}/c-parked.jsonl`, '{"type":"end"}\n');
  j(R, `.loop/runs/${runDay(40)}/t-open.jsonl`, '{"type":"end"}\n');
  j(R, `.loop/runs/${runDay(5)}/c-new-done.jsonl`, '{"type":"end"}\n');
  return { R, runDay };
}

console.log('the cleanup plan');
{
  const { R, runDay } = world();
  const files = M.planCleanup(R, M.DEFAULT_RETENTION, now).map(v => v.file).sort();
  ok(files.includes('.loop/queue/_done/old-done.json') && files.includes('.loop/queue/_done/b-old.json'), 'finished items past 14 days are planned');
  ok(!files.includes('.loop/queue/_done/new-done.json'), 'a recent finished item is kept');
  ok(!files.includes('.loop/queue/_done/old-err.json'), 'a failed item is kept however old');
  ok(!files.some(f => f.includes('queued.json') || f.includes('parked.json')), 'queued and parked items are never planned');
  ok(files.includes('.loop/gates/g-old.json') && !files.includes('.loop/gates/g-pending.json'), 'a resolved question goes, a pending one stays');
  ok(files.includes('.loop/checkpoints/old-done.json') && !files.includes('.loop/checkpoints/parked.json'), 'a checkpoint goes only when no live item needs it');
  ok(files.includes('.loop/tasks/t-done.json') && !files.includes('.loop/tasks/t-open.json') && !files.includes('.loop/tasks/t-recent.json'), 'old closed tasks go; open and recent ones stay');
  ok(files.includes(`.loop/runs/${runDay(40)}/c-old-done.jsonl`), 'an old run log is planned');
  ok(!files.includes(`.loop/runs/${runDay(40)}/c-old-err.jsonl`) && !files.includes(`.loop/runs/${runDay(40)}/c-parked.jsonl`) && !files.includes(`.loop/runs/${runDay(40)}/t-open.jsonl`), 'logs of failed, parked and open-task chains are kept');
  ok(!files.includes(`.loop/runs/${runDay(5)}/c-new-done.jsonl`), 'a recent run log is kept');

  const mine = M.planCleanup(R, M.DEFAULT_RETENTION, now, { agent: 'b' }).map(v => v.file);
  ok(mine.length === 1 && mine[0] === '.loop/queue/_done/b-old.json', 'an agent filter reaches only that agent');
  const all = M.planCleanup(R, M.DEFAULT_RETENTION, now, { olderThanDays: 0 }).map(v => v.file);
  ok(all.includes('.loop/queue/_done/new-done.json') && !all.includes('.loop/queue/_done/old-err.json'), 'age 0 means everything finished, still sparing failures');
  const bad = M.planCleanup(R, M.DEFAULT_RETENTION, now, { includeProblems: true }).map(v => v.file);
  ok(bad.includes('.loop/queue/_done/old-err.json') && bad.includes(`.loop/runs/${runDay(40)}/c-old-err.jsonl`), 'include_problems removes failures and their logs');
  fs.rmSync(R, { recursive: true, force: true });
}

console.log('running a cleanup');
{
  const { R, runDay } = world();
  const before = M.planCleanup(R, M.DEFAULT_RETENTION, now);
  const r = M.runCleanup(R, before, 'human', now);
  ok(!exists(R, '.loop/queue/_done/old-done.json') && exists(R, '.loop/queue/_done/new-done.json') && exists(R, '.loop/gates/g-pending.json') && exists(R, '.loop/queue/_waiting/parked.json'), 'only planned files go');
  ok(r.removed.item === 2 && r.removed.gate === 1 && r.removed.task === 1 && /Removed/.test(M.describeResult(r)), 'the result counts what was removed');
  ok(JSON.parse(fs.readFileSync(path.join(R, '.loop/maintenance.jsonl'), 'utf8').trim()).by === 'human', 'a summary line is logged');
  ok(M.planCleanup(R, M.DEFAULT_RETENTION, now).length === 0, 'a second plan finds nothing');
  ok(M.runCleanup(R, [{ kind: 'item', file: '../outside.json', label: 'x', ageDays: 1, bytes: 1 }], 'human', now).removed.item === 0, 'nothing outside .loop is ever removed');
  fs.rmSync(R, { recursive: true, force: true });

  const w = world();
  ok(M.autoCleanup(w.R, M.DEFAULT_RETENTION, now) && !M.autoCleanup(w.R, M.DEFAULT_RETENTION, now), 'the automatic pass runs once per day');
  ok(M.autoCleanup(w.R, M.DEFAULT_RETENTION, new Date(now.getTime() + 2 * 86_400_000)) !== undefined, 'and again the next day');
  const u = M.storageUsage(w.R);
  ok(u['finished items'].count >= 1 && u.gates.count >= 1, 'storage usage counts what is kept');
  fs.rmSync(w.R, { recursive: true, force: true });
}

console.log('pause and cancel');
{
  const { R } = world();
  ok(M.pausedAgents(R).size === 0, 'nothing is paused at first');
  M.setPaused(R, 'a', true); M.setPaused(R, 'b', true); M.setPaused(R, 'b', false);
  ok([...M.pausedAgents(R)].join() === 'a', 'pause and resume are remembered per agent');
  const q = M.listQueue(R);
  ok(q.length === 2 && q.some(r => r.id === 'queued' && r.state === 'queued') && q.some(r => r.id === 'parked' && r.state === 'waiting'), 'the queue lists queued and parked items');
  ok(/Cancelled/.test(M.cancelQueued(R, 'queued', now)) && exists(R, '.loop/queue/_done/queued.json') && !exists(R, '.loop/queue/a/queued.json'), 'a queued item moves to finished as cancelled');
  ok(/Cancelled/.test(M.cancelQueued(R, 'parked', now)) && !exists(R, '.loop/queue/_waiting/parked.json') && JSON.parse(fs.readFileSync(path.join(R, '.loop/queue/_done/parked.json'), 'utf8')).status === 'cancelled', 'a parked item is cancelled too');
  ok(JSON.parse(fs.readFileSync(path.join(R, '.loop/gates/g-pending.json'), 'utf8')).status === 'rejected', 'and the question it waited on is closed');
  ok(/No queued/.test(M.cancelQueued(R, 'missing', now)), 'an unknown id is explained');
  fs.rmSync(R, { recursive: true, force: true });
}

console.log('damaged state files');
{
  const Q = require(`${OUT}/queue.js`);
  const { R } = world();
  fs.writeFileSync(path.join(R, '.loop/queue/a/broken.json'), '{"id": "half');
  fs.writeFileSync(path.join(R, '.loop/gates/bad.json'), 'not json');
  const ids = Q.pending(R, 'a').map(i => i.id);
  ok(ids.length === 1 && ids[0] === 'queued', 'a torn queue file is skipped and the rest of the queue still reads');
  ok(!exists(R, '.loop/queue/a/broken.json') && fs.readdirSync(path.join(R, '.loop/corrupt')).some(f => f.endsWith('broken.json')), 'the damaged file is kept under .loop/corrupt for inspection');
  ok(Q.listGates(R).every(g => g.id) && !exists(R, '.loop/gates/bad.json'), 'a damaged gate does not break the inbox');
  Q.enqueue(R, { id: 'fresh', agent: 'a', task: 't', from: 'user', chainId: 'cf', hop: 0, createdAt: new Date().toISOString() });
  ok(Q.pending(R, 'a').some(i => i.id === 'fresh') && !fs.readdirSync(path.join(R, '.loop/queue/a')).some(f => f.endsWith('.tmp')), 'writes leave no temporary file behind');
  fs.rmSync(R, { recursive: true, force: true });
}

console.log('the chat tools');
(async () => {
  const { R } = world();
  fs.mkdirSync(path.join(R, '.github/agents'), { recursive: true });
  fs.writeFileSync(path.join(R, '.github/agents/a.agent.md'), '---\nname: a\ndescription: watches\nloop:\n  schedule: "0 9 * * *"\n  task: Look.\n---\nYou watch.\n');
  fs.writeFileSync(path.join(R, '.github/agents/b.agent.md'), '---\nname: b\ndescription: other\nhandoffs:\n  - label: to a\n    agent: a\n    prompt: go\nloop:\n  schedule: "0 10 * * *"\n  task: Other.\n---\nYou work.\n');
  const stopped = [];
  const host = { root: R, state: () => ({ running: true, active: undefined }), submit() {}, answer() {}, power: async () => {}, reload: async () => [], cancel: a => { stopped.push(a); return true; } };

  const c = await runChatTool('propose_cleanup', { older_than_days: 0 }, host);
  ok(c.proposal && /Clean up/.test(c.proposal.title) && exists(R, '.loop/queue/_done/old-done.json'), 'a cleanup is a proposal and deletes nothing yet');
  const msg = await c.proposal.apply();
  ok(/Removed/.test(msg) && !exists(R, '.loop/queue/_done/old-done.json'), 'Apply deletes what was shown');
  ok(/Nothing to clean/.test((await runChatTool('propose_cleanup', { older_than_days: 0 }, host)).text), 'a second cleanup has nothing to do');

  const p = await runChatTool('propose_pause', { agent: 'a', paused: true }, host);
  ok(p.proposal && !M.pausedAgents(R).has('a'), 'a pause is only proposed');
  await p.proposal.apply();
  ok(M.pausedAgents(R).has('a') && JSON.parse((await runChatTool('list_agents', {}, host)).text).agents.find(x => x.name === 'a').paused === true, 'Apply pauses it and list_agents says so');
  ok(/already paused/.test((await runChatTool('propose_pause', { agent: 'a', paused: true }, host)).text), 'pausing twice is a no-op');

  const k = await runChatTool('propose_cancel', { id: 'queued' }, host);
  ok(k.proposal && exists(R, '.loop/queue/a/queued.json'), 'cancelling an item is proposed first');
  await k.proposal.apply();
  ok(!exists(R, '.loop/queue/a/queued.json'), 'Apply cancels it');
  const s = await runChatTool('propose_cancel', { agent: 'a' }, host);
  await s.proposal.apply();
  ok(stopped[0] === 'a', 'stopping a running agent goes through the runner');

  const t = await runChatTool('propose_task_close', { id: 't-open' }, host);
  ok(t.proposal && JSON.parse(fs.readFileSync(path.join(R, '.loop/tasks/t-open.json'), 'utf8')).state === 'open', 'closing a task is proposed first');
  await t.proposal.apply();
  ok(JSON.parse(fs.readFileSync(path.join(R, '.loop/tasks/t-open.json'), 'utf8')).state === 'dropped', 'Apply drops it');

  ok(/unfinished item/.test((await runChatTool('propose_agent_remove', { agent: 'a' }, host)).text), 'an agent with unfinished work is not removed');
  M.cancelQueued(R, 'parked', now);
  ok(/hand work to a/.test((await runChatTool('propose_agent_remove', { agent: 'a' }, host)).text), 'an agent others hand off to is not removed');
  const rm = await runChatTool('propose_agent_remove', { agent: 'b' }, host);
  ok(rm.proposal && exists(R, '.github/agents/b.agent.md'), 'removing an agent is proposed first');
  await rm.proposal.apply();
  ok(!exists(R, '.github/agents/b.agent.md') && fs.readdirSync(path.join(R, '.loop/archive/agents')).some(f => f.endsWith('b.agent.md')), 'Apply archives the file instead of deleting it');

  const use = JSON.parse((await runChatTool('storage_usage', {}, host)).text);
  ok(use.keeps && use.retention.doneDays === 14, 'storage_usage reports what is kept and the retention');
  ok(/No run/.test((await runChatTool('get_run', { chain_id: 'nope' }, host)).text) && /not a chain id/.test((await runChatTool('get_run', { chain_id: '../x' }, host)).text), 'get_run rejects unknown and unsafe ids');

  fs.rmSync(R, { recursive: true, force: true });
  console.log(`${pass} housekeeping checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
