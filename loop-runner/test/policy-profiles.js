// Policy profiles (strict / standard / trusted): what runs, what needs a human, what is never allowed, and when secrets are injected. Needs `tsc` first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const OUT = path.join(__dirname, '..', 'out');
const P = require(`${OUT}/policy.js`);
const { runTool } = require(`${OUT}/tools.js`);
const { setExtraPath } = require(`${OUT}/exec.js`);
const G = require(`${OUT}/gates.js`);
const Q = require(`${OUT}/queue.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-profiles-'));
const w = (rel, t) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };

const strict = P.loadPolicy(R, 'none.json', 'strict');
const standard = P.loadPolicy(R, 'none.json', 'standard');
const trusted = P.loadPolicy(R, 'none.json', 'trusted');
const dec = (p, c, extra = []) => P.decideCommand(p, c, extra);
const allowed = (p, c, extra) => dec(p, c, extra).decision === 'allow';
const asksHuman = (p, c) => { const d = dec(p, c); return d.decision === 'deny' && d.approval === true; };
const hard = (p, c) => !!P.hardReject(p, c);

console.log('which profile applies');
ok(strict.profile === 'strict' && standard.profile === 'standard' && trusted.profile === 'trusted', 'with no policy file the setting decides');
ok(P.loadPolicy(R, 'none.json').profile === 'standard', 'and the default is standard');
w('legacy.json', JSON.stringify({ allowCommands: ['^ls\\b'] }));
const legacy = P.loadPolicy(R, 'legacy.json', 'trusted');
ok(legacy.profile === 'strict' && legacy.denyCommands.join() === P.DEFAULT_POLICY.denyCommands.join() && !allowed(legacy, 'python3 x.py'), 'a policy file without profile is strict whatever the setting says');
w('std.json', JSON.stringify({ profile: 'standard', denyCommands: ['\\bfoo\\b'] }));
const stdFile = P.loadPolicy(R, 'std.json', 'strict');
ok(stdFile.profile === 'standard' && hard(stdFile, 'foo') && !hard(stdFile, 'sudo ls') && stdFile.approveCommands.length > 0 && stdFile.protectedPaths.includes('.github/**'), 'a file may name a profile, override deny rules, and keeps the protected floor');
ok(strict.denyCommands.join() === '\\brm\\s+-[a-z]*r,\\bgit (push|reset --hard|clean)\\b,\\b(curl|wget|ssh|scp|nc)\\b,\\bsudo\\b,>\\s*/', 'strict keeps its deny list exactly');
ok(!standard.denyCommands.some(r => /curl|ssh/.test(r)) && !trusted.denyCommands.some(r => /curl|ssh/.test(r)) && trusted.approveCommands.length === 0, 'standard and trusted do not deny curl/ssh; trusted has no approve list');

console.log('commands');
const free = ['python3 analyze.py', 'node -e "console.log(1)"', 'npm install', 'make build', 'git status', 'git commit -m x', 'curl https://example.com/api', 'curl -s https://x | jq .', 'rm -rf build', 'rm -rf ./node_modules', 'echo $(date)', 'echo `date`', 'cat a.json | python3 -c "import sys"', 'git push --dry-run-not-really-here'.replace('git push', 'git pull'), 'kubectl get pods', 'harbor deploy prod'];
ok(free.every(c => allowed(standard, c) && allowed(trusted, c)), 'standard and trusted allow ordinary commands, including substitution');
ok(!allowed(strict, 'python3 analyze.py') && !allowed(strict, 'echo $(date)') && hard(strict, 'echo $(date)'), 'strict still refuses what its allowlist lacks, and substitution');
const approve = ['git push', 'git push origin main', 'git -C repo push', 'git --no-pager push', 'npm publish', 'pnpm publish --tag x', 'kubectl apply -f x.yaml', 'helm upgrade a b', 'terraform destroy', 'docker push img', 'curl -X POST https://x', 'curl -XPUT https://x', 'curl -d a=b https://x', 'curl --data-binary @f https://x', 'wget --upload-file f https://x', 'ssh host ls', 'scp a b:c', 'rsync -a a b:c', 'nc -l 1', 'rm -rf /tmp/x', 'rm -r ~/x', 'git status && git push', 'ls | ssh h', 'echo $(git push)', 'echo `git push`'];
ok(approve.every(c => asksHuman(standard, c)), 'standard asks a human for push, publish, deploys, network writes, ssh, rm on absolute or home paths, in any segment or substitution');
ok(approve.every(c => !hard(standard, c) || /\$\(|`/.test(c) === false), 'and those are not hard rejects');
ok(approve.every(c => allowed(trusted, c)), 'trusted runs them without asking');
ok(['curl https://x', 'curl -s https://x/a.json', 'git log', 'git pull', 'rm -rf build', 'ssh-keygen -l -f k'.replace('ssh-keygen', 'echo')].every(c => allowed(standard, c)), 'reads and local deletes are not asked');
const never = ['sudo ls', 'git reset --hard', 'git clean -fd', 'echo x > /etc/passwd', 'rm -rf /', 'rm -rf ~', 'rm -fr /', 'rm -rf /*', 'rm -rf $HOME', 'rm / -rf', 'echo x > .env', 'echo x > .github/agents/a.md', 'echo x > ../out', 'echo x > ~/x'];
ok(never.every(c => hard(standard, c) && hard(trusted, c) && dec(standard, c).decision === 'deny' && !dec(standard, c).approval), 'sudo, hard reset, redirects out of the workspace or into protected paths and rm of / or ~ are hard rejects in both');
ok(!hard(standard, 'echo x > src/a.txt') && !hard(standard, 'echo x > anywhere/new.txt') && !hard(standard, 'echo x > .loop/scratch/t.txt') && !hard(standard, 'echo x > .loop/outbox/d.md'), 'redirects inside the workspace are fine');
ok(!hard(trusted, 'echo $(git status)') && asksHuman(standard, 'echo $(git push)') && allowed(trusted, 'echo $(git push)'), '$( is allowed in standard, but the whole string is still checked');

console.log('harbor');
ok(allowed(strict, 'harbor status --json') && allowed(strict, 'harbor logs | jq .') && !allowed(strict, 'harbor status && python3 x.py') && !allowed(strict, 'harbor-evil x'), 'harbor is allowed in strict by default, per segment, and only that word');
const custom = { ...P.DEFAULT_POLICY, allowCommands: ['^ls\\b'] };
ok(allowed(custom, 'harbor deploy prod') && !allowed(custom, 'cat x'), 'and in a custom strict file with its own allowlist');
ok(!allowed({ ...custom, denyCommands: ['\\bdeploy\\b'] }, 'harbor deploy prod'), 'deny rules still apply to harbor');
ok(allowed(standard, 'harbor deploy prod'), 'and in standard');

console.log('writes');
const writes = (p, f) => P.decideWrite(p, f).decision;
ok(writes(standard, 'any/where/new.txt') === 'allow' && writes(trusted, 'README.md') === 'allow', 'standard and trusted write anywhere in the workspace');
ok(['.loop/state.json', '.github/agents/a.agent.md', '.git/config', 'config/.env', 'x/secrets/k'].every(f => writes(standard, f) === 'deny' && writes(trusted, f) === 'deny'), 'except protected paths');
ok(writes(strict, 'README.md') === 'deny' && writes(strict, 'src/a.ts') === 'allow', 'strict still has writablePaths');
ok([strict, standard, trusted].every(p => writes(p, '.loop/scratch/a.py') === 'allow' && writes(p, '.loop/scratch/out/x.txt') === 'allow' && writes(p, '.loop/outbox/d.md') === 'allow' && writes(p, '.loop/queue/a.json') === 'deny'), '.loop/scratch is writable in every profile, the rest of .loop is not');
ok(hard(standard, 'echo x > /tmp/x') && hard(standard, 'echo x > ../x') && hard(trusted, 'echo x > ~/x'), 'outside the workspace is a hard reject');

(async () => {
console.log('approval');
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const agent = { name: 'a', handoffs: [] };
const ctx = (policy, extra = [], secrets = {}) => ({ root: R, agent, team: new Map(), item: { id: 'i1', agent: 'a', task: 't', from: 'user', chainId: 'c1', hop: 0, createdAt: '' }, policy, extraAllow: extra, secrets, maxHops: 5, token });
{
  const r = await runTool('run_command', { command: 'git push origin main' }, ctx(standard));
  ok(/^REFUSED/.test(r.text) && /request_approval/.test(r.text) && r.text.includes('git push origin main') && r.decision === 'deny', 'the refusal tells the model to call request_approval with that exact command');
  const g = (command) => { const id = Q.newId(); Q.saveGate(R, { id, kind: 'approval', agent: 'a', itemId: 'i' + id, chainId: 'c' + id, title: 't', body: 'b', files: [], command, resume: false, status: 'pending', createdAt: new Date().toISOString() }); return id; };
  const ap = await runTool('request_approval', { title: 'push', summary: 's', command: 'echo pushed # git push', wait: false }, ctx(standard));
  ok(/queued/.test(ap.text), 'request_approval accepts an approve-listed command');
  const run = await G.approveAndRun(R, g('echo pushed # git push'), standard, {});
  ok(run.ok && /pushed/.test(run.text), 'approveAndRun runs a command the approve list would have refused');
  await assert.rejects(() => G.approveAndRun(R, g('sudo echo hi'), standard, {}), /Blocked by deny rule/);
  ok(true, 'but a deny-listed one is refused even then');
  const none = await runTool('request_approval', { title: 'x', summary: 's', command: 'sudo ls' }, ctx(standard));
  ok(/^REFUSED/.test(none.text) && /deny rule/.test(none.text), 'and request_approval refuses it up front');
}

console.log('secrets');
{
  const bin = path.join(R, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'harbor'), '#!/bin/sh\necho "h[$MYSEC]"\n', { mode: 0o755 });
  setExtraPath([bin]);
  w('.github/skills/s/scripts/p.sh', '#!/bin/sh\necho "s[$MYSEC]"\n');
  const rule = P.skillScriptRule('.github/skills/s');
  const SEC = { MYSEC: 'hunter2-value' };
  const run = (policy, command, extra = [rule]) => runTool('run_command', { command }, ctx(policy, extra, SEC)).then(r => r.text);
  ok((await run(standard, 'bash .github/skills/s/scripts/p.sh')).includes('s[***]'), 'standard: a skill script gets the secrets');
  ok((await run(standard, 'harbor status')).includes('h[***]'), 'standard: harbor gets the secrets');
  ok((await run(standard, 'bash .github/skills/s/scripts/p.sh | harbor x')).includes('h[***]'), 'standard: a pipe of skill script and harbor does too');
  ok((await run(trusted, 'bash .github/skills/s/scripts/p.sh')).includes('s[***]'), 'trusted: same');
  const free = await run(standard, 'echo "e[$MYSEC]"');
  ok(free.includes('e[]'), 'standard: any other command runs without them');
  ok((await run(standard, `node -e "console.log([...(process.env.MYSEC||'none')].reverse().join(''))"`)).includes('enon'), 'so a script cannot print them reversed');
  ok((await run(standard, 'bash .github/skills/s/scripts/p.sh; echo "e[$MYSEC]"')).includes('e[]') , 'one free segment withholds them from the whole command');
  ok((await run(standard, 'bash .github/skills/s/scripts/p.sh "$(echo x)"')).includes('s[]'), 'and so does a substitution');
  ok((await run(standard, 'bash .github/skills/s/scripts/p.sh', [])).includes('s[]'), 'a script of a skill the agent does not list is just a command');
  ok((await run(strict, 'echo "e[$MYSEC]"', [])).includes('REFUSED') && (await run({ ...strict, allowCommands: ['^echo\\b'] }, 'echo "e[$MYSEC]"', [])).includes('e[***]'), 'strict: every allowed command gets them, as before');
  ok(!(await run(standard, 'echo "$MYSEC"')).includes('hunter2'), 'and no output carries the value');
  setExtraPath([]);
}

console.log('big output goes to disk');
{
  const SEC = { MYSEC: 'hunter2-value' };
  const small = { ...standard, maxOutputBytes: 2000 };
  const r = await runTool('run_command', { command: 'printf "%s\\n" hunter2-value; seq 1 5000' }, { ...ctx(small, [], SEC), step: 7 });
  const m = /Full output: (\.loop\/scratch\/out\/i1-7-[a-z0-9]+\.txt) \(5001 lines\)\. Use grep or read_file with startLine\.$/.exec(r.text);
  ok(m && r.text.includes('[truncated]') && r.text.length < 2300, 'a truncated result ends with the file, its line count and how to read it');
  const full = fs.readFileSync(path.join(R, m[1]), 'utf8');
  ok(full.includes('\n5000') && full.startsWith('[') === false && full.includes('***') && !full.includes('hunter2-value'), 'the file holds the whole output, redacted');
  const rd = await runTool('read_file', { path: m[1], startLine: 4990, endLine: 4995 }, ctx(small, [], SEC));
  ok(/4990\n4991/.test(rd.text.replace(/\r/g, '')), 'read_file reads it under .loop/scratch, from startLine');
  const short = await runTool('run_command', { command: 'seq 1 5' }, ctx(small, [], SEC));
  ok(!/Full output/.test(short.text) && !fs.existsSync(path.join(R, '.loop/scratch/out', fs.readdirSync(path.join(R, '.loop/scratch/out')).find(f => f.includes('-0-')) ?? 'none')), 'short output writes no file and mentions none');
}

fs.rmSync(R, { recursive: true, force: true });
console.log(`${n} policy-profile checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
