// Doctor (can it run?) and health report (is it worth keeping?). Both are model-free. Needs `tsc` first (npm test does it).
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const OUT = path.join(__dirname, '..', 'out');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };
const { runDoctor, doctorMarkdown, onPath } = require(`${OUT}/doctor.js`);
const { healthReport, healthMarkdown } = require(`${OUT}/health.js`);
const { runChatTool } = require(`${OUT}/chatTools.js`);

const w = (R, rel, text) => { const f = path.join(R, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const agent = (name, loop, extra = '') => `---\nname: ${name}\ndescription: ${name} agent\n${extra}loop:\n${loop}---\nYou handle ${name} work carefully. When a call depends on risk, ask the human with ask_human.\n`;
const skill = (R, name, script) => { w(R, `.github/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: Use when checking ${name}.\n---\nRun the script.\n`); if (script) { w(R, `.github/skills/${name}/scripts/check.js`, script); } };

(async () => {
  console.log('doctor');
  {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-doc-'));
    skill(R, 'quiet', 'process.exit(1)');
    skill(R, 'busy', 'console.log("3 failures"); process.exit(0)');
    skill(R, 'broken', 'console.error("no token"); process.exit(2)');
    skill(R, 'shell');
    w(R, '.github/skills/shell/scripts/run.sh', 'echo hi');
    w(R, '.github/agents/good.agent.md', agent('good', '  skills: [quiet]\n  schedule: "0 9 * * *"\n  task: Check.\n  wakeIf: node .github/skills/quiet/scripts/check.js\n'));
    w(R, '.github/agents/loud.agent.md', agent('loud', '  skills: [busy]\n  schedule: "0 9 * * *"\n  task: Check.\n  wakeIf: node .github/skills/busy/scripts/check.js\n'));
    w(R, '.github/agents/sick.agent.md', agent('sick', '  skills: [broken]\n  schedule: "0 9 * * *"\n  task: Check.\n  wakeIf: node .github/skills/broken/scripts/check.js\n'));
    w(R, '.github/agents/lost.agent.md', agent('lost', '  skills: [nowhere]\n'));
    w(R, '.github/agents/refused.agent.md', agent('refused', '  skills: [quiet]\n  schedule: "0 9 * * *"\n  task: Check.\n  wakeIf: curl http://example.com\n'));
    w(R, '.github/agents/needs-bash.agent.md', agent('needs-bash', '  skills: [shell]\n'));
    w(R, '.github/agents/chat-only.agent.md', '---\nname: chat-only\ndescription: x\n---\nHi.\n');

    const r = await runDoctor(R, { runProbes: true });
    const at = n => r.checks.filter(c => c.agent === n);
    ok(r.ready.includes('good') && r.ready.includes('loud'), 'agents whose probes exit 0 or 1 are ready');
    ok(at('good').some(c => c.level === 'ok' && /nothing to do/.test(c.what)) && at('loud').some(c => c.level === 'ok' && /wake/.test(c.what)), 'the probe result is described in plain words');
    ok(r.blocked.includes('sick') && at('sick').some(c => c.level === 'fail' && /exit 2/.test(c.what) && /no token/.test(c.what) && c.fix), 'a broken probe blocks the agent and shows its error');
    ok(at('lost').some(c => c.level === 'fail' && /skill "nowhere"/.test(c.what)), 'a missing skill is reported against its agent');
    ok(at('refused').some(c => c.level === 'fail' && /refused by policy/.test(c.what)), 'a probe policy would refuse is caught before it ever runs');
    ok(!r.checks.some(c => c.agent === 'chat-only'), 'a chat-only agent is not judged');
    const noRun = await runDoctor(R, { runProbes: false });
    ok(!noRun.checks.some(c => /ran: exit/.test(c.what)), 'without runProbes nothing is executed');
    const lone = await runDoctor(R, { agent: 'sick' });
    ok(lone.checks.every(c => c.agent === 'sick'), 'one agent can be checked on its own');
    ok(/Nothing|no agent named/i.test(doctorMarkdown(await runDoctor(R, { agent: 'ghost' }))) || (await runDoctor(R, { agent: 'ghost' })).blocked[0] === 'ghost', 'an unknown agent is explained');
    const md = doctorMarkdown(r);
    ok(/cannot run yet/.test(md) && md.includes('❌') && md.includes('✅'), 'the report reads as ready versus not ready');
    const nb = await runDoctor(R, { agent: 'needs-bash', pathEnv: '/nonexistent' });
    ok(nb.checks.some(c => c.level === 'fail' && /bash or sh/.test(c.what)), 'a missing interpreter is named');
    ok(onPath(['node']) === 'node' && onPath(['definitely-not-a-binary-xyz']) === undefined, 'interpreters are looked up on PATH');
    const tool = await runChatTool('run_doctor', { agent: 'good' }, { root: R, state: () => ({}), reload: async () => [] });
    ok(!/ran: exit/.test(tool.text), 'the chat tool checks but does not execute probes');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('health report');
  {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-health-'));
    w(R, '.github/agents/idle.agent.md', agent('idle', '  schedule: "*/15 * * * *"\n  task: Look.\n'));
    w(R, '.github/agents/stuck.agent.md', agent('stuck', '  schedule: "0 9 * * *"\n  task: Do.\n'));
    w(R, '.github/agents/nosy.agent.md', agent('nosy', '  schedule: "0 9 * * *"\n  task: Ask.\n'));
    const now = new Date('2026-10-14T12:00:00Z');
    const day = '2026-10-10';
    const run = (chain, name, status, events = []) => {
      const ev = [{ type: 'start', agent: name, ts: `${day}T09:00:00Z`, step: 0 }, ...events, { type: 'end', agent: name, status, summary: status, step: 3, outputs: [], ts: `${day}T09:05:00Z` }];
      w(R, `.loop/runs/${day}/${chain}.jsonl`, ev.map(e => JSON.stringify({ chainId: chain, ...e })).join('\n') + '\n');
    };
    for (let i = 0; i < 6; i++) { run(`i${i}`, 'idle', 'nothing_to_do'); }
    for (let i = 0; i < 4; i++) { run(`s${i}`, 'stuck', i < 3 ? 'blocked' : 'done', [{ type: 'tool', agent: 'stuck', name: 'run_command', input: { command: 'curl evil' }, decision: 'deny' }]); }
    for (let i = 0; i < 4; i++) { run(`n${i}`, 'nosy', 'done', [{ type: 'tool', agent: 'nosy', name: 'ask_human', input: {}, decision: 'allow' }]); }
    w(R, `.loop/runs/${day}/wake-${day}.jsonl`, [{ type: 'wake', agent: 'idle', goal: 'default', wake: true }, { type: 'wake', agent: 'idle', goal: 'default', wake: false }, { type: 'wake', agent: 'idle', goal: 'default', wake: false, error: 'boom' }, { type: 'wake', agent: 'idle', goal: 'default', wake: false, error: 'boom' }].map(e => JSON.stringify(e)).join('\n') + '\n');

    const h = healthReport(R, now, 14);
    const f = (a, re) => h.findings.some(x => x.agent === a && re.test(x.what));
    ok(f('idle', /found nothing to do/), 'an agent that always finds nothing is flagged, with a fix that names the probe');
    ok(f('stuck', /blocked/) && f('stuck', /refused 4|refused \d+ of its actions/i) && h.findings.find(x => x.agent === 'stuck' && /refused/i.test(x.what)).what.includes('curl evil'), 'repeated failures and refusals are flagged, with the refused command');
    ok(f('nosy', /asked the human 4 times/), 'an agent that asks every run is flagged');
    ok(f('idle', /probe was broken 2 times/), 'a broken probe is flagged');
    ok(h.findings[0].severity === 'high', 'the worst findings come first');
    ok(h.agents.find(a => a.agent === 'idle').wakes.skipped === 1 && h.agents.find(a => a.agent === 'idle').wakes.woke === 1, 'wake checks are counted');
    ok(healthReport(R, now, 2).agents.length === 0, 'runs outside the window are ignored');
    ok(/Worth a look/.test(healthMarkdown(h)) && /No runs/.test(healthMarkdown(healthReport(R, now, 1))), 'the markdown is readable and handles an empty window');
    const t = await runChatTool('agent_health', {}, { root: R, state: () => ({}), reload: async () => [] });
    ok(typeof t.text === 'string', 'the chat tool answers');
    fs.rmSync(R, { recursive: true, force: true });
  }
  console.log('starter templates');
  {
    const { TEMPLATES, installTemplate } = require(`${OUT}/templates.js`);
    for (const t of TEMPLATES) {
      const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-tpl-'));
      const res = installTemplate(R, t.id);
      ok(res.ok && Object.keys(t.files).every(f => fs.existsSync(path.join(R, f))), `${t.label}: installs its files`);
      const r = await runDoctor(R, { agent: t.agent, runProbes: true });
      ok(r.ready.includes(t.agent) && !r.checks.some(c => c.level !== 'ok'), `${t.label}: is ready as installed, with no warnings`);
      ok(!installTemplate(R, t.id).ok, `${t.label}: never overwrites`);
      fs.rmSync(R, { recursive: true, force: true });
    }
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-tpl-'));
    installTemplate(R, 'folder-watch');
    fs.mkdirSync(path.join(R, 'drop'), { recursive: true });
    fs.writeFileSync(path.join(R, 'drop', 'a.txt'), 'x');
    const { spawnSync } = require('child_process');
    const probe = () => spawnSync('node', ['.github/skills/drop-folder-probe/scripts/check.js'], { cwd: R, encoding: 'utf8' });
    ok(probe().status === 0 && probe().stdout.trim() === 'a.txt', 'the folder probe reports a new file');
    fs.mkdirSync(path.join(R, '.loop/outbox/folder-watch'), { recursive: true });
    fs.writeFileSync(path.join(R, '.loop/outbox/folder-watch/processed.txt'), 'a.txt\n');
    ok(probe().status === 1, 'and stays quiet once it is listed as processed');
    ok(!installTemplate(R, 'nope').ok, 'an unknown template is explained');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log('readiness after a change');
  {
    const R = fs.mkdtempSync(path.join(os.tmpdir(), 'loop-ready-'));
    w(R, '.github/agents/x.agent.md', agent('x', '  skills: [quiet]\n  schedule: "0 9 * * *"\n  task: Go.\n'));
    skill(R, 'quiet', 'process.exit(1)');
    const host = { root: R, state: () => ({}), reload: async () => [] };
    const res = await runChatTool('propose_skills', { agent: 'x', remove: ['quiet'] }, host);
    // removing the skill keeps the agent valid; adding a name that does not exist is refused up front
    ok(res.proposal, 'a skill change is proposed');
    const msg = await res.proposal.apply();
    ok(/Applied/.test(msg), 'and applied');
    const ok2 = await runChatTool('propose_schedule', { agent: 'x', wakeIf: 'node .github/skills/quiet/scripts/check.js' }, host);
    const msg2 = ok2.proposal ? await ok2.proposal.apply() : ok2.text;
    ok(/Not ready to run|Applied/.test(msg2), 'a change reports readiness or is refused with a reason');
    fs.rmSync(R, { recursive: true, force: true });
  }

  console.log(`${pass} doctor and health checks passed`);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
