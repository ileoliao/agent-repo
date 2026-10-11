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
const { cronMatches, validateCron, minuteKey, missedSince } = require(`${OUT}/cron.js`);
const { loadPolicy, decideCommand, decideWrite, skillScriptRule } = require(`${OUT}/policy.js`);
const Q = require(`${OUT}/queue.js`);
const { runItem } = require(`${OUT}/runner.js`);
const { exec, selectShellConfig, POWERSHELL_ARGS, resolveShellConfig } = require(`${OUT}/exec.js`);
const { runTool } = require(`${OUT}/tools.js`);
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
  const missedNow = new Date(2026, 9, 12, 11, 30, 0);
  const missedLast = new Date(2026, 9, 12, 8, 0, 0);
  ok(missedSince('0 * * * *', minuteKey(missedLast), missedNow), 'hourly slots between 08:00 and 11:30 were missed');
  ok(!missedSince('0 * * * *', minuteKey(new Date(2026, 9, 12, 11, 0, 0)), missedNow), 'last hit was the latest slot, so nothing to catch up');
  ok(!missedSince('0 * * * *', minuteKey(missedNow), missedNow), 'the current minute is not a miss');
  ok(!missedSince('0 * * * *', undefined, missedNow), 'no stored fire means no catch-up');
  ok(missedSince('0 0 1 1 *', minuteKey(new Date(missedNow.getTime() - 50 * 60 * 60 * 1000)), missedNow), 'a gap over 48h counts as missed once');

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

  console.log('regression: command chaining, redirects, secrets, approval, windows shell');
  {
    const base = loadPolicy(W, '.loop/policy.json');
    ok(decideCommand(base, 'git status\nnode -e "process.exit(0)"').decision === 'deny', 'newline does not bypass allow rules');
    ok(decideCommand(base, 'git status & node -e "process.exit(0)"').decision === 'deny', 'single & does not bypass allow rules');
    ok(decideCommand(base, 'git status && git diff').decision === 'allow', '&& of two allowed commands still allowed');
    ok(decideCommand(base, 'git commit -m "fix && ship"').decision === 'allow', 'quoted && is not a command separator');
    ok(decideCommand(base, 'git status > .env').decision === 'deny', 'redirect to .env is denied');
    ok(decideCommand(base, 'git diff >> .github/workflows/pwn.yml').decision === 'deny', 'redirect to .github is denied');
    ok(decideCommand(base, 'git status > src/out.txt').decision === 'allow', 'redirect to a writable path is not a hard reject');

    const redirGate = Q.newId();
    Q.saveGate(W, {
      id: redirGate, kind: 'approval', agent: 'support', itemId: 'redir', chainId: 'redir-chain',
      title: 'write env', body: 'x', files: [], command: 'echo pwned > .env', resume: false, status: 'pending',
      createdAt: new Date().toISOString()
    });
    await assert.rejects(() => G.approveAndRun(W, redirGate, base, {}), /protected path/);
    ok(!fs.existsSync(path.join(W, '.env')), 'protected redirect was not executed');

    const subGate = Q.newId();
    Q.saveGate(W, {
      id: subGate, kind: 'approval', agent: 'support', itemId: 'sub', chainId: 'sub-chain',
      title: 'sub', body: 'x', files: [], command: 'echo $(touch pwned-sub.txt)', resume: false, status: 'pending',
      createdAt: new Date().toISOString()
    });
    await assert.rejects(() => G.approveAndRun(W, subGate, base, {}), /command substitution/);
    ok(!fs.existsSync(path.join(W, 'pwned-sub.txt')), '$(...) was not executed on approval');
    const btGate = Q.newId();
    Q.saveGate(W, {
      id: btGate, kind: 'approval', agent: 'support', itemId: 'bt', chainId: 'bt-chain',
      title: 'bt', body: 'x', files: [], command: 'echo `touch pwned-bt.txt`', resume: false, status: 'pending',
      createdAt: new Date().toISOString()
    });
    await assert.rejects(() => G.approveAndRun(W, btGate, base, {}), /command substitution/);
    ok(!fs.existsSync(path.join(W, 'pwned-bt.txt')), 'backticks were not executed on approval');

    process.env.LOOP_LEAKED_SECRET = 'leak-value-zz';
    const leaked = await exec('node -e "process.stdout.write(String(process.env.LOOP_LEAKED_SECRET||\'\'))"', {
      cwd: W, timeoutSec: 15, maxOutputBytes: 2000, secrets: {}
    });
    delete process.env.LOOP_LEAKED_SECRET;
    ok(!leaked.text.includes('leak-value-zz'), 'parent process.env is not inherited');
    const short = await exec('node -e "process.stdout.write(process.env.S||\'\')"', {
      cwd: W, timeoutSec: 15, maxOutputBytes: 2000, secrets: { S: 'xy' }
    });
    ok(short.text.includes('***') && !short.text.includes('xy'), 'short secrets are redacted from command output');
    fs.writeFileSync(path.join(W, 'notes.txt'), 'token=sekret-token-123\n');
    const rd = await runTool('read_file', { path: 'notes.txt' }, {
      root: W, secrets: SECRETS, policy: base, extraAllow: [], token,
      agent: sen, team, item: { id: 'read', hop: 0, chainId: 'read', agent: 'sentinel', task: 't', from: 'user', createdAt: '' },
      maxHops: 5
    });
    ok(rd.text.includes('***') && !rd.text.includes('sekret-token-123'), 'read_file output redacts secrets');

    const pidFile = path.join(W, 'grand.pid');
    const killed = await exec('sleep 30 & echo $! > grand.pid; wait', { cwd: W, timeoutSec: 1, maxOutputBytes: 2000, secrets: {} });
    ok(killed.code === null && killed.text.includes('killed'), 'timeout still reports killed');
    const grandPid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    let grandAlive = true;
    try { process.kill(grandPid, 0); } catch { grandAlive = false; }
    if (grandAlive) { try { process.kill(grandPid, 'SIGKILL'); } catch { /* already gone */ } }
    ok(!grandAlive, 'timeout kills the child process tree');

    const ps = selectShellConfig('win32', {
      bash: () => undefined,
      powershell: () => ({ shell: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', args: [...POWERSHELL_ARGS] })
    });
    ok(/powershell/i.test(ps.shell) && ps.args.includes('-NoProfile') && ps.args.includes('-NonInteractive'), 'windows uses pi PowerShell flags when bash is missing');
    const cmd = selectShellConfig('win32', { bash: () => undefined, powershell: () => undefined, comSpec: 'C:\\Windows\\System32\\cmd.exe' });
    ok(cmd.shell.endsWith('cmd.exe') && cmd.args.join(' ') === '/d /s /c', 'windows falls back to cmd /d /s /c');
    const live = resolveShellConfig();
    ok(live.args.includes('-c') && /bash|sh$/.test(live.shell), 'this host runs commands through pi shell config');
  }

  console.log('read_file continuation and list_dir limit');
  {
    const lines = Array.from({ length: 2005 }, (_, i) => `L${String(i + 1).padStart(4, '0')}`);
    fs.writeFileSync(path.join(W, 'long.txt'), lines.join('\n'));
    const ctx = {
      root: W, secrets: {}, policy: loadPolicy(W, '.loop/policy.json'), extraAllow: [], token,
      agent: sen, team, item: { id: 'read2', hop: 0, chainId: 'read2', agent: 'sentinel', task: 't', from: 'user', createdAt: '' },
      maxHops: 5
    };
    const head = await runTool('read_file', { path: 'long.txt' }, ctx);
    ok(head.text.includes('Use startLine=2001 to continue') && !head.text.includes('Use offset='), 'truncated read tells the model to pass startLine');
    ok(head.text.includes('L0001') && !head.text.includes('L2001'), 'the first page stops before the continuation line');
    const tail = await runTool('read_file', { path: 'long.txt', startLine: 2001 }, ctx);
    ok(tail.text.includes('L2001') && tail.text.includes('L2005') && !tail.text.includes('L2000'), 'startLine continues where the hint said');
    const alias = await runTool('read_file', { path: 'long.txt', offset: 2001, endLine: 2002 }, ctx);
    ok(alias.text.includes('L2001') && alias.text.includes('L2002') && !alias.text.includes('L2003'), 'offset is accepted and endLine limits the window');
    const many = path.join(W, 'many');
    fs.mkdirSync(many);
    for (let i = 0; i < 501; i++) fs.writeFileSync(path.join(many, `f${String(i).padStart(3, '0')}.txt`), 'x');
    const listed = await runTool('list_dir', { path: 'many' }, ctx);
    ok(listed.text.includes('Use limit=1000'), 'list_dir tells the model to pass limit');
    const rest = await runTool('list_dir', { path: 'many', limit: 1000 }, ctx);
    const names = rest.text.split('\n').filter(l => l.endsWith('.txt'));
    ok(names.length === 501 && !rest.text.includes('limit reached'), 'list_dir limit returns every entry');
  }

  console.log('tool mode, cancel, and queue retention');
  {
    const { keepQueued } = require(`${OUT}/extension.js`);
    ok(keepQueued('cancelled', 'The operation was cancelled'), 'cancel stays queued');
    ok(keepQueued('error', 'Blocked: rate limit exceeded'), 'rate limit stays queued');
    ok(keepQueued('error', 'quota exceeded'), 'quota stays queued');
    ok(!keepQueued('error', 'boom') && !keepQueued('done', 'ok'), 'other results still complete');
    // Gap 2: classification
    ok(!keepQueued('error', 'Message exceeds token limit.'), "'Message exceeds token limit.' is a permanent error, not a rate limit");
    ok(keepQueued('error', 'Sorry, you have been temporarily blocked due to too many requests'), "'temporarily blocked due to too many requests' is transient");
    ok(keepQueued('error', 'You have exhausted your credits'), "'exhausted your credits' is transient");
    ok(keepQueued('error', 'ChatRateLimited: slow down') && keepQueued('error', 'ChatQuotaExceeded: out'), 'Copilot error names ChatRateLimited / ChatQuotaExceeded are transient');
    ok(!keepQueued('error', 'Failed to generate a response') && !keepQueued('error', 'cannot generate output'), "'generate' is not mistaken for 'rate'");

    // Gap 1: Copilot rejects Required inside the response stream, after sendRequest() has succeeded.
    const modeSeen = [];
    const modeModel = {
      family: 'fake', id: 'mode',
      async sendRequest(_messages, options) {
        modeSeen.push(options);
        const required = options.toolMode === vscodeMock.LanguageModelChatToolMode.Required;
        return { stream: (async function* () {
          if (required) throw new Error('LanguageModelChatToolMode.Required is not supported with more than one tool');
          yield new ToolCallPart('mode-1', 'finish', { status: 'done', summary: 'mode ok' });
        })() };
      }
    };
    const modeItem = { id: 'mode-item', agent: 'techlead', task: 't', from: 'user', chainId: 'mode-chain', hop: 0, createdAt: new Date().toISOString() };
    const modeResult = await runItem(modeItem, { root: W, team, skills, model: modeModel, secrets: {}, policy: loadPolicy(W, '.loop/policy.json'), maxSteps: 5, maxHops: 5, out, token });
    ok(modeResult.status === 'done' && modeResult.steps === 1, 'a stream-time Required rejection does not error the item at step 1');
    ok(modeSeen.length === 1 && modeSeen[0].toolMode === vscodeMock.LanguageModelChatToolMode.Auto, 'requests use Auto, never a wasted Required attempt');
    ok(typeof modeSeen[0].justification === 'string' && modeSeen[0].justification.includes('techlead'), 'requests carry a justification');
    const cancelToken = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const cancelModel = {
      family: 'fake', id: 'cancel',
      async sendRequest() {
        cancelToken.isCancellationRequested = true;
        throw new Error('cancelled');
      }
    };
    const cancelItem = { id: 'cancel-item', agent: 'techlead', task: 't', from: 'user', chainId: 'cancel-chain', hop: 0, createdAt: new Date().toISOString() };
    const cancelResult = await runItem(cancelItem, { root: W, team, skills, model: cancelModel, secrets: {}, policy: loadPolicy(W, '.loop/policy.json'), maxSteps: 5, maxHops: 5, out, token: cancelToken });
    ok(cancelResult.status === 'cancelled' && keepQueued(cancelResult.status, cancelResult.summary), 'a cancelled request is not a finished error');
  }

  console.log('review fixes: restart, gates, exec, schedule');
  {
    const { keepQueued, selectModelsWhenReady, ensureConsent } = require(`${OUT}/extension.js`);
    const base = loadPolicy(W, '.loop/policy.json');
    const mkItem = (id, agent = 'techlead') => ({ id, agent, task: 't', from: 'user', chainId: `${id}-chain`, hop: 0, createdAt: new Date().toISOString() });
    const run = (item, model, extra = {}) => runItem(item, { root: W, team, skills, model, secrets: {}, policy: base, maxSteps: 5, maxHops: 5, out, token, ...extra });
    const scriptedModel = (turns, log = []) => ({
      family: 'fake', id: 'scripted',
      async sendRequest(messages) {
        const turn = messages.filter(m => m.role === 'assistant').length;
        log.push({ turn, messages: messages.length });
        const t = turns[turn];
        if (t instanceof Error) throw t;
        return { stream: (async function* () { yield* t.map(([n, i], k) => new ToolCallPart(`sm-${turn}-${k}`, n, i)); })() };
      }
    });

    // Gap 7: an interrupted item continues from its last completed turn; the handoff is not repeated.
    const rl = mkItem('resume-item', 'sentinel');
    const hand = [['handoff', { to: 'techlead', task: 'dup check', context: 'c' }]];
    let r1 = await run(rl, scriptedModel([hand, new Error('ChatRateLimited: slow down')]));
    ok(r1.status === 'error' && keepQueued(r1.status, r1.summary), 'rate limit after a handoff is a retryable error');
    ok(Q.loadCheckpoint(W, rl.id)?.parkedCallId === '' && Q.loadCheckpoint(W, rl.id).step === 1, 'each finished turn leaves a checkpoint');
    const retryLog = [];
    r1 = await run(rl, scriptedModel([hand, [['finish', { status: 'done', summary: 'ok' }]]], retryLog), {});
    ok(retryLog.length === 1 && retryLog[0].turn === 1, 'retry continues at turn 1 instead of replaying turn 0');
    ok(r1.status === 'done' && Q.pending(W, 'techlead').filter(i => i.task === 'dup check').length === 1, 'the handoff was enqueued exactly once');
    Q.complete(W, rl, 'done', 'ok');
    ok(!Q.loadCheckpoint(W, rl.id), 'completing the item removes the checkpoint');
    for (const i of Q.pending(W, 'techlead')) Q.complete(W, i, 'done', 'cleanup');

    // Gap 6: gate answered while the turn was still running.
    const race = mkItem('race-item');
    const rr = await run(race, scriptedModel([[['ask_human', { question: 'q?', context: 'c' }], ['run_command', { command: 'ls' }]]]));
    ok(rr.status === 'waiting', 'ask_human plus another call parks');
    ok(G.answerQuestion(W, rr.gateId, 'now').woke === false, 'answering before the item reached _waiting wakes nothing');
    Q.complete(W, race, rr.status, rr.summary, rr.gateId);
    ok(Q.pending(W, 'techlead').some(i => i.id === race.id && i.resumeGate === rr.gateId) && !Q.waiting(W).some(i => i.id === race.id), 'complete() wakes an item whose gate is already resolved');
    const gl = [];
    const rr2 = await run(Q.pending(W, 'techlead').find(i => i.id === race.id), scriptedModel([[], [['finish', { status: 'done', summary: 'x' }]]].map((t, k) => k === 0 ? [['ask_human', { question: 'q?', context: 'c' }]] : t), gl));
    ok(rr2.status === 'done', 'the answered item resumes and finishes');
    Q.complete(W, race, 'done');
    const open = mkItem('open-item');
    const rr3 = await run(open, scriptedModel([[['ask_human', { question: 'still open?', context: 'c' }]]]));
    Q.complete(W, open, rr3.status, rr3.summary, rr3.gateId);
    ok(Q.waiting(W).some(i => i.id === open.id), 'a pending gate keeps the item in _waiting');

    // Minor: scheduled-item dedupe also sees parked items.
    Q.enqueue(W, { ...mkItem('sched-item', 'sentinel'), from: 'schedule' });
    ok(Q.hasOpenScheduled(W, 'sentinel'), 'queued scheduled item counts as open');
    const sch = Q.pending(W, 'sentinel').find(i => i.id === 'sched-item');
    Q.complete(W, sch, 'waiting', undefined, undefined);
    ok(Q.pending(W, 'sentinel').length === 0 && Q.hasOpenScheduled(W, 'sentinel'), 'a scheduled item parked in _waiting still blocks a duplicate wake');
    fs.rmSync(path.join(W, '.loop/queue/_waiting', 'sched-item.json'));
    ok(!Q.hasOpenScheduled(W, 'sentinel'), 'nothing open once it is gone');

    // Gap 10: parked on the last step, the answer still reaches the model.
    const last = mkItem('laststep-item');
    const lastLog = [];
    const lm = scriptedModel([[['ask_human', { question: 'last?', context: 'c' }]], [['finish', { status: 'done', summary: 'answered' }]]], lastLog);
    const l1 = await run(last, lm, { maxSteps: 1 });
    Q.complete(W, last, l1.status, l1.summary, l1.gateId);
    G.answerQuestion(W, l1.gateId, 'yes');
    const l2 = await run(Q.pending(W, 'techlead').find(i => i.id === last.id), lm, { maxSteps: 1 });
    ok(l2.status === 'done' && lastLog.length === 2, 'maxSteps=1: resume still sends one request instead of ending as max_steps');
    Q.complete(W, last, 'done');
    for (const g of Q.listGates(W).filter(g => g.itemId === 'open-item')) { g.status = 'rejected'; Q.saveGate(W, g); }
    fs.rmSync(path.join(W, '.loop/queue/_waiting', 'open-item.json'), { force: true });

    // Gap 9: the tail of a long output survives.
    const longOut = await exec('seq 1 200000', { cwd: W, timeoutSec: 30, maxOutputBytes: 16000, secrets: {} });
    ok(longOut.text.includes('\n200000') && longOut.text.includes('[truncated]') && longOut.text.includes('\n1\n2\n'), 'long output keeps the real head and the real tail');
    ok(longOut.text.length < 16100, 'long output stays within the cap');
    const shortOut = await exec('seq 1 5', { cwd: W, timeoutSec: 30, maxOutputBytes: 16000, secrets: {} });
    ok(!shortOut.text.includes('truncated') && shortOut.text.includes('\n5'), 'short output is untouched');

    // Gap 8: environment plumbing passes, tokens do not.
    Object.assign(process.env, { SSH_AUTH_SOCK: '/tmp/ssh-x', HTTPS_PROXY: 'http://proxy:3128', NODE_EXTRA_CA_CERTS: '/tmp/ca.pem', DBUS_SESSION_BUS_ADDRESS: 'unix:path=/x', GH_TOKEN: 'ghp_leak', GITHUB_TOKEN: 'ghp_leak2' });
    const envOut = await exec('env', { cwd: W, timeoutSec: 15, maxOutputBytes: 20000, secrets: {} });
    for (const k of ['SSH_AUTH_SOCK', 'HTTPS_PROXY', 'NODE_EXTRA_CA_CERTS', 'DBUS_SESSION_BUS_ADDRESS']) delete process.env[k];
    delete process.env.GH_TOKEN; delete process.env.GITHUB_TOKEN;
    ok(/SSH_AUTH_SOCK=\/tmp\/ssh-x/.test(envOut.text) && /HTTPS_PROXY=http:\/\/proxy:3128/.test(envOut.text) && /NODE_EXTRA_CA_CERTS=/.test(envOut.text) && /DBUS_SESSION_BUS_ADDRESS=/.test(envOut.text), 'ssh-agent, DBus, proxy and CA variables reach the child');
    ok(!/GH_TOKEN|GITHUB_TOKEN|ghp_leak/.test(envOut.text), 'GH_TOKEN / GITHUB_TOKEN are still not inherited');

    // Gap 11: a missed slot while running is caught up once.
    const hourly = '0 * * * *';
    const t0 = new Date(2026, 9, 12, 8, 0, 0), t1 = new Date(2026, 9, 12, 11, 17, 0);
    ok(!cronMatches(hourly, t1) && missedSince(hourly, minuteKey(t0), t1), 'a non-matching minute after a long gap is a catch-up');
    ok(!missedSince(hourly, minuteKey(new Date(2026, 9, 12, 11, 0, 0)), t1), 'no catch-up between slots after a normal fire');

    // Gap 3: empty model list waits for Copilot once.
    let calls = 0, listener;
    const lists = [[], ['m']];
    const got = await selectModelsWhenReady(async () => lists[calls++], cb => { listener = cb; setTimeout(cb, 5); return { dispose() {} }; }, 1000);
    ok(got.length === 1 && calls === 2 && typeof listener === 'function', 'empty model list waits for onDidChangeChatModels, then selects again');
    calls = 0;
    const timedOut = await selectModelsWhenReady(async () => { calls++; return []; }, () => ({ dispose() {} }), 20);
    ok(timedOut.length === 0 && calls === 2, 'gives up after the timeout');
    calls = 0;
    ok((await selectModelsWhenReady(async () => { calls++; return ['a']; }, () => { throw new Error('must not wait'); }, 20)).length === 1 && calls === 1, 'a ready list returns at once');

    // Gap 4: consent is requested for models without access, and only those.
    const asked = [];
    const cm = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }];
    const probs = await ensureConsent(cm, m => (m.id === 'a' ? true : m.id === 'c' ? undefined : false), async m => { asked.push(m.id); if (m.id === 'c') throw new Error('NoPermissions'); });
    ok(asked.join() === 'b,c', 'consent request only for models that cannot send yet (once per model)');
    ok(probs.length === 1 && probs[0].startsWith('C:') && probs[0].includes('NoPermissions'), 'a denied consent is reported as a start problem');
  }

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
    ok(smoke.wakeIf.includes('scripts/py.js'), 'smoke wakeIf selects python3/python/py itself');
    const sendCmd = 'node .github/skills/smoke-probe/scripts/py.js .github/skills/smoke-probe/scripts/send.py .loop/outbox/smoke/reply.md';
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

  console.log('latest result: newest file under .loop/outbox');
  {
    const { latestOutput } = require(`${OUT}/outbox.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-outbox-'));
    ok(latestOutput(R) === undefined, 'no outbox means no latest result');
    const older = path.join(R, '.loop', 'outbox', 'techlead', 'old.md');
    const newer = path.join(R, '.loop', 'outbox', 'sentinel', 'report.md');
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.mkdirSync(path.dirname(newer), { recursive: true });
    fs.writeFileSync(older, 'old');
    fs.writeFileSync(newer, 'new');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(older, past, past);
    ok(latestOutput(R) === newer, 'picks the newest file across agent folders');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log(`\nALL ${pass} CHECKS PASSED`);
  fs.rmSync(W, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });

