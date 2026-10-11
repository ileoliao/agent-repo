// End-to-end check of Loop Runner's runtime with a mock vscode module and a scripted fake model.
// Run: npm test
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

// ---- mock vscode (only what the runtime touches) ----
class TextPart { constructor(value) { this.value = value; } }
class ToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
class ToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
const vscodeMock = {
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessage: { User: c => ({ role: 'user', content: c }), Assistant: c => ({ role: 'assistant', content: c }) },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelError: class extends Error {}
};
const origLoad = Module._load;
Module._load = function (req, ...rest) { return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest); };

const OUT = path.join(__dirname, '..', 'out');
const { loadAgents, loadAllAgents, loadSkills, validateTeam, pickModel } = require(`${OUT}/team.js`);
const { checkWake } = require(`${OUT}/wake.js`);
const { parseFrontmatter } = require(`${OUT}/frontmatter.js`);
const { cronMatches, validateCron } = require(`${OUT}/cron.js`);
const { loadPolicy, decideCommand, decideWrite, skillScriptRule } = require(`${OUT}/policy.js`);
const Q = require(`${OUT}/queue.js`);
const { runItem } = require(`${OUT}/runner.js`);
const { exec } = require(`${OUT}/exec.js`);
const G = require(`${OUT}/gates.js`);

// ---- fixture workspace: the repo's team config plus stub skills ----
const W = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-e2e-'));
fs.cpSync(path.join(__dirname, '..', '.github', 'agents'), path.join(W, '.github', 'agents'), { recursive: true });
fs.cpSync(path.join(__dirname, '..', '.loop', 'policies'), path.join(W, '.loop', 'policies'), { recursive: true });
// An interactive-only agent (no loop: block) must not join the team.
fs.writeFileSync(path.join(W, '.github', 'agents', 'planner.agent.md'),
  "---\nname: planner\ndescription: Plans work\ntools: ['search']\nmodel: ['Claude Opus 4.5', 'GPT-5.2']\n---\nPlan only.\n");
fs.copyFileSync(path.join(__dirname, '..', '.loop', 'policy.json'), path.join(W, '.loop', 'policy.json'));
const mk = (name, desc, body, scripts = {}) => {
  const d = path.join(W, '.github', 'skills', name);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: ${desc}\n---\n${body}\n`);
  for (const [f, c] of Object.entries(scripts)) { fs.writeFileSync(path.join(d, 'scripts', f), c); }
};
// Stub probe honouring the wakeIf contract: flag files decide anomaly (0) / clear (1) / broken (3).
mk('harbor-anomaly-detect', 'Detect anomalies', 'Run detect.py',
  { 'detect.py': [
    'import os, sys',
    'if os.path.exists(".loop/flag-broken"): print("HarborSense API 503"); sys.exit(3)',
    'if os.path.exists(".loop/flag-anomaly") or "--exit-code" not in sys.argv:',
    '    print(\'{"anomalies":[{"signal":"task_backlog","observed":412,"target":120,"trace_id":"abc123"}]}\'); sys.exit(0)',
    'print("all clear"); sys.exit(1)', ''].join('\n') });
mk('harborsense-investigate', 'Investigate', 'Follow the protocol.');
mk('fix-pr', 'Fix as draft PR', 'agent/* branches only.');
mk('jira-support', 'Tickets', 'send_reply.sh <KEY> <draft>',
  { 'send_reply.sh': 'echo "posting $1 with token=$JIRA_TOKEN"; cat "$2"\n', 'new_tickets.py': 'import sys; print("SUP-1"); sys.exit(0)\n' });
mk('notify-test', 'Notify', 'n/a', { 'send.sh': 'echo "$LOOP_EVENT_KIND|$LOOP_EVENT_TITLE|$LOOP_EVENT" >> .loop/notified.log\n' });

let pass = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); pass++; console.log('  ✓', msg); };
const SECRETS = { JIRA_TOKEN: 'sekret-token-123' };

(async () => {
  console.log('team');
  const all = loadAllAgents(W), team = loadAgents(W), skills = loadSkills(W);
  ok(all.size === 4 && team.size === 3 && !team.has('planner'), 'reads .github/agents; only agents with a loop: block join the team');
  ok(skills.size === 5, 'loads 5 skills');
  ok(validateTeam(team, skills, all).length === 0, 'team validates clean: ' + JSON.stringify(validateTeam(team, skills, all)));
  const sen = team.get('sentinel');
  ok(sen.schedule === '*/15 9-21 * * 1-5' && sen.handoffs.join() === 'techlead' && sen.wakeIf.includes('--exit-code') && sen.maxSteps === 15,
    'native handoffs objects + loop block parsed');
  ok(all.get('planner').models.join() === 'Claude Opus 4.5,GPT-5.2', 'native model list parsed');
  sen.skills.push('nope'); sen.handoffs.push('planner');
  const errs = validateTeam(team, skills, all);
  ok(errs.some(e => e.includes('"nope"')) && errs.some(e => e.includes('"planner" exists but has no loop: block')), 'missing skill and non-team handoff reported');
  sen.skills.pop(); sen.handoffs.pop();

  console.log('frontmatter');
  const fm = parseFrontmatter("---\ndescription: \"a: b # kept\"\nhandoffs:\n  - label: X\n    agent: y\n    prompt: do: it\n    send: false\nloop:\n  notes: |\n    l1\n      l2\n---\nbody");
  ok(fm.meta.description === 'a: b # kept' && fm.meta.handoffs[0].prompt === 'do: it' && fm.meta.handoffs[0].send === false, 'quoted colons/hashes and list-of-maps');
  ok(fm.meta.loop.notes === 'l1\n  l2' && fm.body === 'body', 'nested block scalar keeps relative indent');

  console.log('model picking');
  const ms = [{ id: 'm1', name: 'GPT-5.2', family: 'gpt-5.2' }, { id: 'm2', name: 'Claude Sonnet 4.5', family: 'claude-sonnet-4.5' }];
  const A = (o) => ({ models: [], ...o });
  ok(pickModel(ms, A({ modelFamily: 'claude-sonnet-4.5' }), '').id === 'm2', 'loop.model picks by family');
  ok(pickModel(ms, A({ models: ['Claude Opus 4.5', 'claude sonnet 4.5 (copilot)'] }), '').id === 'm2', 'native model list: first available, case and (copilot) ignored');
  ok(pickModel(ms, A({}), 'claude-sonnet-4.5').id === 'm2' && pickModel(ms, A({}), '').id === 'm1', 'falls back to default family, then first');
  ok(pickModel(ms, A({ modelFamily: 'nope' }), '') === undefined, 'unknown loop.model is an error, not a silent fallback');

  console.log('wakeIf');
  const senPolicy = loadPolicy(W, '.loop/policy.json');
  const senAllow = [skillScriptRule('.github/skills/harbor-anomaly-detect')];
  let w = await checkWake(W, sen, senPolicy, senAllow, {});
  ok(!w.wake && !w.error, 'exit 1: all clear, no model call');
  fs.writeFileSync(path.join(W, '.loop/flag-anomaly'), '');
  w = await checkWake(W, sen, senPolicy, senAllow, {});
  ok(w.wake && w.context.includes('task_backlog'), 'exit 0: wake, detection output becomes context');
  fs.writeFileSync(path.join(W, '.loop/flag-broken'), '');
  w = await checkWake(W, sen, senPolicy, senAllow, {});
  ok(!w.wake && w.error.includes('exit 3') && w.error.includes('503'), 'other exit: broken probe reported, no wake');
  fs.rmSync(path.join(W, '.loop/flag-broken')); fs.rmSync(path.join(W, '.loop/flag-anomaly'));
  w = await checkWake(W, { ...sen, wakeIf: 'curl http://harbor/api' }, senPolicy, senAllow, {});
  ok(!w.wake && w.error.includes('refused by policy'), 'wakeIf must pass policy');
  ok((await checkWake(W, team.get('techlead'), senPolicy, [], {})).wake, 'no wakeIf: always wake');

  console.log('cron');
  ok(cronMatches('*/15 9-21 * * 1-5', new Date(2026, 9, 12, 9, 30)), 'Mon 09:30 matches');
  ok(!cronMatches('*/15 9-21 * * 1-5', new Date(2026, 9, 11, 9, 30)), 'Sun 09:30 does not');
  ok(!cronMatches('*/15 9-21 * * 1-5', new Date(2026, 9, 12, 9, 31)), 'Mon 09:31 does not');
  ok(cronMatches('0 8 * * 0', new Date(2026, 9, 11, 8, 0)) && cronMatches('0 8 * * 7', new Date(2026, 9, 11, 8, 0)), 'Sunday as 0 and 7');
  ok(validateCron('61 * * * *') && validateCron('* * *'), 'bad cron rejected');

  console.log('policy');
  const tl = loadPolicy(W, '.loop/policies/techlead.json');
  ok(decideCommand(tl, 'git -C repos/core push -u origin agent/incident-42').decision === 'allow', 'techlead may push agent/* branch');
  ok(decideCommand(tl, 'git -C repos/core push origin main').decision === 'deny', 'techlead may not push main');
  ok(decideCommand(tl, 'git push -f origin agent/x').decision === 'deny', 'force push denied');
  ok(decideCommand(tl, 'cd repos/core && npm test').decision === 'allow', 'cd into repo + test allowed');
  ok(decideWrite(tl, 'repos/core/src/a.ts').decision === 'allow' && decideWrite(tl, 'repos/core/.github/x.yml').decision === 'deny', 'techlead writes repos/** but not .github');
  ok(decideWrite(tl, '.loop/outbox/incidents/x.md').decision === 'allow' && decideWrite(tl, '.github/agents/techlead.agent.md').decision === 'deny', 'outbox writable; agents cannot edit their own role definitions');
  const sp = loadPolicy(W, '.loop/policies/support.json');
  const rule = skillScriptRule('.github/skills/jira-support');
  ok(decideCommand(sp, 'bash .github/skills/jira-support/scripts/fetch.sh | jq .', [rule]).decision === 'allow', 'skill scripts pre-approved');
  ok(decideCommand(sp, 'bash .github/skills/other/scripts/x.sh', [rule]).decision === 'deny', "other skills' scripts are not");

  // ---- scripted fake model: per agent, turn N (= number of assistant messages so far) returns these calls ----
  const scripts = {
    sentinel: [
      [['run_command', { command: 'python3 .github/skills/harbor-anomaly-detect/scripts/detect.py --window 15m' }]],
      [['write_file', { path: '.loop/outbox/incidents/2026-10-11-task_backlog.md', content: 'signal: task_backlog 412 vs 120, trace abc123' }]],
      [['handoff', { to: 'techlead', task: 'Investigate task_backlog anomaly', context: 'incident file + trace_id abc123' }]],
      [['finish', { status: 'done', summary: 'anomaly handed to techlead' }]]
    ],
    techlead: [
      [['run_command', { command: 'git push origin main' }]],
      [['ask_human', { question: 'Fix the retry storm (A) or the pool size (B)?', context: 'Two hypotheses fit the evidence.', options: ['A', 'B'] }]],
      [['finish', { status: 'done', summary: 'proceeding with the human choice' }]]
    ],
    support: [
      [['write_file', { path: '.loop/outbox/jira/SUP-1.md', content: '您好，问题已定位。' }]],
      [['request_approval', { title: 'Reply to SUP-1', summary: 'answer', command: 'bash .github/skills/jira-support/scripts/send_reply.sh SUP-1 .loop/outbox/jira/SUP-1.md', files: ['.loop/outbox/jira/SUP-1.md'] }],
       ['ask_human', { question: 'second gate in same turn', context: 'x' }]],
      [['write_file', { path: '.loop/outbox/jira/SUP-1.md', content: '您好，问题已定位，预计本周内修复上线。' }],
       ['request_approval', { title: 'evil', summary: 'x', command: 'rm -rf /' }]],
      [['request_approval', { title: 'Reply to SUP-1 (v2)', summary: 'revised', command: 'bash .github/skills/jira-support/scripts/send_reply.sh SUP-1 .loop/outbox/jira/SUP-1.md', files: ['.loop/outbox/jira/SUP-1.md'] }]],
      [['request_approval', { title: 'FYI only', summary: 'non-blocking', command: 'ls', wait: false }]],
      [['finish', { status: 'done', summary: 'reply sent' }]]
    ]
  };
  const seen = {};         // tool results each agent saw, in order
  const turnsSeen = {};    // which turn index each request was for
  const makeModel = () => ({
    family: 'fake', id: 'fake-1',
    async sendRequest(messages, opts) {
      const agent = /# Your role: (\w+)/.exec(messages[0].content[0].value)[1];
      const turn = messages.filter(m => m.role === 'assistant').length;
      (turnsSeen[agent] ??= []).push(turn);
      const last = messages[messages.length - 1];
      if (last.role === 'user' && last.content[0] instanceof ToolResultPart) {
        (seen[agent] ??= []).push(...last.content.map(r => r.content[0].value));
      }
      assert.ok(opts.tools.some(t => t.name === 'ask_human'), 'ask_human offered');
      const calls = scripts[agent][turn].map(([n, i], k) => new ToolCallPart(`${agent}-${turn}-${k}`, n, i));
      return { stream: (async function* () { yield* calls; })() };
    }
  });
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  const out = { appendLine: l => process.stdout.write('    | ' + l + '\n') };
  const deps = agent => ({
    root: W, team, skills, model: makeModel(), secrets: SECRETS,
    policy: loadPolicy(W, team.get(agent).policy ?? '.loop/policy.json'), maxSteps: 10, maxHops: 5, out, token
  });
  const runNext = async () => {
    const item = Q.nextItem(W, [...team.keys()]);
    const r = await runItem(item, deps(item.agent));
    Q.complete(W, item, r.status, r.summary);
    return { item, r };
  };

  console.log('loop: sentinel -> techlead');
  const chain = Q.newId();
  Q.enqueue(W, { id: Q.newId(), agent: 'sentinel', task: team.get('sentinel').task, from: 'schedule', chainId: chain, hop: 0, createdAt: new Date().toISOString() });
  let { item, r } = await runNext();
  ok(item.agent === 'sentinel' && r.status === 'done' && r.steps === 4, 'sentinel finished in 4 steps');
  ok(seen.sentinel[0].startsWith('[exit 0]') && seen.sentinel[0].includes('task_backlog'), 'skill script output reached the model');

  ({ item, r } = await runNext());
  ok(item.agent === 'techlead' && item.chainId === chain && item.hop === 1, 'techlead picked up the handoff on the same chain');
  ok(seen.techlead[0].startsWith('REFUSED'), 'push to main refused, loop continued');
  ok(r.status === 'waiting' && r.gateId, 'ask_human parks the item');
  ok(Q.waiting(W).some(w => w.id === item.id) && Q.pending(W, 'techlead').length === 0, 'item moved to _waiting, not runnable');
  ok(Q.loadCheckpoint(W, item.id)?.messages.length === 4, 'checkpoint holds prompt, both turns and the parked call');
  const q = Q.getGate(W, r.gateId);
  ok(q.kind === 'question' && q.options.join() === 'A,B' && q.status === 'pending', 'question gate in the inbox with options');

  console.log('human answers -> resume');
  ok(G.answerQuestion(W, q.id, 'B').woke, 'answering wakes the parked item');
  ({ item, r } = await runNext());
  ok(item.agent === 'techlead' && item.resumeGate === q.id, 'same item resumes');
  ok(turnsSeen.techlead.at(-1) === 2, 'model continued at turn 2, with earlier turns intact');
  ok(seen.techlead.at(-1) === 'The human answered: B', 'model received the answer as the tool result');
  ok(r.status === 'done' && !Q.loadCheckpoint(W, item.id), 'finished; checkpoint cleaned up');
  assert.throws(() => G.answerQuestion(W, q.id, 'A'), /already answered/);
  ok(true, 'a resolved gate cannot be answered twice');

  console.log('approval: one gate per turn, reject with feedback -> resume');
  Q.enqueue(W, { id: Q.newId(), agent: 'support', task: 'check tickets', from: 'schedule', chainId: Q.newId(), hop: 0, createdAt: new Date().toISOString() });
  ({ item, r } = await runNext());
  ok(r.status === 'waiting', 'request_approval parks by default');
  const pend = Q.listGates(W).filter(g => g.status === 'pending');
  ok(pend.length === 1 && pend[0].kind === 'approval', 'second gate in the same turn was not created');
  const cp = Q.loadCheckpoint(W, item.id);
  ok(cp.turnResults.find(t => t.callId !== cp.parkedCallId).text.startsWith('Not sent'), 'model will be told the second gate was not sent');
  ok(G.rejectApproval(W, pend[0].id, '不要承诺修复时间').woke, 'reject wakes the item');
  ({ item, r } = await runNext());
  ok(seen.support.some(s => s.startsWith('REJECTED') && s.includes('不要承诺修复时间')), 'model received the rejection with feedback');
  ok(seen.support.some(s => s.startsWith('Not sent')), 'model received the one-gate-per-turn notice');
  ok(seen.support.some(s => s.startsWith('REFUSED: command matches deny rule')), 'rm -rf approval refused at request time');
  ok(r.status === 'waiting', 'revised draft parked for approval again');

  console.log('approve -> run -> resume');
  const v2 = Q.listGates(W).find(g => g.status === 'pending');
  fs.writeFileSync(path.join(W, '.loop/outbox/jira/SUP-1.md'), '您好，问题已定位，修复后会第一时间通知您。'); // human edits the draft
  const ar = await G.approveAndRun(W, v2.id, loadPolicy(W, '.loop/policies/support.json'), SECRETS);
  ok(ar.ok && ar.woke, 'approved command executed and item woken');
  ok(ar.text.includes('token=***') && !ar.text.includes('sekret'), 'secret injected and redacted');
  ok(ar.text.includes('第一时间通知'), "the human's edit is what got sent");
  ({ item, r } = await runNext());
  ok(seen.support.some(s => s.startsWith('APPROVED') && s.includes('第一时间通知')), 'model resumed with the execution result');
  ok(seen.support.some(s => s.includes('you will not be woken')), 'wait=false approval returns immediately');
  ok(r.status === 'done', 'support finished');
  ok(Q.listGates(W).some(g => g.title === 'FYI only' && g.status === 'pending' && !g.resume), 'non-blocking approval stays in inbox');

  console.log('notify');
  const ncmd = 'bash .github/skills/notify-test/scripts/send.sh';
  await G.notify(W, ncmd, { kind: 'question', agent: 'techlead', title: 'A or B?', chainId: chain }, SECRETS);
  const log = fs.readFileSync(path.join(W, '.loop/notified.log'), 'utf8');
  ok(log.startsWith('question|A or B?|') && JSON.parse(log.split('|').slice(2).join('|')).agent === 'techlead', 'notify skill received the event');

  console.log('exec safety');
  const t = await exec('sleep 5', { cwd: W, timeoutSec: 1, maxOutputBytes: 100, secrets: {} });
  ok(t.code === null && t.text.includes('killed'), 'hung command killed by timeout');
  const stdin = await exec('read x; echo "got:$x"', { cwd: W, timeoutSec: 5, maxOutputBytes: 100, secrets: {} });
  ok(stdin.text.includes('got:'), 'stdin closed: prompt does not hang');

  console.log('audit');
  const day = new Date().toISOString().slice(0, 10);
  const lines = fs.readFileSync(path.join(W, '.loop/runs', day, `${chain}.jsonl`), 'utf8').trim().split('\n').map(JSON.parse);
  const types = lines.map(l => l.type);
  ok(new Set(lines.map(l => l.agent).filter(Boolean)).size === 2, 'one chain file holds sentinel and techlead');
  ok(['park', 'gate', 'resume', 'notify'].every(t => types.includes(t)), 'park, gate, resume and notify are audited');
  ok(Q.waiting(W).length === 0 && [...team.keys()].every(a => Q.pending(W, a).length === 0), 'nothing left waiting or queued');

  console.log('smoke workspace (examples/smoke)');
  {
    const S = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-smoke-'));
    fs.cpSync(path.join(__dirname, '..', 'examples', 'smoke'), S, { recursive: true });
    const sTeam = loadAgents(S), sSkills = loadSkills(S), sAll = loadAllAgents(S);
    ok(sTeam.size === 1 && validateTeam(sTeam, sSkills, sAll).length === 0, 'smoke team validates clean');
    const smoke = sTeam.get('smoke');
    const sPolicy = loadPolicy(S, '.loop/policy.json');
    const sAllow = [skillScriptRule(sSkills.get('smoke-probe').relDir)];
    ok(!(await checkWake(S, smoke, sPolicy, sAllow, {})).wake, 'no TRIGGER: probe says nothing to do');
    fs.writeFileSync(path.join(S, 'TRIGGER'), 'hello from JL');
    const sw = await checkWake(S, smoke, sPolicy, sAllow, {});
    ok(sw.wake && sw.context.includes('hello from JL') && fs.existsSync(path.join(S, 'TRIGGER.consumed')), 'TRIGGER: wakes with message and consumes trigger');
    ok(!(await checkWake(S, smoke, sPolicy, sAllow, {})).wake, 'consumed trigger does not fire twice');

    // Drive the role's steps through the real runner with a scripted model.
    const sendCmd = 'python .github/skills/smoke-probe/scripts/send.py .loop/outbox/smoke/reply.md';
    const steps = [
      [['write_file', { path: '.loop/outbox/smoke/reply.md', content: 'Reply: hello from JL' }]],
      [['ask_human', { question: 'Smoke test: which colour should the reply mention?', context: 'smoke', options: ['blue', 'green'] }]],
      [['edit_file', { path: '.loop/outbox/smoke/reply.md', oldText: 'Reply: hello from JL', newText: 'Reply: hello from JL\nColour chosen by the human: green' }]],
      [['request_approval', { title: 'Send smoke reply', summary: 'smoke', command: sendCmd, files: ['.loop/outbox/smoke/reply.md'] }]],
      [['finish', { status: 'done', summary: 'smoke ok' }]]
    ];
    const sSeen = [];
    const sModel = {
      family: 'fake', id: 'fake-smoke',
      async sendRequest(messages) {
        const turn = messages.filter(m => m.role === 'assistant').length;
        const last = messages[messages.length - 1];
        if (last.role === 'user' && last.content[0] instanceof ToolResultPart) { sSeen.push(...last.content.map(r => r.content[0].value)); }
        const calls = steps[turn].map(([n, i], k) => new ToolCallPart(`s-${turn}-${k}`, n, i));
        return { stream: (async function* () { yield* calls; })() };
      }
    };
    const sDeps = { root: S, team: sTeam, skills: sSkills, model: sModel, secrets: { SMOKE_TOKEN: 'smoke-secret-42' }, policy: sPolicy, maxSteps: 15, maxHops: 5, out, token };
    Q.enqueue(S, { id: Q.newId(), agent: 'smoke', task: smoke.task, context: sw.context, from: 'schedule', chainId: Q.newId(), hop: 0, createdAt: new Date().toISOString() });
    const step = async () => { const it = Q.nextItem(S, ['smoke']); const rr = await runItem(it, sDeps); Q.complete(S, it, rr.status, rr.summary); return rr; };
    let sr = await step();
    ok(sr.status === 'waiting' && Q.getGate(S, sr.gateId).kind === 'question', 'smoke parks on the question');
    G.answerQuestion(S, sr.gateId, 'green');
    sr = await step();
    ok(sr.status === 'waiting' && Q.getGate(S, sr.gateId).kind === 'approval', 'smoke resumes, edits the draft, parks on approval');
    const ar2 = await G.approveAndRun(S, sr.gateId, sPolicy, { SMOKE_TOKEN: 'smoke-secret-42' });
    ok(ar2.ok && ar2.text.includes('present: True') && !ar2.text.includes('smoke-secret-42') && ar2.text.includes('green'), 'send ran with secret injected+redacted and the edited draft');
    sr = await step();
    ok(sr.status === 'done' && sSeen.some(x => x.startsWith('APPROVED')), 'smoke finishes after approval');
    fs.rmSync(S, { recursive: true, force: true });
  }

  console.log(`\nALL ${pass} CHECKS PASSED`);
  fs.rmSync(W, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
