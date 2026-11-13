#!/usr/bin/env node
'use strict';

/**
 * Publish a validated .loop/outbox/kb/<domain>/<kind>/<slug>.md (or staged cache draft)
 * to an isolated Git branch / GitHub Pull Request.
 *
 * Designed to run ONLY after human approval via Harbor Mate `request_approval`
 * (or interactive developer confirmation in Copilot Chat / CLI).
 * Uses a temporary `git worktree` so the active checkout is never disturbed.
 * Zero external dependencies (Node.js standard library only).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const POINTER_REL = path.join('.loop', 'outbox', 'kb', '.kb_root');

class PublishError extends Error {}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

function resolveKbRoot(explicit = null) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  const envRoot = (process.env.HARBOR_KB_ROOT || '').trim();
  if (envRoot) candidates.push(envRoot);
  if (fs.existsSync(POINTER_REL)) {
    try {
      const ptr = fs.readFileSync(POINTER_REL, 'utf8').trim();
      if (ptr) candidates.push(ptr);
    } catch {}
  }
  try {
    const realScript = fs.realpathSync(__filename);
    candidates.push(path.resolve(realScript, '..', '..', '..', '..'));
  } catch {}
  candidates.push(path.join(process.cwd(), 'repos', 'team-kb'));
  candidates.push(path.join(os.homedir(), '.harbor', 'team-kb'));
  const defaultPtr = path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root');
  if (fs.existsSync(defaultPtr)) {
    try {
      const ptr = fs.readFileSync(defaultPtr, 'utf8').trim();
      if (ptr) candidates.push(ptr);
    } catch {}
  }
  for (const c of candidates) {
    const absC = path.resolve(expandHome(c));
    try {
      if (fs.statSync(path.join(absC, 'kb')).isDirectory()) return absC;
    } catch {}
  }
  throw new PublishError('KB repository not found. Clone harbor-team-kb or run plug.js install first.');
}

function loadKbModule(kbRoot) {
  const fromKb = path.join(kbRoot, 'skills', 'team-kb', 'scripts', 'kb.js');
  const sibling = path.resolve(__dirname, '..', '..', 'team-kb', 'scripts', 'kb.js');
  const target = fs.existsSync(fromKb) ? fromKb : sibling;
  if (!fs.existsSync(target)) {
    throw new PublishError(`Cannot locate kb.js validator at ${fromKb}`);
  }
  return require(target);
}

function runCmd(args, { cwd = undefined, check = true } = {}) {
  const res = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
  if (res.error && check) {
    throw new PublishError(`Command failed (${args.slice(0, 3).join(' ')}...): ${res.error.message}`);
  }
  if (check && res.status !== 0) {
    const detail = (res.stderr || '').trim() || (res.stdout || '').trim() || `exit ${res.status}`;
    throw new PublishError(`Command failed (${args.slice(0, 3).join(' ')}...): ${detail}`);
  }
  return res;
}

function hasExecutable(binName) {
  const pathEnv = process.env.PATH || '';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const cand = path.join(dir, `${binName}${ext}`);
      try {
        if (fs.statSync(cand).isFile()) return true;
      } catch {}
    }
  }
  return false;
}

function parseGithubSlug(originUrl) {
  const m = String(originUrl || '')
    .trim()
    .match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

function formatTimestampCompact(d = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function resolveDraftTarget(draftPath, kbMod) {
  const rawNorm = String(draftPath || '').replace(/\\/g, '/').trim();
  if (rawNorm.split('/').includes('..')) {
    throw new PublishError('Draft path must not contain .. path traversal.');
  }
  const expanded = expandHome(rawNorm);
  let isCacheDraft = false;
  let relTail;
  let targetFile;

  if (!path.isAbsolute(expanded)) {
    let norm = expanded;
    while (norm.startsWith('./')) norm = norm.slice(2);
    if (!norm.startsWith('.loop/outbox/kb/')) {
      throw new PublishError('Relative draft path must live under .loop/outbox/kb/<domain>/<kind>/<slug>.md.');
    }
    relTail = norm.slice('.loop/outbox/kb/'.length);
    targetFile = norm;
  } else {
    const cacheBase =
      (process.env.HARBOR_KB_CACHE_DIR || '').trim() || path.join(os.homedir(), '.cache', 'harbor-kb');
    const draftsDir = path.join(path.resolve(expandHome(cacheBase)), 'drafts');
    fs.mkdirSync(draftsDir, { recursive: true });
    const draftsRoot = fs.realpathSync(draftsDir);
    if (!fs.existsSync(expanded)) {
      throw new PublishError(`Draft file not found: ${draftPath}`);
    }
    const realDraft = fs.realpathSync(expanded);
    if (!realDraft.startsWith(draftsRoot + path.sep)) {
      throw new PublishError(`Absolute draft path must live inside ${draftsRoot}/<domain>/<kind>/<slug>.md.`);
    }
    relTail = path.relative(draftsRoot, realDraft).replace(/\\/g, '/');
    targetFile = realDraft;
    isCacheDraft = true;
  }

  if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
    throw new PublishError(`Draft file not found: ${draftPath}`);
  }
  const parsed = kbMod.parseEntryId(relTail);
  if (!parsed) {
    throw new PublishError(`Invalid draft path ${draftPath}; expected <domain>/<kind>/<slug>.md.`);
  }
  return { targetFile, parsed, isCacheDraft };
}

function publishDraft(draftPath, kbRoot, { noPush = false, noPr = false, jsonOut = false } = {}) {
  const kbMod = loadKbModule(kbRoot);
  const { targetFile, parsed, isCacheDraft } = resolveDraftTarget(draftPath, kbMod);
  const [domain, kind, slug, entryId] = parsed;

  const { errors, warnings } = kbMod.validateEntryFile(targetFile, { expectedId: entryId });
  if (errors.length) {
    throw new PublishError(`Refusing to publish invalid draft:\n- ${errors.join('\n- ')}`);
  }

  const rawBytes = fs.readFileSync(targetFile);
  const sha256Hex = crypto.createHash('sha256').update(rawBytes).digest('hex');
  const { meta } = kbMod.parseMarkdownEntry(rawBytes.toString('utf8'));

  const top = runCmd(['git', '-C', kbRoot, 'rev-parse', '--show-toplevel']).stdout.trim();
  const kbRelInGit = path.relative(fs.realpathSync(top), fs.realpathSync(kbRoot)).replace(/\\/g, '/');
  const prefix = !kbRelInGit || kbRelInGit === '.' ? '' : `${kbRelInGit}/`;

  const remotes = (runCmd(['git', '-C', top, 'remote'], { check: false }).stdout || '')
    .split(/\s+/)
    .filter(Boolean);
  const hasOrigin = remotes.includes('origin');
  let baseRef = 'HEAD';
  if (hasOrigin && !noPush) {
    const fetchRes = runCmd(['git', '-C', top, 'fetch', 'origin', '--quiet'], { check: false });
    if (fetchRes.status === 0) {
      const sym = runCmd(['git', '-C', top, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { check: false });
      if (sym.status === 0 && (sym.stdout || '').trim()) {
        baseRef = sym.stdout.trim().replace(/^refs\/remotes\//, '');
      } else {
        for (const cand of ['origin/main', 'origin/master']) {
          if (runCmd(['git', '-C', top, 'rev-parse', '--verify', cand], { check: false }).status === 0) {
            baseRef = cand;
            break;
          }
        }
      }
    }
  }

  const stamp = formatTimestampCompact();
  const branch = `kb/${domain}-${slug}-${stamp}`;
  const cacheDir = kbMod.cacheDirFor(kbRoot);
  const lockFile = path.join(cacheDir, 'publish.lock');

  let commitSha = '';
  let pushed = false;
  let prUrl = null;
  let compareUrl = null;

  kbMod.withFileLock(lockFile, true, () => {
    const wtDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-kb-wt-'));
    try {
      runCmd(['git', '-C', top, 'worktree', 'add', '-b', branch, wtDir, baseRef]);
      const destRel = `${prefix}kb/${domain}/${kind}/${slug}.md`;
      const destAbs = path.join(wtDir, destRel);
      const existed = fs.existsSync(destAbs);
      fs.mkdirSync(path.dirname(destAbs), { recursive: true });
      fs.writeFileSync(destAbs, rawBytes);

      const userOk = runCmd(['git', '-C', wtDir, 'config', 'user.email'], { check: false });
      if (!(userOk.stdout || '').trim()) {
        runCmd(['git', '-C', wtDir, 'config', 'user.name', 'Harbor Mate KB']);
        runCmd(['git', '-C', wtDir, 'config', 'user.email', 'harbor-kb@localhost']);
      }

      runCmd(['git', '-C', wtDir, 'add', '--', destRel]);
      const diffCached = runCmd(['git', '-C', wtDir, 'diff', '--cached', '--quiet'], { check: false });
      if (diffCached.status === 0) {
        throw new PublishError(`Entry ${entryId} is already identical in ${baseRef}; nothing to publish.`);
      }

      const verb = existed ? 'update' : 'add';
      const commitTitle = `kb(${domain}): ${verb} ${kind}/${slug}`;
      runCmd(['git', '-C', wtDir, 'commit', '-m', commitTitle]);
      commitSha = runCmd(['git', '-C', wtDir, 'rev-parse', '--short', 'HEAD']).stdout.trim();

      if (hasOrigin && !noPush) {
        runCmd(['git', '-C', wtDir, 'push', '-u', 'origin', branch]);
        pushed = true;
        const originUrl = (
          runCmd(['git', '-C', wtDir, 'remote', 'get-url', 'origin'], { check: false }).stdout || ''
        ).trim();
        const ghSlug = parseGithubSlug(originUrl);
        if (ghSlug) {
          compareUrl = `https://github.com/${ghSlug}/compare/${branch}?expand=1`;
        }
        if (!noPr && ghSlug && hasExecutable('gh')) {
          const prBody = [
            '## Summary',
            '',
            `- **ID**: \`${entryId}\``,
            `- **Title**: ${meta.title || ''}`,
            `- **Summary**: ${meta.summary || ''}`,
            `- **Reviewed Draft SHA-256**: \`${sha256Hex.slice(0, 16)}…\``,
            '',
          ].join('\n');
          const prRes = runCmd(
            ['gh', 'pr', 'create', '--title', commitTitle, '--body', prBody, '--head', branch],
            { cwd: wtDir, check: false }
          );
          if (prRes.status === 0 && (prRes.stdout || '').trim()) {
            const lines = prRes.stdout.trim().split('\n');
            prUrl = lines[lines.length - 1];
          }
        }
      }
    } finally {
      runCmd(['git', '-C', top, 'worktree', 'remove', '--force', wtDir], { check: false });
      try { fs.rmSync(wtDir, { recursive: true, force: true }); } catch {}
    }
  });

  if (isCacheDraft) {
    try { fs.unlinkSync(targetFile); } catch {}
  }

  const result = {
    status: 'published',
    id: entryId,
    target: `${prefix}kb/${domain}/${kind}/${slug}.md`,
    branch,
    commit: commitSha,
    draft_sha256: sha256Hex,
    pushed,
    pr_url: prUrl,
    compare_url: compareUrl,
    warnings,
  };
  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Published ${entryId} on branch ${branch} (${commitSha}), pushed=${pushed}`);
    if (prUrl) console.log(`PR: ${prUrl}`);
    else if (compareUrl) console.log(`Open PR: ${compareUrl}`);
  }
  return result;
}

function parseCliArgs(argv) {
  const opts = {
    draft: null,
    kbRoot: null,
    noPush: false,
    noPr: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--no-push') opts.noPush = true;
    else if (raw === '--no-pr') opts.noPr = true;
    else if (raw === '--json') opts.json = true;
    else if (raw === '--help' || raw === '-h') opts.help = true;
    else if (raw === '--kb-root') {
      opts.kbRoot = argv[++i];
      if (!opts.kbRoot) throw new PublishError('Missing value for --kb-root');
    } else if (raw.startsWith('--kb-root=')) {
      opts.kbRoot = raw.slice('--kb-root='.length);
    } else if (raw.startsWith('-')) {
      throw new PublishError(`Unknown option: ${raw}`);
    } else if (!opts.draft) {
      opts.draft = raw;
    } else {
      throw new PublishError(`Unexpected positional argument: ${raw}`);
    }
  }
  return opts;
}

function main(argv = process.argv.slice(2)) {
  const a = parseCliArgs(argv);
  if (a.help || !a.draft) {
    console.log(
      'Usage: node publish.js [--kb-root <dir>] [--no-push] [--no-pr] [--json] <draft_path>'
    );
    return a.help ? 0 : 2;
  }
  const kbRoot = resolveKbRoot(a.kbRoot);
  publishDraft(a.draft, kbRoot, {
    noPush: a.noPush,
    noPr: a.noPr,
    jsonOut: a.json,
  });
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    if (err instanceof PublishError) {
      console.error(`team-kb-publish: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

module.exports = {
  PublishError,
  resolveKbRoot,
  parseGithubSlug,
  publishDraft,
};
