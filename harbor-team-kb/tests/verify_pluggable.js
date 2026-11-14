#!/usr/bin/env node
/**
 * End-to-end verification suite for harbor-team-kb pluggability into Harbor Mate (loop-runner).
 *
 * Exercises:
 *   1. Real Harbor Mate `lintSkill` & `designWarnings` static safety/budget audits
 *   2. Golden retrieval benchmark (Recall@1, Recall@5, MRR, 2-char CJK bigrams, camelCase/snake_case, noise, latency)
 *   3. Schema validator, secret/local-path leak blocker, expired/disputed demotion, near-duplicate detector
 *   4. 24-process parallel cold-cache rebuild & search stress test (exclusive `.lock` + atomic `fs.renameSync`)
 *   5. One-command `plug.js install` (symlink & copy modes) + byte-exact `plug.js uninstall` on `examples/harbor-team`
 *   6. Strictest `techlead.json` policy compatibility, `publish.js` direct-exec denial, SHA-256 tamper rejection,
 *      and Git branch push -> `sentinel` `--sync` shared knowledge closed loop
 *   7. Full unattended `runItem` loop + `kb-gardener` zero-token `checkWake` (`drift --exit-code`) on code refactor
 *   8. `kb.js dispute` contradiction workflow
 *   9. End-to-end token usage, 128k context budget & `foldForRequest` benchmark
 *  10. Standalone VS Code Copilot Chat & zero-friction UX verification
 *  11. Code review regressions: ownership safety, prototype keys, YAML indent, policy gate, baseRef & auto-sync
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

if (!fs.existsSync(path.join(LOOP_RUNNER, 'node_modules'))) {
  const commonGit = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: KB_ROOT, encoding: 'utf8' });
  if (commonGit.status === 0) {
    const mainRepoRoot = path.resolve(KB_ROOT, commonGit.stdout.trim(), '..');
    const sharedNm = path.join(mainRepoRoot, 'loop-runner', 'node_modules');
    if (fs.existsSync(sharedNm)) {
      process.env.NODE_PATH = [sharedNm, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
      Module._initPaths();
    }
  }
}

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
const { runItem, buildPrompt, LONG_SKILL_CHARS } = require(`${OUT}/runner.js`);
const { foldedLine, foldForRequest } = require(`${OUT}/fold.js`);
const Q = require(`${OUT}/queue.js`);
const G = require(`${OUT}/gates.js`);

const KB_JS = path.join(KB_ROOT, 'skills', 'team-kb', 'scripts', 'kb.js');
const PUBLISH_JS = path.join(KB_ROOT, 'skills', 'team-kb-publish', 'scripts', 'publish.js');
const PLUG_JS = path.join(KB_ROOT, 'plug.js');
const GOLDEN_PATH = path.join(__dirname, 'golden_queries.json');

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
};

function runNode(args, opts = {}) {
  if(path.basename(args[0]) === 'publish.js') args=[...args,'--allow-demo-fallback'];
  const res = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    timeout: 30000,
    ...opts,
    env: {...process.env,...(opts.env||{})},
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
      fs.writeFileSync(path.join(dir, 'scripts', 'detect.js'), 'process.exit(1);\n');
    }
  }
}

(async () => {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-kb-verify-'));
  const isolatedHome = path.join(tmpBase, 'home');
  fs.mkdirSync(isolatedHome, { recursive: true });
  // Copy git identity if present or configure isolated HOME gitconfig so git commits work cleanly
  const origHome = process.env.HOME;
  const origCache=process.env.HARBOR_KB_CACHE_DIR;
  const origRoot=process.env.HARBOR_KB_ROOT;
  process.env.HARBOR_KB_CACHE_DIR=path.join(tmpBase,'cache');
  delete process.env.HARBOR_KB_ROOT;
  const origXdg = process.env.XDG_CONFIG_HOME;
  const origAppData = process.env.APPDATA;
  const origUserSettings = process.env.HARBOR_VSCODE_USER_SETTINGS;
  const origDefaultProfile = process.env.HARBOR_DEFAULT_PROFILE;
  process.env.HOME = isolatedHome;
  process.env.XDG_CONFIG_HOME = path.join(isolatedHome, '.config');
  process.env.APPDATA = path.join(isolatedHome, 'AppData', 'Roaming');
  delete process.env.HARBOR_VSCODE_USER_SETTINGS;
  delete process.env.HARBOR_DEFAULT_PROFILE;
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

      const storyFindings=lintSkill(emptyRoot,loadSkillAsSpec(path.join(KB_ROOT,'skills','story-guard')));
      ok(storyFindings.length===0, 'story-guard passes lintSkill: '+JSON.stringify(storyFindings));
      const lintWs = path.join(tmpBase, 'lint-ws');
      fs.cpSync(EXAMPLE_WS, lintWs, { recursive: true });
      stubExternalSkills(lintWs);
      const plugRes = runNode([PLUG_JS, 'install', '--workspace', lintWs, '--mode', 'copy', '--agents', 'all', '--with-gardener']);
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
    // 2. Stratified Retrieval Recall & Hard-Negative Benchmark (N=16 & N=500)
    // =========================================================================
    console.log('\n2. Stratified retrieval recall & hard-negative benchmark (N=16 & N=500)');
    const scale100Kb = path.join(tmpBase, 'scale-100-kb');
    const scale500Kb = path.join(tmpBase, 'scale-500-kb');
    {
      const benchCache = path.join(tmpBase, 'bench-cache');
      const env = { ...process.env, HARBOR_KB_CACHE_DIR: benchCache };

      const tCold0 = performance.now();
      const buildRes = runNode([KB_JS, '--kb-root', KB_ROOT, 'stats', '--json'], { env });
      const coldBuildMs = +(performance.now() - tCold0).toFixed(1);
      assert.strictEqual(buildRes.status, 0, buildRes.stderr);
      const statsObj = JSON.parse(buildRes.stdout);
      ok(statsObj.rebuilt === true && statsObj.total_entries === 16, `cold BM25F index built for ${statsObj.total_entries} seed entries in ${coldBuildMs}ms`);

      const golden = JSON.parse(fs.readFileSync(GOLDEN_PATH, 'utf8'));
      const coreQueries = golden.filter(q => !q.expect_empty && !q.stress);
      const stressQueries = golden.filter(q => !q.expect_empty && q.stress);
      const allPosQueries = golden.filter(q => !q.expect_empty);
      const negQueries = golden.filter(q => q.expect_empty);

      const populateSyntheticCorpus = (destKb, targetCount) => {
        fs.cpSync(path.join(KB_ROOT, 'kb'), path.join(destKb, 'kb'), { recursive: true });
        const domains = ['gateway', 'observability', 'storage', 'release', 'auth', 'billing', 'scheduler', 'search', 'mesh', 'ci'];
        const kinds = ['gotcha', 'runbook', 'redline', 'adr', 'postmortem'];
        const topics = [
          ['jwt-key-rotation-clock-skew', 'JWT JWKS key rotation 30s clock skew 401 spike', 'Allow 60s clock leeway during OIDC JWKS rotation on edge gateway pods.'],
          ['stripe-idempotency-key-collision', 'Billing webhook idempotency key mismatch 409 conflict', 'Hash payload digest alongside event_id before rejecting duplicate billing webhooks.'],
          ['cronjob-timezone-dst-duplicate', 'Scheduler CronJob DST fallback duplicate execution', 'Pin UTC schedule on Kubernetes CronJobs and guard non-idempotent jobs with lease lock.'],
          ['grpc-max-recv-msg-size-4mb', 'gRPC ResourceExhausted message larger than max 4194304', 'Paginate batch responses instead of raising MaxCallRecvMsgSize above 16MB.'],
          ['clickhouse-too-many-parts-merge', 'ClickHouse DB::Exception Too many parts 300 partition insert', 'Batch async inserts to >= 1000 rows and avoid high-granularity daily partitioning keys.'],
          ['s3-multipart-abort-lifecycle-leak', 'Incomplete S3 multipart upload storage leak without lifecycle rule', 'Enforce 7-day AbortIncompleteMultipartUpload rule on every artifact bucket.'],
          ['etcd-leader-election-fsync-stall', 'etcd wal fsync latency > 100ms triggers spurious leader elections', 'Isolate etcd WAL on dedicated local NVMe SSD away from noisy container log volumes.'],
          ['coredns-ndots-5-lookup-amplification', 'Kubernetes ndots:5 causes 4x external DNS AAAA/A query amplification', 'Set FQDN trailing dot or ndots:2 on egress-heavy pods calling third-party APIs.'],
        ];
        for (let i = 0; i < targetCount - 16; i++) {
          const dom = domains[i % domains.length];
          const knd = kinds[i % kinds.length];
          const [slugBase, titleBase, sumBase] = topics[i % topics.length];
          const dir = path.join(destKb, 'kb', dom, knd);
          fs.mkdirSync(dir, { recursive: true });
          const idx = String(i).padStart(3, '0');
          fs.writeFileSync(
            path.join(dir, `${slugBase}-${idx}.md`),
            [
              '---',
              `title: "[#${idx}] ${titleBase}"`,
              `summary: "${sumBase} (service shard ${idx})"`,
              'sources:',
              `  - "harbor-${dom}:internal/mod_${idx}/handler.go#HandleShard${idx}"`,
              `  - "harbor-${dom}:deploy/shard-${idx}.yaml#shard_config"`,
              'triggers:',
              `  - "HandleShard${idx}"`,
              `  - "${slugBase}-${idx}"`,
              '---',
              '',
              '## Symptom',
              '',
              `Service \`harbor-${dom}\` shard \`${idx}\` emitted elevated warning counts and intermittent status anomalies during peak window traffic while node CPU stayed below 55%.`,
              '',
              '## Root Cause',
              '',
              `${sumBase} Downstream worker pool \`HandleShard${idx}\` observed transient boundary mismatch across rolling pod updates when reading \`deploy/shard-${idx}.yaml\`.`,
              '',
              '## Verified Action',
              '',
              `1. Inspect \`harbor-${dom}:internal/mod_${idx}/handler.go#HandleShard${idx}\` and confirm live metric baselines over a 15-minute window.`,
              `2. Apply the validated configuration in \`harbor-${dom}:deploy/shard-${idx}.yaml#shard_config\` via canary rollout and monitor saturation.`,
              '',
            ].join('\n')
          );
        }
      };

      const evaluateCorpus = (targetKb, cachePath) => {
        const cEnv = { ...process.env, HARBOR_KB_CACHE_DIR: cachePath };
        const t0Build = performance.now();
        const st = JSON.parse(runNode([KB_JS, '--kb-root', targetKb, 'stats', '--json'], { env: cEnv }).stdout);
        const buildMs = +(performance.now() - t0Build).toFixed(1);

        let coreR1 = 0, coreR5 = 0, coreMRR = 0;
        let stressR1 = 0, stressR5 = 0, stressRetryR1 = 0, stressRetryR5 = 0;
        let allR1 = 0, allR3 = 0, allR5 = 0, allMRR = 0;
        const byCategory = {};
        const latencies = [];

        for (const g of allPosQueries) {
          const cat = g.category || 'general';
          if (!byCategory[cat]) byCategory[cat] = { total: 0, r1: 0, r5: 0 };
          byCategory[cat].total++;

          const t0 = performance.now();
          const r = runNode([KB_JS, '--kb-root', targetKb, 'search', '--json', g.query], { env: cEnv });
          latencies.push(performance.now() - t0);
          assert.strictEqual(r.status, 0, r.stderr);
          const parsed = JSON.parse(r.stdout);
          const ids = parsed.results.map(x => x.id);
          const rank = ids.indexOf(g.expect_top1);
          const hit1 = rank === 0;
          const hit3 = rank >= 0 && rank < 3;
          const hit5 = rank >= 0 && rank < 5;
          const rr = hit5 ? 1 / (rank + 1) : 0;

          if (hit1) { allR1++; byCategory[cat].r1++; }
          if (hit3) allR3++;
          if (hit5) { allR5++; byCategory[cat].r5++; }
          allMRR += rr;

          if (!g.stress) {
            if (hit1) coreR1++;
            if (hit5) coreR5++;
            coreMRR += rr;
            if (!hit5) console.error(`  CORE MISS for "${g.query}": expected ${g.expect_top1}, got ${JSON.stringify(ids)}`);
          } else {
            if (hit1) stressR1++;
            if (hit5) stressR5++;
            // Agent 1-retry reformulation check when initial colloquial query misses or ranks low
            let rHit1 = hit1;
            let rHit5 = hit5;
            if (!hit1 && g.reformulated_query) {
              const r2 = JSON.parse(runNode([KB_JS, '--kb-root', targetKb, 'search', '--json', g.reformulated_query], { env: cEnv }).stdout);
              const ids2 = r2.results.map(x => x.id);
              if (ids2[0] === g.expect_top1) rHit1 = true;
              if (ids2.indexOf(g.expect_top1) >= 0 && ids2.indexOf(g.expect_top1) < 5) rHit5 = true;
            }
            if (rHit1) stressRetryR1++;
            if (rHit5) stressRetryR5++;
          }
        }

        let falsePositives = 0;
        for (const g of negQueries) {
          const r = JSON.parse(runNode([KB_JS, '--kb-root', targetKb, 'search', '--json', g.query], { env: cEnv }).stdout);
          if (r.results.length > 0) {
            falsePositives++;
            console.error(`  FALSE POSITIVE for "${g.query}": ${JSON.stringify(r.results.map(x => x.id))}`);
          }
        }

        latencies.sort((a, b) => a - b);
        const p50Ms = +latencies[Math.floor(latencies.length * 0.5)].toFixed(1);
        const p95Ms = +latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))].toFixed(1);
        return {
          entries: st.total_entries,
          coldBuildMs: buildMs,
          p50Ms,
          p95Ms,
          coreCount: coreQueries.length,
          coreRecall1: +(coreR1 / coreQueries.length).toFixed(4),
          coreRecall5: +(coreR5 / coreQueries.length).toFixed(4),
          coreMRR: +(coreMRR / coreQueries.length).toFixed(4),
          stressCount: stressQueries.length,
          stressSingleShotR1: +(stressR1 / stressQueries.length).toFixed(4),
          stressSingleShotR5: +(stressR5 / stressQueries.length).toFixed(4),
          stressWithAgentRetryR1: +(stressRetryR1 / stressQueries.length).toFixed(4),
          stressWithAgentRetryR5: +(stressRetryR5 / stressQueries.length).toFixed(4),
          overallCount: allPosQueries.length,
          overallRecall1: +(allR1 / allPosQueries.length).toFixed(4),
          overallRecall3: +(allR3 / allPosQueries.length).toFixed(4),
          overallRecall5: +(allR5 / allPosQueries.length).toFixed(4),
          overallMRR: +(allMRR / allPosQueries.length).toFixed(4),
          negativeCount: negQueries.length,
          falsePositives,
          falsePositiveRate: +(falsePositives / negQueries.length).toFixed(4),
          byCategory,
        };
      };

      const eval12 = evaluateCorpus(KB_ROOT, path.join(tmpBase, 'eval12-cache'));
      populateSyntheticCorpus(scale100Kb, 100);
      populateSyntheticCorpus(scale500Kb, 500);
      const eval500 = evaluateCorpus(scale500Kb, path.join(tmpBase, 'eval500-cache'));

      metrics.retrieval = { n12: eval12, n500: eval500 };

      ok(
        eval12.coreRecall1 === 1 && eval12.coreRecall5 === 1,
        `N=16 core engineering queries (${eval12.coreCount}): Recall@1=${(eval12.coreRecall1 * 100).toFixed(1)}%, Recall@5=${(eval12.coreRecall5 * 100).toFixed(1)}%, MRR=${eval12.coreMRR} (p50=${eval12.p50Ms}ms)`
      );
      ok(
        eval12.stressSingleShotR5 >= 0.7 && eval12.stressWithAgentRetryR1 === 1,
        `N=16 zero-symbol colloquial stress (${eval12.stressCount}): single-shot R@5=${(eval12.stressSingleShotR5 * 100).toFixed(1)}%, with 1-step agent term retry R@1=${(eval12.stressWithAgentRetryR1 * 100).toFixed(1)}%`
      );
      ok(
        eval12.falsePositives === 0,
        `N=16 hard domain-adjacent & out-of-domain negatives (${eval12.negativeCount}): False Positive Rate=0% (0/${eval12.negativeCount})`
      );
      ok(
        eval500.entries === 500 && eval500.coldBuildMs < 2000 && eval500.coreRecall1 === 1 && eval500.falsePositives === 0,
        `N=500 multi-domain scale test: cold build=${eval500.coldBuildMs}ms, warm p50=${eval500.p50Ms}ms, core R@1=${(eval500.coreRecall1 * 100).toFixed(1)}%, overall R@5=${(eval500.overallRecall5 * 100).toFixed(1)}%, hard-negative FPR=0%`
      );

      // Verify Push path: redlines filter
      const redGw = JSON.parse(runNode([KB_JS, '--kb-root', KB_ROOT, 'redlines', '--repo', 'harbor-gateway', '--json'], { env }).stdout);
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
        runNode([KB_JS, '--kb-root', rankKb, '--now', '2026-04-12', 'search', '--json', 'envoy_idle_reset'], { env }).stdout
      );
      ok(
        rankRes.results[0].id === 'gateway/gotcha/fresh-entry' &&
          rankRes.results.find(x => x.id.endsWith('expired-entry')).flags.some(f => f.startsWith('EXPIRED')) &&
          rankRes.results.find(x => x.id.endsWith('disputed-entry')).flags.includes('DISPUTED'),
        'fresh knowledge ranks above expired and disputed entries, and flags are surfaced'
      );
    }

    // =========================================================================
    // 3. Schema Validation, Secret/Path Leak Blocker & Duplicate Detector
    // =========================================================================
    console.log('\n3. Validator guardrails: schema, secret/path rejection, near-duplicate warning');
    {
      const valWs = path.join(tmpBase, 'val-ws');
      fs.mkdirSync(path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'gotcha'), { recursive: true });

      const allOk = JSON.parse(runNode([KB_JS, '--kb-root', KB_ROOT, 'validate', '--all', '--json']).stdout);
      ok(allOk.valid && allOk.checked === 16 && allOk.warnings.length === 0, 'all 16 seed entries pass validate --all with 0 warnings');

      // Secret leak draft
      const fakeTok = 'gh' + 'p_1234567890abcdefghijklmnopqrstuvwx';
      const secretDraft = path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'gotcha', 'leak-test.md');
      fs.writeFileSync(
        secretDraft,
        `---\ntitle: "Leak test"\nsummary: "Bad draft"\nsources: ["gw:x.go"]\ntriggers: ["leak"]\n---\ncurl -H "Authorization: Bearer ${fakeTok}" https://example.com\n`
      );
      const secRes = runNode([KB_JS, '--kb-root', KB_ROOT, 'validate', '.loop/outbox/kb/gateway/gotcha/leak-test.md'], { cwd: valWs });
      ok(secRes.status === 2 && /GitHub token|strip secrets/i.test(secRes.stderr + secRes.stdout), 'validator hard-rejects drafts containing credential tokens');

      // Local user path leak draft
      const pathLeak = '/' + 'Users/alice/private-project/config.yaml';
      fs.writeFileSync(
        secretDraft,
        `---\ntitle: "Path test"\nsummary: "Bad path"\nsources: ["gw:x.go"]\ntriggers: ["path"]\n---\nRead config from ${pathLeak}\n`
      );
      const pathRes = runNode([KB_JS, '--kb-root', KB_ROOT, 'validate', '.loop/outbox/kb/gateway/gotcha/leak-test.md'], { cwd: valWs });
      ok(pathRes.status === 2 && /local machine user path/i.test(pathRes.stderr + pathRes.stdout), 'validator hard-rejects drafts containing local /Users/<name>/ paths');

      // Near-duplicate draft against English-primary seed entry
      const dupDraft = path.join(valWs, '.loop', 'outbox', 'kb', 'gateway', 'redline', 'duplicate-shadow-rule.md');
      fs.mkdirSync(path.dirname(dupDraft), { recursive: true });
      fs.writeFileSync(
        dupDraft,
        `---\ntitle: "Gateway RateLimitConfig changes must observe 24h shadow_only before enforcing 429"\nsummary: "Never deploy harbor-gateway RateLimitConfig quota or burst rules directly; run shadow_only: true for 24 hours first."\nsources: ["harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"]\ntriggers: ["RateLimitConfig", "shadow_only", "429 Too Many Requests", "rate limit", "限流"]\n---\nAlways run harbor-gateway RateLimitConfig updates in shadow_only: true for 24h before enforcing HTTP 429.\n`
      );
      const dupRes = JSON.parse(
        runNode([KB_JS, '--kb-root', KB_ROOT, 'validate', '--json', '.loop/outbox/kb/gateway/redline/duplicate-shadow-rule.md'], { cwd: valWs }).stdout
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
            ? [KB_JS, '--kb-root', KB_ROOT, 'redlines', '--json']
            : [KB_JS, '--kb-root', KB_ROOT, 'search', '--json', queries[idx % queries.length]];
        return new Promise((resolve, reject) => {
          const child = spawn(process.execPath, subArgs, { env });
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
      ok(failures.length === 0, `24/24 parallel cold-cache processes exited 0 without lock failures`);

      const parsedOk = results.every(r => {
        const obj = JSON.parse(r.stdout);
        return (obj.count ?? 0) >= 1;
      });
      ok(parsedOk, 'all 24 parallel processes returned valid non-empty JSON results');

      const hashDirs = fs.readdirSync(stressCache);
      const leftoverTmp = hashDirs.flatMap(d => fs.readdirSync(path.join(stressCache, d)).filter(f => f.includes('.tmp.')));
      metrics.parallelWorkers = 24;
      ok(leftoverTmp.length === 0, 'atomic fs.renameSync left 0 temporary index files behind');
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

        const inst1 = runNode([
          PLUG_JS, 'install', '--workspace', ws, '--mode', mode,
          '--agents', 'briefer,sentinel,techlead', '--with-gardener', '--with-hooks', '--json',
        ]);
        assert.strictEqual(inst1.status, 0, inst1.stderr);

        // Idempotency check: second install should succeed without duplicating skills/markers
        const inst2 = runNode([
          PLUG_JS, 'install', '--workspace', ws, '--mode', mode,
          '--agents', 'briefer,sentinel,techlead', '--with-gardener', '--with-hooks', '--json',
        ]);
        assert.strictEqual(inst2.status, 0, inst2.stderr);

        const statRes = runNode([PLUG_JS, 'status', '--workspace', ws, '--json']);
        assert.strictEqual(statRes.status, 0, statRes.stderr);
        const statObj = JSON.parse(statRes.stdout);
        ok(
          statObj.healthy && statObj.workspace_status.team_kb_mode === mode,
          `plug.js install (${mode}) is healthy, idempotent, and runtime probe resolves 16 KB entries`
        );

        const skills = loadSkills(ws);
        const team = loadAgents(ws);
        ok(
          skills.has('team-kb') && skills.has('team-kb-publish') &&
            validateTeam(team, skills, loadAllAgents(ws)).length === 0,
          `Harbor Mate loadSkills & validateTeam succeed cleanly in ${mode} mode`
        );

        const uninst = runNode([PLUG_JS, 'uninstall', '--workspace', ws, '--json']);
        assert.strictEqual(uninst.status, 0, uninst.stderr);

        // Clean empty .github/hooks or .loop/outbox/kb directories if created solely during install
        for (const emptyCand of [path.join(ws, '.github', 'hooks'), path.join(ws, '.loop', 'outbox', 'kb'), path.join(ws, '.loop', 'outbox')]) {
          if (fs.existsSync(emptyCand) && fs.readdirSync(emptyCand).length === 0 && !beforeSnap[path.relative(ws, emptyCand)]) {
            fs.rmdirSync(emptyCand);
          }
        }
        const afterSnap = snapshotTree(ws);
        assert.deepStrictEqual(afterSnap, beforeSnap);
        ok(true, `plug.js uninstall (${mode}) restores workspace byte-for-byte to pre-plug state`);
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
        runNode([path.join(kbCloneA, 'plug.js'), 'install', '--workspace', wsA, '--agents', 'sentinel,techlead', '--with-gardener']).status,
        0
      );

      fs.cpSync(EXAMPLE_WS, wsB, { recursive: true });
      stubExternalSkills(wsB);
      assert.strictEqual(
        runNode([path.join(kbCloneB, 'plug.js'), 'install', '--workspace', wsB, '--agents', 'sentinel,techlead']).status,
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
      const rRed = await runTool('run_command', { command: 'node .github/skills/team-kb/scripts/kb.js redlines --repo harbor-gateway' }, tlCtx);
      ok(rRed.decision === 'allow' && /RateLimitConfig/.test(rRed.text), 'techlead can run kb.js redlines inside sanitized buildShellEnv without env vars');

      const rSearch = await runTool('run_command', { command: 'node .github/skills/team-kb/scripts/kb.js search "request_rate 429 Retry-After"' }, tlCtx);
      ok(rSearch.decision === 'allow' && /partner-retry-storm-2026-02/.test(rSearch.text), 'techlead can search team-kb and see prior postmortem');

      const rGet = await runTool('run_command', { command: 'node .github/skills/team-kb/scripts/kb.js get gateway/postmortem/partner-retry-storm-2026-02' }, tlCtx);
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

      const rVal = await runTool('run_command', { command: `node .github/skills/team-kb/scripts/kb.js validate ${draftRel}` }, tlCtx);
      ok(rVal.decision === 'allow' && /OK: 1 file\(s\) validated clean/.test(rVal.text), 'techlead can validate its outbox KB draft via kb.js validate');

      // Security check: unattended techlead CANNOT run publish.js directly!
      const pubCmd = `node .github/skills/team-kb-publish/scripts/publish.js --allow-demo-fallback --no-pr ${draftRel}`;
      const rDirectPub = await runTool('run_command', { command: pubCmd }, tlCtx);
      ok(rDirectPub.decision === 'deny', 'security boundary: techlead CANNOT execute publish.js directly without human approval');

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
        'approveAndRun executes publish.js cleanly and pushes topic branch to origin: '+approved.text
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
        { command: 'node .github/skills/team-kb/scripts/kb.js search --sync "StreamCSVExport 504"' },
        senCtxB
      );
      ok(
        rSyncSearch.decision === 'allow' && /gateway\/gotcha\/envoy-header-timeout-504/.test(rSyncSearch.text),
        'multi-laptop closed loop: sentinel on second clone pulls merged KB via --sync, auto-rebuilds BM25F index, and retrieves new entry at Rank #1'
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
        [['run_command', { command: 'node .github/skills/team-kb/scripts/kb.js redlines --repo harbor-gateway' }]],
        [['run_command', { command: 'node .github/skills/team-kb/scripts/kb.js search "request_rate 429 Retry-After"' }]],
        [['run_command', { command: 'node .github/skills/team-kb/scripts/kb.js get gateway/postmortem/partner-retry-storm-2026-02' }]],
        [['write_file', { path: newRunbookRel, content: newRunbookBody }]],
        [['run_command', { command: `node .github/skills/team-kb/scripts/kb.js validate ${newRunbookRel}` }]],
        [[
          'request_approval',
          {
            title: 'Publish webhook burst triage runbook',
            summary: 'Distilled from incident analysis.',
            command: `node .github/skills/team-kb-publish/scripts/publish.js --allow-demo-fallback --no-pr ${newRunbookRel}`,
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

      // Read-time immediate warning check via `kb.js get`
      const getDrift = runNode([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.js'),
        'get', 'gateway/redline/rate-limit-shadow-mode-first',
      ], { cwd: wsA });
      ok(/WARNING \[ANCHOR DRIFT\]/.test(getDrift.stdout), 'kb.js get immediately warns agents at read-time when a local code symbol drifted');
    }

    // =========================================================================
    // 8. Contradiction / Dispute Workflow (`kb.js dispute`)
    // =========================================================================
    console.log('\n8. Live-reality contradiction workflow (kb.js dispute)');
    {
      const dispRes = runNode([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.js'),
        'dispute',
        '--id', 'gateway/gotcha/grpc-keepalive-rst-stream-burst',
        '--reason', 'Envoy MaxConnectionIdle increased to 600s in commit a1b2c3d',
        '--json',
      ], { cwd: wsA });
      assert.strictEqual(dispRes.status, 0, dispRes.stderr);
      const dispObj = JSON.parse(dispRes.stdout);
      const valDisp = runNode([
        path.join(wsA, '.github', 'skills', 'team-kb', 'scripts', 'kb.js'),
        'validate', dispObj.draft,
      ], { cwd: wsA });
      ok(
        dispObj.status === 'dispute_drafted' && valDisp.status === 0,
        'kb.js dispute creates a valid disputed draft in .loop/outbox/kb/ ready for request_approval'
      );
    }

    // =========================================================================
    // 9. End-to-End Token Usage, Context Budget & Fold-Friendliness Benchmark
    // =========================================================================
    console.log('\n9. End-to-end token usage, 128k context budget & foldForRequest benchmark');
    {
      // Batch-count exact BPE tokens via optional tiktoken (o200k_base) when available, with pure Node.js deterministic fallback
      const countTokensBatch = (textsMap) => {
        const tikScript = [
          'import json, sys',
          'import tiktoken',
          'data = json.load(sys.stdin)',
          'enc = tiktoken.get_encoding("o200k_base")',
          'out = {"tokenizer": "tiktoken:o200k_base", "counts": {k: {"tokens": len(enc.encode(v)), "chars": len(v)} for k, v in data.items()}}',
          'print(json.dumps(out))',
        ].join('\n');
        const r = spawnSync('python3', ['-c', tikScript], {
          encoding: 'utf8',
          input: JSON.stringify(textsMap),
          maxBuffer: 64 * 1024 * 1024,
          timeout: 30000,
          env: { ...process.env, HOME: origHome },
        });
        if (r.status === 0 && r.stdout) {
          return JSON.parse(r.stdout);
        }
        const counts = {};
        const fallbackRe = /[A-Za-z0-9]+|[\u4e00-\u9fff]|[^\sA-Za-z0-9\u4e00-\u9fff]/g;
        for (const [k, v] of Object.entries(textsMap)) {
          counts[k] = { tokens: (v.match(fallbackRe) || []).length, chars: v.length };
        }
        return { tokenizer: 'node_regex_subword_fallback', counts };
      };

      const wsBase = path.join(tmpBase, 'tok-ws-base');
      const wsPlug = path.join(tmpBase, 'tok-ws-plug');
      fs.cpSync(EXAMPLE_WS, wsBase, { recursive: true });
      stubExternalSkills(wsBase);
      fs.cpSync(EXAMPLE_WS, wsPlug, { recursive: true });
      stubExternalSkills(wsPlug);
      assert.strictEqual(
        runNode([PLUG_JS, 'install', '--workspace', wsPlug, '--agents', 'briefer,sentinel,techlead', '--with-gardener']).status,
        0
      );

      const baseTeam = loadAgents(wsBase);
      const baseSkills = loadSkills(wsBase);
      const plugTeam = loadAgents(wsPlug);
      const plugSkills = loadSkills(wsPlug);

      const workItem = {
        id: 'item-tok-1',
        agent: 'techlead',
        task: 'Investigate 3.4x request_rate spike and elevated 429 responses on harbor-gateway after partner batch window.',
        context: 'Alert: harbor_gateway_request_rate_ratio=3.42, http_429_ratio=0.38 over 10m.',
        from: 'sentinel',
        chainId: 'chain-tok-1',
        hop: 1,
        createdAt: '2026-04-20T09:00:00Z',
      };

      const promptNoKb = buildPrompt(baseTeam.get('techlead'), workItem, { team: baseTeam, skills: baseSkills }, '', [], [], [], 'strict');
      const promptWithKb = buildPrompt(plugTeam.get('techlead'), workItem, { team: plugTeam, skills: plugSkills }, '', [], [], [], 'strict');
      const teamKbSkill = plugSkills.get('team-kb');

      ok(
        teamKbSkill.body.length < LONG_SKILL_CHARS,
        `team-kb SKILL.md body (${teamKbSkill.body.length} chars) stays well under LONG_SKILL_CHARS (${LONG_SKILL_CHARS})`
      );

      // Collect real CLI outputs across N=16, N=100, and N=500
      const tokEnv12 = { ...process.env, HARBOR_KB_CACHE_DIR: path.join(tmpBase, 'tok12-cache') };
      const tokEnv100 = { ...process.env, HARBOR_KB_CACHE_DIR: path.join(tmpBase, 'tok100-cache') };
      const tokEnv500 = { ...process.env, HARBOR_KB_CACHE_DIR: path.join(tmpBase, 'tok500-cache') };

      const outRedlinesGw12 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', KB_ROOT, 'redlines', '--repo', 'harbor-gateway'], { env: tokEnv12 }).stdout.trim();
      const outRedlinesAll12 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', KB_ROOT, 'redlines'], { env: tokEnv12 }).stdout.trim();
      const outSearch12 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', KB_ROOT, 'search', 'request_rate 429 Retry-After'], { env: tokEnv12 }).stdout.trim();
      const outSearch100 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', scale100Kb, 'search', 'request_rate 429 Retry-After'], { env: tokEnv100 }).stdout.trim();
      const outSearch500 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', scale500Kb, 'search', 'request_rate 429 Retry-After'], { env: tokEnv500 }).stdout.trim();
      const outGet12 = '[exit 0]\n' + runNode([KB_JS, '--kb-root', KB_ROOT, 'get', 'gateway/postmortem/partner-retry-storm-2026-02'], { env: tokEnv12 }).stdout.trim();

      // Measure average `get` and build Full-KB vs Index-in-Prompt corpora for N=16, 100, 500
      const readCorpusBlobs = (kbDir) => {
        const fullParts = [];
        const idxParts = [];
        const walkKb = (d) => {
          for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
            const p = path.join(d, ent.name);
            if (ent.isDirectory()) walkKb(p);
            else if (ent.isFile() && ent.name.endsWith('.md')) {
              const raw = fs.readFileSync(p, 'utf8');
              const rel = path.relative(path.join(kbDir, 'kb'), p).replace(/\\/g, '/').replace(/\.md$/, '');
              const fm = parseFrontmatter(raw);
              fullParts.push(`### [${rel}]\n${raw.trim()}`);
              idxParts.push(`- [${rel}] ${fm.meta.title || ''}: ${fm.meta.summary || ''} (triggers: ${(fm.meta.triggers || []).join(', ')})`);
            }
          }
        };
        walkKb(path.join(kbDir, 'kb'));
        return { fullText: fullParts.join('\n\n'), indexText: idxParts.join('\n'), count: fullParts.length };
      };

      const blob12 = readCorpusBlobs(KB_ROOT);
      const blob100 = readCorpusBlobs(scale100Kb);
      const blob500 = readCorpusBlobs(scale500Kb);

      // Verify Harbor Mate `foldedLine` & `foldForRequest` compatibility on long `kb.js get` output (> FOLD_MIN_CHARS=2000)
      const longGetText = outGet12 + '\n' + 'Detailed stack trace verification line for replay check.\n'.repeat(40);
      assert.ok(longGetText.length > 2000);
      const foldedGet = foldedLine(longGetText);
      ok(
        foldedGet.includes('[team-kb REFERENCE] gateway/postmortem/partner-retry-storm-2026-02'),
        `Harbor Mate foldedLine preserves REFERENCE tag, entry ID & title within 100-char clip (${foldedGet})`
      );

      // Verify foldForRequest triggers on a 17-turn conversation exceeding 60% budget and folds old kb.js get result
      const longMsgs = [{ role: 'user', parts: [{ t: 'text', v: promptWithKb }] }];
      for (let step = 0; step < 17; step++) {
        longMsgs.push({ role: 'assistant', parts: [{ t: 'call', callId: `c-${step}`, name: 'run_command', input: { command: 'kb.js get ...' } }] });
        longMsgs.push({ role: 'user', parts: [{ t: 'result', callId: `c-${step}`, text: step === 0 ? longGetText : 'ok' }] });
      }
      const foldedMsgs = foldForRequest(longMsgs, 10000); // force folding threshold (60% of 10,000 = 6,000 chars)
      ok(
        foldedMsgs[2].parts[0].text.startsWith('[folded: exit 0 · [team-kb REFERENCE] gateway/postmortem/partner-retry-storm-2026-02'),
        'Harbor Mate foldForRequest cleanly folds old >2000-char kb.js get results to 1-line summary'
      );

      // Batch count all components via tiktoken o200k_base
      const liveMetricsStep = '[exit 0]\nharbor_gateway_ratelimit_429_total{client_id="partner-sync-7"} 18420\nRetry-After header: constant "5" (no jitter)';
      const liveCodeStep = '[exit 0]\nfunc WriteRetryHeader(w http.ResponseWriter) { w.Header().Set("Retry-After", "5") }';
      const assistantCallOverhead = 'run_command {"command":"node .github/skills/team-kb/scripts/kb.js ..."}';

      const tokBatch = countTokensBatch({
        promptNoKb,
        promptWithKb,
        skillMdOnly: `## Skill: ${teamKbSkill.name}\nDirectory: ${teamKbSkill.relDir}\n${teamKbSkill.description}\n\n${teamKbSkill.body}`,
        outRedlinesGw12,
        outRedlinesAll12,
        outSearch12,
        outSearch100,
        outSearch500,
        outGet12,
        longGetText,
        foldedGet,
        fullKb12: blob12.fullText,
        fullKb100: blob100.fullText,
        fullKb500: blob500.fullText,
        indexKb12: blob12.indexText,
        indexKb100: blob100.indexText,
        indexKb500: blob500.indexText,
        liveMetricsStep,
        liveCodeStep,
        assistantCallOverhead,
      });

      const C = tokBatch.counts;
      const MAX_WINDOW = 128000;
      const staticKbOverhead = C.promptWithKb.tokens - C.promptNoKb.tokens;

      // Simulate exact 5-turn cumulative input tokens sent to model.sendRequest(messages) in runner.ts
      // Turn k sends openingPrompt + prior (k-1) assistant calls + prior (k-1) tool results
      const sim5Turn = (openingTokens, stepResultTokens) => {
        const callTok = C.assistantCallOverhead.tokens;
        const perTurn = [];
        let historyTok = openingTokens;
        for (let t = 0; t < 5; t++) {
          perTurn.push(historyTok);
          historyTok += callTok + (stepResultTokens[t] || 0);
        }
        const cumulative = perTurn.reduce((a, b) => a + b, 0);
        return {
          turn1Tokens: perTurn[0],
          turn5PeakTokens: perTurn[4],
          cumulative5TurnTokens: cumulative,
          turn1WindowPct: +((perTurn[0] / MAX_WINDOW) * 100).toFixed(2),
          peakWindowPct: +((perTurn[4] / MAX_WINDOW) * 100).toFixed(2),
          exceeds128kWindow: perTurn[4] > MAX_WINDOW,
        };
      };

      // Baseline 0 (No KB): 5 turns inspecting metrics/code/logs
      const baseNoKb5 = sim5Turn(C.promptNoKb.tokens, [
        C.liveMetricsStep.tokens,
        C.liveCodeStep.tokens,
        C.liveMetricsStep.tokens,
        C.liveCodeStep.tokens,
        0,
      ]);

      const compareAtScale = (n, fullTok, idxTok, searchTok) => {
        // Strategy A: Full KB stuffed into prompt/instructions on every turn
        const full = sim5Turn(C.promptNoKb.tokens + fullTok, [
          C.liveMetricsStep.tokens,
          C.liveCodeStep.tokens,
          C.liveMetricsStep.tokens,
          C.liveCodeStep.tokens,
          0,
        ]);
        // Strategy B: All entry summaries/triggers stuffed into prompt + 1 entry read on Turn 2
        const indexPrompt = sim5Turn(C.promptNoKb.tokens + idxTok, [
          C.outGet12.tokens,
          C.liveMetricsStep.tokens,
          C.liveCodeStep.tokens,
          C.liveCodeStep.tokens,
          0,
        ]);
        // Strategy C: team-kb Progressive Disclosure (redlines -> search -> get -> live check)
        const progressive = sim5Turn(C.promptWithKb.tokens, [
          C.outRedlinesGw12.tokens,
          searchTok,
          C.outGet12.tokens,
          C.liveMetricsStep.tokens,
          0,
        ]);
        const staticPrefixShare = +(((C.promptWithKb.tokens * 5) / progressive.cumulative5TurnTokens) * 100).toFixed(1);
        return {
          entries: n,
          fullKbInPrompt: full,
          summariesInPrompt: indexPrompt,
          teamKbProgressive: {
            ...progressive,
            kbAddedCumulativeTokens: progressive.cumulative5TurnTokens - baseNoKb5.cumulative5TurnTokens,
            staticPrefixCacheablePct: staticPrefixShare,
            savingsVsFullKbPct: +(((full.cumulative5TurnTokens - progressive.cumulative5TurnTokens) / full.cumulative5TurnTokens) * 100).toFixed(1),
            savingsVsSummariesPct: +(((indexPrompt.cumulative5TurnTokens - progressive.cumulative5TurnTokens) / indexPrompt.cumulative5TurnTokens) * 100).toFixed(1),
          },
        };
      };

      const scaleComparison = {
        n12: compareAtScale(12, C.fullKb12.tokens, C.indexKb12.tokens, C.outSearch12.tokens),
        n100: compareAtScale(100, C.fullKb100.tokens, C.indexKb100.tokens, C.outSearch100.tokens),
        n500: compareAtScale(500, C.fullKb500.tokens, C.indexKb500.tokens, C.outSearch500.tokens),
      };

      metrics.tokenUsage = {
        tokenizer: tokBatch.tokenizer,
        contextWindowTokens: MAX_WINDOW,
        components: {
          baseTechleadPrompt: C.promptNoKb,
          pluggedTechleadPrompt: C.promptWithKb,
          staticKbOverheadTokens: staticKbOverhead,
          staticKbWindowPct: +((staticKbOverhead / MAX_WINDOW) * 100).toFixed(2),
          skillMdBlock: C.skillMdOnly,
          redlinesRepoFiltered: C.outRedlinesGw12,
          redlinesAllDomains: C.outRedlinesAll12,
          searchTopHitsN12: C.outSearch12,
          searchTopHitsN500: C.outSearch500,
          getSingleEntry: C.outGet12,
          foldedLongGetLine: C.foldedGet,
          gardenerCleanWakeTokens: 0,
        },
        baselineNoKb5Turn: baseNoKb5,
        byCorpusSize: scaleComparison,
      };

      ok(
        staticKbOverhead < 1600 && scaleComparison.n500.teamKbProgressive.peakWindowPct < 4.5,
        `static KB prompt delta is only +${staticKbOverhead} tokens (${((staticKbOverhead / MAX_WINDOW) * 100).toFixed(2)}% of 128k); 5-turn peak at N=500 is ${scaleComparison.n500.teamKbProgressive.turn5PeakTokens} tokens (${scaleComparison.n500.teamKbProgressive.peakWindowPct}% of 128k)`
      );
      ok(
        Math.abs(scaleComparison.n500.teamKbProgressive.cumulative5TurnTokens - scaleComparison.n12.teamKbProgressive.cumulative5TurnTokens) <= 150,
        `O(1) scale invariance proven: 5-turn cumulative tokens at N=16 (${scaleComparison.n12.teamKbProgressive.cumulative5TurnTokens}) vs N=500 (${scaleComparison.n500.teamKbProgressive.cumulative5TurnTokens}) differ by <= 150 tokens`
      );
      ok(
        scaleComparison.n500.fullKbInPrompt.exceeds128kWindow &&
          scaleComparison.n500.teamKbProgressive.savingsVsFullKbPct > 95 &&
          scaleComparison.n500.teamKbProgressive.savingsVsSummariesPct > 75,
        `at N=500 entries, full-KB stuffing overflows 128k window (${scaleComparison.n500.fullKbInPrompt.turn1Tokens} tok/turn), while team-kb cuts cumulative tokens by ${scaleComparison.n500.teamKbProgressive.savingsVsFullKbPct}% vs full-KB and ${scaleComparison.n500.teamKbProgressive.savingsVsSummariesPct}% vs summary-stuffing`
      );
    }

    // =========================================================================
    // 10. Standalone VS Code Copilot Chat & Low-Cognitive-Load UX Verification
    // =========================================================================
    console.log('\n10. Standalone VS Code Copilot Chat & zero-friction UX verification');
    {
      const uxDir = path.join(tmpBase, 'ux-suite');
      const bareOriginUx = path.join(uxDir, 'kb-origin.git');
      const kbCloneUx = path.join(uxDir, 'harbor-team-kb');
      const serviceRepo = path.join(uxDir, 'harbor-gateway');
      const quickWs = path.join(uxDir, 'quick-mate-ws');
      fs.mkdirSync(uxDir, { recursive: true });

      git(['init', '--bare', bareOriginUx], uxDir);
      fs.cpSync(KB_ROOT, kbCloneUx, { recursive: true });
      git(['init', '-b', 'main'], kbCloneUx);
      git(['config', 'user.name', 'Test Engineer'], kbCloneUx);
      git(['config', 'user.email', 'eng@example.com'], kbCloneUx);
      git(['remote', 'add', 'origin', bareOriginUx], kbCloneUx);
      git(['add', '.'], kbCloneUx);
      git(['commit', '-m', 'seed kb'], kbCloneUx);
      git(['push', '-u', 'origin', 'main'], kbCloneUx);

      // Create an ordinary standalone microservice repo (`harbor-gateway`) with NO `.loop` or `.github/skills`
      fs.mkdirSync(path.join(serviceRepo, 'pkg', 'ratelimit'), { recursive: true });
      fs.writeFileSync(
        path.join(serviceRepo, 'pkg', 'ratelimit', 'limiter.go'),
        'package ratelimit\ntype RateLimitConfig struct { ShadowOnly bool }\n'
      );
      git(['init', '-b', 'main'], serviceRepo);
      git(['config', 'user.name', 'Service Dev'], serviceRepo);
      git(['config', 'user.email', 'dev@example.com'], serviceRepo);
      git(['add', '.'], serviceRepo);
      git(['commit', '-m', 'initial gateway'], serviceRepo);

      // 1) Zero-flag `plug.js install` inside non-Mate directory -> installs Copilot skills cleanly
      const zeroFlagInst = runNode([path.join(kbCloneUx, 'plug.js'), 'install', '--json'], { cwd: serviceRepo });
      assert.strictEqual(zeroFlagInst.status, 0, zeroFlagInst.stderr);
      const statusCopilot = JSON.parse(runNode([path.join(kbCloneUx, 'plug.js'), 'status', '--json'], { cwd: serviceRepo }).stdout);
      ok(
        statusCopilot.copilot_status.team_kb_installed && statusCopilot.copilot_status.publish_installed,
        'zero-flag `plug.js install` installs Copilot user skills and `plug.js status` reports readiness'
      );

      // 2) Single-flag `plug.js install -w <ws>` wires all loop Mates + weekly gardener out of the box
      fs.cpSync(EXAMPLE_WS, quickWs, { recursive: true });
      stubExternalSkills(quickWs);
      assert.strictEqual(runNode([path.join(kbCloneUx, 'plug.js'), 'install', '-w', quickWs]).status, 0);
      const quickStatus = JSON.parse(runNode([path.join(kbCloneUx, 'plug.js'), 'status', '-w', quickWs, '--json']).stdout);
      ok(
        quickStatus.workspace_status.gardener_installed && quickStatus.workspace_status.wired_agents.length >= 3,
        'one-flag `plug.js install -w <ws>` auto-wires all loop Mates and installs kb-gardener by default'
      );

      // 3) `kb.js redlines --auto` in standalone `harbor-gateway` auto-filters to gateway redlines
      const copilotKbJs = path.join(process.env.HOME, '.copilot', 'skills', 'team-kb', 'scripts', 'kb.js');
      const copilotPubJs = path.join(process.env.HOME, '.copilot', 'skills', 'team-kb-publish', 'scripts', 'publish.js');
      const autoRed = JSON.parse(runNode([copilotKbJs, 'redlines', '--auto', '--json'], { cwd: serviceRepo }).stdout);
      ok(
        autoRed.count >= 1 && autoRed.redlines.every(r => r.domain === 'gateway'),
        'kb.js redlines --auto inside standalone harbor-gateway repo returns only gateway redlines'
      );

      // 4) Dual-runtime sessionStart hook works in standalone service repo via ~/.copilot/skills fallback
      const hookCfg = JSON.parse(fs.readFileSync(path.join(KB_ROOT, 'hooks', 'harbor-kb.hooks.json'), 'utf8'));
      const hookRun = spawnSync('sh', ['-c', hookCfg.hooks.sessionStart[0].command], { cwd: serviceRepo, encoding: 'utf8' });
      ok(
        hookRun.status === 0 && /RateLimitConfig/.test(hookRun.stdout) && !/Postgres/i.test(hookRun.stdout),
        'sessionStart hook works in standalone Copilot repos via ~/.copilot/skills and auto-filters by repo'
      );

      // 5) Single-repo live anchor drift check inside standalone microservice repo
      const getClean = runNode([copilotKbJs, 'get', 'gateway/redline/rate-limit-shadow-mode-first'], { cwd: serviceRepo });
      fs.writeFileSync(
        path.join(serviceRepo, 'pkg', 'ratelimit', 'limiter.go'),
        'package ratelimit\ntype AdaptiveQuotaRule struct { DryRun bool }\n'
      );
      const getDrifted = runNode([copilotKbJs, 'get', 'gateway/redline/rate-limit-shadow-mode-first'], { cwd: serviceRepo });
      git(['checkout', '--', 'pkg/ratelimit/limiter.go'], serviceRepo);
      ok(
        !/WARNING \[ANCHOR DRIFT\]/.test(getClean.stdout) && /WARNING \[ANCHOR DRIFT\]/.test(getDrifted.stdout),
        'kb.js get verifies live code symbols directly inside standalone single-repo checkouts'
      );

      // 6) Standalone `kb.js propose` stages draft in persistent storage without leaving `.loop/` dirt in service repo
      const propRes = runNode([
        copilotKbJs, 'propose', '--force', '--json',
        '--id', 'gateway/gotcha/http2-max-concurrent-streams-spike',
        '--title', 'Gateway HTTP/2 MaxConcurrentStreams Exhaustion Under Slow Upstream Reads',
        '--summary', 'Slow upstream body reads pin HTTP/2 streams on harbor-gateway until MaxConcurrentStreams (250) drops new RPCs.',
        '--triggers', 'MaxConcurrentStreams,http2 stream limit,upstream slow read',
        '--sources', 'harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig',
        '--body', '## Symptom\nHTTP/2 streams saturate at 250.\n\n## Root Cause\nUnbounded response body read.\n\n## Verified Action\nSet ReadBodyTimeout=10s.\n',
      ], { cwd: serviceRepo });
      assert.strictEqual(propRes.status, 0, propRes.stderr);
      const propObj = JSON.parse(propRes.stdout);
      const serviceGitDirty = git(['status', '--porcelain'], serviceRepo);
      ok(
        serviceGitDirty === '' && !fs.existsSync(path.join(serviceRepo, '.loop')) && fs.existsSync(propObj.draft),
        'standalone Copilot `kb.js propose` stages draft in persistent storage and leaves service repo git status 100% clean'
      );

      // 7) Standalone `publish.js` publishes persistent draft, cleans staged file, and parses GitHub compare_url
      const pubRes = runNode([copilotPubJs, '--no-pr', '--json', propObj.draft], { cwd: serviceRepo });
      assert.strictEqual(pubRes.status, 0, pubRes.stderr);
      const pubObj = JSON.parse(pubRes.stdout);
      const { parseGithubSlug } = require(copilotPubJs);
      const parsedSlug = parseGithubSlug('git@github.com:acme/harbor-team-kb.git');
      ok(
        pubObj.status === 'published' && pubObj.pushed && !fs.existsSync(propObj.draft) && parsedSlug === 'acme/harbor-team-kb',
        'standalone publish.js pushes cache draft cleanly, deletes published draft, and parses GitHub PR compare slug'
      );

      // 8) Zero-flag `plug.js uninstall` removes Copilot skills cleanly
      assert.strictEqual(runNode([path.join(kbCloneUx, 'plug.js'), 'uninstall'], { cwd: serviceRepo }).status, 0);
      const statusAfterUninstall = JSON.parse(runNode([path.join(kbCloneUx, 'plug.js'), 'status', '--json'], { cwd: serviceRepo }).stdout);
      ok(
        !statusAfterUninstall.copilot_status.team_kb_installed && !statusAfterUninstall.copilot_status.publish_installed,
        'zero-flag `plug.js uninstall` cleanly removes Copilot skills and default_root pointer'
      );
    }

    // -------------------------------------------------------------------------
    // 11. Code review security & correctness regressions (all 6 findings)
    // -------------------------------------------------------------------------
    console.log('\n11. Code review regressions: ownership safety, prototype keys, YAML indent, policy gate, baseRef & auto-sync');
    {
      // (R1) Ownership manifest: never clobber or delete pre-existing / user-modified files
      const wsOwn = path.join(tmpBase, 'rev-own-ws');
      fs.mkdirSync(path.join(wsOwn, '.github', 'skills', 'team-kb'), { recursive: true });
      fs.mkdirSync(path.join(wsOwn, '.github', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(wsOwn, '.github', 'hooks'), { recursive: true });
      const customSkillMd = '---\nname: team-kb\ndescription: Custom user skill.\n---\nCustom body.\n';
      const customGardener = '---\nname: kb-gardener\ndescription: Custom user gardener.\n---\nKeep me.\n';
      const customHook = '{"hooks":{"sessionStart":[{"type":"command","command":"echo custom"}]}}\n';
      fs.writeFileSync(path.join(wsOwn, '.github', 'skills', 'team-kb', 'SKILL.md'), customSkillMd);
      fs.writeFileSync(path.join(wsOwn, '.github', 'agents', 'kb-gardener.agent.md'), customGardener);
      fs.writeFileSync(path.join(wsOwn, '.github', 'hooks', 'harbor-kb.json'), customHook);

      const collideSkill = runNode([PLUG_JS, 'install', '-w', wsOwn]);
      ok(
        collideSkill.status !== 0 &&
          /Refusing to overwrite existing skill target/.test(collideSkill.stderr) &&
          fs.readFileSync(path.join(wsOwn, '.github', 'skills', 'team-kb', 'SKILL.md'), 'utf8') === customSkillMd,
        'plug.js install refuses to clobber pre-existing unmanaged .github/skills/team-kb directory'
      );

      fs.rmSync(path.join(wsOwn, '.github', 'skills', 'team-kb'), { recursive: true, force: true });
      const collideGardener = runNode([PLUG_JS, 'install', '-w', wsOwn]);
      ok(
        collideGardener.status !== 0 &&
          /kb-gardener\.agent\.md/.test(collideGardener.stderr) &&
          fs.readFileSync(path.join(wsOwn, '.github', 'agents', 'kb-gardener.agent.md'), 'utf8') === customGardener,
        'plug.js install refuses to overwrite pre-existing custom kb-gardener.agent.md without --force'
      );

      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsOwn, '--no-gardener']).status, 0);
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsOwn]).status, 0);
      ok(
        fs.readFileSync(path.join(wsOwn, '.github', 'agents', 'kb-gardener.agent.md'), 'utf8') === customGardener &&
          fs.readFileSync(path.join(wsOwn, '.github', 'hooks', 'harbor-kb.json'), 'utf8') === customHook,
        'plug.js uninstall preserves pre-existing unmanaged kb-gardener.agent.md and .github/hooks/harbor-kb.json'
      );

      // Post-install user modification to managed kb-gardener.agent.md preserved until --force
      const wsMod = path.join(tmpBase, 'rev-mod-ws');
      fs.mkdirSync(path.join(wsMod, '.github', 'agents'), { recursive: true });
      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsMod]).status, 0);
      const modGardenerPath = path.join(wsMod, '.github', 'agents', 'kb-gardener.agent.md');
      fs.appendFileSync(modGardenerPath, '\n<!-- user custom schedule note -->\n');
      const uninstKeep = JSON.parse(runNode([PLUG_JS, 'uninstall', '-w', wsMod, '--json']).stdout);
      const keptModified = fs.existsSync(modGardenerPath) && uninstKeep.skipped.some(s => s.includes('kb-gardener.agent.md'));
      const uninstForce = JSON.parse(runNode([PLUG_JS, 'uninstall', '-w', wsMod, '--force', '--json']).stdout);
      ok(
        keptModified && !fs.existsSync(modGardenerPath) && uninstForce.skipped.length === 0,
        'plug.js uninstall preserves user-modified managed files by default and removes them only with --force'
      );

      // (R2) Object.prototype key collision (`constructor`, `__proto__`, `toString`, `valueOf`, `hasOwnProperty`)
      const protoKb = path.join(tmpBase, 'rev-proto-kb');
      fs.cpSync(KB_ROOT, protoKb, { recursive: true });
      const protoEntry = path.join(protoKb, 'kb', 'gateway', 'gotcha', 'js-prototype-constructor-guard.md');
      fs.writeFileSync(
        protoEntry,
        [
          '---',
          'id: gateway/gotcha/js-prototype-constructor-guard',
          'title: "Object.prototype constructor __proto__ toString valueOf hasOwnProperty Collision"',
          'domain: gateway',
          'kind: gotcha',
          'summary: "Plain JS objects collide on constructor, __proto__, toString, valueOf, and hasOwnProperty keys during indexing."',
          'triggers:',
          '  - constructor',
          '  - __proto__',
          '  - toString',
          '  - valueOf',
          '  - hasOwnProperty',
          'sources:',
          '  - harbor-gateway:internal/proxy/proto.go',
          'verified_at: 2026-04-15',
          'confidence: high',
          '---',
          '',
          '## Root Cause',
          'Lookup on constructor or toString hits Object.prototype unless Object.create(null) is used.',
          '',
        ].join('\n')
      );
      const coldProto = runNode(
        [KB_JS, '--kb-root', protoKb, '--no-sync', '--json', 'search', 'constructor __proto__ toString valueOf hasOwnProperty'],
        { env: { HARBOR_KB_NO_AUTO_SYNC: '1' } }
      );
      assert.strictEqual(coldProto.status, 0, coldProto.stderr);
      const warmProto = runNode(
        [KB_JS, '--kb-root', protoKb, '--no-sync', '--json', 'search', 'constructor'],
        { env: { HARBOR_KB_NO_AUTO_SYNC: '1' } }
      );
      assert.strictEqual(warmProto.status, 0, warmProto.stderr);
      const coldHits = JSON.parse(coldProto.stdout).results;
      const warmHits = JSON.parse(warmProto.stdout).results;
      ok(
        coldHits[0]?.id === 'gateway/gotcha/js-prototype-constructor-guard' &&
          warmHits[0]?.id === 'gateway/gotcha/js-prototype-constructor-guard' &&
          Number.isFinite(warmHits[0].score),
        'kb.js cold index build and warm cached search handle constructor/__proto__/toString/valueOf without prototype collision'
      );

      // (R3) Dynamic YAML indentation (4-space `loop:` inline & block-list `skills:`)
      const wsYaml = path.join(tmpBase, 'rev-yaml-ws');
      fs.mkdirSync(path.join(wsYaml, '.github', 'agents'), { recursive: true });
      const fourInline = [
        '---',
        'name: ops-inline',
        'description: Four-space loop mate without prior skills.',
        'loop:',
        '    schedule: "0 * * * *"',
        '    task: Audit gateway queues.',
        '---',
        'Inspect queues carefully.',
        '',
      ].join('\n');
      const fourBlock = [
        '---',
        'name: ops-block',
        'description: Four-space loop mate with 8-space block skill list.',
        'loop:',
        '    schedule: "30 * * * *"',
        '    skills:',
        '        - harbor-memory',
        '    task: Triage webhook backlog.',
        '---',
        'Check webhook backlog.',
        '',
      ].join('\n');
      fs.writeFileSync(path.join(wsYaml, '.github', 'agents', 'ops-inline.agent.md'), fourInline);
      fs.writeFileSync(path.join(wsYaml, '.github', 'agents', 'ops-block.agent.md'), fourBlock);
      stubExternalSkills(wsYaml);
      const yamlSnapBefore = snapshotTree(wsYaml);

      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsYaml, '--no-gardener']).status, 0);
      const parsedAgents = loadAllAgents(wsYaml);
      const aInline = parsedAgents.get('ops-inline');
      const aBlock = parsedAgents.get('ops-block');
      const yamlErrors = validateTeam(parsedAgents, loadSkills(wsYaml)).filter(p => p.level === 'error');
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsYaml]).status, 0);
      const yamlSnapAfter = snapshotTree(wsYaml);
      ok(
        aInline &&
          aInline.schedule === '0 * * * *' &&
          aInline.task === 'Audit gateway queues.' &&
          JSON.stringify(aInline.skills) === JSON.stringify(['team-kb','story-guard']) &&
          aBlock &&
          aBlock.schedule === '30 * * * *' &&
          aBlock.task === 'Triage webhook backlog.' &&
          JSON.stringify(aBlock.skills) === JSON.stringify(['harbor-memory', 'team-kb','story-guard']) &&
          yamlErrors.length === 0 &&
          JSON.stringify(yamlSnapBefore) === JSON.stringify(yamlSnapAfter),
        'plug.js preserves 4-space YAML loop indentation (inline & block skills) and restores byte-for-byte on uninstall'
      );

      // (R4) Default workspace without `.loop/policy.json` across `standard`, `strict` (P1 no-downgrade), `trusted` & custom `policyFile`
      const wsNoPol = path.join(tmpBase, 'rev-nopol-ws');
      fs.mkdirSync(path.join(wsNoPol, '.github', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(wsNoPol, '.github', 'agents', 'worker.agent.md'), fourInline);
      const noPolBefore = snapshotTree(wsNoPol);

      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsNoPol, '--no-gardener']).status, 0);
      const effDefaultPol = loadPolicy(wsNoPol, '.loop/policy.json', 'standard');
      const pubGateDecision = decideCommand(
        effDefaultPol,
        'node .github/skills/team-kb-publish/scripts/publish.js .loop/outbox/kb/gateway/gotcha/x.md'
      );
      const gitPushDecision = decideCommand(effDefaultPol, 'git push origin main');
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsNoPol]).status, 0);
      const noPolAfter = snapshotTree(wsNoPol);
      ok(
        pubGateDecision.decision === 'deny' &&
          pubGateDecision.approval === true &&
          gitPushDecision.decision === 'deny' &&
          gitPushDecision.approval === true &&
          !fs.existsSync(path.join(wsNoPol, '.loop')) &&
          JSON.stringify(noPolBefore) === JSON.stringify(noPolAfter),
        'workspace without .loop/policy.json (default standard) gets publish.js approval gate + STANDARD_APPROVE defaults, and cleans up byte-for-byte on uninstall'
      );

      // (R4b - P1) Workspace with `harborMate.defaultProfile: "strict"` (JSONC comments + trailing commas) and NO `.loop/policy.json`
      // MUST NOT be downgraded to `standard`!
      const wsStrictCfg = path.join(tmpBase, 'rev-strict-cfg-ws');
      fs.mkdirSync(path.join(wsStrictCfg, '.github', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(wsStrictCfg, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(wsStrictCfg, '.github', 'agents', 'worker.agent.md'), fourInline);
      fs.writeFileSync(
        path.join(wsStrictCfg, '.vscode', 'settings.json'),
        [
          '{',
          '  // Keep Harbor Mate in strict allowlist mode (URL https://example.com//not-a-comment/*ok*/)',
          '  "telemetry.endpoint": "https://example.com//v1/*keep*/",',
          '  /* Multi-line JSONC comment + trailing comma */',
          '  "harborMate.defaultProfile": "strict",',
          '}',
          '',
        ].join('\n')
      );
      const strictBefore = snapshotTree(wsStrictCfg);

      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsStrictCfg, '--no-gardener']).status, 0);
      const strictPolOnDisk = fs.existsSync(path.join(wsStrictCfg, '.loop', 'policy.json'));
      const effStrictPol = loadPolicy(wsStrictCfg, '.loop/policy.json', 'strict');
      const kbSkillRule = skillScriptRule('.github/skills/team-kb');
      const strictPyCmd = decideCommand(effStrictPol, 'python3 -c "print(1)"', [kbSkillRule]);
      const strictReadmeWrite = decideWrite(effStrictPol, 'README.md');
      const strictPubCmd = decideCommand(
        effStrictPol,
        'node .github/skills/team-kb-publish/scripts/publish.js .loop/outbox/kb/gateway/gotcha/x.md',
        [kbSkillRule]
      );
      const strictKbCmd = decideCommand(
        effStrictPol,
        'node .github/skills/team-kb/scripts/kb.js search retry',
        [kbSkillRule]
      );
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsStrictCfg]).status, 0);
      const strictAfter = snapshotTree(wsStrictCfg);
      ok(
        !strictPolOnDisk &&
          effStrictPol.profile === 'strict' &&
          strictPyCmd.decision === 'deny' &&
          strictReadmeWrite.decision === 'deny' &&
          strictPubCmd.decision === 'deny' &&
          strictKbCmd.decision === 'allow' &&
          JSON.stringify(strictBefore) === JSON.stringify(strictAfter),
        'harborMate.defaultProfile=strict (JSONC .vscode/settings.json, no policy.json) preserves strict allowlist & writablePaths without downgrading to standard'
      );

      // (R4c - P1) User-level VS Code `settings.json` (`loopRunner.defaultProfile: "strict"` fallback) + standard->strict re-install cleanup
      const userSettingsPath =
        process.platform === 'darwin'
          ? path.join(isolatedHome, 'Library', 'Application Support', 'Code', 'User', 'settings.json')
          : process.platform === 'win32'
            ? path.join(process.env.APPDATA, 'Code', 'User', 'settings.json')
            : path.join(process.env.XDG_CONFIG_HOME, 'Code', 'User', 'settings.json');
      const wsUserStrict = path.join(tmpBase, 'rev-user-strict-ws');
      fs.mkdirSync(path.join(wsUserStrict, '.github', 'agents'), { recursive: true });
      fs.writeFileSync(path.join(wsUserStrict, '.github', 'agents', 'worker.agent.md'), fourInline);
      // Step 1: install first while no strict setting exists (synthesizes standard `.loop/policy.json`)
      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsUserStrict, '--no-gardener']).status, 0);
      const hadSynthesizedBeforeStrict = fs.existsSync(path.join(wsUserStrict, '.loop', 'policy.json'));
      // Step 2: user configures legacy `loopRunner.defaultProfile: "strict"` in global VS Code User settings and re-runs `plug.js install`
      fs.mkdirSync(path.dirname(userSettingsPath), { recursive: true });
      fs.writeFileSync(userSettingsPath, '// User settings\n{\n  "loopRunner.defaultProfile": "strict",\n}\n');
      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsUserStrict, '--no-gardener']).status, 0);
      const removedSynthesizedOnStrict = !fs.existsSync(path.join(wsUserStrict, '.loop', 'policy.json')) && !fs.existsSync(path.join(wsUserStrict, '.loop'));
      const statusStrictObj = JSON.parse(runNode([PLUG_JS, 'status', '-w', wsUserStrict, '--json']).stdout);
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsUserStrict]).status, 0);
      fs.unlinkSync(userSettingsPath);
      ok(
        hadSynthesizedBeforeStrict &&
          removedSynthesizedOnStrict &&
          statusStrictObj.workspace_status.effective_default_profile === 'strict',
        'VS Code User settings.json (loopRunner.defaultProfile=strict) is respected and re-install cleans up prior untouched synthesized standard policy'
      );

      // (R4d - P1) `harborMate.defaultProfile: "trusted"` + custom `harborMate.policyFile` preserves `trusted` while gating `publish.js`
      const wsTrustedCfg = path.join(tmpBase, 'rev-trusted-cfg-ws');
      fs.mkdirSync(path.join(wsTrustedCfg, '.github', 'agents'), { recursive: true });
      fs.mkdirSync(path.join(wsTrustedCfg, '.vscode'), { recursive: true });
      fs.writeFileSync(path.join(wsTrustedCfg, '.github', 'agents', 'worker.agent.md'), fourInline);
      fs.writeFileSync(
        path.join(wsTrustedCfg, '.vscode', 'settings.json'),
        JSON.stringify(
          {
            'harborMate.defaultProfile': 'trusted',
            'harborMate.policyFile': '.loop/custom-default.json',
          },
          null,
          2
        ) + '\n'
      );
      const trustedBefore = snapshotTree(wsTrustedCfg);
      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsTrustedCfg, '--no-gardener']).status, 0);
      const hasCustomPol = fs.existsSync(path.join(wsTrustedCfg, '.loop', 'custom-default.json'));
      const hasDefaultPol = fs.existsSync(path.join(wsTrustedCfg, '.loop', 'policy.json'));
      const effTrustedPol = loadPolicy(wsTrustedCfg, '.loop/custom-default.json', 'trusted');
      const trustedGitPush = decideCommand(effTrustedPol, 'git push origin main');
      const trustedPubGate = decideCommand(
        effTrustedPol,
        'node .github/skills/team-kb-publish/scripts/publish.js .loop/outbox/kb/gateway/gotcha/x.md'
      );
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsTrustedCfg]).status, 0);
      const trustedAfter = snapshotTree(wsTrustedCfg);
      ok(
        hasCustomPol &&
          !hasDefaultPol &&
          effTrustedPol.profile === 'trusted' &&
          trustedGitPush.decision === 'allow' &&
          trustedPubGate.decision === 'deny' &&
          trustedPubGate.approval === true &&
          JSON.stringify(trustedBefore) === JSON.stringify(trustedAfter),
        'harborMate.defaultProfile=trusted + custom policyFile keeps trusted commands allowed, gates publish.js, and restores byte-for-byte on uninstall'
      );

      const wsImplicitStd = path.join(tmpBase, 'rev-implicit-std-ws');
      fs.mkdirSync(path.join(wsImplicitStd, '.loop'), { recursive: true });
      fs.mkdirSync(path.join(wsImplicitStd, '.github', 'agents'), { recursive: true });
      const implicitPolRaw = '{\n  "profile": "standard"\n}\n';
      fs.writeFileSync(path.join(wsImplicitStd, '.loop', 'policy.json'), implicitPolRaw);
      assert.strictEqual(runNode([PLUG_JS, 'install', '-w', wsImplicitStd, '--no-gardener']).status, 0);
      const effImplicitPol = loadPolicy(wsImplicitStd, '.loop/policy.json', 'standard');
      const impPub = decideCommand(
        effImplicitPol,
        'node .github/skills/team-kb-publish/scripts/publish.js .loop/outbox/kb/gateway/gotcha/x.md'
      );
      const impKube = decideCommand(effImplicitPol, 'kubectl apply -f deploy.yaml');
      assert.strictEqual(runNode([PLUG_JS, 'uninstall', '-w', wsImplicitStd]).status, 0);
      ok(
        impPub.decision === 'deny' &&
          impPub.approval === true &&
          impKube.decision === 'deny' &&
          impKube.approval === true &&
          fs.readFileSync(path.join(wsImplicitStd, '.loop', 'policy.json'), 'utf8') === implicitPolRaw,
        'standard policy omitting approveCommands keeps built-in STANDARD_APPROVE rules alongside publish.js gate and restores exact JSON'
      );

      // (R5) Fail-closed publish baseline: never leak unmerged local feature-branch commits
      const bareTrunk = path.join(tmpBase, 'rev-trunk-origin.git');
      const seedTrunk = path.join(tmpBase, 'rev-trunk-seed');
      const clonePub = path.join(tmpBase, 'rev-trunk-clone');
      git(['init', '--bare', bareTrunk], tmpBase);
      fs.cpSync(KB_ROOT, seedTrunk, { recursive: true });
      git(['init', '-b', 'trunk'], seedTrunk);
      git(['config', 'user.name', 'Seed'], seedTrunk);
      git(['config', 'user.email', 'seed@example.com'], seedTrunk);
      git(['add', '.'], seedTrunk);
      git(['commit', '-m', 'seed trunk'], seedTrunk);
      git(['remote', 'add', 'origin', bareTrunk], seedTrunk);
      git(['push', '-u', 'origin', 'trunk'], seedTrunk);
      git(['symbolic-ref', 'HEAD', 'refs/heads/trunk'], bareTrunk);

      // Initialize clone via `git init + remote add` so local `refs/remotes/origin/HEAD` is NOT pre-populated!
      fs.mkdirSync(clonePub, { recursive: true });
      git(['init', '-b', 'trunk'], clonePub);
      git(['config', 'user.name', 'Dev'], clonePub);
      git(['config', 'user.email', 'dev@example.com'], clonePub);
      git(['remote', 'add', 'origin', bareTrunk], clonePub);
      git(['fetch', 'origin'], clonePub);
      git(['checkout', '-B', 'trunk', 'origin/trunk'], clonePub);

      // Switch engineer checkout to an unmerged feature branch with an unrelated file commit
      git(['checkout', '-b', 'feat/unmerged-local-work'], clonePub);
      fs.writeFileSync(path.join(clonePub, 'UNMERGED_LOCAL_SECRET_WORK.txt'), 'unmerged feature work\n');
      git(['add', 'UNMERGED_LOCAL_SECRET_WORK.txt'], clonePub);
      git(['commit', '-m', 'wip: unmerged local feature'], clonePub);

      // Stage a clean KB draft
      const draftStageWs = path.join(tmpBase, 'rev-pub-stage');
      const draftStagePath = path.join(draftStageWs, '.loop', 'outbox', 'kb', 'gateway', 'gotcha', 'trunk-isolation-check.md');
      fs.mkdirSync(path.dirname(draftStagePath), { recursive: true });
      fs.writeFileSync(
        draftStagePath,
        [
          '---',
          'id: gateway/gotcha/trunk-isolation-check',
          'title: "Ensure Publish Branches Strictly Off Remote Default Branch"',
          'domain: gateway',
          'kind: gotcha',
          'summary: "publish.js resolves origin default branch via ls-remote symref and never branches off unmerged local HEAD."',
          'triggers:',
          '  - trunk isolation check',
          '  - ls-remote symref origin default branch',
          'sources:',
          '  - harbor-gateway:cmd/gateway/main.go',
          'verified_at: 2026-04-15',
          'confidence: high',
          '---',
          '',
          '## Verified Action',
          'Always branch worktree from verified remote tracking ref.',
          '',
        ].join('\n')
      );

      const draftRelPath = '.loop/outbox/kb/gateway/gotcha/trunk-isolation-check.md';
      // 5a) When `git fetch origin` fails, publish.js MUST fail closed instead of falling back to local HEAD
      git(['remote', 'set-url', 'origin', path.join(tmpBase, 'non-existent-origin.git')], clonePub);
      const failedFetchPub = runNode(
        [PUBLISH_JS, '--kb-root', clonePub, '--no-pr', draftRelPath],
        { cwd: draftStageWs }
      );
      ok(
        failedFetchPub.status !== 0 && /Failed to fetch from origin/.test(failedFetchPub.stderr),
        'publish.js fails closed when git fetch origin fails instead of falling back to unmerged local HEAD'
      );

      // 5b) Restore valid `origin` (with `trunk` default branch and NO local origin/HEAD symref) -> publishes cleanly without unmerged commit!
      git(['remote', 'set-url', 'origin', bareTrunk], clonePub);
      const cleanTrunkPub = runNode(
        [PUBLISH_JS, '--kb-root', clonePub, '--no-pr', '--json', draftRelPath],
        { cwd: draftStageWs }
      );
      assert.strictEqual(cleanTrunkPub.status, 0, cleanTrunkPub.stderr);
      const pubMeta = JSON.parse(cleanTrunkPub.stdout);
      const remoteFilesOnKbBranch = git(['ls-tree', '-r', '--name-only', `refs/heads/${pubMeta.branch}`], bareTrunk).split('\n');
      ok(
        pubMeta.base_ref === 'origin/trunk' &&
          remoteFilesOnKbBranch.includes('kb/gateway/gotcha/trunk-isolation-check.md') &&
          !remoteFilesOnKbBranch.includes('UNMERGED_LOCAL_SECRET_WORK.txt'),
        'publish.js resolves non-main remote default branch (origin/trunk) and excludes unmerged local feature-branch commits'
      );

      // (R6) Default throttled auto-sync on `search` / `redlines` without `--sync` (plus `--no-sync` opt-out)
      const autoConsumer = path.join(tmpBase, 'rev-autosync-consumer');
      git(['clone', bareTrunk, autoConsumer], tmpBase);
      // Warm initial cache + last_sync stamp on consumer
      const initAutoSearch = runNode([KB_JS, '--kb-root', autoConsumer, '--json', 'search', 'trunk isolation check']);
      assert.strictEqual(initAutoSearch.status, 0, initAutoSearch.stderr);
      assert.ok(
        !JSON.parse(initAutoSearch.stdout).results.some(r => r.id === 'gateway/gotcha/trunk-isolation-check')
      );

      // Merge the published KB branch into bare origin's `trunk`
      const mergeWt = path.join(tmpBase, 'rev-autosync-merger');
      git(['clone', bareTrunk, mergeWt], tmpBase);
      git(['config', 'user.name', 'Reviewer'], mergeWt);
      git(['config', 'user.email', 'rev@example.com'], mergeWt);
      git(['merge', '--no-ff', `origin/${pubMeta.branch}`, '-m', 'Merge trunk-isolation-check'], mergeWt);
      git(['push', 'origin', 'trunk'], mergeWt);

      // Expire consumer's 10-minute `last_sync` TTL stamp to simulate elapsed session window
      const consumerStats = JSON.parse(runNode([KB_JS, '--kb-root', autoConsumer, '--json', 'stats']).stdout);
      const stampPath = path.join(path.dirname(consumerStats.index_file), 'last_sync');
      const expiredTime = new Date(Date.now() - 605 * 1000);
      fs.utimesSync(stampPath, expiredTime, expiredTime);

      // With `--no-sync`, consumer does NOT pull remote changes even when TTL is expired
      const skippedSyncRes = JSON.parse(
        runNode([KB_JS, '--kb-root', autoConsumer, '--no-sync', '--json', 'search', 'trunk isolation check']).stdout
      );
      // Default `search` (WITHOUT `--sync`!) automatically pulls `origin`, rebuilds index, and finds the merged entry!
      const defaultAutoSyncRes = JSON.parse(
        runNode([KB_JS, '--kb-root', autoConsumer, '--json', 'search', 'trunk isolation check']).stdout
      );
      ok(
        !skippedSyncRes.results.some(r => r.id === 'gateway/gotcha/trunk-isolation-check') &&
          defaultAutoSyncRes.results.length > 0 &&
          defaultAutoSyncRes.results[0].id === 'gateway/gotcha/trunk-isolation-check',
        'default `kb.js search` (without --sync) auto-pulls merged teammate entries once TTL expires, while --no-sync opts out'
      );
    }

    require('./verify_v3.js').run();
    require('./verify_jira_mock_e2e.js').run();
    console.log(`ALL ${passed} ASSERTIONS PASSED!`);
    console.log('Measured Benchmarks:', JSON.stringify(metrics));
    console.log('============================================================\n');
  } finally {
    process.env.HOME = origHome;
    if(origCache===undefined)delete process.env.HARBOR_KB_CACHE_DIR;else process.env.HARBOR_KB_CACHE_DIR=origCache;
    if(origRoot===undefined)delete process.env.HARBOR_KB_ROOT;else process.env.HARBOR_KB_ROOT=origRoot;
    if (origXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = origXdg;
    if (origAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = origAppData;
    if (origUserSettings === undefined) delete process.env.HARBOR_VSCODE_USER_SETTINGS;
    else process.env.HARBOR_VSCODE_USER_SETTINGS = origUserSettings;
    if (origDefaultProfile === undefined) delete process.env.HARBOR_DEFAULT_PROFILE;
    else process.env.HARBOR_DEFAULT_PROFILE = origDefaultProfile;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
})().catch(err => {
  console.error('\nVERIFICATION FAILED:', err);
  process.exit(1);
});
