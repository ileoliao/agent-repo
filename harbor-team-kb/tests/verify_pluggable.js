#!/usr/bin/env node
/**
 * End-to-end verification suite for harbor-team-kb pluggability into Harbor Mate (loop-runner).
 *
 * Exercises:
 *   1. Real Harbor Mate `lintSkill` & `designWarnings` static safety/budget audits
 *   2. Golden retrieval benchmark (Recall@1, Recall@5, MRR, 2-char CJK bigrams, camelCase/snake_case, noise, latency)
 *   3. Schema validator, secret/local-path leak blocker, expired/disputed demotion, near-duplicate detector
 *   4. 24-process parallel cold-cache rebuild & search stress test (`fcntl.flock` + atomic `os.replace`)
 *   5. One-command `plug.py install` (symlink & copy modes) + byte-exact `plug.py uninstall` on `examples/harbor-team`
 *   6. Strictest `techlead.json` policy compatibility, `publish.py` direct-exec denial, SHA-256 tamper rejection,
 *      and Git branch push -> `sentinel` `--sync` shared knowledge closed loop
 *   7. Full unattended `runItem` loop + `kb-gardener` zero-token `checkWake` (`drift --exit-code`) on code refactor
 *   8. `kb.py dispute` contradiction workflow
 */
const Module = require('module');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawn, spawnSync } = require('child_process');

// ---- Mock minimal `vscode` surface so Harbor Mate's compiled runtime loads directly in Node ----
class TextPart { constructor(value) { this.value = value; } }
class ToolCallPart { constructor(callId, name, input) { this.callId = callId; this.name = name; this.input = input; } }
class ToolResultPart { constructor(callId, content) { this.callId = callId; this.content = content; } }
const vscodeMock = {
  LanguageModelTextPart: TextPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelChatMessage: {
    User: c => ({ role: 'user', content: c }),
    Assistant: c => ({ role: 'assistant', content: c }),
  },
  LanguageModelChatToolMode: { Auto: 1, Required: 2 },
  LanguageModelError: class extends Error {},
  workspace: {
    workspaceFolders: undefined,
    getConfiguration: () => ({ get: (_k, d) => d, inspect: () => undefined }),
  },
  window: { showInformationMessage: () => Promise.resolve(undefined) },
  CancellationTokenSource: class {
    constructor() {
      this.cbs = [];
      this.token = {
        isCancellationRequested: false,
        onCancellationRequested: cb => { this.cbs.push(cb); return { dispose() {} }; },
      };
    }
    cancel() { this.token.isCancellationRequested = true; this.cbs.forEach(cb => cb()); }
    dispose() {}
  },
};
const origLoad = Module._load;
Module._load = function (req, ...rest) {
  return req === 'vscode' ? vscodeMock : origLoad.call(this, req, ...rest);
};

const KB_ROOT = path.resolve(__dirname, '..');
const LOOP_RUNNER = path.resolve(KB_ROOT, '..', 'loop-runner');
const OUT = path.join(LOOP_RUNNER, 'out');
const EXAMPLE_WS = path.join(LOOP_RUNNER, 'examples', 'harbor-team');

if (!fs.existsSync(path.join(OUT, 'team.js'))) {
  console.error('Missing compiled loop-runner/out. Run `npm run compile` in loop-runner first.');
  process.exit(2);
}

const { loadAgents, loadAllAgents, loadSkills, validateTeam } = require(`${OUT}/team.js`);
const { parseFrontmatter } = require(`${OUT}/frontmatter.js`);
const { lintSkill } = require(`${OUT}/skillAuthoring.js`);
const { designWarnings } = require(`${OUT}/manage.js`);
const { loadPolicy, decideCommand, decideWrite, skillScriptRule } = require(`${OUT}/policy.js`);
const { checkWake } = require(`${OUT}/wake.js`);
const { runTool } = require(`${OUT}/tools.js`);
const { runItem } = require(`${OUT}/runner.js`);
const Q = require(`${OUT}/queue.js`);
const G = require(`${OUT}/gates.js`);

const KB_PY = path.join(KB_ROOT, 'skills', 'team-kb', 'scripts', 'kb.py');
const PLUG_PY = path.join(KB_ROOT, 'plug.py');
const GOLDEN_PATH = path.join(__dirname, 'golden_queries.json');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
};

function py(args, opts = {}) {
  const res = spawnSync('python3', args, {
    encoding: 'utf8',
    timeout: 30000,
    ...opts,
  });
  return res;
}

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 30000 });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
  return res.stdout.trim();
}

function snapshotTree(root) {
  const out = {};
  function walk(dir) {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, d.name);
      const rel = path.relative(root, abs).replace(/\\/g, '/');
      if (d.isSymbolicLink()) {
        out[rel] = `symlink:${fs.readlinkSync(abs)}`;
      } else if (d.isDirectory()) {
        walk(abs);
      } else if (d.isFile()) {
        out[rel] = fs.readFileSync(abs, 'utf8');
      }
    }
  }
  walk(root);
  return out;
}

function stubExternalSkills(wsRoot) {
  for (const name of ['jira-board', 'harborsense-investigate', 'harbor-anomaly-detect']) {
    const dir = path.join(wsRoot, '.github', 'skills', name);
    fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Use when testing ${name} stub.\n---\nStub skill.\n`
    );
    if (name === 'harbor-anomaly-detect') {
      fs.writeFileSync(path.join(dir, 'scripts', 'detect.py'), 'import sys; sys.exit(1)\n');
    }
  }
}

(async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-kb-verify-'));
  const isolatedHome = path.join(tmpBase, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  // Copy git identity if present or configure isolated HOME gitconfig so git commits work cleanly
  const origHome = process.env.HOME;
  process.env.HOME = isolatedHome;
  spawnSync('git', ['config', '--global', 'user.name', 'Harbor KB Verifier'], { encoding: 'utf8' });
  spawnSync('git', ['config', '--global', 'user.email', 'verifier@example.local'], { encoding: 'utf8' });
  spawnSync('git', ['config', '--global', 'init.defaultBranch', 'main'], { encoding: 'utf8' });

  const metrics = {};

  try {
    // =========================================================================
    // 1. Static Harbor Mate Lint & Design Audits
    // =========================================================================
    console.log('\n1. Harbor Mate lintSkill & designWarnings compliance');
    {
      const emptyRoot = path.join(tmpBase, 'empty-lint-root');
      fs.mkdirSync(emptyRoot, { recursive: true });
      const loadSkillAsSpec = (skillDirPath) => {
        const rawSkill = fs.readFileSync(path.join(skillDirPath, 'SKILL.md'), 'utf8');
        const fm = parseFrontmatter(rawSkill);
        const scriptsDir = path.join(skillDirPath, 'scripts');
        const scripts = fs.existsSync(scriptsDir)
          ? fs.readdirSync(scriptsDir).map(name => ({ name, content: fs.readFileSync(path.join(scriptsDir, name), 'utf8') }))
          : [];
        return {
          name: fm.meta.name,
          description: fm.meta.description,
          instructions: fm.body.trim(),
          scripts,
          references: [],
        };
      };

      const kbFindings = lintSkill(emptyRoot, loadSkillAsSpec(path.join(KB_ROOT, 'skills', 'team-kb')));
      ok(
        kbFindings.length === 0,
        `team-kb passes lintSkill with 0 errors & 0 warnings (got ${JSON.stringify(kbFindings)})`
      );

      const pubFindings = lintSkill(emptyRoot, loadSkillAsSpec(path.join(KB_ROOT, 'skills', 'team-kb-publish')));
      ok(
        pubFindings.length === 0,
        `team-kb-publish passes lintSkill with 0 errors & 0 warnings (got ${JSON.stringify(pubFindings)})`
      );

      const lintWs = path.join(tmpBase, 'lint-ws');
      fs.cpSync(EXAMPLE_WS, lintWs, { recursive: true });
      stubExternalSkills(lintWs);
      const plugRes = py([PLUG_PY, 'install', '--workspace', lintWs, '--mode', 'copy', '--agents', 'all', '--with-gardener']);
      assert.strictEqual(plugRes.status, 0, plugRes.stderr);

      const team = loadAgents(lintWs);
      const skills = loadSkills(lintWs);
      const allAgents = loadAllAgents(lintWs);
      const teamErrs = validateTeam(team, skills, allAgents);
      ok(teamErrs.length === 0, `validateTeam passes with kb-gardener + wired mates (${JSON.stringify(teamErrs)})`);

      const gWarn = designWarnings(team.get('kb-gardener'));
      ok(gWarn.length === 0, `kb-gardener.agent.md has 0 designWarnings (${JSON.stringify(gWarn)})`);
    }

    // =========================================================================
    // 2. Golden Retrieval Benchmark & Hybrid Tokenizer Evaluation
    // =========================================================================
    console.log('\n2. Golden retrieval benchmark & hybrid CJK/code tokenizer');
    {
      const benchCache = path.join(tmpBase, 'bench-cache');
      const env = { ...process.env, HARBOR_KB_CACHE_DIR: benchCache };

      const tCold0 = performance.now();
      const buildRes = py([KB_PY, '--kb-root', KB_ROOT, 'stats', '--json'], { env });
      const coldBuildMs = +(performance.now() - tCold0).toFixed(1);
      assert.strictEqual(buildRes.status, 0, buildRes.stderr);
      const statsObj = JSON.parse(buildRes.stdout);
      ok(statsObj.rebuilt === true && statsObj.total_entries === 12, `cold FTS5 index built for ${statsObj.total_entries} seed entries in ${coldBuildMs}ms`);

      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
      const posQueries = golden.filter(q => !q.expect_empty);
      const negQueries = golden.filter(q => q.expect_empty);

      let top1Hits = 0;
      let top5Hits = 0;
      let rrs = 0;
      const latencies = [];

      for (const g of posQueries) {
        const t0 = performance.now();
        const r = py([KB_PY, '--kb-root', KB_ROOT, 'search', '--json', g.query], { env });
        latencies.push(performance.now() - t0);
        assert.strictEqual(r.status, 0, r.stderr);
        const parsed = JSON.parse(r.stdout);
        const ids = parsed.results.map(x => x.id);
        const rank = ids.indexOf(g.expect_top1);
        if (rank === 0) top1Hits++;
        if (rank >= 0 && rank < 5) {
          top5Hits++;
          rrs += 1 / (rank + 1);
        } else {
          console.error(`  MISS for "${g.query}": expected ${g.expect_top1}, got ${JSON.stringify(ids)}`);
        }
      }

      let negClean = 0;
      for (const g of negQueries) {
        const r = py([KB_PY, '--kb-root', KB_ROOT, 'search', '--json', g.query], { env });
        const parsed = JSON.parse(r.stdout);
        if (parsed.results.length === 0) negClean++;
      }

      latencies.sort((a, b) => a - b);
      const p50Ms = +latencies[Math.floor(latencies.length * 0.5)].toFixed(1);
      const p95Ms = +latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))].toFixed(1);
      const recall1 = +(top1Hits / posQueries.length).toFixed(4);
      const recall5 = +(top5Hits / posQueries.length).toFixed(4);
      const mrr = +(rrs / posQueries.length).toFixed(4);

      metrics.coldBuildMs = coldBuildMs;
      metrics.p50Ms = p50Ms;
      metrics.p95Ms = p95Ms;
      metrics.recall1 = recall1;
      metrics.recall5 = recall5;
      metrics.mrr = mrr;
      metrics.positiveCases = posQueries.length;
      metrics.negativeCases = negQueries.length;

      ok(recall1 === 1 && recall5 === 1 && mrr === 1, `Recall@1=${recall1 * 100}%, Recall@5=${recall5 * 100}%, MRR=${mrr} across ${posQueries.length} golden queries (p50=${p50Ms}ms, p95=${p95Ms}ms)`);
      ok(negClean === negQueries.length, `unrelated noise queries return 0 false-positive hits (${negClean}/${negQueries.length})`);

      // Verify Push path: redlines filter
      const redGw = JSON.parse(py([KB_PY, '--kb-root', KB_ROOT, 'redlines', '--repo', 'harbor-gateway', '--json'], { env }).stdout);
      ok(
        redGw.count === 1 && redGw.redlines[0].id === 'gateway/redline/rate-limit-shadow-mode-first',
        'redlines --repo harbor-gateway pushes only the gateway guardrail without unrelated domains'
      );

      // Verify expired & disputed ranking demotion + warnings
      const rankKb = path.join(tmpBase, 'rank-kb');
      fs.mkdirSync(path.join(rankKb, 'kb', 'gateway', 'gotcha'), { recursive: true });
      const mkEntry = (slug, extraFm) =>
        `---\ntitle: "Envoy idle timeout reset"\nsummary: "Envoy resets idle upstream stream with 503."\nsources: ["gw:a.go#Dial"]\ntriggers: ["envoy_idle_reset"]\n${extraFm}---\nDetails about envoy_idle_reset.\n`;
      fs.writeFileSync(path.join(rankKb, 'kb', 'gateway', 'gotcha', 'fresh-entry.md'), mkEntry('fresh-entry', ''));
      fs.writeFileSync(path.join(rankKb, 'kb', 'gateway', 'gotcha', 'expired-entry.md'), mkEntry('expired-entry', 'expires: "2026-01-10"\n'));
      fs.writeFileSync(path.join(rankKb, 'kb', 'gateway', 'gotcha', 'disputed-entry.md'), mkEntry('disputed-entry', 'disputed: "2026-03-01: no longer happens"\n'));

      const rankRes = JSON.parse(
        py([KB_PY, '--kb-root', rankKb, '--now', '2026-04-12', 'search', '--json', 'envoy_idle_reset'], { env }).stdout
      );
      ok(
        rankRes.results[0].id === 'gateway/gotcha/fresh-entry' &&
          rankRes.results.find(x => x.id.endsWith('expired-entry')).flags.some(f => f.startsWith('EXPIRED')) &&
          rankRes.results.find(x => x.id.endsWith('disputed-entry')).flags.includes('DISPUTED'),
        'fresh knowledge ranks above expired and disputed entries, and flags are surfaced'
      );

      // 500-entry scale & distractor benchmark (12 golden entries + 488 synthetic multi-domain entries)
      const scaleKb = path.join(tmpBase, 'scale-500-kb');
      const scaleCache = path.join(tmpBase, 'scale-500-cache');
      fs.cpSync(path.join(KB_ROOT, 'kb'), path.join(scaleKb, 'kb'), { recursive: true });
      const scaleDomains = ['auth', 'billing', 'ci', 'compute', 'data', 'mesh', 'network', 'search'];
      const scaleKinds = ['gotcha', 'runbook', 'adr', 'postmortem'];
      for (let i = 0; i < 488; i++) {
        const dom = scaleDomains[i % scaleDomains.length];
        const knd = scaleKinds[i % scaleKinds.length];
        const dir = path.join(scaleKb, 'kb', dom, knd);
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
          path.join(dir, `synthetic-item-${String(i).padStart(4, '0')}.md`),
          `---\ntitle: "${dom} service module ${i} timeout calibration note"\nsummary: "Operational parameter tuning note ${i} for ${dom} worker queue batching and retry backoff."\nsources:\n  - "harbor-${dom}:internal/worker/handler_${i}.go#HandleBatch${i}"\ntriggers:\n  - "HandleBatch${i}"\n  - "${dom}_queue_${i}"\n---\n\nDetailed operational verification steps for ${dom} worker shard ${i} under elevated queue depth.\n`
        );
      }
      const scaleEnv = { ...process.env, HARBOR_KB_CACHE_DIR: scaleCache };
      const tScaleCold0 = performance.now();
      const scaleStats = JSON.parse(py([KB_PY, '--kb-root', scaleKb, 'stats', '--json'], { env: scaleEnv }).stdout);
      const scaleColdMs = +(performance.now() - tScaleCold0).toFixed(1);

      let scaleTop1 = 0;
      let scaleTop5 = 0;
      const scaleLatencies = [];
      for (const g of posQueries) {
        const ts0 = performance.now();
        const sr = JSON.parse(py([KB_PY, '--kb-root', scaleKb, 'search', '--json', g.query], { env: scaleEnv }).stdout);
        scaleLatencies.push(performance.now() - ts0);
        const sIds = sr.results.map(x => x.id);
        const sRank = sIds.indexOf(g.expect_top1);
        if (sRank === 0) scaleTop1++;
        if (sRank >= 0 && sRank < 5) scaleTop5++;
      }
      scaleLatencies.sort((a, b) => a - b);
      const scaleP50Ms = +scaleLatencies[Math.floor(scaleLatencies.length * 0.5)].toFixed(1);
      metrics.scale500ColdBuildMs = scaleColdMs;
      metrics.scale500WarmP50Ms = scaleP50Ms;
      metrics.scale500Recall1 = +(scaleTop1 / posQueries.length).toFixed(4);
      metrics.scale500Recall5 = +(scaleTop5 / posQueries.length).toFixed(4);
      ok(
        scaleStats.total_entries === 500 && scaleColdMs < 2000 && scaleTop5 === posQueries.length && scaleTop1 >= posQueries.length - 1,
        `500-entry scale test: cold FTS5 build=${scaleColdMs}ms, warm p50=${scaleP50Ms}ms, Recall@1=${((scaleTop1 / posQueries.length) * 100).toFixed(1)}%, Recall@5=${((scaleTop5 / posQueries.length) * 100).toFixed(1)}%`
      );
    }

    // =========================================================================
    // 3. Schema Validation, Secret/Path Leak Blocker & Duplicate Detector
    // =========================================================================
    console.log('\n3. Validator guardrails: schema, secret/path rejection, near-duplicate warning');
    {
      const valWs = path.join(tmpBase, 'val-ws');
      fs.mkdirSync(path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'gotcha'), { recursive: true });

      const allOk = JSON.parse(py([KB_PY, '--kb-root', KB_ROOT, 'validate', '--all', '--json']).stdout);
      ok(allOk.valid && allOk.checked === 12 && allOk.warnings.length === 0, 'all 12 seed entries pass validate --all with 0 warnings');

      // Secret leak draft
      const fakeTok = 'gh' + 'p_1234567890abcdefghijklmnopqrstuvwx';
      const secretDraft = path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'gotcha', 'leak-test.md');
      fs.writeFileSync(
        secretDraft,
        `---\ntitle: "Leak test"\nsummary: "Bad draft"\nsources: ["gw:x.go"]\ntriggers: ["leak"]\n---\ncurl -H "Authorization: Bearer ${fakeTok}" https://example.com\n`
      );
      const secRes = py([KB_PY, '--kb-root', KB_ROOT, 'validate', '.loop/outbox/kb/gateway/gotcha/leak-test.md'], { cwd: valWs });
      ok(secRes.status === 2 && /GitHub token|strip secrets/i.test(secRes.stderr + secRes.stdout), 'validator hard-rejects drafts containing credential tokens');

      // Local user path leak draft
      const pathLeak = '/' + 'Users/alice/private-project/config.yaml';
      fs.writeFileSync(
        secretDraft,
        `---\ntitle: "Path test"\nsummary: "Bad path"\nsources: ["gw:x.go"]\ntriggers: ["path"]\n---\nRead config from ${pathLeak}\n`
      );
      const pathRes = py([KB_PY, '--kb-root', KB_ROOT, 'validate', '.loop/outbox/kb/gateway/gotcha/leak-test.md'], { cwd: valWs });
      ok(pathRes.status === 2 && /local machine user path/i.test(pathRes.stderr + pathRes.stdout), 'validator hard-rejects drafts containing local /Users/<name>/ paths');

      // Near-duplicate draft against seed entry
      const dupDraft = path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'redline', 'duplicate-shadow-rule.md');
      fs.mkdirSync(path.dirname(dupDraft), { recursive: true });
      fs.writeFileSync(
        dupDraft,
        `---\ntitle: "网关限流变更：RateLimitConfig 必须先开 shadow_only 灰度 24 小时"\nsummary: "修改 harbor-gateway 的 RateLimitConfig 配额或突发桶前必须先开启 shadow_only 运行 24 小时，禁止直接拦截 429。"\nsources: ["harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"]\ntriggers: ["RateLimitConfig", "shadow_only", "429", "限流"]\n---\n任何 harbor-gateway 限流修改必须先下发 shadow_only: true 观察 24 小时再切换为 false。\n`
      );
      const dupRes = JSON.parse(
        py([KB_PY, '--kb-root', KB_ROOT, 'validate', '--json', '.loop/outbox/kb/gateway/redline/duplicate-shadow-rule.md'], { cwd: valWs }).stdout
      );
      ok(
        dupRes.valid && dupRes.warnings.some(w => w.includes('gateway/redline/rate-limit-shadow-mode-first')),
        'validator flags near-duplicate drafts and points to the existing canonical entry ID'
      );
    }

    // =========================================================================
    // 4. 24-Process Parallel Cold-Cache Stress Test
    // =========================================================================
    console.log('\n4. Multi-process concurrency stress test (24 parallel processes on cold cache)');
    {
      const stressCache = path.join(tmpBase, 'stress-cache');
      const env = { ...process.env, HARBOR_KB_CACHE_DIR: stressCache };
      const queries = ['限流', '死锁', 'RateLimitConfig', '42P05', 'ErrSeriesLimitExceeded', '回滚'];

      const procs = Array.from({ length: 24 }, (_, idx) => {
        const subArgs =
          idx % 4 === 0
            ? [KB_PY, '--kb-root', KB_ROOT, 'redlines', '--json']
            : [KB_PY, '--kb-root', KB_ROOT, 'search', '--json', queries[idx % queries.length]];
        return new Promise((resolve, reject) => {
          const child = spawn('python3', subArgs, { env });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', d => { stdout += d; });
          child.stderr.on('data', d => { stderr += d; });
          child.on('error', reject);
          child.on('close', code => resolve({ idx, code, stdout, stderr }));
        });
      });

      const results = await Promise.all(procs);
      const failures = results.filter(r => r.code !== 0);
      ok(failures.length === 0, `24/24 parallel cold-cache processes exited 0 without SQLite lock failures`);

      const parsedOk = results.every(r => {
        const obj = JSON.parse(r.stdout);
        return (obj.count ?? 0) >= 1;
      });
      ok(parsedOk, 'all 24 parallel processes returned valid non-empty JSON results');

      const hashDirs = fs.readdirSync(stressCache);
      const leftoverTmp = hashDirs.flatMap(d => fs.readdirSync(path.join(stressCache, d)).filter(f => f.includes('.tmp.')));
      metrics.parallelWorkers = 24;
      ok(leftoverTmp.length === 0, 'atomic os.replace left 0 temporary SQLite files behind');
    }

    // =========================================================================
    // 5. Hot-Plug (symlink & copy) + Clean Byte-Exact Unplug on examples/harbor-team
    // =========================================================================
    console.log('\n5. Zero-copy hot-plug (symlink & copy) and clean byte-exact unplug');
    {
      for (const mode of ['symlink', 'copy']) {
        const ws = path.join(tmpBase, `plug-${mode}`);
        fs.cpSync(EXAMPLE_WS, ws, { recursive: true });
        stubExternalSkills(ws);
        const beforeSnap = snapshotTree(ws);

        const inst1 = py([
          PLUG_PY, 'install', '--workspace', ws, '--mode', mode,
          '--agents', 'briefer,sentinel,techlead', '--with-gardener', '--with-hooks', '--json',
        ]);
        assert.strictEqual(inst1.status, 0, inst1.stderr);

        // Idempotency check: second install should succeed without duplicating skills/markers
        const inst2 = py([
          PLUG_PY, 'install', '--workspace', ws, '--mode', mode,
          '--agents', 'briefer,sentinel,techlead', '--with-gardener', '--with-hooks', '--json',
        ]);
        assert.strictEqual(inst2.status, 0, inst2.stderr);

        const statRes = py([PLUG_PY, 'status', '--workspace', ws, '--json']);
        assert.strictEqual(statRes.status, 0, statRes.stderr);
        const statObj = JSON.parse(statRes.stdout);
        ok(
          statObj.healthy && statObj.workspace_status.team_kb_mode === mode,
          `plug.py install (${mode}) is healthy, idempotent, and runtime probe resolves 12 KB entries`
        );

        const skills = loadSkills(ws);
        const team = loadAgents(ws);
        ok(
          skills.has('team-kb') && skills.has('team-kb-publish') &&
            validateTeam(team, skills, loadAllAgents(ws)).length === 0,
          `Harbor Mate loadSkills & validateTeam succeed cleanly in ${mode} mode`
        );

        const uninst = py([PLUG_PY, 'uninstall', '--workspace', ws, '--json']);
        assert.strictEqual(uninst.status, 0, uninst.stderr);

        // Clean empty .github/hooks or .loop/outbox/kb directories if created solely during install
        for (const emptyCand of [path.join(ws, '.github', 'hooks'), path.join(ws, '.loop', 'outbox', 'kb'), path.join(ws, '.loop', 'outbox')]) {
          if (fs.existsSync(emptyCand) && fs.readdirSync(emptyCand).length === 0 && !beforeSnap[path.relative(ws, emptyCand)]) {
            fs.rmdirSync(emptyCand);
          }
        }
        const afterSnap = snapshotTree(ws);
        assert.deepStrictEqual(afterSnap, beforeSnap);
        ok(true, `plug.py uninstall (${mode}) restores workspace byte-for-byte to pre-plug state`);
      }
    }

    // =========================================================================
    // 6. Security Policy Boundary, SHA-256 Tamper Gate & Git Shared Sync Loop
    // =========================================================================
    console.log('\n6. Strictest policy boundary (techlead.json), SHA-256 gate tamper block & Git shared sync');
    const bareRemote = path.join(tmpBase, 'origin-kb.git');
    const kbCloneA = path.join(tmpBase, 'kb-clone-techlead');
    const kbCloneB = path.join(tmpBase, 'kb-clone-sentinel');
    const wsA = path.join(tmpBase, 'ws-techlead');
    const wsB = path.join(tmpBase, 'ws-sentinel');
    {
      // Create bare remote + two engineer/mate clones (simulating two laptops / workspaces)
      git(['init', '--bare', bareRemote], tmpBase);
      fs.cpSync(KB_ROOT, kbCloneA, { recursive: true });
      git(['init', '-b', 'main'], kbCloneA);
      git(['add', '.'], kbCloneA);
      git(['commit', '-m', 'chore: initial team-kb seed'], kbCloneA);
      git(['remote', 'add', 'origin', bareRemote], kbCloneA);
      git(['push', '-u', 'origin', 'main'], kbCloneA);

      git(['clone', bareRemote, kbCloneB], tmpBase);

      fs.cpSync(EXAMPLE_WS, wsA, { recursive: true });
      stubExternalSkills(wsA);
      assert.strictEqual(
        py([path.join(kbCloneA, 'plug.py'), 'install', '--workspace', wsA, '--agents', 'sentinel,techlead', '--with-gardener']).status,
        0
      );

      fs.cpSync(EXAMPLE_WS, wsB, { recursive: true });
      stubExternalSkills(wsB);
      assert.strictEqual(
        py([path.join(kbCloneB, 'plug.py'), 'install', '--workspace', wsB, '--agents', 'sentinel,techlead']).status,
        0
      );

      const teamA = loadAgents(wsA);
      const skillsA = loadSkills(wsA);
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      const ctxFor = (ws, team, skills, agentName) => {
        const agent = team.get(agentName);
        return {
          root: ws,
          agent,
          team,
          item: { id: `item-${agentName}`, agent: agentName, task: 'investigate', from: 'schedule', chainId: 'ch-1', hop: 0, createdAt: new Date().toISOString() },
          policy: loadPolicy(ws, agent.policy),
          // Notice: only skills listed in agent.skills get skillScriptRule! team-kb-publish is NOT listed!
          extraAllow: agent.skills.map(k => skillScriptRule(skills.get(k).relDir)),
          secrets: {},
          maxHops: 5,
          token,
        };
      };

      const tlCtx = ctxFor(wsA, teamA, skillsA, 'techlead');
      ok(tlCtx.policy.writablePaths.length === 0, 'techlead.json has writablePaths: [] (strictest read-only repo policy)');

      // Read paths allowed under techlead.json + Harbor Mate sanitized buildShellEnv (no HARBOR_KB_ROOT env needed!)
      const rRed = await runTool('run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py redlines --repo harbor-gateway' }, tlCtx);
      ok(rRed.decision === 'allow' && /RateLimitConfig/.test(rRed.text), 'techlead can run kb.py redlines inside sanitized buildShellEnv without env vars');

      const rSearch = await runTool('run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py search "request_rate 429 Retry-After"' }, tlCtx);
      ok(rSearch.decision === 'allow' && /partner-retry-storm-2026-02/.test(rSearch.text), 'techlead can search team-kb and see prior postmortem');

      const rGet = await runTool('run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py get gateway/postmortem/partner-retry-storm-2026-02' }, tlCtx);
      ok(rGet.decision === 'allow' && /REFERENCE ONLY/.test(rGet.text) && /WriteRetryHeader/.test(rGet.text), 'techlead can get full entry with REFERENCE ONLY prompt-injection banner');

      // Write draft with `/` code paths inside Markdown body via write_file (avoids CLI `/` denyCommands!)
      const draftRel = '.loop/outbox/kb/gateway/gotcha/envoy-header-timeout-504.md';
      const draftContent = [
        '---',
        'title: "Envoy 响应头超时导致大报表导出固定 15s 报 504"',
        'summary: "流式导出接口未在 15s 内刷新首个 HTTP 响应头会触发 Envoy route timeout 504，需先 flush 表头或独立路由超时。"',
        'sources:',
        '  - "harbor-gateway:pkg/http/export_handler.go#StreamCSVExport"',
        'triggers:',
        '  - "StreamCSVExport"',
        '  - "504 Gateway Timeout"',
        '  - "export_handler"',
        '---',
        '',
        '## 根因与修复',
        '',
        '检查 `harbor-gateway:pkg/http/export_handler.go#StreamCSVExport`（配置路径 `deploy/envoy/routes.yaml`），必须在查询聚合前先 flush HTTP 200 头或拆分为异步导出任务。',
        '',
      ].join('\n');

      const rWrite = await runTool('write_file', { path: draftRel, content: draftContent }, tlCtx);
      ok(rWrite.decision === 'allow' && fs.existsSync(path.join(wsA, draftRel)), 'techlead can write KB draft containing `/` paths via write_file to .loop/outbox/kb/');

      const rVal = await runTool('run_command', { command: `python3 .github/skills/team-kb/scripts/kb.py validate ${draftRel}` }, tlCtx);
      ok(rVal.decision === 'allow' && /OK: 1 file\(s\) validated clean/.test(rVal.text), 'techlead can validate its outbox KB draft via kb.py validate');

      // Security check: unattended techlead CANNOT run publish.py directly!
      const pubCmd = `python3 .github/skills/team-kb-publish/scripts/publish.py --no-pr ${draftRel}`;
      const rDirectPub = await runTool('run_command', { command: pubCmd }, tlCtx);
      ok(rDirectPub.decision === 'deny', 'security boundary: techlead CANNOT execute publish.py directly without human approval');

      // Submit non-blocking request_approval (`wait: false`)
      const rGate1 = await runTool('request_approval', {
        title: 'Publish gateway 504 export timeout gotcha to team-kb',
        summary: 'Verified during export 504 investigation.',
        command: pubCmd,
        files: [draftRel],
        wait: false,
      }, tlCtx);
      const gateId1 = /^Approval (\S+) queued/.exec(rGate1.text)?.[1];
      ok(!rGate1.park && Boolean(gateId1), 'request_approval(wait: false) queues non-blocking approval gate');

      // Console records SHA-256 of what the reviewer saw (`seen`), then blocks if tampered before Approve!
      const seen1 = { [draftRel]: G.fileSha256(wsA, draftRel) };
      fs.writeFileSync(path.join(wsA, draftRel), draftContent + '\n<!-- tampered after review -->\n');
      await assert.rejects(
        () => G.approveAndRun(wsA, gateId1, tlCtx.policy, {}, seen1),
        /changed after you reviewed it/,
      );
      ok(true, 'Harbor Mate approveAndRun blocks tampered KB draft via SHA-256 verification');

      // Restore exact reviewed content and approve with matching SHA-256!
      fs.writeFileSync(path.join(wsA, draftRel), draftContent);
      const seenClean = { [draftRel]: G.fileSha256(wsA, draftRel) };
      const approved = await G.approveAndRun(wsA, gateId1, tlCtx.policy, {}, seenClean);
      ok(
        approved.ok && /Published gateway\/gotcha\/envoy-header-timeout-504/.test(approved.text),
        'approveAndRun executes publish.py cleanly and pushes topic branch to origin'
      );

      // Verify local kbCloneA working tree stayed completely clean on main!
      ok(git(['status', '--porcelain'], kbCloneA) === '' && git(['branch', '--show-current'], kbCloneA) === 'main', 'isolated git worktree publish leaves engineer active checkout untouched');

      // Simulate reviewer merging the PR branch into origin/main
      const remoteBranches = git(['branch', '--list', 'kb/gateway-envoy-header-timeout-504-*'], bareRemote)
        .split('\n')
        .map(s => s.replace('*', '').trim())
        .filter(Boolean);
      ok(remoteBranches.length === 1, `PR topic branch pushed to bare origin (${remoteBranches[0]})`);

      const mergeTmp = path.join(tmpBase, 'pr-merger');
      git(['clone', bareRemote, mergeTmp], tmpBase);
      git(['merge', '--no-ff', `origin/${remoteBranches[0]}`, '-m', 'Merge PR #1: add envoy 504 gotcha'], mergeTmp);
      git(['push', 'origin', 'main'], mergeTmp);

      // Now on a SECOND workspace/laptop (wsB -> kbCloneB), sentinel runs search --sync and immediately finds it!
      const teamB = loadAgents(wsB);
      const skillsB = loadSkills(wsB);
      const senCtxB = ctxFor(wsB, teamB, skillsB, 'sentinel');
      const rSyncSearch = await runTool(
        'run_command',
        { command: 'python3 .github/skills/team-kb/scripts/kb.py search --sync "StreamCSVExport 504"' },
        senCtxB
      );
      ok(
        rSyncSearch.decision === 'allow' && /gateway\/gotcha\/envoy-header-timeout-504/.test(rSyncSearch.text),
        'multi-laptop closed loop: sentinel on second clone pulls merged KB via --sync, auto-rebuilds FTS5, and retrieves new entry at Rank #1'
      );
    }

    // =========================================================================
    // 7. Full Scripted Harbor Mate `runItem` + Zero-Token `kb-gardener` Anchor Drift
    // =========================================================================
    console.log('\n7. Full unattended Harbor Mate runItem loop & kb-gardener zero-token anchor drift');
    {
      const team = loadAgents(wsA);
      const skills = loadSkills(wsA);
      const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
      const outLog = { appendLine() {} };

      const newRunbookRel = '.loop/outbox/kb/gateway/runbook/webhook-burst-triage.md';
      const newRunbookBody = [
        '---',
        'title: "合作方 Webhook 突发流量与 Retry-After 脉冲快速核查手册"',
        'summary: "当 request_rate 呈固定秒级锯齿突刺时，在 3 分钟内核对单一 client_id 占比与响应头抖动配置。"',
        'sources:',
        '  - "harbor-gateway:pkg/middleware/retry_after.go#WriteRetryHeader"',
        'triggers:',
        '  - "webhook burst"',
        '  - "锯齿流量"',
        '---',
        '',
        '1. 按 `client_id` 聚合最近 15 分钟 `429` 比例。\n2. 核对 `WriteRetryHeader` 是否保留随机退避抖动。\n',
      ].join('\n');

      const seenToolResults = [];
      const turns = [
        [['run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py redlines --repo harbor-gateway' }]],
        [['run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py search "request_rate 429 Retry-After"' }]],
        [['run_command', { command: 'python3 .github/skills/team-kb/scripts/kb.py get gateway/postmortem/partner-retry-storm-2026-02' }]],
        [['write_file', { path: newRunbookRel, content: newRunbookBody }]],
        [['run_command', { command: `python3 .github/skills/team-kb/scripts/kb.py validate ${newRunbookRel}` }]],
        [[
          'request_approval',
          {
            title: 'Publish webhook burst triage runbook',
            summary: 'Distilled from incident analysis.',
            command: `python3 .github/skills/team-kb-publish/scripts/publish.py --no-pr ${newRunbookRel}`,
            files: [newRunbookRel],
            wait: false,
          },
        ]],
        [['finish', { status: 'done', summary: 'Diagnosed retry storm with team-kb and queued runbook PR approval' }]],
      ];

      const fakeModel = {
        family: 'fake',
        id: 'fake-sonnet',
        maxInputTokens: 32000,
        async sendRequest(messages) {
          const turn = messages.filter(m => m.role === 'assistant').length;
          if (turn > 0) {
            const lastUser = messages[messages.length - 1];
            const txt = lastUser.content.map(p => (p.content ? p.content.map(x => x.value).join('') : p.value || '')).join('');
            seenToolResults.push(txt);
          }
          const stepCalls = turns[turn];
          return {
            stream: (async function* () {
              yield* stepCalls.map(([name, input], k) => new ToolCallPart(`call-${turn}-${k}`, name, input));
            })(),
          };
        },
      };

      const item = {
        id: 'run-techlead-kb-1',
        agent: 'techlead',
        task: 'Investigate 3.4x request_rate spike on harbor-gateway',
        from: 'sentinel',
        chainId: 'chain-kb-1',
        hop: 1,
        createdAt: new Date().toISOString(),
      };

      const res = await runItem(item, {
        root: wsA,
        team,
        skills,
        model: fakeModel,
        secrets: {},
        policy: loadPolicy(wsA, team.get('techlead').policy),
        maxSteps: 15,
        maxHops: 5,
        out: outLog,
        token,
      });

      ok(res.status === 'done', `full runItem completed with status="done" without blocking on KB approval (${res.summary})`);
      ok(
        seenToolResults.some(t => t.includes('shadow_only')) &&
          seenToolResults.some(t => t.includes('WriteRetryHeader')) &&
          seenToolResults.some(t => t.includes('validated clean')),
        'agent received redlines, search hits, full postmortem, and validation verdict inside runItem loop'
      );
      ok(
        Q.listGates(wsA).some(g => g.status === 'pending' && g.title === 'Publish webhook burst triage runbook'),
        'non-blocking KB publication approval gate is queued in Harbor Mate Console'
      );

      // Zero-token checkWake for kb-gardener:
      // 1) When repo code matches KB anchors -> exit 1 (wake === false, 0 LLM tokens!)
      const gwFile = path.join(wsA, 'repos', 'harbor-gateway', 'pkg', 'ratelimit', 'limiter.go');
      fs.mkdirSync(path.dirname(gwFile), { recursive: true });
      fs.writeFileSync(gwFile, 'package ratelimit\n\ntype RateLimitConfig struct {\n\tShadowOnly bool\n}\n');
      const dialerFile = path.join(wsA, 'repos', 'harbor-gateway', 'pkg', 'upstream', 'grpc_dialer.go');
      fs.mkdirSync(path.dirname(dialerFile), { recursive: true });
      fs.writeFileSync(dialerFile, 'package upstream\n\nfunc NewUpstreamDialer() {}\n');
      const retryFile = path.join(wsA, 'repos', 'harbor-gateway', 'pkg', 'middleware', 'retry_after.go');
      fs.mkdirSync(path.dirname(retryFile), { recursive: true });
      fs.writeFileSync(retryFile, 'package middleware\n\nfunc WriteRetryHeader() {}\n');

      const gardener = team.get('kb-gardener');
      const gPolicy = loadPolicy(wsA, gardener.policy ?? '.loop/policy.json');
      const gExtra = gardener.skills.map(k => skillScriptRule(skills.get(k).relDir));

      const wakeClean = await checkWake(wsA, gardener, gPolicy, gExtra, {});
      ok(!wakeClean.wake && !wakeClean.error, 'kb-gardener wakeIf exits 1 when checked-out code anchors match (0 LLM tokens consumed)');

      // 2) Refactor renames RateLimitConfig -> TenantQuotaConfig -> anchor breaks -> exit 0 (wake === true!)
      fs.writeFileSync(gwFile, 'package ratelimit\n\ntype TenantQuotaConfig struct {\n\tShadowOnly bool\n}\n');
      const wakeDrift = await checkWake(wsA, gardener, gPolicy, gExtra, {});
      ok(
        wakeDrift.wake &&
          wakeDrift.context.includes('gateway/redline/rate-limit-shadow-mode-first') &&
          wakeDrift.context.includes('RateLimitConfig'),
        'kb-gardener wakeIf exits 0 and injects exact JSON anchor drift report when symbol is refactored'
      );

      // Read-time immediate warning check via `kb.py get`
      const getDrift = py([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.py'),
        'get', 'gateway/redline/rate-limit-shadow-mode-first',
      ], { cwd: wsA });
      ok(/WARNING \[ANCHOR DRIFT\]/.test(getDrift.stdout), 'kb.py get immediately warns agents at read-time when a local code symbol drifted');
    }

    // =========================================================================
    // 8. Contradiction / Dispute Workflow (`kb.py dispute`)
    // =========================================================================
    console.log('\n8. Live-reality contradiction workflow (kb.py dispute)');
    {
      const dispRes = py([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.py'),
        'dispute',
        '--id', 'gateway/gotcha/grpc-keepalive-rst-stream-burst',
        '--reason', 'Envoy MaxConnectionIdle increased to 600s in commit a1b2c3d',
        '--json',
      ], { cwd: wsA });
      assert.strictEqual(dispRes.status, 0, dispRes.stderr);
      const dispObj = JSON.parse(dispRes.stdout);
      const valDisp = py([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.py'),
        'validate', dispObj.draft,
      ], { cwd: wsA });
      ok(
        dispObj.status === 'dispute_drafted' && valDisp.status === 0,
        'kb.py dispute creates a valid disputed draft in .loop/outbox/kb/ ready for request_approval'
      );
    }

    console.log('\n============================================================');
    console.log(`ALL ${passed} ASSERTIONS PASSED!`);
    console.log('Measured Benchmarks:', JSON.stringify(metrics));
    console.log('============================================================\n');
  } finally {
    process.env.HOME = origHome;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
})().catch(err => {
  console.error('\nVERIFICATION FAILED:', err);
  process.exit(1);
});
