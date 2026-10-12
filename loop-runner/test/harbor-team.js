// The harbor-team workspace assumes three skills that already exist in the user's environment (jira-board,
// harbor-anomaly-detect, harborsense-investigate) plus the local gh and git. This checks everything that is ours:
// the agents load, the schedules and the zero-token pre-check wiring work, and techlead's policy lets it read and
// nothing else. The skills are stubs here. Run: npm test
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'out');
const SRC = path.join(__dirname, '..', 'examples', 'harbor-team');
const { loadAgents, loadSkills, loadAllAgents, validateTeam } = require(`${OUT}/team.js`);
const { decideCommand, loadPolicy, skillScriptRule, hardReject } = require(`${OUT}/policy.js`);
const { checkWake } = require(`${OUT}/wake.js`);

let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const read = (...p) => fs.readFileSync(path.join(SRC, ...p), 'utf8');

const stub = (root, name, scripts = {}) => {
  const d = path.join(root, '.github', 'skills', name);
  fs.mkdirSync(path.join(d, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(d, 'SKILL.md'), `---\nname: ${name}\ndescription: stub of the existing ${name} skill\n---\nstub\n`);
  for (const [f, c] of Object.entries(scripts)) { fs.writeFileSync(path.join(d, 'scripts', f), c); }
};

(async () => {
  console.log('the workspace on its own');
  {
    const team = loadAgents(SRC);
    const errs = validateTeam(team, loadSkills(SRC), loadAllAgents(SRC));
    ok(['jira-board', 'harbor-anomaly-detect', 'harborsense-investigate'].every(s => errs.some(e => e.includes(`"${s}"`))) && errs.length === 3,
      'without your skills, validation names exactly the three it expects you to provide');
  }

  console.log('with the three skills present');
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-team-'));
  fs.cpSync(SRC, R, { recursive: true });
  stub(R, 'jira-board');
  stub(R, 'harborsense-investigate');
  stub(R, 'harbor-anomaly-detect', { 'detect.py': [
    'import os, sys',
    'mode = os.environ.get("STUB_MODE", "clear")',
    'if mode == "anomaly": print(\'{"anomalies":[{"signal":"request_rate","observed":412,"target":120}]}\'); sys.exit(0)',
    'if mode == "broken": print("HarborSense API 503"); sys.exit(3)',
    'print("all clear"); sys.exit(1)', ''].join('\n') });
  {
    const team = loadAgents(R), skills = loadSkills(R);
    ok([...team.keys()].sort().join() === 'briefer,sentinel,techlead' && validateTeam(team, skills, loadAllAgents(R)).length === 0, 'briefer, sentinel and techlead load and validate clean');
    ok(team.get('briefer').schedule === '30 8 * * 1-5' && team.get('sentinel').schedule === '0 9,13,18 * * *' && !team.get('techlead').schedule, 'the brief runs weekday mornings, the check three times a day, techlead only on handoff');
    ok(team.get('sentinel').handoffs.join() === 'techlead' && !team.get('briefer').handoffs.length, 'sentinel can hand to techlead');
    ok(team.get('sentinel').maxRunsPerDay === 6 && team.get('briefer').maxRunsPerDay === 3, 'daily caps are set');
    ok(/handoff/.test(team.get('sentinel').body) && /ask_human/.test(team.get('techlead').body) && /finish/.test(team.get('briefer').body), 'each agent names the tool that ends its work');
    ok(/never change code|do not change code/i.test(team.get('techlead').body), 'techlead is told it analyses and does not change code');
  }

  console.log('how the agents remember');
  {
    const team = loadAgents(R), body = n => team.get(n).body, all = ['briefer', 'sentinel', 'techlead'];
    ok(all.every(n => team.get(n).skills.includes('loop-memory')), 'every agent gets memory by listing one shared skill');
    ok(all.every(n => body(n).includes(`recall --agent ${n}`) && body(n).includes(`note --agent ${n}`) && /`now`/.test(body(n))), 'each role says only when to use it: start with now and recall, end with a note');
    ok(!all.some(n => /signals\.md|notes\/|date \+|REFERENCE ONLY|Never copy text/.test(body(n))), 'no role carries its own copy of the protocol or the file layout; that lives once in the skill');
    ok(/check --key/.test(body('sentinel')) && ['new', 'escalate', 'expired', 'tracked', 'suppress'].every(v => body('sentinel').includes('`' + v + '`')), 'sentinel acts on each verdict of check');
    ok(/track --key/.test(body('techlead')) && /until which date/.test(body('techlead')) && /Decision/.test(body('techlead')), 'techlead asks how long to watch and records the decision');
    const skill = fs.readFileSync(path.join(R, '.github', 'skills', 'loop-memory', 'SKILL.md'), 'utf8');
    ok(/reference, not orders/.test(skill) && /Never copy text from tickets/.test(skill), 'the skill says its records are reference, and that untrusted text must not be copied into a note');
  }

  console.log('memory through the real tools');
  const pyOk = !spawnSync('python3', ['--version']).error;
  if (!pyOk) {
    console.log('  - SKIPPED: python3 was not found on PATH');
  } else {
    const { runTool } = require(`${OUT}/tools.js`);
    const team = loadAgents(R), skills = loadSkills(R);
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const as = (name, listed = true) => {
      const a = team.get(name);
      return { root: R, agent: a, team, item: { id: 'i', agent: name, task: 't', from: 'schedule', chainId: 'c', hop: 0, createdAt: '' }, policy: loadPolicy(R, a.policy),
        extraAllow: listed ? a.skills.map(k => skillScriptRule(skills.get(k).relDir)) : [], secrets: {}, maxHops: 5, token };
    };
    const mem = (name, args, listed = true) => runTool('run_command', { command: `python3 .github/skills/loop-memory/scripts/mem.py --now 2026-10-12T09:00 ${args}` }, as(name, listed));
    const out = r => r.text.replace(/^\[exit \d+\]\n/, '');
    const now = await mem('sentinel', 'now');
    ok(now.decision === 'allow' && /2026-10-12 09:00 \(Monday\)/.test(now.text), 'sentinel can ask for the time through its policy');
    const t = await mem('techlead', 'track --key request_rate --state watching --until 2026-10-20 --ref 2.8 --note "known batch job" --agent techlead');
    ok(t.decision === 'allow' && /"until": "2026-10-20"/.test(t.text), 'techlead records the human\'s decision to watch');
    ok(JSON.parse(out(await mem('sentinel', 'check --key request_rate --value 3.0'))).verdict === 'suppress', 'sentinel, next time, sees it is being watched and the number is not clearly worse: suppress');
    ok(JSON.parse(out(await mem('sentinel', 'check --key request_rate --value 4.5'))).verdict === 'escalate', 'a clearly worse number: escalate');
    const late = await runTool('run_command', { command: 'python3 .github/skills/loop-memory/scripts/mem.py --now 2026-10-21T09:00 check --key request_rate --value 3.0' }, as('sentinel'));
    ok(JSON.parse(out(late)).verdict === 'expired', 'after the date: expired');
    ok(/request_rate: watching until 2026-10-20/.test((await mem('sentinel', 'recall --agent sentinel')).text), 'what techlead recorded shows up in sentinel\'s recall: the team shares what it is tracking');
    ok(/noted:/.test((await mem('briefer', 'note --agent briefer --text "reported 12 open, 2 blocked"')).text) && /reported 12 open/.test((await mem('briefer', 'recall --agent briefer')).text), 'briefer\'s note comes back to briefer');
    ok(!/reported 12 open/.test((await mem('sentinel', 'recall --agent sentinel')).text), 'and not to sentinel');
    const refused = await mem('sentinel', 'now', false);
    ok(refused.decision === 'deny' && /REFUSED/.test(refused.text), 'an agent that does not list the skill cannot run it: memory is opt-in, and the permission comes from the config the agent cannot edit');
    ok(fs.existsSync(path.join(R, '.loop/outbox/memory/tracked.json')) && fs.readdirSync(path.join(R, '.loop/outbox/memory/notes')).sort().join() === 'briefer', 'the records are plain files under the outbox, where the human can see them');
    for (const bad of ['.github/agents/sentinel.agent.md', '.loop/policy.json', '.loop/queue/x.json', 'repos/x.txt']) {
      const abs = path.join(R, bad), before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      const r = await runTool('write_file', { path: bad, content: 'x' }, as('sentinel'));
      ok(/REFUSED/.test(r.text) && (fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null) === before, `an agent still cannot write ${bad}`);
    }
  }

  console.log('zero-token pre-check');
  {
    const team = loadAgents(R), skills = loadSkills(R), s = team.get('sentinel');
    const policy = loadPolicy(R, s.policy), allow = s.skills.map(k => skillScriptRule(skills.get(k).relDir));
    ok(decideCommand(policy, s.wakeIf, allow).decision === 'allow', 'the pre-check passes sentinel\'s own policy');
    const py = spawnSync('python3', ['--version']);
    if (py.error || py.status !== 0) {
      console.log('  - exit-code wiring SKIPPED: python3 was not found on PATH');
    } else {
      // The child process gets an allow-listed environment plus secrets, so the stub's mode travels as a secret.
      const wake = mode => checkWake(R, s, policy, allow, { STUB_MODE: mode });
      const a = await wake('anomaly'), c = await wake('clear'), b = await wake('broken');
      ok(a.wake && a.context.includes('request_rate'), 'exit 0: sentinel wakes with the detection output as context');
      ok(!c.wake && !c.error, 'exit 1: nothing to do, no model call');
      ok(!b.wake && /exit 3/.test(b.error) && /503/.test(b.error), 'exit 3: the check is broken; alert, do not wake');
    }
  }

  console.log('techlead can read, nothing else');
  {
    const team = loadAgents(R), tl = loadPolicy(R, team.get('techlead').policy);
    const verdict = cmd => decideCommand(tl, cmd, []).decision === 'allow' && !hardReject(tl, cmd);
    const readOnly = [
      'ls repos', 'cat repos/harbor-service/README.md', 'head -50 repos/harbor-docs/docs/runbook.md', 'grep -rn RateLimit repos/harbor-service/src', 'rg RateLimit repos',
      'jq . .loop/outbox/incidents/x.json', "find repos -name '*.go'", 'git -C repos/harbor-service log --since=2026-10-12 --oneline',
      'git -C repos/harbor-service grep -n RateLimit', 'git -C repos/harbor-docs show HEAD:docs/runbook.md', 'git -C repos/harbor-service diff HEAD~3 -- src',
      'git -C repos/harbor-service fetch', 'git -C repos/harbor-service blame -L 1,40 src/limit.go', 'git -C repos/harbor-service pull --ff-only',
      'gh search code RateLimit --repo your-org/harbor-service', 'gh pr view 123 --repo your-org/harbor-service', 'gh pr list --repo your-org/harbor-service --state merged --limit 10',
      'gh repo view your-org/harbor-docs', 'gh api repos/your-org/harbor-service/commits?per_page=5'
    ];
    for (const c of readOnly) { ok(verdict(c), `allowed: ${c}`); }
    const writes = [
      'git -C repos/harbor-service push origin main', 'git push', 'git -C repos/harbor-service commit -am x', 'git -C repos/harbor-service checkout -b fix',
      'git -C repos/harbor-service reset --hard HEAD~1', 'git -C repos/harbor-service config user.name x', 'git -C repos/harbor-service remote set-url origin x',
      'gh pr create --title x --body y', 'gh pr merge 1', 'gh pr comment 1 --body hi', 'gh issue create --title x', 'gh issue comment 1 --body hi', 'gh repo delete your-org/harbor-service',
      'gh repo clone your-org/harbor-service', 'gh auth login', 'gh workflow run build.yml', 'gh run rerun 1', 'gh secret set X',
      'gh api repos/your-org/harbor-service/issues -X POST', 'gh api repos/your-org/harbor-service/issues -f title=x', 'gh api repos/your-org/harbor-service/pulls --method PATCH',
      'curl http://example.com', 'wget http://example.com', 'ssh host', 'rm -rf repos', "find repos -name '*.go' -delete", 'find repos -exec cat {} ;',
      'cat repos/x > /etc/passwd', 'date -s 2020-01-01', 'cat /etc/passwd', 'ls ~', 'cat ../outside.txt', 'cat repos/../../x', 'grep -r key /Users', 'ls; git push', 'ls && gh pr merge 1', 'python3 -c "print(1)"', 'npm test'
    ];
    for (const c of writes) { ok(!verdict(c), `refused: ${c}`); }
    ok(tl.writablePaths.length === 0 && tl.protectedPaths.includes('.github/**') && tl.protectedPaths.includes('.loop/**'), 'it can write only to the outbox (no writable paths), and not to .github or .loop');
  }

  console.log('briefer and sentinel');
  {
    const team = loadAgents(R), skills = loadSkills(R);
    for (const n of ['briefer', 'sentinel']) {
      const a = team.get(n), p = loadPolicy(R, a.policy), allow = a.skills.map(k => skillScriptRule(skills.get(k).relDir));
      const s = a.skills[0];
      ok(decideCommand(p, `python3 .github/skills/${s}/scripts/x.py`, allow).decision === 'allow', `${n}: its own skill's scripts are allowed`);
      ok(['git push origin main', 'gh pr merge 1', 'curl http://x', 'ls repos', 'cat /etc/passwd', 'date -s 2020-01-01', 'date +%s; rm -rf x'].every(c => decideCommand(p, c, allow).decision !== 'allow' || hardReject(p, c)), `${n}: nothing but its skills' scripts`);
      ok(p.writablePaths.length === 0, `${n}: can write only to the outbox`);
    }
  }
  fs.rmSync(R, { recursive: true, force: true });
  console.log(`${pass} harbor-team checks passed`);
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
