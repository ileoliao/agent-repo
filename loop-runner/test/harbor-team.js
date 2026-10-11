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
      'cat repos/x > /etc/passwd', 'cat /etc/passwd', 'ls ~', 'cat ../outside.txt', 'cat repos/../../x', 'grep -r key /Users', 'ls; git push', 'ls && gh pr merge 1', 'python3 -c "print(1)"', 'npm test'
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
      ok(['git push origin main', 'gh pr merge 1', 'curl http://x', 'ls repos', 'cat /etc/passwd'].every(c => decideCommand(p, c, allow).decision !== 'allow'), `${n}: nothing but its skill's scripts`);
      ok(p.writablePaths.length === 0, `${n}: can write only to the outbox`);
    }
  }
  fs.rmSync(R, { recursive: true, force: true });
  console.log(`${pass} harbor-team checks passed`);
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
