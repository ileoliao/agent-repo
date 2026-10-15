// One-click allow of a refused command: scope, deny rules, and what is written. Needs `tsc` first.
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const OUT = path.join(__dirname, '..', 'out');
const { planAllowCommand } = require(`${OUT}/policyEdit.js`);
const { applyChange } = require(`${OUT}/manage.js`);
const { decideCommand, loadPolicy } = require(`${OUT}/policy.js`);
const { loadAllAgents } = require(`${OUT}/team.js`);
let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; console.log('  ✓', m); };
const w = (R, rel, t) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, t); };
const agent = (name, loop = '') => `---\nname: ${name}\ndescription: ${name}\nloop:\n  schedule: "0 9 * * *"\n  task: Go.\n${loop}---\nYou do careful work and finish with a summary.\n`;
const world = () => {
  const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-allow-'));
  w(R, '.github/agents/a.agent.md', agent('a'));
  w(R, '.github/agents/b.agent.md', agent('b'));
  return R;
};
const allowed = (R, name, cmd) => { const a = loadAllAgents(R).get(name); return decideCommand(loadPolicy(R, a.policy ?? '.loop/policy.json', 'strict'), cmd).decision === 'allow'; };

console.log('allowing a refused command');
{
  const R = world();
  ok(!allowed(R, 'a', 'kubectl status --json'), 'it is refused to begin with');
  const plan = planAllowCommand(R, 'a', 'kubectl status --json');
  ok(!plan.error && plan.file === '.loop/policies/a.json' && plan.changes.length === 2 && plan.shared.length === 0, 'the plan gives that mate its own policy file and points the agent at it');
  for (const c of plan.changes) { applyChange(R, c); }
  ok(allowed(R, 'a', 'kubectl status --json'), 'then the command is allowed');
  ok(!allowed(R, 'a', 'kubectl deploy prod') && !allowed(R, 'a', 'kubectl status --json && kubectl deploy prod'), 'but nothing else, not even chained onto it');
  ok(allowed(R, 'a', 'git status'), 'and what it could already run still works');
  ok(!allowed(R, 'b', 'kubectl status --json'), 'another mate is unaffected');
  ok(loadAllAgents(R).get('a').policy === '.loop/policies/a.json', 'the agent file now names its policy');
  const again = planAllowCommand(R, 'a', 'kubectl status --json');
  ok(again.error && /already allowed/.test(again.error), 'allowing it twice is explained');
  const more = planAllowCommand(R, 'a', 'kubectl logs --json');
  ok(!more.error && more.changes.length === 1, 'a second command only adds a rule');
  for (const c of more.changes) { applyChange(R, c); }
  ok(allowed(R, 'a', 'kubectl logs --json') && allowed(R, 'a', 'kubectl status --json'), 'both are allowed');
  fs.rmSync(R, { recursive: true, force: true });
}
console.log('what is never one click');
{
  const R = world();
  ok(/deny rule/.test(planAllowCommand(R, 'a', 'curl https://example.com').error), 'a command a deny rule blocks is not unblocked');
  ok(/deny rule/.test(planAllowCommand(R, 'a', 'sudo ls').error), 'neither is sudo');
  ok(planAllowCommand(R, 'a', 'x\ny').error && planAllowCommand(R, 'a', '').error && planAllowCommand(R, 'a', 'x'.repeat(600)).error, 'empty, multi-line and huge commands are refused');
  ok(/not a mate/.test(planAllowCommand(R, 'ghost', 'ls').error), 'an unknown mate is refused');
  w(R, '.loop/policies/a.json', 'not json');
  w(R, '.github/agents/a.agent.md', agent('a', '  policy: .loop/policies/a.json\n'));
  ok(/not valid JSON|cannot be read/.test(planAllowCommand(R, 'a', 'kubectl status').error), 'a damaged policy file is left alone');
  fs.rmSync(R, { recursive: true, force: true });
}
console.log('a shared policy file');
{
  const R = world();
  w(R, '.loop/policies/team.json', JSON.stringify({ allowCommands: ['^ls\\b'], denyCommands: ['\\bsudo\\b'], writablePaths: [], protectedPaths: [], commandTimeoutSec: 60, maxOutputBytes: 8000 }));
  w(R, '.github/agents/a.agent.md', agent('a', '  policy: .loop/policies/team.json\n'));
  w(R, '.github/agents/b.agent.md', agent('b', '  policy: .loop/policies/team.json\n'));
  const plan = planAllowCommand(R, 'a', 'kubectl status');
  ok(!plan.error && plan.shared.join() === 'b' && plan.file === '.loop/policies/team.json', 'when the file is shared, the plan names who else it reaches');
  for (const c of plan.changes) { applyChange(R, c); }
  ok(allowed(R, 'a', 'ls') && allowed(R, 'a', 'kubectl status') && allowed(R, 'b', 'kubectl status'), 'and the existing rules are kept');
  w(R, '.github/agents/c.agent.md', agent('c'));
  const rx = planAllowCommand(R, 'c', 'echo a.b');
  for (const c of rx.changes) { applyChange(R, c); }
  ok(allowed(R, 'c', 'echo a.b') && !allowed(R, 'c', 'echo aXb'), 'special characters in the command are matched literally');
  fs.rmSync(R, { recursive: true, force: true });
}
console.log(`${n} allow-command checks passed`);
