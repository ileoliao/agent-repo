// Inbound triggers: a goal woken by a webhook or a new file. Needs `tsc` first (npm test does it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const assert = require('assert');

const OUT = path.join(__dirname, '..', 'out');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const T = require(`${OUT}/triggers.js`);
const { loadAgents } = require(`${OUT}/team.js`);
const Q = require(`${OUT}/queue.js`);
const M = require(`${OUT}/maintenance.js`);
const { runDoctor } = require(`${OUT}/doctor.js`);
const { runChatTool } = require(`${OUT}/chatTools.js`);

const w = (R, rel, text) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const agentFile = (name, goals) => `---\nname: ${name}\ndescription: ${name}\nloop:\n  goals:\n${goals}---\nYou handle events carefully and finish with a summary.\n`;
const world = () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-trig-'));
  w(R, '.github/agents/deployer.agent.md', agentFile('deployer', '    - id: on-deploy\n      text: React to deploy events.\n      task: A deploy event arrived. Check it.\n      on: "webhook:deploy"\n'));
  w(R, '.github/agents/filer.agent.md', agentFile('filer', '    - id: inbox\n      text: Handle new reports.\n      task: New report files arrived.\n      on: "file:reports/*.md"\n'));
  return R;
};
const post = (port, url, body, token) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: url, method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : {} }, res => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.end(body);
});

(async () => {
  console.log('the on: field');
  ok(T.parseOn('webhook:deploy').name === 'deploy' && T.parseOn('file:reports/*.md').pattern === 'reports/*.md' && T.parseOn(undefined) === undefined, 'webhook and file triggers parse');
  ok(['webhook:', 'webhook:Bad Name', 'file:/etc/*', 'file:../x', 'file:.loop/*', 'cron:x'].every(v => T.parseOn(v).error), 'bad values are explained');
  {
    const R = world();
    const team = loadAgents(R);
    ok(team.get('deployer').goals[0].on === 'webhook:deploy', 'the goal carries its trigger');
    w(R, '.github/agents/typo.agent.md', agentFile('typo', '    - id: g\n      text: x\n      on: "weebhook:x"\n'));
    const { loadAllAgents, validateTeam, loadSkills } = require(`${OUT}/team.js`);
    ok(validateTeam(loadAgents(R), loadSkills(R), loadAllAgents(R)).some(e => /on must look like/.test(e)), 'a bad trigger is a config error at load');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('webhooks');
  {
    const R = world();
    const team = () => [...loadAgents(R).values()];
    const r = T.handleWebhook(R, team(), 'deploy', 'build 42 failed');
    const item = Q.pending(R, 'deployer')[0];
    ok(r.status === 202 && item && item.from === 'trigger' && item.goal === 'on-deploy' && item.task.includes('deploy event'), 'a webhook queues the goal for its agent');
    ok(/not instructions/.test(item.context) && item.context.includes('build 42 failed'), 'the payload reaches the agent framed as data');
    ok(T.handleWebhook(R, team(), 'nobody', 'x').status === 404, 'a name nobody listens on is a 404');
    M.setPaused(R, 'deployer', true);
    ok(T.handleWebhook(R, team(), 'deploy', 'x').status === 404, 'a paused agent is not woken');
    M.setPaused(R, 'deployer', false);
    for (let i = 0; i < 25; i++) { T.handleWebhook(R, team(), 'deploy', `e${i}`); }
    ok(Q.pending(R, 'deployer').length === 20 && T.handleWebhook(R, team(), 'deploy', 'x').status === 429, 'a flood is capped instead of filling the queue');
    const big = T.handleWebhook(R, team(), 'nobody', 'x'.repeat(10000));
    ok(big.status === 404, 'large bodies are handled');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('the listener');
  {
    const R = world();
    const got = [];
    const srv = await T.startTriggerServer({ port: 0, token: 'sekret', onHook: (n, b) => { got.push([n, b]); return T.handleWebhook(R, loadAgents(R).values(), n, b); } });
    ok((await post(srv.port, '/hook/deploy', 'hi')).status === 401 && (await post(srv.port, '/hook/deploy', 'hi', 'wrong')).status === 401, 'no token or a wrong token is refused');
    ok(got.length === 0, 'and never reaches the handler');
    const good = await post(srv.port, '/hook/deploy', 'build 7', 'sekret');
    ok(good.status === 202 && got[0][0] === 'deploy' && got[0][1] === 'build 7' && Q.pending(R, 'deployer').length === 1, 'the right token queues work');
    ok((await post(srv.port, '/other', 'x', 'sekret')).status === 404 && (await post(srv.port, '/hook/BAD', 'x', 'sekret')).status === 404, 'other paths are 404');
    const get = await new Promise(r => http.get({ host: '127.0.0.1', port: srv.port, path: '/hook/deploy' }, res => { res.resume(); r(res.statusCode); }));
    ok(get === 404, 'only POST is accepted');
    ok((await post(srv.port, '/hook/deploy', 'y'.repeat(70 * 1024), 'sekret').catch(() => ({ status: 413 }))).status === 413, 'an oversized body is refused');
    await srv.close();
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('file triggers');
  {
    const R = world();
    w(R, 'reports/old.md', 'old');
    const team = () => [...loadAgents(R).values()];
    ok(T.scanFileTriggers(R, team()) === 0 && Q.pending(R, 'filer').length === 0, 'the first scan only records what is already there');
    w(R, 'reports/new.md', 'new'); w(R, 'reports/skip.txt', 'no');
    ok(T.scanFileTriggers(R, team()) === 1, 'a new matching file fires once');
    const it = Q.pending(R, 'filer')[0];
    ok(it && it.context.includes('reports/new.md') && !it.context.includes('old.md') && !it.context.includes('skip.txt'), 'only the new matching file is named');
    ok(T.scanFileTriggers(R, team()) === 0, 'and is not reported again');
    M.setPaused(R, 'filer', true);
    w(R, 'reports/later.md', 'x');
    ok(T.scanFileTriggers(R, team()) === 0, 'a paused agent is left alone');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('doctor and chat');
  {
    const R = world();
    const off = await runDoctor(R, { agent: 'deployer', triggerPort: 0 });
    ok(off.checks.some(c => /no webhook port/.test(c.what)), 'the doctor warns when a webhook goal has no port');
    const on = await runDoctor(R, { agent: 'deployer', triggerPort: 8765 });
    ok(!on.checks.some(c => /no webhook port/.test(c.what)), 'and not when it has one');
    const host = { root: R, state: () => ({}), reload: async () => [] };
    const p = await runChatTool('propose_goals', { agent: 'deployer', op: 'add', id: 'hook2', text: 'Another.', task: 'Do it.', on: 'webhook:two' }, host);
    ok(p.proposal && /on: "?webhook:two/.test(p.proposal.detail), 'a trigger can be proposed from chat');
    fs.rmSync(R, { recursive: true, force: true });
  }
  console.log(`${pass} trigger checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
