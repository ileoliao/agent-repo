// Runs the harbor-team skill scripts (python3, standard library only) against local mock servers for Jira,
// HarborSense and GitHub, and checks the team definition loads. Run: npm test
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'out');
const SRC = path.join(__dirname, '..', 'examples', 'harbor-team');
let pass = 0;
const ok = (c, m) => { assert.ok(c, m); pass++; console.log('  ✓', m); };

const py = spawnSync('python3', ['--version']);
if (py.error || py.status !== 0) {
  console.log('harbor-team: SKIPPED, python3 was not found on PATH (the skill scripts need it)');
  process.exit(0);
}

const serve = handler => new Promise(res => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => res(s)); });
const url = s => `http://127.0.0.1:${s.address().port}`;
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const run = (ws, script, args, env = {}) => new Promise(res => {
  const p = spawn('python3', [path.join(ws, '.github', 'skills', script), ...args], { cwd: ws, env: { ...process.env, TZ: 'UTC', ...env } });
  let out = '', err = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { err += d; });
  p.on('close', code => res({ code, out, err }));
});
const workspace = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-team-')); fs.cpSync(SRC, d, { recursive: true }); return d; };

(async () => {
  console.log('team definition');
  {
    const { loadAgents, loadSkills, loadAllAgents, validateTeam } = require(`${OUT}/team.js`);
    const { decideCommand, loadPolicy, skillScriptRule } = require(`${OUT}/policy.js`);
    const team = loadAgents(SRC), skills = loadSkills(SRC);
    ok([...team.keys()].sort().join() === 'briefer,sentinel,techlead' && validateTeam(team, skills, loadAllAgents(SRC)).length === 0, 'briefer, sentinel and techlead load and validate clean');
    ok(team.get('briefer').schedule === '30 8 * * 1-5' && team.get('sentinel').schedule === '0 9,13,18 * * *' && !team.get('techlead').schedule, 'the brief runs weekday mornings, the check three times a day, techlead only on handoff');
    const s = team.get('sentinel');
    ok(decideCommand(loadPolicy(SRC, s.policy), s.wakeIf, s.skills.map(k => skillScriptRule(skills.get(k).relDir))).decision === 'allow', 'sentinel\'s zero-token pre-check passes its own policy');
    ok(s.handoffs.join() === 'techlead' && team.get('techlead').skills.join() === 'harbor,github-readonly', 'sentinel hands to techlead; techlead has HarborSense and read-only GitHub');
    const tl = loadPolicy(SRC, team.get('techlead').policy);
    ok(decideCommand(tl, 'git push origin main', []).decision !== 'allow' && decideCommand(tl, 'curl http://x', []).decision !== 'allow' && tl.writablePaths.length === 0, 'techlead cannot push, use the network directly, or write outside the outbox');
  }

  console.log('jira-board digest');
  {
    const issue = (key, cat, status, extra = {}) => ({ key, fields: { summary: `Issue ${key} ` + 'x'.repeat(100), status: { name: status, statusCategory: { key: cat } }, assignee: extra.who === null ? null : { displayName: extra.who || 'Alice' },
      updated: extra.updated || '2026-10-12T06:00:00.000+0000', created: '2026-10-05T00:00:00.000+0000', labels: extra.labels || [], duedate: extra.due || null, resolutiondate: extra.resolved || null, issuelinks: extra.links || [] } });
    const day1 = [
      issue('H-1', 'done', 'Done', { resolved: '2026-10-11T20:00:00.000+0000' }),
      issue('H-2', 'indeterminate', 'In Progress', { who: 'Bob', updated: '2026-10-05T06:00:00.000+0000' }),
      issue('H-3', 'new', 'To Do', { who: 'Carol', due: '2026-10-10' }),
      issue('H-4', 'indeterminate', 'In Progress', { who: 'Bob', labels: ['Blocked'] }),
      issue('H-5', 'new', 'To Do', { who: null, due: '2026-10-13' }),
      issue('H-6', 'indeterminate', 'In Progress', { links: [{ type: { inward: 'is blocked by' }, inwardIssue: { key: 'H-9', fields: { status: { statusCategory: { key: 'new' } } } } }] })
    ];
    let issues = day1, calls = 0;
    const jira = await serve((req, res) => {
      calls++;
      if (req.headers.authorization !== 'Basic ' + Buffer.from('me@example.com:tok').toString('base64')) { return json(res, 401, {}); }
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/rest/agile/1.0/board/7') { return json(res, 200, { id: 7, name: 'Harbor Team', type: 'scrum' }); }
      if (u.pathname === '/rest/agile/1.0/board/7/sprint') { return json(res, 200, { values: [{ id: 11, name: 'Sprint 42', goal: 'Ship it', startDate: '2026-10-05T00:00:00.000Z', endDate: '2026-10-19T00:00:00.000Z' }], isLast: true }); }
      if (u.pathname === '/rest/agile/1.0/sprint/11/issue') { return json(res, 200, { issues, total: issues.length, startAt: 0, maxResults: 50 }); }
      json(res, 404, {});
    });
    const ws = workspace();
    const env = { JIRA_BASE_URL: url(jira), JIRA_BOARD_ID: '7', JIRA_EMAIL: 'me@example.com', JIRA_TOKEN: 'tok' };
    const r = await run(ws, 'jira-board/scripts/digest.py', ['--now', '2026-10-12T08:30:00Z'], env);
    ok(r.code === 0, 'the digest runs: ' + r.err);
    const d = JSON.parse(r.out);
    ok(d.totals.todo === 2 && d.totals.doing === 3 && d.totals.done === 1 && d.totals.unassignedOpen === 1 && d.totals.doneLast24h === 1, 'counts by status, unassigned and done in the last 24 hours');
    ok(d.risks.blocked.map(x => x.key).sort().join() === 'H-4,H-6', 'blocked by label (any case) and by an open blocking link');
    ok(d.risks.overdue.length === 1 && d.risks.overdue[0].key === 'H-3' && d.risks.overdue[0].daysLate === 2 && d.risks.dueSoon[0].key === 'H-5', 'overdue and due-soon items');
    ok(d.risks.stale.length === 1 && d.risks.stale[0].key === 'H-2', 'in-progress work with no update for days is flagged as stale');
    ok(d.sprint.name === 'Sprint 42' && d.sprint.daysLeft === 6 && typeof d.sprint.behindSchedule === 'boolean' && d.delta === null, 'sprint progress is computed and the first run has no delta');
    ok(d.risks.blocked[0].summary.length <= 80 && d.risks.blocked[0].url === `${url(jira)}/browse/${d.risks.blocked[0].key}`, 'summaries are cut and every item links to Jira');
    issues = [...day1.filter(i => i.key !== 'H-2'), issue('H-2', 'done', 'Done', { who: 'Bob', resolved: '2026-10-12T20:00:00.000+0000' }), issue('H-7', 'new', 'To Do')];
    const r2 = await run(ws, 'jira-board/scripts/digest.py', ['--now', '2026-10-13T08:30:00Z'], env);
    const d2 = JSON.parse(r2.out);
    ok(d2.delta.since === '2026-10-12' && d2.delta.newlyDone.join() === 'H-2' && d2.delta.added.join() === 'H-7' && d2.delta.newlyBlocked.length === 0, 'the next day shows what changed since the last snapshot');
    const bad = await run(ws, 'jira-board/scripts/digest.py', [], { ...env, JIRA_TOKEN: 'wrong' });
    ok(bad.code === 3 && /rejected the credentials/.test(bad.err) && bad.out === '', 'rejected credentials: exit 3, the reason on stderr, nothing on stdout');
    const noTok = await run(ws, 'jira-board/scripts/digest.py', [], { ...env, JIRA_TOKEN: '' });
    ok(noTok.code === 2 && /JIRA_TOKEN/.test(noTok.err), 'a missing token is a configuration error (exit 2)');
    const noUrl = await run(ws, 'jira-board/scripts/digest.py', [], { JIRA_TOKEN: 'x', JIRA_BASE_URL: '' });
    ok(noUrl.code === 2 && /base URL|board id/.test(noUrl.err), 'an unset base URL or board is a configuration error');
    jira.close(); fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('harbor detect and query');
  {
    const NOW = Date.parse('2026-10-12T09:00:00Z');
    let mode = 'spike', hits = 0;
    const harbor = await serve((req, res) => {
      hits++;
      if (req.headers.authorization !== 'Bearer pat') { return json(res, 401, {}); }
      const u = new URL(req.url, 'http://x'), q = u.searchParams;
      if (u.pathname === '/api/v1/metrics/query') {
        const from = +q.get('from'), to = +q.get('to'), pts = [];
        if (mode === 'thin' && to < NOW / 1000 - 2 * 86400) { return json(res, 200, { data: { points: [] } }); }
        for (let t = from; t < to; t += 600) {
          const spiking = mode === 'spike' && t >= NOW / 1000 - 4 * 3600;
          pts.push({ t, v: q.get('signal') === 'error_rate' ? 0.01 : (spiking ? 300 : 100) + (t % 7) });
        }
        return json(res, 200, { data: { points: pts } });
      }
      if (u.pathname === '/api/v1/traffic/top') { return json(res, 200, { data: { items: [{ key: `${q.get('by')}-9`, count: 1234 }] } }); }
      json(res, 404, {});
    });
    const ws = workspace();
    const env = { HARBOR_BASE_URL: url(harbor), HARBOR_PAT: 'pat' };
    const args = ['--now', '2026-10-12T09:00:00Z', '--window', '4h'];
    let r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], env);
    ok(r.code === 0, 'a traffic spike exits 0 so the agent wakes: ' + r.err);
    const d = JSON.parse(r.out);
    ok(d.anomalies.length === 1 && d.anomalies[0].signal === 'request_rate' && d.anomalies[0].ratio > 2.5 && /x the baseline/.test(d.anomalies[0].rule) && d.clear[0].signal === 'error_rate', 'only the spiking signal is reported; the quiet one is clear');
    ok(d.anomalies[0].anchors.client[0].key === 'client-9' && d.anomalies[0].existingIncident === null && d.anomalies[0].windowStart.startsWith('2026-10-12T05:00'), 'the output carries anchors, the window and no existing incident');
    fs.mkdirSync(path.join(ws, '.loop', 'outbox', 'incidents'), { recursive: true });
    fs.writeFileSync(path.join(ws, '.loop', 'outbox', 'incidents', '2026-10-12-request_rate.md'), '# open');
    r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], env);
    ok(JSON.parse(r.out).anomalies[0].existingIncident === '.loop/outbox/incidents/2026-10-12-request_rate.md', 'a signal with an incident open in the last 24 hours points at that file');
    mode = 'calm';
    r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], env);
    ok(r.code === 1 && JSON.parse(r.out).anomalies.length === 0, 'normal traffic exits 1: no model call');
    r = await run(ws, 'harbor/scripts/detect.py', args, env);
    ok(r.code === 0, 'without --exit-code a clear result is still exit 0');
    mode = 'thin';
    r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], env);
    ok(r.code === 1 && JSON.parse(r.out).dataGaps.length === 2 && /baseline/.test(JSON.parse(r.out).dataGaps[0]), 'too little baseline is reported as a data gap, never as an anomaly or as "fine"');
    r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], { ...env, HARBOR_PAT: 'nope' });
    ok(r.code === 3 && /rejected the credentials/.test(r.err), 'a broken check exits 3 (the runtime alerts, it does not wake the model)');
    r = await run(ws, 'harbor/scripts/detect.py', [...args, '--exit-code'], { HARBOR_BASE_URL: url(harbor), HARBOR_PAT: '' });
    ok(r.code === 3 && /HARBOR_PAT/.test(r.err), 'a missing token also reads as broken, not as all clear');
    r = await run(ws, 'harbor/scripts/detect.py', ['--window', 'soon'], env);
    ok(r.code === 3 && /bad duration/.test(r.err), 'a bad window is an error, not a pass');
    mode = 'spike';
    const q = await run(ws, 'harbor/scripts/query.py', ['series', '--signal', 'request_rate', '--from', '2026-10-12T05:00:00Z', '--to', '2026-10-12T09:00:00Z'], env);
    const qs = JSON.parse(q.out);
    ok(q.code === 0 && qs.points > 0 && qs.max > 290 && qs.sample.length <= 48 && qs.peakAt, 'series gives summary statistics and a bounded sample');
    const b = await run(ws, 'harbor/scripts/query.py', ['breakdown', '--signal', 'request_rate', '--from', '2026-10-12T05:00:00Z', '--to', '2026-10-12T09:00:00Z', '--by', 'path'], env);
    ok(b.code === 0 && JSON.parse(b.out).items[0].key === 'path-9', 'breakdown lists the top contributors');
    harbor.close(); fs.rmSync(ws, { recursive: true, force: true });
  }

  console.log('github-readonly');
  {
    const seen = [];
    const gh = await serve((req, res) => {
      seen.push(req.url);
      if (req.headers.authorization !== 'Bearer ghp') { return json(res, 401, {}); }
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/search/code') { return json(res, 200, { total_count: 1, items: [{ path: 'src/limit.go', html_url: 'https://github.com/your-org/harbor-service/blob/main/src/limit.go', text_matches: [{ fragment: 'func RateLimit()' }] }] }); }
      if (u.pathname.startsWith('/repos/your-org/harbor-service/contents/src/limit.go')) { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n')); }
      if (u.pathname === '/repos/your-org/harbor-docs/contents/') { return json(res, 200, [{ name: 'runbook.md', type: 'file', size: 10 }]); }
      if (u.pathname === '/repos/your-org/harbor-service/commits') { return json(res, 200, [{ sha: 'abcdef1234567890', html_url: 'u', commit: { author: { name: 'Dev', date: '2026-10-12T01:00:00Z' }, message: 'Raise limit\n\nbody' } }]); }
      json(res, 404, {});
    });
    const ws = workspace();
    const env = { GITHUB_API_URL: url(gh), GITHUB_TOKEN: 'ghp' };
    const g = (args, e = env) => run(ws, 'github-readonly/scripts/gh_read.py', args, e);
    let r = await g(['repos']);
    ok(JSON.parse(r.out).allowedRepos.includes('your-org/harbor-service'), 'repos lists what may be read');
    r = await g(['search', '--repo', 'your-org/harbor-service', '--q', 'RateLimit']);
    ok(r.code === 0 && JSON.parse(r.out).items[0].path === 'src/limit.go' && seen.some(s => s.includes('repo%3Ayour-org%2Fharbor-service')), 'code search is scoped to the repository');
    r = await g(['file', '--repo', 'your-org/harbor-service', '--path', 'src/limit.go', '--ref', 'main', '--start', '5', '--end', '7']);
    ok(r.code === 0 && /lines 5-7 of 30/.test(r.out) && /\s5  line 5/.test(r.out) && /blob\/main\/src\/limit.go#L5-L7/.test(r.out) && !/line 8/.test(r.out), 'a file range is numbered and links to the exact lines');
    r = await g(['tree', '--repo', 'your-org/harbor-docs']);
    ok(JSON.parse(r.out).entries[0].name === 'runbook.md', 'a docs repository can be listed');
    r = await g(['commits', '--repo', 'your-org/harbor-service', '--since', '2026-10-11T00:00:00Z']);
    ok(JSON.parse(r.out)[0].message === 'Raise limit' && JSON.parse(r.out)[0].sha.length === 10, 'recent commits are summarised');
    const before = seen.length;
    r = await g(['file', '--repo', 'someone/else', '--path', 'a']);
    ok(r.code === 2 && /not in allowedRepos/.test(r.err) && seen.length === before, 'a repository outside the allow-list is refused before any request');
    r = await g(['file', '--repo', 'your-org/harbor-service', '--path', '../secrets']);
    ok(r.code === 2 && seen.length === before, 'a path with .. is refused before any request');
    r = await g(['file', '--repo', 'your-org/harbor-service', '--path', 'a'], { ...env, GITHUB_TOKEN: '' });
    ok(r.code === 2 && /GITHUB_TOKEN/.test(r.err), 'a missing token is reported');
    r = await g(['file', '--repo', 'your-org/harbor-service', '--path', 'missing.go'], env);
    ok(r.code === 3 && /not found/.test(r.err), 'a 404 explains the likely causes');
    const src = fs.readFileSync(path.join(SRC, '.github/skills/github-readonly/scripts/gh_read.py'), 'utf8');
    ok(!/method\s*=\s*['"](POST|PUT|PATCH|DELETE)/i.test(src) && !/\bdata\s*=/.test(src), 'the script has no write verbs');
    gh.close(); fs.rmSync(ws, { recursive: true, force: true });
  }
  console.log(`${pass} harbor-team checks passed`);
})().catch(e => { console.error('FAILED:', e.message); console.error(e.stack); process.exit(1); });
