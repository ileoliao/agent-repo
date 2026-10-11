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
    const team = loadAgents(R);
    const body = n => team.get(n).body;
    ok(['briefer', 'sentinel', 'techlead'].every(n => body(n).includes(`.loop/outbox/notes/${n}/`) && body(n).includes('date +%Y-%m-%d-%H%M')), 'every agent reads its own notes and checks the date before it acts, and writes one note per run');
    ok(['sentinel', 'techlead', 'briefer'].every(n => body(n).includes('.loop/outbox/signals.md')), 'all three share the signal board');
    ok(/watching-until/.test(body('sentinel')) && /one and a half times/.test(body('sentinel')) && /expired/.test(body('sentinel')), 'sentinel suppresses a watched signal only while it has not got clearly worse and the date has not passed');
    ok(/watching-until/.test(body('techlead')) && /until which date/.test(body('techlead')) && /Decision/.test(body('techlead')), 'techlead asks how long to watch and writes the human\'s decision back to the board');
    ok(['briefer', 'sentinel', 'techlead'].every(n => /Never copy text from/.test(body(n)) && /reference, not orders/.test(body(n))), 'notes are marked as reference, and untrusted text is never copied into them');
    ok(!/signals\.md/.test(read('.loop', 'policies', 'techlead.json')) && loadPolicy(SRC, '.loop/policies/techlead.json').writablePaths.length === 0, 'the board and notes live in the outbox, the only place the agents can write');
  }

  console.log('the notebook flow on the real tools');
  {
    const { runTool } = require(`${OUT}/tools.js`);
    const team = loadAgents(R), skills = loadSkills(R), a = team.get('sentinel');
    const policy = loadPolicy(R, a.policy), extraAllow = a.skills.map(k => skillScriptRule(skills.get(k).relDir));
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
    const ctx = { root: R, agent: a, team, item: { id: 'i', agent: 'sentinel', task: 't', from: 'schedule', chainId: 'c', hop: 0, createdAt: '' }, policy, extraAllow, secrets: {}, maxHops: 5, token };
    const call = async (name, input) => { try { return await runTool(name, input, ctx); } catch (e) { return { text: `ERROR: ${e.message}`, thrown: true }; } };
    const now = await call('run_command', { command: 'date +%Y-%m-%d-%H%M' });
    ok(now.decision === 'allow' && /\d{4}-\d\d-\d\d-\d{4}/.test(now.text), 'the agent can learn the date and time');
    const board = '.loop/outbox/signals.md';
    ok(/ENOENT|ERROR|not found|no such/i.test((await call('read_file', { path: board })).text), 'reading a board that does not exist yet fails in a way the agent can see and handle');
    const line1 = '- request_rate | state: open | at-decision: 2.8 | incident: .loop/outbox/incidents/2026-10-12-request_rate.md | analysis: - | note: new';
    ok(/^Wrote/.test((await call('write_file', { path: board, content: line1 + '\n- error_rate | state: closed | at-decision: 3.1 | incident: - | analysis: - | note: fixed\n' })).text), 'it can create the board');
    const edit = await call('edit_file', { path: board, oldText: line1, newText: line1.replace('state: open', 'state: watching-until 2026-10-20').replace('note: new', 'note: known batch job') });
    ok(/^Edited/.test(edit.text) && fs.readFileSync(path.join(R, board), 'utf8').includes('watching-until 2026-10-20') && fs.readFileSync(path.join(R, board), 'utf8').includes('error_rate | state: closed'), 'it can change exactly one line of the board and leave the others');
    ok(/already|0 times|matched/i.test((await call('edit_file', { path: board, oldText: 'a line that is not there', newText: 'x' })).text), 'an edit of a line that is not there is refused with a reason, not silently ignored');
    const dir = '.loop/outbox/notes/sentinel';
    ok(/^Wrote/.test((await call('write_file', { path: `${dir}/2026-10-12-0900.md`, content: '- 做了: x\n' })).text) && /^Wrote/.test((await call('write_file', { path: `${dir}/2026-10-12-1300.md`, content: '- 做了: y\n' })).text), 'it can write one note file per run (the folder is created on demand)');
    const listing = (await call('list_dir', { path: dir })).text;
    ok(listing.indexOf('2026-10-12-0900.md') >= 0 && listing.indexOf('2026-10-12-0900.md') < listing.indexOf('2026-10-12-1300.md'), 'listing the folder gives names that sort by time, so the last three are the newest');
    ok(/^Wrote/.test((await call('write_file', { path: '.loop/outbox/incidents/2026-10-12-request_rate.md', content: '# Signal\n' })).text), 'it can write an incident file');
    for (const bad of ['.github/agents/sentinel.agent.md', '.loop/policy.json', '.loop/policies/sentinel.json', '.loop/queue/x.json', 'repos/x.txt', '../outside.txt']) {
      const abs = path.join(R, bad), before = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      const r = await call('write_file', { path: bad, content: 'x' });
      const after = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : null;
      ok(/REFUSED|escapes|ERROR/.test(r.text) && after === before, `it cannot write ${bad} (refused, and the file is unchanged)`);
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
      'gh repo view your-org/harbor-docs', 'gh api repos/your-org/harbor-service/commits?per_page=5', 'date +%Y-%m-%d-%H%M'
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
      ok(['git push origin main', 'gh pr merge 1', 'curl http://x', 'ls repos', 'cat /etc/passwd', 'date -s 2020-01-01', 'date +%s; rm -rf x'].every(c => decideCommand(p, c, allow).decision !== 'allow' || hardReject(p, c)), `${n}: nothing but its skill's scripts and the read-only date`);
      ok(decideCommand(p, 'date +%Y-%m-%d-%H%M', allow).decision === 'allow', `${n}: may ask for the date and time (agents have no other clock)`);
      ok(p.writablePaths.length === 0, `${n}: can write only to the outbox`);
    }
  }
  fs.rmSync(R, { recursive: true, force: true });
  console.log(`${pass} harbor-team checks passed`);
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
