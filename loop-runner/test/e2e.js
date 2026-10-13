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
  LanguageModelError: class extends Error {},
  // Just enough for TeamService (the worker pool test): a folder, settings, cancellation and an info message.
  workspace: { workspaceFolders: undefined, getConfiguration: () => ({ get: (k, d) => (k in vscodeSettings ? vscodeSettings[k] : d) }) },
  window: { showInformationMessage: () => Promise.resolve(undefined) },
  CancellationTokenSource: class {
    constructor() { this.cbs = []; this.token = { isCancellationRequested: false, onCancellationRequested: cb => { this.cbs.push(cb); return { dispose() {} }; } }; }
    cancel() { this.token.isCancellationRequested = true; this.cbs.forEach(cb => cb()); }
    dispose() {}
  }
};
var vscodeSettings = {};
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
    fs.mkdirSync(path.join(W, 'rep'), { recursive: true }); fs.writeFileSync(path.join(W, 'rep/out.md'), '# r');
    const fd = await runTool('finish', { status: 'done', summary: 's', deliverables: ['./rep/../rep/out.md', 'rep/missing.md', '../outside.md', '/etc/passwd', 'rep/out.md'] }, ctx);
    ok(fd.finished.deliverables.join() === 'rep/out.md', 'finish deliverables are normalized to workspace paths and deduplicated');
    ok(/missing\.md/.test(fd.text) && /outside\.md/.test(fd.text) && /passwd/.test(fd.text) && !fd.finished.deliverables.some(d => /outside|passwd|missing/.test(d)), 'a missing file and paths outside the workspace are dropped, and the result text says which');
    ok((await runTool('finish', { status: 'done', summary: 's' }, ctx)).finished.deliverables === undefined, 'deliverables are optional');
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

  console.log('task ledger');
  {
    const T = require(`${OUT}/tasks.js`);
    const { runChatTool } = require(`${OUT}/chatTools.js`);
    const { consoleModel, renderBody } = require(`${OUT}/console.js`);
    const prompts = [];
    const results = [];
    const run = async (agent, chainId, task, script, o = {}) => {
      const item = o.item ?? { id: Q.newId(), agent, task, from: o.from ?? 'user', chainId, hop: o.hop ?? 0, createdAt: new Date().toISOString() };
      if (!o.item) { Q.enqueue(W, item); }
      const model = { family: 'fake', id: 'fake-1', async sendRequest(messages) {
        const turn = messages.filter(m => m.role === 'assistant').length;
        if (turn === 0) { prompts.push(messages[0].content[0].value); }
        const last = messages[messages.length - 1];
        if (last.role === 'user' && last.content[0] instanceof ToolResultPart) { results.push(...last.content.map(r => r.content[0].value)); }
        return { stream: (async function* () { yield* script[turn].map(([n, i], k) => new ToolCallPart(`t-${turn}-${k}`, n, i)); })() };
      } };
      const r = await runItem(item, { ...deps(agent), model, maxHops: o.maxHops ?? 5 });
      Q.complete(W, item, r.status, r.summary, r.gateId);
      return { item, r, prompt: prompts[prompts.length - 1] };
    };
    const fin = (status, summary, next) => [['finish', { status, summary, ...(next ? { next } : {}) }]];
    const mine = (agent, chain) => Q.pending(W, agent).filter(i => i.chainId === chain);

    const c1 = 'task-c1';
    results.length = 0;
    let x = await run('sentinel', 'task-c0', 'A one-run job', [fin('nothing_to_do', 'nothing')]);
    ok(!T.getTask(W, 'task-c0') && !fs.existsSync(path.join(W, '.loop/tasks/task-c0.json')), 'a run that finishes done or nothing_to_do without a handoff leaves no task file');
    fs.mkdirSync(path.join(W, 'rep'), { recursive: true }); fs.writeFileSync(path.join(W, 'rep/dl.md'), '# d');
    await run('sentinel', 'dl-c', 'Report', [[['finish', { status: 'done', summary: 'ok', deliverables: ['rep/dl.md', 'nope.md'] }]]]);
    { const f = fs.readdirSync(path.join(W, '.loop/runs')).map(d => path.join(W, '.loop/runs', d, 'dl-c.jsonl')).find(fs.existsSync);
      const end = fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse).find(e => e.type === 'end');
      ok(end && end.deliverables && end.deliverables.join() === 'rep/dl.md', 'the end audit event records the deliverables'); }
    x = await run('sentinel', c1, 'Watch the backlog\nuntil it drops below 120', [fin('open', 'not yet'), fin('open', 'still above target', 'recheck after the next deploy')]);
    ok(results[0].startsWith('Not finished') && x.r.status === 'open' && x.r.steps === 2, 'finish open without next is an error result; the run continues and finishes on the second try');
    let t = T.getTask(W, c1);
    ok(t && t.state === 'open' && t.title === 'Watch the backlog' && t.holders.join() === 'sentinel', 'a run that finishes open creates the task, titled from the first line');
    ok(t.next.sentinel === 'recheck after the next deploy' && T.openTasksFor(W, 'sentinel').some(k => k.id === c1), 'finish open keeps it on the agent\'s list with its next step');
    ok(t.log.filter(e => e.event === 'start').length === 1 && t.log.at(-1).event === 'end' && t.log.at(-1).status === 'open', 'start and end are logged');

    x = await run('sentinel', 'task-c2', 'Another job', [fin('done', 'finished it')]);
    ok(/# Your open tasks[\s\S]*task-c1: Watch the backlog[\s\S]*recheck after the next deploy[\s\S]*# Work item/.test(x.prompt), 'the next run\'s prompt lists the open task with its next step, before the work item');
    ok(!/# Your open tasks[\s\S]*task-c2[\s\S]*# Work item/.test(x.prompt), 'and not the chain it is running');
    ok(!T.getTask(W, 'task-c2'), 'a one-run job that finishes done leaves no record');
    ok(!/# Your open tasks/.test(require(`${OUT}/runner.js`).buildPrompt(team.get('techlead'), { id: 'i', agent: 'techlead', task: 't', from: 'user', chainId: 'q', hop: 0, createdAt: '' }, { team, skills })), 'with no open tasks the section is left out');

    // handoff and the return wake
    const c3 = 'task-c3';
    x = await run('sentinel', c3, 'Investigate checkout latency', [[['handoff', { to: 'techlead', task: 'Analyse the latency traces', context: 'trace abc' }]], fin('open', 'handed to techlead', 'reply to ops once techlead has analysed it')]);
    t = T.getTask(W, c3);
    ok(t.holders.join() === 'sentinel,techlead' && t.log.some(e => e.event === 'handoff' && e.to === 'techlead' && e.text.includes('Analyse')), 'handoff adds the receiver to the holders and logs it');
    ok(mine('sentinel', c3).length === 0, 'nothing wakes sentinel while techlead has not finished');
    const tlItem = mine('techlead', c3)[0];
    x = await run('techlead', c3, '', [fin('done', 'p99 caused by pool size')], { item: tlItem });
    ok(/## Task history[\s\S]*sentinel handoff -> techlead[\s\S]*Analyse the latency traces/.test(x.prompt), 'the receiver\'s prompt carries the task history');
    t = T.getTask(W, c3);
    ok(t.holders.join() === 'sentinel' && t.state === 'open', 'techlead finished done: it leaves the holders, the task stays open for sentinel');
    const wk = mine('sentinel', c3);
    ok(wk.length === 1 && wk[0].from === 'task' && wk[0].hop === tlItem.hop + 1 && wk[0].chainId === c3, 'return wake: an item for sentinel from "task" on the same chain, hop + 1');
    ok(wk[0].task.includes(`Task ${c3} progressed: techlead finished: p99 caused by pool size.`) && wk[0].task.includes('Your next step was: reply to ops once techlead has analysed it'), 'the wake item names what progressed and the saved next step');
    x = await run('sentinel', c3, '', [fin('done', 'replied to ops')], { item: wk[0] });
    ok(/## Task history/.test(x.prompt) && T.getTask(W, c3).state === 'done' && mine('sentinel', c3).length === 0, 'the woken agent sees the history; finishing done by the last holder closes the task and wakes nobody');

    // no wake when hops are used up
    const c4 = 'task-c4';
    await run('sentinel', c4, 'Hop limited', [[['handoff', { to: 'techlead', task: 'go', context: 'c' }]], fin('open', 'waiting', 'next')], { maxHops: 1 });
    await run('techlead', c4, '', [fin('done', 'ok')], { item: mine('techlead', c4)[0], maxHops: 1 });
    t = T.getTask(W, c4);
    ok(mine('sentinel', c4).length === 0 && t.state === 'open' && t.holders.join() === 'sentinel' && t.log.some(e => /max hops/.test(e.text ?? '')), 'return wake is not enqueued past maxHops, and the task log says so');
    const day4 = new Date().toISOString().slice(0, 10);
    ok(fs.readFileSync(path.join(W, '.loop/runs', day4, `${c4}.jsonl`), 'utf8').includes('max hops'), 'and the audit trail does too');

    // a wake is not due while another holder still has live work
    const c5 = 'task-c5';
    await run('sentinel', c5, 'Two helpers', [[['handoff', { to: 'techlead', task: 'a', context: 'c' }]], fin('open', 'waiting', 'collect')]);
    T.taskOnHandoff(W, { id: 'x', agent: 'support', chainId: c5, hop: 0 }, 'support', 'b');
    Q.enqueue(W, { id: Q.newId(), agent: 'support', task: 'b', from: 'sentinel', chainId: c5, hop: 1, createdAt: new Date().toISOString() });
    await run('techlead', c5, '', [fin('done', 'a done')], { item: mine('techlead', c5)[0] });
    ok(mine('sentinel', c5).length === 0, 'no wake while another holder still has a queued item in the chain');
    Q.complete(W, mine('support', c5)[0], 'done', 'x');

    // update_task
    results.length = 0;
    await run('techlead', 'task-c6', 'Unrelated', [[['update_task', { id: c1, state: 'done', note: 'not mine' }]], fin('done', 'ok')]);
    ok(results[0].startsWith('REFUSED') && T.getTask(W, c1).state === 'open', 'update_task is refused for an agent that does not hold the task');
    results.length = 0;
    await run('sentinel', 'task-c7', 'Scheduled look', [[['update_task', { id: c1, state: 'open', note: 'recheck on Friday' }]], [['update_task', { id: c1, state: 'done', note: 'resolved' }]], [['update_task', { id: c1, state: 'done', note: 'again' }]], fin('done', 'ok')]);
    ok(results[0].startsWith('Task task-c1 stays open') && results[1].startsWith('You no longer hold') && results[2].startsWith('REFUSED'), 'update_task works for a holder (open with a note, then done), and not twice');
    ok(T.getTask(W, c1).state === 'done' && T.getTask(W, c1).holders.length === 0 && T.getTask(W, c1).log.some(e => e.event === 'update' && e.status === 'done'), 'done by the last holder closes the task');
    ok(T.updateTask(W, '../../etc/passwd', 'sentinel', 'done', 'x').startsWith('REFUSED'), 'a task id cannot point outside the ledger');

    // blocked keeps it; resume does not log a second start
    const c8 = 'task-c8';
    x = await run('techlead', c8, 'Needs an answer', [[['ask_human', { question: 'A or B?', context: 'c' }]], fin('blocked', 'cannot proceed without access')]);
    ok(x.r.status === 'waiting' && !T.getTask(W, c8), 'parked on a gate: the ledger is unchanged');
    const gate8 = Q.listGates(W).find(g => g.chainId === c8 && g.status === 'pending');
    G.answerQuestion(W, gate8.id, 'A');
    await run('techlead', c8, '', [[], fin('blocked', 'cannot proceed without access')], { item: Q.pending(W, 'techlead').find(i => i.chainId === c8) });
    t = T.getTask(W, c8);
    ok(t.log.filter(e => e.event === 'start').length === 1, 'resuming from a gate does not log a second start');
    ok(t.state === 'open' && t.holders.join() === 'techlead' && t.next.techlead === 'cannot proceed without access' && t.log.at(-1).status === 'blocked', 'blocked keeps the agent as holder and records the summary as its next step');

    // errors end in the ledger too
    const c9 = 'task-c9';
    const boom = { family: 'fake', id: 'f', async sendRequest() { throw new Error('model exploded'); } };
    const it9 = { id: Q.newId(), agent: 'sentinel', task: 'Doomed', from: 'user', chainId: c9, hop: 0, createdAt: new Date().toISOString() };
    Q.enqueue(W, it9);
    const r9 = await runItem(it9, { ...deps('sentinel'), model: boom });
    Q.complete(W, it9, r9.status, r9.summary);
    ok(r9.status === 'error' && T.getTask(W, c9).log.at(-1).status === 'error' && T.getTask(W, c9).holders.join() === 'sentinel', 'an error keeps the holder and is logged');
    const it9b = { id: Q.newId(), agent: 'sentinel', task: 'Doomed too', from: 'user', chainId: 'task-c9b', hop: 0, createdAt: new Date().toISOString() };
    Q.enqueue(W, it9b);
    const r9b = await runItem(it9b, { ...deps('sentinel'), model: { family: 'fake', id: 'f', async sendRequest() { throw new Error('rate limit exceeded'); } } });
    ok(r9b.status === 'error' && !T.getTask(W, 'task-c9b'), 'a rate-limited item stays queued, so the ledger does not record an end');
    fs.rmSync(path.join(W, '.loop/queue/sentinel', `${it9b.id}.json`), { force: true });

    // a corrupt ledger never breaks a run
    fs.mkdirSync(path.join(W, '.loop/tasks'), { recursive: true });
    fs.writeFileSync(path.join(W, '.loop/tasks/task-bad.json'), '{ not json');
    fs.writeFileSync(path.join(W, '.loop/tasks/zzz.json'), '[]');
    x = await run('sentinel', 'task-bad', 'Survive a corrupt file', [fin('open', 'fine', 'again later')]);
    ok(x.r.status === 'open' && T.getTask(W, 'task-bad').state === 'open', 'a corrupt task file is treated as absent, the run completes and the ledger is rewritten');
    ok(T.listTasks(W).length > 0 && T.openTasksFor(W, 'sentinel') !== undefined, 'listing skips unreadable files');

    // the human cancels a run for good: the agent stays a holder, with a next step
    const c12 = 'task-c12';
    const it12 = { id: Q.newId(), agent: 'sentinel', task: 'Cancelled by hand', from: 'user', chainId: c12, hop: 0, createdAt: new Date().toISOString() };
    T.taskOnEnd(W, it12, 'cancelled', 'x', undefined, 5);
    ok(!T.getTask(W, c12), 'a retried (cancelled) item changes nothing');
    T.taskOnEnd(W, it12, 'cancelled_by_human', undefined, undefined, 5);
    t = T.getTask(W, c12);
    ok(t.state === 'open' && t.holders.join() === 'sentinel' && t.next.sentinel === 'cancelled by the human' && t.log.at(-1).event === 'end' && t.log.at(-1).status === 'cancelled', 'cancelled by the human: still a holder, next step recorded, end logged as cancelled');

    // human close, console, @loop
    const c10 = 'task-c10';
    await run('sentinel', c10, '<img src=x onerror=alert(1)> evil title', [fin('open', 'later', 'do <b>it</b>')]);
    const cm = consoleModel(W, { running: false, tab: 'overview' });
    const html = renderBody(cm);
    ok(cm.tasks.some(k => k.id === c10) && html.includes('data-close-task="task-c10"') && !html.includes('<img src=x') && html.includes('&lt;img src=x'), 'the overview lists open tasks, escaped, with a Close action');
    const lt = JSON.parse((await runChatTool('list_tasks', { agent: 'sentinel' }, { root: W, state: () => ({ running: false }) })).text);
    ok(lt.some(k => k.id === c10 && k.next.sentinel.includes('do')) && !lt.some(k => k.id === c1), '@loop list_tasks shows open tasks of an agent');
    ok(T.closeTaskByHuman(W, c10) && !T.closeTaskByHuman(W, 'nope'), 'the human can close a task');
    t = T.getTask(W, c10);
    ok(t.state === 'dropped' && t.holders.length === 0 && !t.next && t.log.at(-1).event === 'human' && !T.openTasksFor(W, 'sentinel').some(k => k.id === c10), 'closed by the human: dropped, no holders, off every list');
    ok(!consoleModel(W, { running: false, tab: 'overview' }).tasks.some(k => k.id === c10), 'and off the console');
    ok(!/task-c10/.test((await run('sentinel', 'task-c11', 'later', [fin('done', 'ok')])).prompt), 'and out of the next prompt');
    for (const agent of ['sentinel', 'techlead', 'support']) { for (const i of Q.pending(W, agent)) { Q.complete(W, i, 'done', 'cleanup'); } }
  }

  console.log('goals and the worker pool');
  {
    const { goalKey, goalsDue, fireGoal, checkSilence, lastCheck } = require(`${OUT}/goals.js`);
    const { skillsFor, policyPathFor } = require(`${OUT}/team.js`);
    const { buildPrompt } = require(`${OUT}/runner.js`);
    const GW = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-goals-'));
    fs.mkdirSync(path.join(GW, '.github/agents'), { recursive: true });
    fs.cpSync(path.join(W, '.loop'), path.join(GW, '.loop'), { recursive: true, filter: src => !/[\\/](queue|runs|gates|checkpoints|tasks)([\\/]|$)/.test(src) });
    const skill = (name, scripts) => {
      const d = path.join(GW, '.github/skills', name, 'scripts'); fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(GW, '.github/skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}.\n`);
      for (const [f, c] of Object.entries(scripts)) { fs.writeFileSync(path.join(d, f), c); }
    };
    skill('probes', { 'yes.sh': 'echo found\nexit 0\n', 'none.sh': 'exit 1\n' });
    skill('alert-probe', { 'found.sh': 'echo disk almost full\nexit 0\n' });
    const agent = (name, loop) => fs.writeFileSync(path.join(GW, '.github/agents', `${name}.agent.md`), `---\nname: ${name}\ndescription: ${name} agent\nloop:\n${loop}---\nRole of ${name}.\n`);
    agent('legacy', '  skills: [probes]\n  schedule: "* * * * *"\n  wakeIf: bash .github/skills/probes/scripts/yes.sh\n  task: legacy task\n');
    agent('multi', [
      '  goals:',
      '    - id: alerts', '      text: Production issues are found and reported in time', '      schedule: "* * * * *"',
      '      wakeIf: bash .github/skills/alert-probe/scripts/found.sh', '      skills: [alert-probe]', '      policy: .loop/policies/support.json',
      '      urgent: true', '      maxSilence: 2h', '      maxRunsPerDay: 2',
      '    - id: release', '      text: Release runs normally', '      schedule: "* * * * *"', '      wakeIf: bash .github/skills/probes/scripts/none.sh', '      skills: [probes]', '      task: check the release', ''].join('\n'));
    agent('quiet', '  goals:\n    - id: watch\n      text: Something that never gets checked\n      schedule: "0 3 1 1 *"\n      wakeIf: bash .github/skills/probes/scripts/none.sh\n      skills: [probes]\n      maxSilence: 30m\n');
    const gTeam = loadAgents(GW), gSkills = loadSkills(GW);
    const legacy = gTeam.get('legacy'), multi = gTeam.get('multi'), quiet = gTeam.get('quiet');
    ok(validateTeam(gTeam, gSkills, loadAllAgents(GW)).length === 0, 'a team with goals validates clean: ' + JSON.stringify(validateTeam(gTeam, gSkills, loadAllAgents(GW))));
    ok(legacy.goals.length === 1 && legacy.goals[0].id === 'default' && legacy.goals[0].task === 'legacy task' && goalKey('legacy', legacy.goals[0]) === 'legacy' && goalKey('multi', multi.goals[0]) === 'multi#alerts', 'a legacy schedule is one goal "default", keyed by the agent name; other goals by agent#goal');
    ok(multi.goals[0].urgent === true && multi.goals[0].maxSilenceMs === 2 * 3600e3 && multi.goals[1].task === 'check the release' && multi.goals[0].task === multi.goals[0].text, 'goal fields are read; the task defaults to the text');
    const bad = new Map([['x', { ...multi, name: 'x', goals: [{ ...multi.goals[0], id: 'Bad Id' }, { ...multi.goals[1] }, { ...multi.goals[1] }, { ...multi.goals[1], id: 'ok', maxSilenceMs: NaN }] }]]);
    const badErrors = validateTeam(bad, gSkills).join('\n');
    ok(/must match/.test(badErrors) && /used twice/.test(badErrors) && /maxSilence must look like/.test(badErrors), 'bad goal ids, duplicates and maxSilence are reported');

    const events = [];
    const fired = new Map();
    const io = { lastFired: fired, save() {}, policy: () => loadPolicy(GW, '.loop/policy.json'), skills: gSkills, secrets: async () => ({}), alert: async ev => { events.push({ ev, queued: Q.pending(GW, 'multi').length }); }, wakeErrors: new Map(), lastAlert: new Map(), log() {} };
    const now = new Date();
    const wakes = () => { const dir = path.join(GW, '.loop/runs', now.toISOString().slice(0, 10)); return fs.readdirSync(dir).filter(n => n.startsWith('wake-')).flatMap(n => fs.readFileSync(path.join(dir, n), 'utf8').trim().split('\n').map(JSON.parse)); };

    const due = goalsDue(gTeam.values(), new Map(), now, false);
    ok(due.filter(d => d.agent.name === 'multi').map(d => d.goal.id).join() === 'alerts,release' && !due.some(d => d.agent.name === 'quiet'), 'each goal is due on its own schedule');
    ok(goalsDue(gTeam.values(), new Map([['legacy', require(`${OUT}/cron.js`).minuteKey(now)]]), now, false).every(d => d.agent.name !== 'legacy'), 'a goal already handled this minute is not due again (state key unchanged for legacy)');

    await fireGoal(GW, legacy, legacy.goals[0], now, io);
    const li = Q.pending(GW, 'legacy')[0];
    ok(fired.get('legacy') && li.from === 'schedule' && li.goal === undefined && !li.urgent && events.length === 0, 'legacy agent: one default goal, state under the agent name, no goal on the item, no alert');
    ok(wakes().some(w => w.agent === 'legacy' && w.goal === 'default' && w.wake === true), 'the wake event names the goal');

    // two goals, independent state and caps; the urgent one tells the human before its item exists
    await fireGoal(GW, multi, multi.goals[0], now, io);
    await fireGoal(GW, multi, multi.goals[1], now, io);
    ok(fired.has('multi#alerts') && fired.has('multi#release'), 'each goal keeps its own schedule state');
    ok(events.length === 1 && events[0].ev.kind === 'alert' && events[0].ev.title === 'multi/alerts: probe found something' && /disk almost full/.test(events[0].ev.detail) && events[0].queued === 0, 'an urgent probe alerts (kind alert) BEFORE its item is queued');
    const ai = Q.pending(GW, 'multi')[0];
    ok(Q.pending(GW, 'multi').length === 1 && ai.goal === 'alerts' && ai.urgent === true && ai.from === 'schedule', 'the item carries its goal and urgent');
    ok(wakes().some(w => w.agent === 'multi' && w.goal === 'release' && w.wake === false), 'the other goal had its own check (nothing to do) and queued nothing');
    await fireGoal(GW, multi, multi.goals[0], now, io);
    ok(Q.pending(GW, 'multi').length === 1, 'a goal with a scheduled item still open is not woken twice');
    Q.complete(GW, ai, 'done', 'x');
    await fireGoal(GW, multi, multi.goals[0], now, io);
    Q.complete(GW, Q.pending(GW, 'multi')[0], 'done', 'x');
    const before = events.length;
    await fireGoal(GW, multi, multi.goals[0], now, io);
    ok(Q.pending(GW, 'multi').length === 0 && events.length === before + 1 && wakes().some(w => w.agent === 'multi' && w.goal === 'alerts' && w.capped === 2), 'the daily cap is per goal and limits runs, not probes: alerts is capped after 2 and queues nothing, but an urgent probe still alerts');
    await fireGoal(GW, multi, multi.goals[1], now, io);
    ok(wakes().filter(w => w.goal === 'release' && w.wake === false && !w.capped).length >= 2, 'while release (no cap) keeps checking');

    // an open (parked) item must not silence an urgent goal, nor make a quiet goal look silent
    const openItem = { id: Q.newId(), agent: 'multi', task: 'parked', from: 'schedule', goal: 'alerts', urgent: true, chainId: 'parked-chain', hop: 0, createdAt: new Date().toISOString() };
    Q.enqueue(GW, openItem); Q.complete(GW, openItem, 'waiting', undefined);
    io.lastAlert.clear();
    const n0 = events.length;
    await fireGoal(GW, multi, multi.goals[0], now, io);
    ok(events.length === n0 + 1 && events.at(-1).ev.kind === 'alert' && Q.pending(GW, 'multi').length === 0, 'urgent goal with a parked item: the probe still runs and alerts, and no second item is queued');
    await fireGoal(GW, multi, multi.goals[0], now, io);
    ok(events.length === n0 + 1, 'the same finding is not announced again while the item is open');
    const alertsProbe = path.join(GW, '.github/skills/alert-probe/scripts/found.sh');
    fs.writeFileSync(alertsProbe, 'echo a different problem\nexit 0\n');
    await fireGoal(GW, multi, multi.goals[0], now, io);
    ok(events.length === n0 + 2 && /different problem/.test(events.at(-1).ev.detail) && Q.pending(GW, 'multi').length === 0, 'a changed finding is announced');
    fs.writeFileSync(alertsProbe, 'echo disk almost full\nexit 0\n');
    Q.complete(GW, openItem, 'done', 'x');
    const relItem = { id: Q.newId(), agent: 'multi', task: 'parked', from: 'schedule', goal: 'release', chainId: 'parked-release', hop: 0, createdAt: new Date().toISOString() };
    Q.enqueue(GW, relItem); Q.complete(GW, relItem, 'waiting', undefined);
    const rel = multi.goals[1];
    await fireGoal(GW, multi, rel, now, io);
    ok(wakes().some(w => w.goal === 'release' && w.open === true && w.wake === false) && Q.pending(GW, 'multi').length === 0, 'a non-urgent goal with an open item skips its check but records it as open');
    const silentRel = [];
    await checkSilence(GW, [{ ...multi, goals: [{ ...rel, maxSilenceMs: 3600e3 }] }], new Date(Date.now() - 5 * 3600e3), new Date(Date.now() + 30 * 60e3), new Set(), async ev => { silentRel.push(ev); });
    ok(silentRel.length === 0, 'an open item counts as a check: no goal_silent while the goal is being handled');
    Q.complete(GW, relItem, 'done', 'x');

    // skills and policy of a goal apply only to its runs
    ok(skillsFor(multi, 'alerts').join() === 'alert-probe' && skillsFor(multi, 'release').join() === 'probes' && skillsFor(multi).length === 0 && skillsFor(legacy, 'default').join() === 'probes', 'a goal adds its skills to the agent\'s, for its own runs only');
    ok(policyPathFor(multi, 'alerts', '.loop/policy.json') === '.loop/policies/support.json' && policyPathFor(multi, 'release', '.loop/policy.json') === '.loop/policy.json' && policyPathFor(multi, undefined, 'd') === 'd', 'a goal\'s policy overrides the default for its own runs only');
    const mk = goal => ({ id: 'i', agent: 'multi', task: 't', from: 'schedule', chainId: 'c', hop: 0, createdAt: '', ...(goal ? { goal } : {}) });
    const pAlerts = buildPrompt(multi, mk('alerts'), { team: gTeam, skills: gSkills }), pRelease = buildPrompt(multi, mk('release'), { team: gTeam, skills: gSkills });
    ok(/## Skill: alert-probe/.test(pAlerts) && !/## Skill: alert-probe/.test(pRelease) && /## Skill: probes/.test(pRelease) && !/## Skill: probes/.test(pAlerts), 'only the triggering goal\'s skills are expanded in the prompt');
    ok(/# Your responsibilities\n- alerts: Production issues[^\n]*\n- release: Release runs normally/.test(pAlerts) && pAlerts.indexOf('# Your role') < pAlerts.indexOf('# Your responsibilities') && pAlerts.indexOf('# Your responsibilities') < pAlerts.indexOf('# Work item'), 'the prompt lists every responsibility after the role and before the work item');
    ok(/hop: 0 \| goal: alerts/.test(pAlerts) && !/\| goal:/.test(pRelease.replace('goal: release', '')) , 'the work item header says which goal triggered it');
    ok(!/# Your responsibilities/.test(buildPrompt(legacy, { ...mk(), agent: 'legacy' }, { team: gTeam, skills: gSkills })), 'a legacy agent\'s prompt is unchanged (no responsibilities section)');
    const stat = (a, b) => a.slice(0, a.indexOf('# Work item')) === b.slice(0, b.indexOf('# Work item'));
    ok(stat(buildPrompt(multi, mk('release'), { team: gTeam, skills: gSkills }), buildPrompt(multi, { ...mk('release'), chainId: 'other' }, { team: gTeam, skills: gSkills })), 'the part before the work item does not vary per run (prompt caching, invariant 8)');

    // goal_silent: once, and again only after a check ran
    const alerts = [];
    const notified = new Set();
    const t0 = new Date(Date.now() + 3 * 3600e3);
    ok(lastCheck(GW, 'multi', 'alerts') instanceof Date && lastCheck(GW, 'quiet', 'watch') === undefined, 'the latest wake check that ran is read from the wake audit');
    await checkSilence(GW, gTeam.values(), new Date(), t0, notified, async ev => { alerts.push(ev); });
    ok(alerts.filter(a => a.agent === 'multi').length === 1 && alerts[0].kind === 'goal_silent' && /multi\/alerts/.test(alerts.find(a => a.agent === 'multi').title), 'a goal with no wake check for longer than maxSilence is announced (kind goal_silent)');
    ok(alerts.filter(a => a.agent === 'quiet').length === 1, 'a goal that never had a check is measured from the team start');
    await checkSilence(GW, gTeam.values(), new Date(), t0, notified, async ev => { alerts.push(ev); });
    ok(alerts.filter(a => a.agent === 'multi').length === 1, 'and only once');
    await checkSilence(GW, gTeam.values(), new Date(), new Date(Date.now() + 3600e3), notified, async ev => { alerts.push(ev); });
    await checkSilence(GW, gTeam.values(), new Date(), t0, notified, async ev => { alerts.push(ev); });
    ok(alerts.filter(a => a.agent === 'multi').length === 2, 'it resets when a check has run again, so a later silence is announced again');
    const q2 = [];
    await checkSilence(GW, [quiet], new Date(Date.now() - 10 * 60e3), new Date(), new Set(), async ev => { q2.push(ev); });
    await checkSilence(GW, [quiet], new Date(Date.now() - 40 * 60e3), new Date(), new Set(), async ev => { q2.push(ev); });
    ok(q2.length === 1, 'with no check at all, silence counts from the team start (10 minutes in: quiet, 40 minutes: announced)');

    // handoffs keep urgency; tasks remember their goal
    const uItem = { id: Q.newId(), agent: 'sentinel', task: 'urgent chain', from: 'schedule', goal: 'alerts', urgent: true, chainId: 'goal-chain', hop: 0, createdAt: new Date().toISOString() };
    Q.enqueue(W, uItem);
    const ur = await runItem(uItem, { ...deps('sentinel'), model: { family: 'fake', id: 'f', async sendRequest(m) { const t = m.filter(x => x.role === 'assistant').length; return { stream: (async function* () { yield t === 0 ? new ToolCallPart('u0', 'handoff', { to: 'techlead', task: 'go', context: 'c' }) : new ToolCallPart('u1', 'finish', { status: 'open', summary: 's', next: 'wait' }); })() }; } } });
    Q.complete(W, uItem, ur.status, ur.summary);
    const hand = Q.pending(W, 'techlead').find(i => i.chainId === 'goal-chain');
    ok(hand && hand.urgent === true && !hand.goal, 'a handoff from an urgent run is urgent too');
    ok(require(`${OUT}/tasks.js`).getTask(W, 'goal-chain').goal === 'alerts', 'a task created from a goal run records the goal');
    Q.complete(W, hand, 'done', 'cleanup');

    // the pool
    const { pickItem } = Q;
    const it = (chainId, createdAt, urgent) => ({ id: chainId + createdAt, agent: 'a', task: 't', from: 'user', chainId, hop: 0, createdAt, ...(urgent ? { urgent: true } : {}) });
    const A = it('A', '1'), B = it('B', '2'), C = it('C', '3'), U = it('U', '4', true), A2 = { ...it('A', '5'), id: 'A-2' };
    ok(pickItem([A, B], [], 1) === A && pickItem([B, A], [], 1) === A && pickItem([B], [A], 1) === undefined, 'one worker: plain FIFO, nothing starts while one runs (as before)');
    ok(pickItem([A2, B], [A], 3) === B, 'two items of different chains run together; the same chain never does');
    ok(pickItem([C], [A, B], 3) === undefined && pickItem([C], [A], 3) === C, 'non-urgent items cannot take the last slot');
    ok(pickItem([C, U], [A, B], 3) === U && pickItem([C, U], [], 3) === U, 'an urgent item takes the reserved slot, and goes before older items');
    ok(pickItem([B], [A], 2) === undefined && pickItem([U], [A], 2) === U, 'with two workers, one normal run and one urgent run at a time');
    ok(pickItem([U], [A, it('V', '9', true)], 2) === undefined, 'no free slot, nothing starts');
    ok(pickItem([U, it('U', '0', true)], [], 2) !== undefined && pickItem([A2, U], [A], 1) === undefined, 'the same chain, or a full pool, blocks even urgent items');
    fs.rmSync(GW, { recursive: true, force: true });
  }

  console.log('worker pool: TeamService with overlapping runs');
  {
    const { TeamService } = require(`${OUT}/extension.js`);
    const PW = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-pool-'));
    fs.mkdirSync(path.join(PW, '.github/agents'), { recursive: true });
    fs.mkdirSync(path.join(PW, '.loop'), { recursive: true });
    fs.copyFileSync(path.join(W, '.loop/policy.json'), path.join(PW, '.loop/policy.json'));
    for (const n of ['p1', 'p2', 'p3']) { fs.writeFileSync(path.join(PW, '.github/agents', `${n}.agent.md`), `---\nname: ${n}\ndescription: ${n}\nloop:\n  maxSteps: 6\n---\nRole of ${n}.\n`); }
    vscodeMock.workspace.workspaceFolders = [{ uri: { fsPath: PW } }];
    const mem = { get: (_k, d) => d, update: async () => {}, };
    const svc = new TeamService({ workspaceState: mem, globalState: mem, secrets: { get: async () => undefined }, languageModelAccessInformation: {} }, { appendLine() {}, show() {} }, () => {}, () => {});
    svc.reload();
    svc.running = true;
    svc.ratePauseMs = () => 400;

    // The fake model: each item's first request waits on its own gate; later requests answer at once.
    const gates = {}, started = [], sawText = {}, throwOnce = new Set();
    const gate = id => (gates[id] ??= (() => { let open; const p = new Promise(r => { open = r; }); return { p, open }; })());
    const model = {
      family: 'fake', id: 'fake-1',
      async sendRequest(messages, opts, tok) {
        const id = /work item (\S+)/.exec(opts.justification)[1];
        const turn = messages.filter(m => m.role === 'assistant').length;
        (sawText[id] ??= []).push(JSON.stringify(messages));
        if (turn === 0) {
          started.push(id);
          if (throwOnce.delete(id)) { throw new Error('rate limit exceeded'); }
          await new Promise((res, rej) => { gate(id).p.then(res); tok.onCancellationRequested(() => rej(new Error('cancelled'))); if (tok.isCancellationRequested) { rej(new Error('cancelled')); } });
          const talk = gate(id).talk;
          if (talk) { return { stream: (async function* () { yield new ToolCallPart(`${id}-t`, 'list_dir', { path: '.' }); })() }; }
        }
        return { stream: (async function* () { yield new ToolCallPart(`${id}-f`, 'finish', { status: 'done', summary: 'ok' }); })() };
      }
    };
    for (const n of ['p1', 'p2', 'p3']) { svc.models.set(n, model); }
    const until = async (cond, what, ms = 4000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) { throw new Error('timed out waiting for ' + what); } await new Promise(r => setTimeout(r, 10)); } };
    const queue = (id, agent, chainId, o = {}) => Q.enqueue(PW, { id, agent, task: 'work', from: 'user', chainId, hop: 0, createdAt: new Date(Date.now() + o.age).toISOString(), ...(o.urgent ? { urgent: true } : {}) });
    const settle = async () => { await until(() => { for (const id of Object.keys(gates)) { gate(id).open(); } return svc.live.size === 0 && !Q.nextItem(PW, ['p1', 'p2', 'p3']); }, 'the pool to drain'); };
    const quiet = () => new Promise(r => setTimeout(r, 120));
    const doneStatus = id => JSON.parse(fs.readFileSync(path.join(PW, '.loop/queue/_done', `${id}.json`), 'utf8')).status;

    vscodeSettings.workers = 3;
    queue('i1', 'p1', 'c1', { age: 0 }); queue('i2', 'p2', 'c2', { age: 1 });
    void svc.tick();
    await until(() => svc.live.size === 2, 'two runs together');
    ok(svc.live.size === 2 && svc.activeAgents.sort().join() === 'p1,p2', 'workers=3: two items of different chains run at the same time');
    await settle();
    ok(doneStatus('i1') === 'done' && doneStatus('i2') === 'done', 'and both finish');

    queue('i3', 'p1', 'c3', { age: 0 }); queue('i4', 'p2', 'c3', { age: 1 });
    void svc.tick();
    await until(() => svc.live.size === 1, 'the first of one chain');
    await quiet();
    ok(svc.live.size === 1 && !started.includes('i4') && [...svc.live.keys()].join() === 'i3', 'the same chain never runs two items at once');
    gate('i3').open();
    await until(() => started.includes('i4'), 'the second of that chain');
    await settle();

    vscodeSettings.workers = 2;
    queue('n1', 'p1', 'c5', { age: 0 }); queue('n2', 'p2', 'c6', { age: 1 });
    void svc.tick();
    await until(() => svc.live.size === 1, 'one normal run');
    await quiet();
    ok(svc.live.size === 1 && !started.includes('n2'), 'workers=2: a second normal item waits (one slot is kept for urgent)');
    queue('u1', 'p3', 'c7', { age: 2, urgent: true });
    void svc.tick();
    await until(() => svc.live.size === 2, 'normal and urgent together');
    ok(svc.live.has('n1') && svc.live.has('u1') && !started.includes('n2'), 'an urgent item runs next to the normal one');
    await settle();
    ok(started.includes('n2'), 'and the waiting normal item runs once a slot frees');

    // a rate limit stops new starts for the whole pool, not for runs already going
    vscodeSettings.workers = 4;
    queue('x1', 'p1', 'c8', { age: 0 });
    void svc.tick();
    await until(() => svc.live.has('x1'), 'x1 running');
    throwOnce.add('r1');
    queue('r1', 'p2', 'c9', { age: 1 });
    void svc.tick();
    await until(() => svc.paused, 'the pause');
    queue('r2', 'p3', 'c10', { age: 2 });
    void svc.tick();
    await quiet();
    ok(svc.paused && !started.includes('r2') && svc.live.has('x1'), 'a rate limit pauses the pool: nothing new starts, the run already going continues');
    await until(() => !svc.paused && started.includes('r2'), 'the pause to end and r2 to start');
    ok(started.filter(i => i === 'r1').length === 2, 'the rate-limited item stays queued and is retried after the pause');
    await settle();
    ok(doneStatus('r1') === 'done' && doneStatus('r2') === 'done' && doneStatus('x1') === 'done', 'everything finishes');

    // Cancel this run stops one run only, for good
    queue('k1', 'p1', 'c11', { age: 0 }); queue('k2', 'p2', 'c12', { age: 1 });
    void svc.tick();
    await until(() => svc.live.size === 2, 'two runs to cancel between');
    ok(svc.cancelRun('p1') && !svc.cancelRun('p3'), 'cancelRun finds the agent\'s run, and says no for an idle agent');
    await until(() => !svc.live.has('k1'), 'k1 to end');
    ok(svc.live.has('k2') && doneStatus('k1') === 'cancelled' && Q.pending(PW, 'p1').length === 0, 'the cancelled run is closed as cancelled (not retried) and the other run keeps going');
    await settle();
    ok(doneStatus('k2') === 'done', 'the other run finishes normally');

    // a message from the human goes to the earliest-started run of that agent only
    const T2 = require(`${OUT}/thread.js`);
    gate('m1').talk = true; gate('m2').talk = true;
    queue('m1', 'p1', 'c13', { age: 0 });
    void svc.tick();
    await until(() => svc.live.has('m1'), 'm1 running');
    queue('m2', 'p1', 'c14', { age: 1 });
    void svc.tick();
    await until(() => svc.live.has('m2'), 'm2 running');
    T2.postHumanMessage(PW, 'p1', 'please also check the cache');
    gate('m1').open();
    await until(() => !svc.live.has('m1'), 'm1 to end');
    gate('m2').open();
    await until(() => svc.live.size === 0, 'm2 to end');
    ok(sawText.m1.some(t => t.includes('please also check the cache')) && !sawText.m2.some(t => t.includes('please also check the cache')), 'two runs of one agent: the human\'s message reaches the earliest-started run only');
    ok(T2.pendingMessages(PW, 'p1').length === 0, 'and it is marked delivered, not left for the other run');

    svc.running = false;
    fs.rmSync(PW, { recursive: true, force: true });
    vscodeMock.workspace.workspaceFolders = undefined;
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

  console.log('recent runs: newest chains from .loop/runs');
  {
    const { recentRuns } = require(`${OUT}/runs.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-runs-'));
    const day = path.join(R, '.loop', 'runs', '2026-10-11');
    fs.mkdirSync(day, { recursive: true });
    const line = o => JSON.stringify(o);
    const doneFile = path.join(day, 'chain-a.jsonl');
    const parkFile = path.join(day, 'chain-b.jsonl');
    const wakeFile = path.join(day, 'wake-2026-10-11.jsonl');
    fs.writeFileSync(doneFile, [
      line({ ts: '2026-10-11T09:00:00Z', chainId: 'chain-a', agent: 'techlead', type: 'start' }),
      line({ ts: '2026-10-11T09:00:05Z', chainId: 'chain-a', agent: 'techlead', type: 'end', status: 'done', summary: 'all good' })
    ].join('\n'));
    fs.writeFileSync(parkFile, [
      line({ ts: '2026-10-11T10:00:00Z', chainId: 'chain-b', agent: 'smoke', type: 'start' }),
      line({ ts: '2026-10-11T10:00:09Z', chainId: 'chain-b', agent: 'smoke', type: 'park', gateId: 'g1' })
    ].join('\n'));
    fs.writeFileSync(wakeFile, line({ ts: '2026-10-11T10:00:00Z', chainId: 'wake-2026-10-11', type: 'wake', agent: 'smoke', wake: false }));
    const past = new Date(Date.now() - 120_000);
    fs.utimesSync(doneFile, past, past);
    const runs = recentRuns(R);
    ok(runs.length === 2 && !runs.some(r => r.chainId.startsWith('wake-')), 'wake checks are not listed as runs');
    ok(runs[0].chainId === 'chain-b' && runs[0].status === 'waiting' && runs[0].agent === 'smoke', 'newest chain first, parked shows as waiting');
    ok(runs[1].status === 'done' && runs[1].summary === 'all good', 'a finished chain shows its end status and summary');
    ok(recentRuns(os.tmpdir() + '/no-such-loop-dir-xyz').length === 0, 'no runs directory gives an empty list');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('console: next wake, run outputs, agent rows');
  {
    const { nextMatch, cronMatches } = require(`${OUT}/cron.js`);
    const { outputsFrom, recentRuns } = require(`${OUT}/runs.js`);
    const { agentRows } = require(`${OUT}/status.js`);
    const from = new Date(2026, 9, 10, 17, 30);
    const nm = nextMatch('0 9 * * 1-5', from);
    ok(nm && cronMatches('0 9 * * 1-5', nm) && nm.getTime() > from.getTime(), 'next weekday 09:00 is found after the given time');
    let skipped = false;
    for (let t = from.getTime() + 60_000; nm && t < nm.getTime(); t += 60_000) { if (cronMatches('0 9 * * 1-5', new Date(t))) skipped = true; }
    ok(nm && !skipped, 'no earlier matching minute is skipped');
    ok(nextMatch('0 0 31 2 *', from, 2) === undefined, 'a schedule that never matches in the window gives no next run');
    ok(JSON.stringify(outputsFrom(['Wrote a/b.md.', 'REFUSED by policy (x).', 'Edited c.md.', 'Wrote a/b.md.', 'edit_file failed: oldText matched 0 times (need exactly 1).'])) === '["a/b.md","c.md"]', 'only successful writes count, each file once');

    const writer = [
      [['write_file', { path: '.loop/outbox/console-check/report.md', content: 'hello' }]],
      [['finish', { status: 'done', summary: 'wrote it' }]]
    ];
    let turn = 0;
    const writeModel = {
      family: 'fake', id: 'writer',
      async sendRequest() {
        const t = writer[turn++];
        return { stream: (async function* () { yield* t.map(([n, i], k) => new ToolCallPart(`cw-${turn}-${k}`, n, i)); })() };
      }
    };
    const wItem = { id: 'console-writer', agent: 'techlead', task: 't', from: 'user', chainId: 'console-writer-chain', hop: 0, createdAt: new Date().toISOString() };
    const wRes = await runItem(wItem, { root: W, team, skills, model: writeModel, secrets: {}, policy: loadPolicy(W, '.loop/policy.json'), maxSteps: 5, maxHops: 5, out, token });
    ok(wRes.status === 'done', 'writer run finishes');
    const wRun = recentRuns(W).find(r => r.chainId === 'console-writer-chain');
    ok(wRun && JSON.stringify(wRun.outputs) === JSON.stringify(['.loop/outbox/console-check/report.md']), 'the end event records the file the run wrote');
    ok(wRun && wRun.step === 2, 'the run reports the highest step it reached');

    const rows = agentRows(W, 'techlead');
    const tl = rows.find(r => r.name === 'techlead');
    ok(tl && tl.state === 'running', 'the active agent is shown as running');
    ok(rows.every(r => r.name !== undefined && typeof r.file === 'string'), 'every team row has a name and an agent file');
  }

  console.log('outputs include files that commands leave in the outbox');
  {
    fs.mkdirSync(path.join(W, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(W, 'scripts', 'w.sh'), 'mkdir -p .loop/outbox/cmd && echo hi > .loop/outbox/cmd/made.md\n');
    const pol = { ...loadPolicy(W, '.loop/policy.json') }; pol.allowCommands = [...pol.allowCommands, '^bash scripts/w\\.sh$'];
    let t = 0;
    const script = [[['run_command', { command: 'bash scripts/w.sh' }]], [['finish', { status: 'done', summary: 'ran' }]]];
    const m = { family: 'fake', id: 'o', async sendRequest() { const c = script[t++]; return { stream: (async function* () { yield* c.map(([n, i], k) => new ToolCallPart(`ob-${t}-${k}`, n, i)); })() }; } };
    const r = await runItem({ id: 'obox1', agent: 'techlead', task: 't', from: 'user', chainId: 'obox-chain', hop: 0, createdAt: new Date().toISOString() },
      { root: W, team, skills, model: m, secrets: {}, policy: pol, maxSteps: 5, maxHops: 5, out, token });
    ok(r.status === 'done', 'the run finishes');
    const run = require(`${OUT}/runs.js`).recentRuns(W).find(x => x.chainId === 'obox-chain');
    ok(run && JSON.stringify(run.outputs) === JSON.stringify(['.loop/outbox/cmd/made.md']), 'a file a script wrote into the outbox is listed as the run\'s output');
  }

  console.log('console page: model and rendering');
  {
    const { consoleModel, stepsOf, renderBody, renderPage } = require(`${OUT}/console.js`);
    const wRun = require(`${OUT}/runs.js`).recentRuns(W).find(r => r.chainId === 'console-writer-chain');
    const steps = stepsOf(wRun.file);
    ok(steps.some(s => s.kind === 'tool' && s.title.startsWith('write_file') && s.title.includes('report.md') && s.ok), 'a run shows its tool steps with what they touched');
    ok(steps[steps.length - 1].kind === 'end', 'a run ends with its outcome');
    const m = consoleModel(W, { running: true, active: 'techlead', tab: 'overview' });
    ok(m.running && m.active === 'techlead' && m.runs.some(r => r.chainId === 'console-writer-chain' && r.steps.length > 0), 'the model carries state and run steps');
    const evil = { ...m, pending: [{ id: 'g<1>', kind: 'approval', agent: 'a', itemId: 'i', chainId: 'c', title: '<img src=x onerror=alert(1)>', body: '</div><script>x</script>', command: 'rm -rf "<x>"', files: ['a"b.md'], resume: true, status: 'pending', createdAt: new Date().toISOString(), previews: [{ path: 'a"b.md', text: '<b>patch</b>', sha256: 'h"1', truncated: false }] }] };
    ok(renderBody(evil).includes('&lt;b&gt;patch&lt;/b&gt;') && renderBody(evil).includes('data-hash="h&quot;1"'), 'draft contents are shown escaped, with the hash the approval is bound to');
    const html = renderBody(evil);
    ok(!html.includes('<img') && !html.includes('<script>x') && html.includes('&lt;img') && html.includes('Approve and run') && html.includes('rm -rf &quot;&lt;x&gt;&quot;'), 'gate text is escaped and the exact command is shown');
    ok(renderBody({ ...m, pending: [], agents: [], runs: [] }).includes('Nothing is waiting for you'), 'empty states explain themselves');
    const page = renderPage(m, 'abc123', 'vscode-webview://x');
    ok(page.includes("script-src 'nonce-abc123'") && page.includes('<script nonce="abc123">') && !/<script(?! nonce)/.test(page), 'only the nonce script may run');
    ok(stepsOf(os.tmpdir() + '/no-such-run.jsonl').length === 0, 'a missing log gives no steps');
  }

  console.log('guardrails: stalled, wall-clock, daily cap');
  {
    const scripted = (turns, delayMs = 0) => { let t = 0; return {
      family: 'fake', id: 'g',
      async sendRequest() {
        if (delayMs) await new Promise(r => setTimeout(r, delayMs));
        const calls = turns[Math.min(t++, turns.length - 1)];
        return { stream: (async function* () { yield* calls.map(([n, i], k) => new ToolCallPart(`gr-${t}-${k}`, n, i)); })() };
      } }; };
    const gItem = id => ({ id, agent: 'techlead', task: 't', from: 'user', chainId: `${id}-chain`, hop: 0, createdAt: new Date().toISOString() });
    const gDeps = (model, extra = {}) => ({ root: W, team, skills, model, secrets: {}, policy: loadPolicy(W, '.loop/policy.json'), maxSteps: 20, maxHops: 5, out, token, ...extra });
    const loop = await runItem(gItem('stall1'), gDeps(scripted([[['list_dir', { path: '.' }]]])));
    ok(loop.status === 'stalled' && loop.steps === 3 && loop.summary.includes('3 times'), 'the same call with the same result 3 times in a row ends the run as stalled');
    const varied = await runItem(gItem('stall2'), gDeps(scripted([[['list_dir', { path: '.' }]], [['list_dir', { path: '.github' }]], [['list_dir', { path: '.' }]], [['finish', { status: 'done', summary: 'ok' }]]])));
    ok(varied.status === 'done', 'different calls are not a stall');
    const slow = await runItem(gItem('slow1'), gDeps(scripted([[['list_dir', { path: '.' }]], [['list_dir', { path: '.github' }]], [['list_dir', { path: '.loop' }]]], 30), { maxMs: 40 }));
    ok(slow.status === 'stalled' && slow.summary.includes('wall-clock') && slow.steps < 3, 'a run past its wall-clock cap ends as stalled');

    const today = new Date();
    const capBase = Q.scheduledToday(W, 'sentinel', today);
    for (let i = 0; i < 2; i++) { Q.enqueue(W, { id: `cap-${i}`, agent: 'sentinel', task: 't', from: 'schedule', chainId: `cap-c${i}`, hop: 0, createdAt: today.toISOString() }); }
    Q.enqueue(W, { id: 'cap-old', agent: 'sentinel', task: 't', from: 'schedule', chainId: 'cap-co', hop: 0, createdAt: new Date(today.getTime() - 3 * 86400000).toISOString() });
    Q.enqueue(W, { id: 'cap-user', agent: 'sentinel', task: 't', from: 'user', chainId: 'cap-cu', hop: 0, createdAt: today.toISOString() });
    ok(Q.scheduledToday(W, 'sentinel', today) === capBase + 2, 'only today\'s scheduled items count toward the daily cap');
    for (const f of ['cap-0', 'cap-1', 'cap-old', 'cap-user']) { fs.rmSync(path.join(W, '.loop', 'queue', 'sentinel', `${f}.json`), { force: true }); }
    const capAgent = { ...team.get('sentinel'), maxRunsPerDay: 0 };
    ok(validateTeam(new Map([['sentinel', capAgent]]), skills, all).some(e => e.includes('maxRunsPerDay')), 'a daily cap below 1 is a config error');
    ok(validateTeam(new Map([['sentinel', { ...capAgent, maxRunsPerDay: 3 }]]), skills, all).every(e => !e.includes('maxRunsPerDay')), 'a whole-number daily cap is accepted');
  }

  console.log('approval is bound to what the reviewer saw');
  {
    const policy = loadPolicy(W, '.loop/policy.json');
    fs.mkdirSync(path.join(W, '.loop', 'outbox'), { recursive: true });
    const draft = '.loop/outbox/patch-draft.md';
    fs.writeFileSync(path.join(W, draft), 'v1');
    const mkGate = id => Q.saveGate(W, { id, kind: 'approval', agent: 'techlead', itemId: 'x', chainId: 'x', title: 't', body: 'b', command: 'echo applied', files: [draft], resume: false, status: 'pending', createdAt: new Date().toISOString() });
    mkGate('bind-1');
    const seen = { [draft]: G.fileSha256(W, draft) };
    fs.writeFileSync(path.join(W, draft), 'v2 changed after review');
    await assert.rejects(() => G.approveAndRun(W, 'bind-1', policy, {}, seen), /changed after you reviewed/);
    ok(Q.getGate(W, 'bind-1').status === 'pending', 'a file changed after review blocks the run and leaves the gate pending');
    await assert.rejects(() => G.approveAndRun(W, 'bind-1', policy, {}, {}), /changed after you reviewed/);
    ok(true, 'a file the reviewer was never shown also blocks the run');
    const r = await G.approveAndRun(W, 'bind-1', policy, {}, { [draft]: G.fileSha256(W, draft) });
    ok(r.ok && Q.getGate(W, 'bind-1').status === 'executed', 'approving the content that was shown runs the command');
    mkGate('bind-2');
    ok((await G.approveAndRun(W, 'bind-2', policy, {})).ok, 'without review hashes (older callers) approval still works');
  }

  console.log('planted secret: agents cannot reach it, change protected files, or leak it into the audit');
  {
    const PLANTED = 'planted-s3cret-Zq81xv';
    fs.writeFileSync(path.join(W, 'creds.env'), `TOKEN=${PLANTED}\n`);
    const script = [
      [['read_file', { path: 'creds.env' }]],
      [['write_file', { path: '.github/agents/evil.agent.md', content: 'x' }]],
      [['edit_file', { path: '.loop/policy.json', oldText: '{', newText: '{ ' }]],
      [['write_file', { path: '.github/workflows/x.yml', content: 'x' }]],
      [['run_command', { command: 'git commit -am pwn' }]],
      [['finish', { status: 'done', summary: 'tried' }]]
    ];
    let t = 0;
    const m = { family: 'fake', id: 'p', async sendRequest() {
      const calls = script[t++];
      return { stream: (async function* () { yield* calls.map(([n, i], k) => new ToolCallPart(`ps-${t}-${k}`, n, i)); })() };
    } };
    const policyBefore = fs.readFileSync(path.join(W, '.loop', 'policy.json'), 'utf8');
    const res = await runItem({ id: 'planted1', agent: 'techlead', task: 't', from: 'user', chainId: 'planted-chain', hop: 0, createdAt: new Date().toISOString() },
      { root: W, team, skills, model: m, secrets: { PLANTED_TOKEN: PLANTED }, policy: loadPolicy(W, '.loop/policy.json'), maxSteps: 10, maxHops: 5, out, token });
    ok(res.status === 'done', 'the run finishes');
    ok(!fs.existsSync(path.join(W, '.github/agents/evil.agent.md')) && !fs.existsSync(path.join(W, '.github/workflows/x.yml')), 'writes under .github are refused');
    ok(fs.readFileSync(path.join(W, '.loop', 'policy.json'), 'utf8') === policyBefore, 'the policy file is not editable by the agent');
    const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
    const leaked = walk(path.join(W, '.loop')).filter(f => fs.readFileSync(f, 'utf8').includes(PLANTED));
    ok(leaked.length === 0, 'the planted secret appears nowhere under .loop (audit, checkpoints, queue)');
    const events = fs.readFileSync(path.join(W, '.loop', 'runs', new Date().toISOString().slice(0, 10), 'planted-chain.jsonl'), 'utf8');
    ok(events.includes('REFUSED') && !events.includes(PLANTED), 'refusals are recorded and the audit holds no secret');
  }

  console.log('conversation changes: schedule, role edits, memory');
  {
    const M = require(`${OUT}/manage.js`);
    const { buildPrompt } = require(`${OUT}/runner.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-manage-'));
    fs.mkdirSync(path.join(R, '.github', 'agents'), { recursive: true });
    const agentFile = path.join(R, '.github', 'agents', 'sentinel.agent.md');
    const original = '---\nname: sentinel\ndescription: watches things\nloop:\n  skills: [probe]\n  schedule: "*/15 9-21 * * 1-5"\n  task: Check the dashboard.\n  maxSteps: 15\n---\nYou watch the dashboard.\nBe brief.\n';
    fs.writeFileSync(agentFile, original);
    const sched = M.proposeSchedule(R, 'sentinel', { schedule: '0 9 * * 1-5' });
    ok(sched.change && sched.change.after.includes('  schedule: "0 9 * * 1-5"') && sched.change.after.includes('  maxSteps: 15') && sched.change.after.endsWith('Be brief.\n'), 'a new schedule changes one line and leaves the rest of the file alone');
    ok(M.diffOf(sched.change).includes('-  schedule: "*/15 9-21 * * 1-5"') && M.diffOf(sched.change).includes('+  schedule: "0 9 * * 1-5"'), 'the proposal shows a diff');
    ok(fs.readFileSync(agentFile, 'utf8') === original, 'proposing writes nothing');
    ok(M.proposeSchedule(R, 'sentinel', { schedule: '61 * * * *' }).error, 'an invalid cron is rejected before any file is touched');
    ok(M.proposeSchedule(R, 'nobody', { schedule: '0 9 * * *' }).error.includes('No agent named'), 'an unknown agent is rejected');
    const off = M.proposeSchedule(R, 'sentinel', { schedule: null });
    ok(off.change && !require(`${OUT}/frontmatter.js`).parseFrontmatter(off.change.after).meta.loop.schedule && off.change.after.includes('  # schedule: "*/15 9-21 * * 1-5"'), 'scheduling can be turned off, keeping the old schedule as a comment');
    const multi = M.proposeSchedule(R, 'sentinel', { task: 'Line one.\nHe said "go" and \'stop\'.' });
    ok(multi.change && require(`${OUT}/frontmatter.js`).parseFrontmatter(multi.change.after).meta.loop.task === 'Line one.\nHe said "go" and \'stop\'.', 'a task with both quote kinds and a newline round-trips through a block scalar');
    {
      const withProbe = original.replace('  task: Check the dashboard.', '  wakeIf: bash .github/skills/probe/scripts/check.sh\n  task: Check the dashboard.');
      fs.writeFileSync(agentFile, withProbe);
      const offP = M.proposeSchedule(R, 'sentinel', { schedule: null }); M.applyChange(R, offP.change);
      const parsedOff = require(`${OUT}/frontmatter.js`).parseFrontmatter(fs.readFileSync(agentFile, 'utf8')).meta.loop;
      ok(!parsedOff.schedule && !parsedOff.wakeIf, 'turned off: neither schedule nor wakeIf is live (so the config stays valid)');
      const onP = M.proposeSchedule(R, 'sentinel', { schedule: '*/5 * * * *' });
      M.applyChange(R, onP.change);
      const parsedOn = require(`${OUT}/frontmatter.js`).parseFrontmatter(fs.readFileSync(agentFile, 'utf8')).meta.loop;
      ok(parsedOn.schedule === '*/5 * * * *' && parsedOn.wakeIf === 'bash .github/skills/probe/scripts/check.sh' && onP.change.summary.includes('wakeIf restored'), 'turning it back on restores the zero-token wakeIf check');
      ok(!fs.readFileSync(agentFile, 'utf8').includes('# schedule:'), 'the old commented schedule line is replaced, not left behind');
      fs.writeFileSync(agentFile, original);
    }
    M.applyChange(R, M.proposeSchedule(R, 'sentinel', { schedule: '0 9 * * 1-5' }).change);
    ok(loadAgents(R).get('sentinel').schedule === '0 9 * * 1-5', 'applying the change is read back by the team loader');
    let stale = false; try { M.applyChange(R, off.change); } catch (e) { stale = /changed since/.test(e.message); }
    ok(stale, 'a proposal built on an older file is refused');
    const role = M.proposeRoleEdit(R, 'sentinel', 'Be brief.', 'Be brief. Answer in Chinese.');
    ok(role.change && role.change.after.includes('Be brief. Answer in Chinese.') && role.change.after.startsWith('---\nname: sentinel'), 'a role edit touches only the body');
    ok(M.proposeRoleEdit(R, 'sentinel', 'name: sentinel', 'x').error, 'the frontmatter cannot be edited through a role edit');
    ok(M.proposeRoleEdit(R, 'sentinel', 'e', 'x').error.includes('times'), 'an ambiguous role edit asks for more context');

    const rem = M.proposeRemember(R, 'sentinel', 'Reports go to the ops channel');
    ok(rem.change && rem.change.before === null && /^- \d{4}-\d{2}-\d{2}: Reports go to the ops channel\n$/.test(rem.change.after), 'a remembered note is a dated line in .loop/memory/<agent>.md');
    M.applyChange(R, rem.change);
    M.applyChange(R, M.proposeRemember(R, 'all', 'Never email customers directly').change);
    ok(M.memoryFor(R, 'sentinel').split('\n').length === 2 && M.memoryFor(R, 'sentinel').startsWith('- ') && M.memoryFor(R, 'other').includes('Never email'), 'a run is told everyone\'s notes and its own');
    ok(M.proposeRemember(R, 'sentinel', 'Reports go to the ops channel').error.includes('already'), 'a duplicate note is not added twice');
    const forget = M.proposeForget(R, 'sentinel', 'ops channel');
    M.applyChange(R, forget.change);
    ok(M.readMemory(R, 'sentinel') === '' && !fs.existsSync(path.join(R, '.loop', 'memory', 'sentinel.md')), 'forgetting the last note removes the file');
    const a = loadAgents(R).get('sentinel');
    const prompt = buildPrompt(a, { id: 'i1', task: 'do', from: 'user', chainId: 'c', hop: 0 }, { team: new Map(), skills: new Map() }, M.memoryFor(R, 'sentinel'));
    ok(prompt.indexOf('# Standing instructions') > prompt.indexOf('# Your role') && prompt.indexOf('# Standing instructions') < prompt.indexOf('# Work item'), 'standing instructions sit after the role and before the work item');
    ok(!buildPrompt(a, { id: 'i1', task: 'do', from: 'user', chainId: 'c', hop: 0 }, { team: new Map(), skills: new Map() }, '').includes('Standing instructions'), 'no notes means no section');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('@loop chat tools: read at once, change only after Apply');
  {
    const { runChatTool, CHAT_TOOLS } = require(`${OUT}/chatTools.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-chat-'));
    fs.mkdirSync(path.join(R, '.github', 'agents'), { recursive: true });
    const file = path.join(R, '.github', 'agents', 'sentinel.agent.md');
    const src = '---\nname: sentinel\ndescription: watches\nloop:\n  schedule: "0 9 * * *"\n  task: Look.\n---\nYou watch.\n';
    fs.writeFileSync(file, src);
    fs.writeFileSync(path.join(R, '.github', 'agents', 'planner.agent.md'), '---\nname: planner\ndescription: chat only\n---\nPlan.\n');
    const calls = { submit: [], answer: [], power: [], reload: 0 };
    const host = { root: R, state: () => ({ running: true, active: undefined }), submit: (a, t) => calls.submit.push([a, t]), answer: (i, t) => calls.answer.push([i, t]),
      power: async on => { calls.power.push(on); }, reload: async () => { calls.reload++; return []; } };
    const list = JSON.parse((await runChatTool('list_agents', {}, host)).text);
    ok(list.agents.length === 2 && list.agents.find(a => a.name === 'sentinel').schedule === '0 9 * * *' && list.agents.find(a => a.name === 'planner').runsUnattended === false, 'list_agents tells team agents from chat-only ones');
    ok(CHAT_TOOLS.every(t => t.name && t.description && t.inputSchema.type === 'object') && CHAT_TOOLS.filter(t => t.name.startsWith('propose_')).length === 10, 'every change goes through a propose_ tool');

    const sched = await runChatTool('propose_schedule', { agent: 'sentinel', schedule: '*/30 9-18 * * 1-5' }, host);
    ok(sched.proposal && sched.proposal.detail.includes('+  schedule: "*/30 9-18 * * 1-5"') && fs.readFileSync(file, 'utf8') === src, 'a schedule request becomes a diff and writes nothing');
    ok(/Apply button/.test(sched.text) && /nothing has changed/i.test(sched.text), 'the model is told nothing has happened yet');
    const msg = await sched.proposal.apply();
    ok(loadAgents(R).get('sentinel').schedule === '*/30 9-18 * * 1-5' && calls.reload === 1 && msg.includes('Team reloaded'), 'Apply writes the file and reloads the team');
    ok((await runChatTool('propose_schedule', { agent: 'sentinel', schedule: 'every day' }, host)).text.startsWith('Not proposed'), 'a bad cron is explained to the model, not proposed');
    ok((await runChatTool('propose_schedule', { agent: 'planner', schedule: '0 9 * * *', task: 'x' }, host)).text.includes('no loop: block'), 'a chat-only agent cannot be scheduled from here');

    const mem = await runChatTool('propose_remember', { agent: 'sentinel', note: 'Reports go to ops' }, host);
    ok(mem.proposal && !fs.existsSync(path.join(R, '.loop', 'memory', 'sentinel.md')), 'a note is proposed, not written');
    const reloadsBefore = calls.reload;
    await mem.proposal.apply();
    ok(fs.readFileSync(path.join(R, '.loop', 'memory', 'sentinel.md'), 'utf8').includes('Reports go to ops') && calls.reload === reloadsBefore, 'applying a note writes it without reloading the team');
    ok((await runChatTool('get_memory', { agent: 'sentinel' }, host)).text.includes('Reports go to ops'), 'get_memory reads it back');

    const run = await runChatTool('propose_run', { agent: 'sentinel', task: 'Check now' }, host);
    ok(run.proposal && calls.submit.length === 0, 'a task is proposed, not queued');
    await run.proposal.apply();
    ok(JSON.stringify(calls.submit) === '[["sentinel","Check now"]]', 'Apply queues the task');
    ok((await runChatTool('propose_run', { agent: 'planner', task: 'x' }, host)).text.startsWith('Not proposed'), 'a chat-only agent cannot be given a task');

    Q.saveGate(R, { id: 'cq1', kind: 'question', agent: 'sentinel', itemId: 'i', chainId: 'c', title: 'Which host?', body: 'b', files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
    Q.saveGate(R, { id: 'ca1', kind: 'approval', agent: 'sentinel', itemId: 'i', chainId: 'c', title: 'Run it', body: 'b', command: 'echo', files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
    ok(JSON.parse((await runChatTool('list_pending', {}, host)).text).length === 2, 'list_pending shows both kinds');
    const ans = await runChatTool('propose_answer', { gate_id: 'cq1', answer: 'mac-mini' }, host);
    ok(ans.proposal && calls.answer.length === 0, 'an answer is proposed, not sent');
    await ans.proposal.apply();
    ok(JSON.stringify(calls.answer) === '[["cq1","mac-mini"]]', 'Apply sends the human\'s answer');
    ok((await runChatTool('propose_answer', { gate_id: 'ca1', answer: 'yes' }, host)).text.includes('Loop Console'), 'an approval cannot be decided in chat; the model is sent to the console');
    ok((await runChatTool('propose_answer', { gate_id: 'nope', answer: 'x' }, host)).text.startsWith('Not proposed'), 'an unknown gate is refused');
    const pw = await runChatTool('propose_team_power', { on: false }, host);
    await pw.proposal.apply();
    ok(calls.power.join() === 'false', 'stop is proposed, then done on Apply');
    ok((await runChatTool('propose_team_power', { on: true }, host)).text.includes('already running'), 'starting a running team is a no-op');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('@loop: goals, skills and new agents');
  {
    const { runChatTool } = require(`${OUT}/chatTools.js`);
    const M = require(`${OUT}/manage.js`);
    const { parseFrontmatter } = require(`${OUT}/frontmatter.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-author-'));
    const A = n => path.join(R, '.github', 'agents', `${n}.agent.md`);
    fs.mkdirSync(path.join(R, '.github', 'agents'), { recursive: true });
    fs.mkdirSync(path.join(R, '.github', 'skills', 'probe'), { recursive: true });
    fs.writeFileSync(path.join(R, '.github', 'skills', 'probe', 'SKILL.md'), '---\nname: probe\ndescription: checks\n---\nCheck.\n');
    fs.mkdirSync(path.join(R, '.loop', 'policies'), { recursive: true });
    fs.writeFileSync(path.join(R, '.loop', 'policies', 'ro.json'), '{}');
    const src = '---\nname: sentinel\ndescription: watches\nloop:\n  skills: [probe]\n  schedule: "0 9 * * *"\n  task: Look.\n  maxSteps: 12\n---\nYou watch.\n';
    fs.writeFileSync(A('sentinel'), src);
    const reloads = [];
    const host = { root: R, state: () => ({ running: true }), submit() {}, answer() {}, power: async () => {}, reload: async () => { reloads.push(1); return []; }, guidePath: path.join(__dirname, '..', 'guides', 'authoring.md') };
    const cardOf = async (name, input) => runChatTool(name, input, host);

    // goals
    const add = await cardOf('propose_goals', { agent: 'sentinel', op: 'add', id: 'release-health', text: 'Releases run normally', schedule: '*/15 * * * *', skills: ['probe'], urgent: true, maxRunsPerDay: 6 });
    ok(add.proposal && fs.readFileSync(A('sentinel'), 'utf8') === src, 'adding a goal is proposed and writes nothing');
    ok(add.proposal.detail.includes('Will run on its own') && add.proposal.detail.includes('*/15 * * * *') && add.proposal.detail.indexOf('Will run on its own') < add.proposal.detail.indexOf('```diff'), 'the card says when it will run, above the diff');
    await add.proposal.apply();
    const g1 = loadAgents(R).get('sentinel').goals.find(g => g.id === 'release-health');
    ok(g1 && g1.schedule === '*/15 * * * *' && g1.urgent === true && g1.maxRunsPerDay === 6 && g1.skills[0] === 'probe' && reloads.length === 1, 'Apply writes the goal; the team loader reads it back; the team is reloaded');
    const after1 = fs.readFileSync(A('sentinel'), 'utf8');
    ok(after1.startsWith(src.slice(0, src.indexOf('---\nYou watch.'))) && after1.endsWith('---\nYou watch.\n') && after1.includes('  maxSteps: 12\n  goals:\n    - id: "release-health"'), 'the rest of the file is untouched and goals goes at the end of the loop block');
    const upd = await cardOf('propose_goals', { agent: 'sentinel', op: 'update', id: 'release-health', schedule: '0 * * * *' });
    ok(upd.proposal && upd.proposal.detail.includes('-      schedule: "*/15 * * * *"') && upd.proposal.detail.includes('+      schedule: "0 * * * *"') && !upd.proposal.detail.includes('maxRunsPerDay'), 'update changes only the given field');
    await upd.proposal.apply();
    ok(loadAgents(R).get('sentinel').goals.find(g => g.id === 'release-health').maxRunsPerDay === 6, 'update keeps the other fields');
    for (const [input, why] of [
      [{ agent: 'sentinel', op: 'add', id: 'release-health', text: 'x' }, 'a duplicate id'],
      [{ agent: 'sentinel', op: 'add', id: 'Bad Id', text: 'x' }, 'an id with spaces and capitals'],
      [{ agent: 'sentinel', op: 'add', id: 'g2' }, 'a goal with no text'],
      [{ agent: 'sentinel', op: 'add', id: 'g2', text: 'x', schedule: '61 * * * *' }, 'an invalid cron'],
      [{ agent: 'sentinel', op: 'add', id: 'g2', text: 'x', wakeIf: 'true' }, 'wakeIf without a schedule'],
      [{ agent: 'sentinel', op: 'add', id: 'g2', text: 'x', skills: ['ghost'] }, 'an unknown skill'],
      [{ agent: 'sentinel', op: 'add', id: 'g2', text: 'x', policy: '.loop/policies/missing.json' }, 'a policy that does not exist'],
      [{ agent: 'sentinel', op: 'add', id: 'g2', text: 'x', policy: '.loop/policies/../../x' }, 'a policy path that climbs out'],
      [{ agent: 'sentinel', op: 'update', id: 'nope', text: 'x' }, 'updating a goal that is not there'],
      [{ agent: 'sentinel', op: 'remove', id: 'default' }, 'touching the legacy default goal'],
      [{ agent: 'nobody', op: 'add', id: 'g2', text: 'x' }, 'an unknown agent']
    ]) { ok((await cardOf('propose_goals', input)).text.startsWith('Not proposed'), `goals: ${why} is explained, not proposed`); }
    const rem = await cardOf('propose_goals', { agent: 'sentinel', op: 'remove', id: 'release-health' });
    await rem.proposal.apply();
    ok(fs.readFileSync(A('sentinel'), 'utf8') === src, 'removing the only goal gives back the original file byte for byte');

    // skills
    const sk = await cardOf('propose_skills', { agent: 'sentinel', add: ['probe', 'ghost'] });
    ok(sk.text.startsWith('Not proposed') && /ghost/.test(sk.text), 'a skill that does not exist is refused by name');
    ok((await cardOf('propose_skills', { agent: 'sentinel', add: ['probe'] })).text.startsWith('Not proposed'), 'adding what it already has changes nothing');
    ok((await cardOf('propose_skills', { agent: 'sentinel', remove: ['other'] })).text.startsWith('Not proposed'), 'removing a skill it does not have is refused');
    const rmSk = await cardOf('propose_skills', { agent: 'sentinel', remove: ['probe'] });
    await rmSk.proposal.apply();
    ok(loadAgents(R).get('sentinel').skills.length === 0 && !/skills:/.test(fs.readFileSync(A('sentinel'), 'utf8')), 'removing the last skill removes the key');
    fs.writeFileSync(A('sentinel'), src);

    // a block-style list is replaced whole
    fs.writeFileSync(A('sentinel'), src.replace('  skills: [probe]', '  skills:\n    - probe\n    - other'));
    const sk2 = M.proposeSkills(R, 'sentinel', { remove: ['other'] });
    ok(sk2.change && parseFrontmatter(sk2.change.after).meta.loop.skills.join() === 'probe' && !sk2.change.after.includes('- other'), 'a block-style skills list is rewritten cleanly');
    fs.writeFileSync(A('sentinel'), src);

    // new agents
    const mk = await cardOf('propose_agent', { name: 'release-watch', description: 'Watches releases.', instructions: 'You watch releases.\nBe brief.', skills: ['probe'] });
    ok(mk.proposal && !fs.existsSync(A('release-watch')), 'a new agent is proposed and no file exists yet');
    ok(mk.proposal.detail.includes('Will not run on its own') && /not.*on its own/.test(mk.text), 'without a schedule the card and the model are told it will not run on its own');
    await mk.proposal.apply();
    const rw = loadAgents(R).get('release-watch');
    ok(rw && rw.description === 'Watches releases.' && rw.skills[0] === 'probe' && !rw.schedule && rw.goals.length === 0 && rw.body.startsWith('You watch releases.'), 'Apply creates an agent that joins the team with no schedule');
    const sch = await cardOf('propose_agent', { name: 'nightly', description: 'Runs nightly.', instructions: 'Do it.', schedule: '0 2 * * *', task: 'Run the nightly job.', policy: '.loop/policies/ro.json', goals: [{ id: 'g1', text: 'Stay green', schedule: '*/5 * * * *' }], handoffs: ['sentinel'], maxSteps: 20 });
    ok(sch.proposal && sch.proposal.detail.includes('Will run on its own') && sch.proposal.detail.includes('0 2 * * *') && sch.proposal.detail.includes('goal g1') && sch.proposal.detail.includes('.loop/policies/ro.json'), 'with a schedule the card spells out every automatic run and the policy');
    await sch.proposal.apply();
    const nt = loadAgents(R).get('nightly');
    ok(nt && nt.schedule === '0 2 * * *' && nt.task === 'Run the nightly job.' && nt.policy === '.loop/policies/ro.json' && nt.maxSteps === 20 && nt.handoffs[0] === 'sentinel' && nt.goals.some(g => g.id === 'g1'), 'every field reads back');
    for (const [input, why] of [
      [{ name: 'sentinel', description: 'd', instructions: 'x' }, 'a name that is taken'],
      [{ name: 'Bad Name', description: 'd', instructions: 'x' }, 'a bad name'],
      [{ name: 'loop', description: 'd', instructions: 'x' }, 'a reserved name'],
      [{ name: 'a1', description: '', instructions: 'x' }, 'no description'],
      [{ name: 'a1', description: 'd', instructions: ' ' }, 'no instructions'],
      [{ name: 'a1', description: 'd', instructions: 'x', skills: ['ghost'] }, 'an unknown skill'],
      [{ name: 'a1', description: 'd', instructions: 'x', handoffs: ['ghost'] }, 'a handoff to nobody'],
      [{ name: 'a1', description: 'd', instructions: 'x', schedule: '0 9 * * *' }, 'a schedule without a task'],
      [{ name: 'a1', description: 'd', instructions: 'x', schedule: 'nope', task: 't' }, 'a bad cron'],
      [{ name: 'a1', description: 'd', instructions: 'x', policy: '.github/agents/sentinel.agent.md' }, 'a policy outside .loop/policies'],
      [{ name: 'a1', description: 'd', instructions: 'x', policy: '.loop/policies/new.json' }, 'a policy that does not exist (chat cannot create one)'],
      [{ name: 'a1', description: 'He said "go" and \'stop\'', instructions: 'x' }, 'a description that cannot be quoted safely']
    ]) { ok((await cardOf('propose_agent', input)).text.startsWith('Not proposed'), `new agent: ${why} is explained, not proposed`); }
    ok(!fs.existsSync(A('a1')) && !fs.existsSync(A('Bad Name')), 'a refused proposal leaves no file behind');
    // a file that appears between the proposal and Apply is never overwritten
    const race = await cardOf('propose_agent', { name: 'raced', description: 'd', instructions: 'x' });
    fs.writeFileSync(A('raced'), 'someone else wrote this\n');
    let blocked = false; try { await race.proposal.apply(); } catch (e) { blocked = /changed since/.test(e.message); }
    ok(blocked && fs.readFileSync(A('raced'), 'utf8') === 'someone else wrote this\n', 'Apply refuses to overwrite a file that appeared after the proposal');

    // guide
    const guide = (await cardOf('get_authoring_guide', {})).text;
    ok(guide.includes('propose_agent') && guide.includes('goals') && guide.includes('wakeIf') && guide.includes('Leave out `schedule`'), 'the authoring guide is served and covers goals, probes and new agents');
    ok((await runChatTool('get_authoring_guide', {}, { ...host, guidePath: path.join(R, 'nope.md') })).text.includes('could not be read'), 'a missing guide is reported, not thrown');
    // the guide only names tools and fields that exist
    const { CHAT_TOOLS } = require(`${OUT}/chatTools.js`);
    const named = [...new Set([...guide.matchAll(/`(propose_[a-z_]+|get_[a-z_]+|list_[a-z_]+)`/g)].map(m => m[1]))];
    ok(named.length > 5 && named.every(n => CHAT_TOOLS.some(t => t.name === n)), 'every tool the guide names exists');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('console: run status, review binding, page states');
  {
    const { consoleModel, renderBody } = require(`${OUT}/console.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-pro-'));
    const day = path.join(R, '.loop', 'runs', '2026-10-11');
    fs.mkdirSync(day, { recursive: true });
    const line = o => JSON.stringify(o);
    fs.writeFileSync(path.join(day, 'resumed.jsonl'), [
      line({ ts: '2026-10-11T09:00:00Z', chainId: 'resumed', agent: 'a1', type: 'start' }),
      line({ ts: '2026-10-11T09:00:05Z', chainId: 'resumed', agent: 'a1', type: 'park', step: 1, gateId: 'g' }),
      line({ ts: '2026-10-11T09:10:00Z', chainId: 'resumed', agent: 'a1', type: 'resume', gateId: 'g' })
    ].join('\n'));
    const { recentRuns } = require(`${OUT}/runs.js`);
    ok(recentRuns(R)[0].status === 'running' && recentRuns(R)[0].updated === '2026-10-11T09:10:00Z', 'a run that resumed after a park is running again, with its last event time');
    const cut = consoleModel(R, { running: false, tab: 'overview' });
    ok(cut.runs[0].status === 'interrupted', 'a run no worker owns is shown as interrupted, not running forever');
    ok(consoleModel(R, { running: true, active: 'a1', tab: 'overview' }).runs[0].status === 'running', 'the active agent\'s run stays running');
    ok(renderBody(cut).includes('Interrupted') && renderBody(cut).includes('Team stopped'), 'the page says so');

    const F = path.join(R, '.loop', 'outbox'); fs.mkdirSync(F, { recursive: true });
    fs.writeFileSync(path.join(F, 'd.md'), 'draft v1');
    Q.saveGate(R, { id: 'pg1', kind: 'approval', agent: 'a1', itemId: 'i', chainId: 'c', title: 't', body: 'b', command: 'echo hi', files: ['.loop/outbox/d.md', '.loop/outbox/gone.md'], resume: false, status: 'pending', createdAt: new Date().toISOString() });
    const m = consoleModel(R, { running: true, tab: 'overview' });
    const pv = m.pending[0].previews;
    ok(pv[0].sha256 === G.fileSha256(R, '.loop/outbox/d.md') && pv[1].sha256 === 'missing', 'the shown draft and its hash come from the same bytes; a missing file is marked missing');
    const html = renderBody(m);
    ok(/<button class="btn primary" data-approve="pg1" disabled>/.test(html) && html.includes('is missing, so this cannot be approved'), 'approval is disabled while a draft is missing');
    await assert.rejects(() => G.approveAndRun(R, 'pg1', loadPolicy(W, '.loop/policy.json'), {}, { '.loop/outbox/d.md': pv[0].sha256, '.loop/outbox/gone.md': 'missing' }), /changed after you reviewed/);
    ok(true, 'the host also refuses an approval that covers a missing file');
    ok(html.includes('data-copy="echo hi"') && html.includes('<time datetime='), 'the command can be copied and times carry their exact value');
    fs.writeFileSync(path.join(F, 'big.md'), 'x'.repeat(7000));
    Q.saveGate(R, { id: 'pg2', kind: 'approval', agent: 'a1', itemId: 'i', chainId: 'c', title: 't2', body: 'b', command: 'echo', files: ['.loop/outbox/big.md'], resume: false, status: 'pending', createdAt: new Date().toISOString() });
    ok(renderBody(consoleModel(R, { running: true, tab: 'overview' })).includes('Open full file'), 'a long draft offers the full file and says approval covers all of it');
    const banner = renderBody({ ...m, note: { tone: 'bad', text: '<b>boom</b>' } });
    ok(banner.includes('role="alert"') && banner.includes('&lt;b&gt;boom') && !banner.includes('<b>boom'), 'a page-level error is shown, escaped');
    ok(renderBody({ ...m, running: true, active: undefined }).includes('Team on · idle'), 'a running team with no active agent is labelled idle, not stopped');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('chat with an agent: messages reach a running agent');
  {
    const T = require(`${OUT}/thread.js`);
    const policy = loadPolicy(W, '.loop/policy.json');
    const texts = messages => messages.flatMap(m => m.content.map(c => (c instanceof ToolResultPart ? `[result] ${c.content[0].value}` : c.value ?? '')));
    const all = reqs => reqs.map(r => texts(r).join('\n'));
    let n = 0;
    const model = (script, onRequest) => { const requests = []; let i = 0;
      return { requests, family: 'fake', id: 'chat',
        async sendRequest(messages) {
          requests.push(messages); onRequest?.(requests.length, messages);
          const t = script[Math.min(i++, script.length - 1)];
          if (t === 'throw') { throw new Error('model unavailable'); }
          return { stream: (async function* () { yield* t.map(([name, input], k) => new ToolCallPart(`ch-${++n}-${k}`, name, input)); })() };
        } }; };
    const item = id => ({ id, agent: 'techlead', task: 'Look at the queue.', from: 'user', chainId: `${id}-chain`, hop: 0, createdAt: new Date().toISOString() });
    const run = (it, m) => runItem(it, { root: W, team, skills, model: m, secrets: {}, policy, maxSteps: 12, maxHops: 5, out, token });
    const FIN = [['finish', { status: 'done', summary: 'ok' }]];
    const mine = () => T.listMessages(W, 'techlead');

    // 1. said before the run started: it is in the first prompt, after the work item
    const m1 = T.postHumanMessage(W, 'techlead', 'Please focus on the backlog first.');
    ok(m1.status === 'pending' && T.pendingMessages(W, 'techlead').length === 1, 'a message you send is pending until the agent has seen it');
    const mod1 = model([FIN]);
    await run(item('chat-start'), mod1);
    const first = all(mod1.requests)[0];
    ok(first.includes('Messages from the human, sent before this run started') && first.includes('Please focus on the backlog first.') && first.indexOf('# Work item') < first.indexOf('Please focus on the backlog'), 'said before the run started: in the first prompt, after the work item (the static prefix is untouched)');
    const d1 = mine().find(m => m.id === m1.id);
    ok(d1.status === 'delivered' && d1.via === 'start' && d1.itemId === 'chat-start' && T.pendingMessages(W, 'techlead').length === 0, 'and it is then marked delivered, with how and in which run');
    ok(fs.readFileSync(path.join(W, '.loop/runs', new Date().toISOString().slice(0, 10), 'chat-start-chain.jsonl'), 'utf8').includes('"type":"human"'), 'the audit records that the agent was given it');
    ok(first.includes('The human may send you a message while you work'), 'the runtime rules tell the agent such messages are instructions from the owner of the work');

    // 2. said while it works: it is read before the next request
    let m2;
    const mod2 = model([[['list_dir', { path: '.' }]], FIN], count => { if (count === 1) { m2 = T.postHumanMessage(W, 'techlead', 'Actually, skip the docs folder.'); } });
    const r2 = await run(item('chat-turn'), mod2);
    const second = all(mod2.requests)[1];
    ok(r2.status === 'done' && !all(mod2.requests)[0].includes('skip the docs folder') && second.includes('Message from the human, sent while you were working') && second.includes('Actually, skip the docs folder.'), 'said while it works: it reaches the model before its next request, not before the one already in flight');
    ok(mine().find(m => m.id === m2.id).via === 'turn' && mine().find(m => m.id === m2.id).status === 'delivered', 'and is marked delivered once that turn is done');

    // 3. said while it was finishing: it does not stop before reading it
    const mod3 = model([FIN, FIN], count => { if (count === 1) { T.postHumanMessage(W, 'techlead', 'Wait, also check the backlog count.'); } });
    const r3 = await run(item('chat-finish'), mod3);
    ok(mod3.requests.length === 2 && all(mod3.requests)[1].includes('also check the backlog count') && r3.status === 'done', 'said while it was finishing: it reads the message before it stops, then finishes again');

    // 4. said while it waits for you: it comes with your answer
    const mod4 = model([[['ask_human', { question: 'Which queue?', context: 'two match' }]], FIN]);
    const it4 = item('chat-wait');
    Q.enqueue(W, it4);
    const r4 = await run(it4, mod4);
    ok(r4.status === 'waiting' && T.chatState(W, 'techlead').state === 'waiting', 'it parks on a question, and the chat says it is waiting for you');
    const m4 = T.postHumanMessage(W, 'techlead', 'By the way, the blue queue is the one.');
    ok(mod4.requests.length === 1 && T.pendingMessages(W, 'techlead').length === 1, 'a message sent now is not delivered yet');
    Q.complete(W, it4, r4.status, r4.summary, r4.gateId);
    G.answerQuestion(W, r4.gateId, 'blue');
    const resumed = Q.nextItem(W, ['techlead']);
    await run(resumed, mod4);
    const afterWait = all(mod4.requests)[1];
    ok(afterWait.includes('The human answered: blue') && afterWait.includes('the blue queue is the one'), 'it resumes with your answer and the message together');
    ok(mine().find(m => m.id === m4.id).via === 'resume', 'delivered, as a resume');

    // 5. an interruption between receiving and finishing the turn does not lose it
    let m5;
    const mod5 = model([[['list_dir', { path: '.' }]], 'throw'], count => { if (count === 1) { m5 = T.postHumanMessage(W, 'techlead', 'Remember to be brief.'); } });
    const r5 = await run(item('chat-crash'), mod5);
    ok(r5.status === 'error' && mine().find(m => m.id === m5.id).status === 'pending', 'if the model fails right after it was given, the message is still pending and will be given again');

    // 6. said after the last turn: it stays pending for the follow-up
    const mod6 = model([FIN]);
    await run(item('chat-late'), mod6);
    const late = T.postHumanMessage(W, 'techlead', 'One more thing for next time.');
    ok(T.pendingMessages(W, 'techlead').some(m => m.id === late.id), 'a message that arrives after the run is still pending (the extension turns it into a follow-up run)');
    for (const m of T.pendingMessages(W, 'techlead')) { T.markDelivered(W, 'techlead', [m.id], { via: 'task' }); }
  }

  console.log('chat with an agent: the thread and where a message goes');
  {
    const T = require(`${OUT}/thread.js`);
    ok(T.cleanMessage('  hi\x00 there\x07\r\nbye  ') === 'hi there\nbye' && T.cleanMessage('x'.repeat(5000)).length === 4000, 'a message is stripped of control characters and bounded');
    ok(!T.postHumanMessage.length || (() => { try { T.postHumanMessage(W, '../x', 'a'); } catch { return true; } return false; })(), 'a bad agent name is refused');
    ok((() => { try { T.postHumanMessage(W, 'techlead', '   '); } catch { return true; } return false; })(), 'an empty message is refused');
    const th = T.buildThread(W, 'techlead');
    const flat = (evs) => evs.flatMap(e => e.kind === 'result' ? [e, ...flat(e.fold)] : [e]);
    const all = flat(th.events);
    const kinds = all.map(e => e.kind);
    ok(kinds.includes('human') && kinds.includes('status') && kinds.includes('steps') && kinds.includes('answer') && kinds.includes('result'), 'the thread has your messages, the runs, the steps and your answers');
    ok(th.events.every((e, i, a) => i === 0 || a[i - 1].ts <= e.ts), 'oldest first');
    const turn = th.events.find(e => e.kind === 'human' && e.text.includes('skip the docs'));
    ok(turn && turn.status === 'delivered' && turn.via === 'turn', 'a delivered message says how it was delivered');
    const ans = all.find(e => e.kind === 'answer' && e.text === 'blue');
    ok(ans && ans.title === 'Which queue?', 'your answer to a question appears with the question it answered');
    const steps = all.find(e => e.kind === 'steps' && e.steps.some(s => s.title.startsWith('list_dir')));
    ok(steps && !all.some(e => e.kind === 'steps' && e.steps.some(s => s.title.startsWith('finish'))), 'consecutive tool calls are one block, and finish is shown as the run\'s end instead');
    ok(T.buildThread(W, 'techlead', { limit: 5 }).events.length === 5 && T.buildThread(W, 'techlead', { limit: 5 }).hidden > 0, 'the thread can be limited and says how much is hidden');
    ok(T.buildThread(W, 'nobody-here').events.length === 0, 'an agent with no history has an empty thread');

    const route = T.routeFor;
    ok(route('running') === 'in-run' && route('waiting') === 'on-resume' && route('queued') === 'at-start' && route('idle') === 'new-task', 'where a message goes depends on what the agent is doing');
    ok(T.chatState(W, 'techlead', 'techlead').state === 'running' && T.chatState(W, 'nobody-here', 'sentinel').state === 'idle', 'running when the worker is on it, idle otherwise');
    Q.enqueue(W, { id: 'q1', agent: 'sentinel', task: 't', from: 'user', chainId: 'q1c', hop: 0, createdAt: new Date().toISOString() });
    ok(T.chatState(W, 'sentinel').state === 'queued', 'queued when it has work waiting for the worker');
    Q.complete(W, { id: 'q1', agent: 'sentinel', task: 't', from: 'user', chainId: 'q1c', hop: 0, createdAt: '' }, 'done', 'x');
    const ctx = T.conversationContext(W, 'techlead');
    ok(/^Conversation so far/.test(ctx) && /You: /.test(ctx) && ctx.length < 2500, 'a run that starts from a message gets a short summary of the conversation so far');
  }

  console.log('chat page: what you see for each state of an agent');
  {
    const { consoleModel, renderBody } = require(`${OUT}/console.js`);
    const T = require(`${OUT}/thread.js`);
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-chatui-'));
    fs.mkdirSync(path.join(R, '.github', 'agents'), { recursive: true });
    for (const n of ['alpha', 'beta']) { fs.writeFileSync(path.join(R, '.github', 'agents', `${n}.agent.md`), `---\nname: ${n}\ndescription: ${n}\nloop:\n  skills: []\n  task: t\n---\nbody\n`); }
    const page = (state, agent) => renderBody(consoleModel(R, { running: true, ...state, tab: 'chat', agent }));
    ok(renderBody(consoleModel(R, { running: true })).includes('data-tab="chat"') && /aria-selected="true" data-tab="chat"/.test(renderBody(consoleModel(R, { running: true }))), 'the console opens on the chat tab');
    ok(!renderBody(consoleModel(R, { running: true, tab: 'overview' })).includes('chat-agents') && renderBody(consoleModel(R, { running: true, tab: 'overview' })).includes('Recent runs'), 'the overview is still there, with the runs, the agents and what needs you');
    let h = page({}, 'alpha');
    ok(h.includes('data-agent="alpha"') && h.includes('data-agent="beta"') && /alpha is idle\. This starts a new run\./.test(h) && !/class="composer running"/.test(h), 'an idle agent: it says a message starts a run, and the composer is not in its running form (no stop button)');
    ok(/The team is stopped\. This is saved/.test(renderBody(consoleModel(R, { running: false, tab: 'chat', agent: 'alpha' }))), 'with the team stopped it says the message is kept until you start it');
    Q.enqueue(R, { id: 'qa', agent: 'alpha', task: 't', from: 'user', chainId: 'qac', hop: 0, createdAt: new Date().toISOString() });
    ok(/alpha has work queued\. It reads this when it starts\./.test(page({}, 'alpha')), 'a queued agent: it will read the message when it starts');
    h = page({ active: 'alpha' }, 'alpha');
    ok(/alpha is working\. It reads this at its next step/.test(h) && /class="composer running"/.test(h) && h.includes('data-chat-cancel="alpha"') && /class="av working"/.test(h), 'a working agent: it will read it at its next step, the composer offers Stop, and its avatar shows it is working');
    Q.complete(R, { id: 'qa', agent: 'alpha', task: 't', from: 'user', chainId: 'qac', hop: 0, createdAt: '' }, 'done', 'x');
    Q.saveGate(R, { id: 'cg1', kind: 'approval', agent: 'alpha', itemId: 'i', chainId: 'c', title: 'Publish it', body: 'b', command: 'echo go', files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
    h = page({}, 'alpha');
    ok(/alpha is waiting for your answer above/.test(h) && h.includes('thread-gates') && h.includes('data-approve="cg1"') && h.includes('echo go'), 'a waiting agent: its question or approval sits at the end of the conversation, with the exact command, and a message is read when it continues');
    ok(/class="count warn" title="needs you">1<\/span>/.test(h), 'the agent list and the tab show that something needs you');
    ok(!page({}, 'beta').includes('data-approve="cg1"'), 'another agent\'s conversation does not show it');
    ok(page({}, 'alpha').includes('aria-pressed="true"') && page({}, 'unknown-agent').includes('data-agent="alpha"'), 'an unknown or missing selection falls back to an agent that needs you');
    T.postHumanMessage(R, 'beta', '<img src=x onerror=alert(1)> hello & goodbye');
    h = page({}, 'beta');
    ok(!h.includes('<img') && h.includes('&lt;img src=x') && h.includes('hello &amp; goodbye') && /waiting for beta to read it/.test(h), 'your own text is shown escaped, and says the agent has not read it yet');
    ok(/empty-title">Nothing yet with alpha|Nothing yet with beta/.test(page({}, 'beta')) === false && true, 'a conversation with messages is not shown as empty');
    ok(/Nothing yet with alpha/.test(renderBody(consoleModel(fs.mkdtempSync(path.join(os.tmpdir(), 'loop-chatui2-')), { running: true, tab: 'chat' }))) === false, 'a workspace with no team says there are no agents rather than showing an empty chat');
    // the roster: a glance at each agent
    const G = T.glance;
    ok(G(R, 'gamma', 'Does gamma things').line === 'Does gamma things' && G(R, 'gamma', 'x').avatar === 'idle', 'an agent that never ran shows what it is for, and is still');
    ok(G(R, 'beta', 'x').line === 'Your message is waiting to be read', 'an unread message of yours is what the roster shows');
    const stamp0 = new Date();
    Q.audit(R, 'alpha-chain', { type: 'start', agent: 'alpha', from: 'user', task: 'work' });
    Q.audit(R, 'alpha-chain', { type: 'tool', agent: 'alpha', step: 1, name: 'run_command', input: { command: 'bash probe.sh' }, result: '[exit 0]' });
    const live = G(R, 'alpha', 'alpha', 'alpha');
    ok(live.avatar === 'working' && live.line === 'bash probe.sh', 'a working agent shows the tool it is on, as its progress line');
    Q.audit(R, 'alpha-chain', { type: 'end', agent: 'alpha', step: 2, status: 'done', summary: 'Everything checked out', outputs: [] });
    Q.complete(R, { id: 'cg-gate-clean', agent: 'alpha', task: 't', from: 'user', chainId: 'x', hop: 0, createdAt: '' }, 'done', 'x');
    const g0 = Q.getGate(R, 'cg1'); g0.status = 'answered'; Q.saveGate(R, g0);
    const done = G(R, 'alpha', 'alpha', undefined, stamp0);
    ok(done.avatar === 'done' && done.line === 'Finished: Everything checked out', 'a run that just finished: a check on the avatar, and its summary as the line');
    ok(G(R, 'alpha', 'alpha', undefined, new Date(stamp0.getTime() + 2 * 3600e3)).avatar === 'idle', 'the check fades after an hour');
    Q.audit(R, 'beta-chain', { type: 'start', agent: 'beta', from: 'user', task: 'x' });
    Q.audit(R, 'beta-chain', { type: 'end', agent: 'beta', step: 1, status: 'blocked', summary: 'no access to the board' });
    const stuck = G(R, 'beta', 'beta', undefined, stamp0);
    ok(stuck.avatar === 'blocked' && stuck.line === 'Your message is waiting to be read', 'a run that ended blocked: a red avatar, even while an unread message of yours is what the line says');
    const stuck2 = G(R, 'delta', 'delta', undefined, stamp0);
    Q.audit(R, 'delta-chain', { type: 'start', agent: 'delta', from: 'user', task: 'x' });
    Q.audit(R, 'delta-chain', { type: 'end', agent: 'delta', step: 1, status: 'blocked', summary: 'no access to the board' });
    const stuck3 = G(R, 'delta', 'delta', undefined, new Date());
    ok(stuck3.avatar === 'blocked' && /^Blocked: no access/.test(stuck3.line) && stuck2.avatar === 'idle', 'and with nothing unread, the line says why it is blocked');
    Q.saveGate(R, { id: 'cg2', kind: 'question', agent: 'beta', itemId: 'i', chainId: 'c', title: 'Which board?', body: 'b', files: [], resume: true, status: 'pending', createdAt: new Date().toISOString() });
    ok(G(R, 'beta', 'beta').avatar === 'waiting' && G(R, 'beta', 'beta').line === 'Needs you: Which board?', 'an agent waiting for you says what it needs');
    const rows = page({}, 'alpha');
    ok(/data-agent="beta"[^>]*title="beta is waiting for you: Needs you: Which board\?"/.test(rows) && /class="av waiting"/.test(rows) && /rr-line warn/.test(rows), 'the roster row carries the avatar, the progress line, and the line as a tooltip');
    ok(/class="av [a-z]+" style="--h:\d+;--sz:38px"/.test(rows) && page({}, 'alpha').match(/--h:(\d+)/g).length >= 2, 'every agent has its own avatar');
    ok(!/<img/.test(rows) && !/onerror/.test(rows), 'the avatars are drawn inline, with nothing fetched');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('tool arguments: checked and converted before a tool runs');
  {
    const { validateToolArguments: v } = require(`${OUT}/vendor/pi-agent/ai/validation.js`);
    const { buildTools } = require(`${OUT}/tools.js`);
    const tool = { name: 'read_file', description: 'd', parameters: { type: 'object', properties: { path: { type: 'string' }, startLine: { type: 'number' }, wait: { type: 'boolean' }, files: { type: 'array', items: { type: 'string' } }, mode: { type: 'string', enum: ['a', 'b'] }, nested: { type: 'object', properties: { n: { type: 'integer' } }, required: ['n'] } }, required: ['path'] } };
    const call = args => ({ type: 'toolCall', id: '1', name: 'read_file', arguments: args });
    const fails = args => { try { v(tool, call(args)); return ''; } catch (e) { return e.message; } };
    ok(JSON.stringify(v(tool, call({ path: 'a', startLine: '5', wait: 'true' }))) === '{"path":"a","startLine":5,"wait":true}', 'a number or boolean the model sent as text is converted');
    ok(v(tool, call({ path: 'a', extra: 1 })).extra === 1, 'a property the schema does not know is allowed');
    ok(JSON.stringify(v(tool, call({ path: 'a', nested: { n: '3' }, files: ['x'] })).nested) === '{"n":3}', 'nested objects are converted too');
    const missing = fails({ startLine: 2 });
    ok(/Validation failed for tool "read_file"/.test(missing) && /\/path: required property is missing/.test(missing) && /Received arguments/.test(missing), 'a missing required property: an error the model can read and act on');
    ok(/\/startLine: expected number, received string/.test(fails({ path: 'a', startLine: 'soon' })) && /\/startLine: expected number/.test(fails({ path: 'a', startLine: '' })), 'text that is not a number is an error, and so is an empty string');
    ok(/must be one of "a", "b"/.test(fails({ path: 'a', mode: 'c' })), 'a value outside an enum names the choices');
    ok(/\/files: expected array, received string/.test(fails({ path: 'a', files: 'x' })) && /\/files\/0: expected string, received object/.test(fails({ path: 'a', files: [{}] })), 'arrays are checked, item by item');
    ok(JSON.stringify(v(tool, call({ path: 'a', files: [1, true] })).files) === '["1","true"]', 'and numbers or booleans in a list of strings are converted to text');
    ok(/\/nested\/n: required property is missing/.test(fails({ path: 'a', nested: {} })), 'required properties of nested objects too');
    const original = { path: 'a', startLine: '5' }; v(tool, call(original));
    ok(original.startLine === '5', 'the model\'s own arguments are not changed in place (the audit keeps what it sent)');
    ok(buildTools({ handoffs: ['x'] }).every(t => t.inputSchema.type === 'object'), 'every tool Loop Runner offers describes its arguments as a JSON Schema object');
    const real = buildTools({ handoffs: ['x'] });
    const asTool = n => ({ name: n, description: '', parameters: real.find(t => t.name === n).inputSchema });
    ok(v(asTool('ask_human'), call({ question: 'q', context: 'c', options: ['a'] })).options.length === 1 && /required property is missing/.test((() => { try { v(asTool('ask_human'), call({ question: 'q' })); } catch (e) { return e.message; } })()), 'the real tools: ask_human needs its context, and its options are an array');
    ok(v(asTool('request_approval'), call({ title: 't', summary: 's', command: 'c', wait: 'false' })).wait === false, 'the real tools: request_approval accepts "false" as false');
    ok(v(asTool('handoff'), call({ to: 'x', task: 't', context: 'c' })).to === 'x' && /must be one of "x"/.test((() => { try { v(asTool('handoff'), call({ to: 'y', task: 't', context: 'c' })); } catch (e) { return e.message; } })()), 'the real tools: a handoff to someone who is not a teammate is refused');
  }

  console.log(`\nALL ${pass} CHECKS PASSED`);
  fs.rmSync(W, { recursive: true, force: true });
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });

