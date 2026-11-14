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

function realEngineRoot() {
  let dir = path.dirname(fs.realpathSync(__filename));
  while (path.dirname(dir) !== dir) {
    if (fs.existsSync(path.join(dir, 'plug.js')) && fs.existsSync(path.join(dir, 'skills'))) return fs.realpathSync(dir);
    dir = path.dirname(dir);
  }
  const ptr=path.join(os.homedir(),'.cache','harbor-kb','default_root');
  if(fs.existsSync(ptr)){const original=fs.readFileSync(ptr,'utf8').trim();if(fs.existsSync(path.join(original,'plug.js')) && fs.existsSync(path.join(original,'skills')))return fs.realpathSync(original);}
  return null;
}
function isPublicEngineRoot(root) {
  if (!root || !fs.existsSync(root)) return false;
  const real = fs.realpathSync(root);
  if (real === realEngineRoot()) return true;
  // A copied skill must recognize an engine by its target layout, without a cache pointer.
  const installer = path.join(real, 'plug.js');
  const skills = path.join(real, 'skills');
  return fs.existsSync(installer) && fs.statSync(installer).isFile() &&
    fs.existsSync(skills) && fs.statSync(skills).isDirectory();
}
function resolveKbRoot(explicit = null) {
  const engine = realEngineRoot();
  let fallbackEngine = engine, foundLegacyEngine = false;
  const read = p => fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  const candidates = [
    [explicit, 'CLI_FLAG'], [process.env.HARBOR_KB_ROOT, 'ENV_VAR'],
    [read(path.join('.loop', 'outbox', 'kb', '.kb_root')), 'WORKSPACE_PTR'],
    [read(path.join(os.homedir(), '.harbor', 'kb_data_root')), 'USER_DATA_PTR'],
    [read(path.join(os.homedir(), '.cache', 'harbor-kb', 'default_root')), 'LEGACY_CACHE_PTR'],
  ];
  for (const [value, source] of candidates) {
    if (!value || !String(value).trim()) continue;
    const root = path.resolve(expandHome(String(value).trim()));
    const real = fs.existsSync(root) ? fs.realpathSync(root) : root;
    if (['WORKSPACE_PTR','LEGACY_CACHE_PTR'].includes(source) && isPublicEngineRoot(real)) {
      if (!foundLegacyEngine) fallbackEngine = real;
      foundLegacyEngine = true;
      continue;
    }
    if (!fs.existsSync(path.join(root, 'kb')) || !fs.statSync(path.join(root, 'kb')).isDirectory()) throw new Error('Invalid configured KB root (' + source + ')');
    return {root: real, source};
  }
  for (const root of [path.resolve('repos', 'team-kb'), path.join(os.homedir(), '.harbor', 'team-kb')]) {
    if (fs.existsSync(path.join(root, 'kb'))) return {root: fs.realpathSync(root), source: 'CONVENTION_DIR'};
  }
  if (fallbackEngine) return {root: fallbackEngine, source: 'DEMO_FALLBACK'};
  throw new Error('KB repository not found; bind a private data repository.');
}

const KINDS = ['map', 'spec', 'redline', 'gotcha', 'runbook', 'adr', 'postmortem'];
const KIND_SET = new Set(KINDS);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const SECRET_CHECKS = [
  [new RegExp('\\bgh' + '[pousr]_[A-Za-z0-9]{20,}'), 'GitHub token'],
  [new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b'), 'AWS access key'],
  [new RegExp('-----BEGIN ' + '[A-Z ]*PRIVATE KEY-----'), 'private key'],
  [new RegExp('\\bxox' + '[abprs]-[A-Za-z0-9-]{10,}'), 'Slack token'],
  [new RegExp('\\bsk-' + '[A-Za-z0-9_-]{20,}'), 'API key'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}/, 'Bearer token'],
  [/(?<![A-Za-z0-9])(\/Users\/[A-Za-z0-9._-]+\/|\/home\/[A-Za-z0-9._-]+\/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)/, 'local machine user path'],
];

function stripInlineComment(line) {
  let inQ = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === inQ) inQ = null;
    } else if (ch === '"' || ch === "'") {
      inQ = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function unquote(val) {
  const s = val.trim();
  if (s.length >= 2 && s[0] === s[s.length - 1] && (s[0] === '"' || s[0] === "'")) {
    const inner = s.slice(1, -1);
    return s[0] === '"' ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner;
  }
  return s;
}

function parseInlineList(text) {
  const inner = text.trim().slice(1, -1).trim();
  if (!inner) return [];
  const items = [];
  let buf = '';
  let inQ = null;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inQ) {
      if (ch === inQ) inQ = null;
      else buf += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = ch;
    } else if (ch === ',') {
      const s = buf.trim();
      if (s) items.push(s);
      buf = '';
    } else {
      buf += ch;
    }
  }
  const tail = buf.trim();
  if (tail) items.push(tail);
  return items;
}

function parseMarkdownEntry(rawText) {
  const text = String(rawText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (!text.startsWith('---\n')) return { meta: {}, body: text };
  let end = text.indexOf('\n---\n', 4);
  if (end === -1) {
    if (text.endsWith('\n---')) end = text.length - 4;
    else return { meta: {}, body: text };
  }
  const fmBlock = text.slice(4, end);
  const body = end + 5 <= text.length ? text.slice(end + 5) : '';
  const meta = Object.create(null);
  let curListKey = null;
  for (const rawLine of fmBlock.split('\n')) {
    const line = stripInlineComment(rawLine);
    if (!line.trim()) continue;
    if (curListKey && /^\s*-\s+/.test(line)) {
      const item = unquote(line.replace(/^\s*-\s+/, ''));
      if (item) meta[curListKey].push(item);
      continue;
    }
    curListKey = null;
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const rest = m[2].trim();
    if (!rest) {
      meta[key] = [];
      curListKey = key;
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      meta[key] = parseInlineList(rest);
    } else {
      meta[key] = unquote(rest);
    }
  }
  return { meta, body: body.trim() };
}

function formatYamlScalar(v) {
  const s = String(v).trim();
  if (!s) return '""';
  if (/[:#[\]{},&*!|>'"%@`]/.test(s)) {
    const escaped = s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  return s;
}

function renderEntryMarkdown({ title, summary, triggers, sources, body, expires = null, disputed = null }) {
  const lines = [
    '---',
    `title: ${formatYamlScalar(title)}`,
    `summary: ${formatYamlScalar(summary)}`,
    `triggers: [${triggers.map(formatYamlScalar).join(', ')}]`,
    `sources: [${sources.map(formatYamlScalar).join(', ')}]`,
  ];
  if (expires) lines.push(`expires: ${formatYamlScalar(expires)}`);
  if (disputed) lines.push(`disputed: ${formatYamlScalar(disputed)}`);
  lines.push('---', '', body.trim(), '');
  return lines.join('\n');
}

function parseIsoDateStr(nowStr) {
  if (!nowStr) {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }
  const datePart = String(nowStr).trim().split('T')[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) {
    throw new KbError(`Invalid ISO date: ${nowStr}`);
  }
  const [y, m, d] = datePart.split('-').map(Number);
  const check = new Date(Date.UTC(y, m - 1, d));
  if (
    check.getUTCFullYear() !== y ||
    check.getUTCMonth() + 1 !== m ||
    check.getUTCDate() !== d
  ) {
    throw new KbError(`Invalid calendar date: ${nowStr}`);
  }
  return datePart;
}

function isValidIsoDate(s) {
  try {
    parseIsoDateStr(s);
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
  } catch {
    return false;
  }
}

function isExpiredDate(expiresStr, todayStr) {
  if (!expiresStr || !isValidIsoDate(expiresStr)) return false;
  return todayStr > expiresStr;
}

function oneLine(text, limit = 280) {
  const cleaned = String(text || '')
    .replace(/[\x00-\x1f\x7f]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


const SLEEP_ARRAY=new Int32Array(new SharedArrayBuffer(4));
const KbError=PublishError;
function sleepMs(ms){Atomics.wait(SLEEP_ARRAY,0,0,ms);}
function segmentTokens(s){return String(s).toLowerCase().match(/[a-z0-9]+/g)||[];}
function cacheDirFor(kbRoot) {
  const override = (process.env.HARBOR_KB_CACHE_DIR || '').trim();
  const realKb = fs.realpathSync(kbRoot);
  const key = crypto.createHash('sha256').update(realKb, 'utf8').digest('hex').slice(0, 12);
  const base = override
    ? path.resolve(expandHome(override))
    : path.join(os.homedir(), '.cache', 'harbor-kb');
  const dir = path.join(base, key);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function withFileLock(lockPath, blocking, fn) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + 15000;
  let fd = null;
  while (fd === null) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, `${process.pid}\n`);
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        try {
          const st = fs.statSync(lockPath);
          if (Date.now() - st.mtimeMs > 20000) {
            fs.unlinkSync(lockPath);
            continue;
          }
        } catch {}
        if (!blocking || Date.now() >= deadline) {
          return fn(false);
        }
        sleepMs(15);
        continue;
      }
      throw err;
    }
  }
  try {
    return fn(true);
  } finally {
    try { fs.closeSync(fd); } catch {}
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function parseEntryId(relFromKb) {
  const parts = String(relFromKb).replace(/\\/g, '/').split('/');
  if (parts.length !== 3 || !parts[2].endsWith('.md')) return null;
  const [domain, kind, file] = parts;
  const slug = file.slice(0, -3);
  if (!SLUG_RE.test(domain) || !KIND_SET.has(kind) || !SLUG_RE.test(slug)) return null;
  return [domain, kind, slug, `${domain}/${kind}/${slug}`];
}

function normalizeEntryId(rawId) {
  let s = String(rawId || '').trim().replace(/\\/g, '/');
  for (const prefix of ['.loop/outbox/kb/', 'drafts/', 'kb/']) {
    if (s.startsWith(prefix)) {
      s = s.slice(prefix.length);
      break;
    }
  }
  if (s.endsWith('.md')) s = s.slice(0, -3);
  const parsed = parseEntryId(`${s}.md`);
  if (!parsed) {
    throw new KbError(
      `Invalid entry ID "${rawId}". Expected <domain>/<kind>/<slug> where kind is one of: ${KINDS.join(', ')}`
    );
  }
  return parsed;
}

function validateEntryFile(filePath, { expectedId = null, index = null, todayStr = null } = {}) {
  const errors = [];
  const warnings = [];
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    return { errors: [`File not found: ${filePath}`], warnings };
  }
  const raw = fs.readFileSync(filePath, 'utf8');

  for (const [rx, label] of SECRET_CHECKS) {
    if (rx.test(raw)) {
      errors.push(`Contains ${label}; strip secrets and local user home paths before sharing.`);
    }
  }

  const relNorm = filePath.replace(/\\/g, '/');
  let inferredId = expectedId;
  if (!inferredId) {
    for (const marker of ['.loop/outbox/kb/', '/drafts/', 'drafts/', '/kb/', 'kb/']) {
      const idx = relNorm.indexOf(marker);
      if (idx !== -1) {
        const tail = relNorm.slice(idx + marker.length);
        const parsed = parseEntryId(tail);
        if (parsed) {
          inferredId = parsed[3];
          break;
        }
      }
    }
    if (!inferredId) {
      const parts3 = relNorm.split('/').filter(Boolean);
      if (parts3.length >= 3) {
        const parsed = parseEntryId(parts3.slice(-3).join('/'));
        if (parsed) inferredId = parsed[3];
      }
    }
  }

  if (!inferredId) {
    errors.push(
      `Path "${filePath}" must end with <domain>/<kind>/<slug>.md (allowed kinds: ${KINDS.join(', ')}).`
    );
  } else {
    try {
      normalizeEntryId(inferredId);
    } catch (err) {
      errors.push(err.message);
    }
  }

  const { meta, body } = parseMarkdownEntry(raw);
  if (!Object.keys(meta).length) {
    errors.push('Missing YAML frontmatter block (`--- ... ---`).');
    return { errors, warnings };
  }

  const title = String(meta.title || '').trim();
  const summary = String(meta.summary || '').trim();
  const triggers = meta.triggers;
  const sources = meta.sources;
  const expires = String(meta.expires || '').trim();

  if (title.length < 6 || title.length > 140) {
    errors.push('Frontmatter `title` is required (6..140 chars).');
  }
  if (summary.length < 10 || summary.length > 300) {
    errors.push('Frontmatter `summary` is required (10..300 chars).');
  }
  if (!Array.isArray(triggers) || triggers.filter(t => String(t).trim()).length < 2) {
    errors.push('Frontmatter `triggers` must be a list of at least 2 search trigger terms.');
  }
  if (!Array.isArray(sources) || sources.filter(s => String(s).trim()).length < 1) {
    errors.push('Frontmatter `sources` must list at least 1 code path, config file, or incident ref.');
  }
  if (expires && !isValidIsoDate(expires)) {
    errors.push('Frontmatter `expires` must be YYYY-MM-DD when provided.');
  }
  if (body.trim().length < 20) {
    errors.push('Markdown body is too short (< 20 chars); state symptom/rule, cause, and verified action.');
  }
  if (Buffer.byteLength(raw, 'utf8') > 32 * 1024) {
    errors.push('Entry exceeds 32 KB; split into focused atomic entries.');
  }

  if (index && title && Array.isArray(triggers) && errors.length === 0) {
    const q = `${title} ${triggers.slice(0, 6).join(' ')}`;
    const sim = rankSearch(index, q, todayStr || parseIsoDateStr(null), {
      limit: 3,
      excludeId: inferredId,
    });
    const candSet = new Set(segmentTokens(`${title} ${triggers.join(' ')}`));
    for (const hit of sim) {
      const hitSet = new Set(segmentTokens(`${hit.title} ${hit.triggers.join(' ')}`));
      const union = new Set([...candSet, ...hitSet]).size;
      let inter = 0;
      for (const tok of candSet) {
        if (hitSet.has(tok)) inter++;
      }
      const jaccard = union ? inter / union : 0;
      if (jaccard >= 0.45) {
        warnings.push(
          `Near-duplicate of existing entry "${hit.id}" (${hit.title}, overlap=${Math.round(jaccard * 100)}%). ` +
            'Prefer updating the existing entry instead of creating a duplicate.'
        );
      }
    }
  }
  return { errors, warnings };
}

// ---- CLI Commands ----

function loadKbModule() { return {parseEntryId,parseMarkdownEntry,validateEntryFile,cacheDirFor,withFileLock}; }

function runCmd(args, { cwd = undefined, check = true } = {}) {
  const res = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
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
  let expanded = expandHome(rawNorm);
  if(!fs.existsSync(expanded)){
    let id=rawNorm.replace(/^kb\//,'').replace(/\.md$/,'');
    const parsed=kbMod.parseEntryId(id+'.md');
    if(parsed){
      const legacy=(process.env.HARBOR_KB_CACHE_DIR||'').trim()||path.join(os.homedir(),'.cache','harbor-kb');
      const candidate=[path.join('.loop','outbox','kb',id+'.md'),path.join(os.homedir(),'.harbor','drafts','kb',id+'.md'),path.join(legacy,'drafts',id+'.md')].find(p=>fs.existsSync(p));
      if(candidate) expanded=candidate;
    }
  }
  if(fs.existsSync(expanded)){
    const actual=fs.realpathSync(expanded);
    const parsed=kbMod.parseEntryId(actual.replace(/\\/g,'/').split('/').slice(-3).join('/'));
    if(parsed&&fs.statSync(actual).isFile()){
      const roots=[path.join(os.homedir(),'.harbor','drafts','kb'),path.join((process.env.HARBOR_KB_CACHE_DIR||'').trim()||path.join(os.homedir(),'.cache','harbor-kb'),'drafts')];
      return {targetFile:actual,parsed,isCacheDraft:roots.filter(p=>fs.existsSync(p)).some(p=>actual.startsWith(fs.realpathSync(p)+path.sep))};
    }
  }
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
    const persistent=path.join(os.homedir(),'.harbor','drafts','kb');
    if (!fs.existsSync(expanded)) throw new PublishError('Draft file not found');
    const realDraft=fs.realpathSync(expanded);
    const draftsRoot=[persistent,draftsDir].filter(p=>fs.existsSync(p)).map(p=>fs.realpathSync(p)).find(p=>realDraft.startsWith(p+path.sep));
    if(!draftsRoot) throw new PublishError('Draft must be in the persistent drafts directory');
    relTail=path.relative(draftsRoot,realDraft).replace(/\\/g,'/');
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

function refExists(top, ref) {
  return (
    runCmd(['git', '-C', top, 'rev-parse', '--verify', `${ref}^{commit}`], { check: false }).status === 0
  );
}

function detectOriginDefaultRef(top, { queryRemote = false } = {}) {
  const sym = runCmd(['git', '-C', top, 'symbolic-ref', 'refs/remotes/origin/HEAD'], { check: false });
  if (sym.status === 0 && (sym.stdout || '').trim()) {
    const ref = sym.stdout.trim().replace(/^refs\/remotes\//, '');
    if (refExists(top, ref)) return ref;
  }
  if (queryRemote) {
    const lsRem = runCmd(['git', '-C', top, 'ls-remote', '--symref', 'origin', 'HEAD'], { check: false });
    if (lsRem.status === 0 && lsRem.stdout) {
      const m = /^ref:\s+refs\/heads\/(\S+)\s+HEAD$/m.exec(lsRem.stdout);
      if (m) {
        const ref = `origin/${m[1]}`;
        if (refExists(top, ref)) return ref;
      }
    }
  }
  for (const cand of ['origin/main', 'origin/master']) {
    if (refExists(top, cand)) return cand;
  }
  return null;
}

function resolvePublishBaseRef(top, { hasOrigin, noPush, base = null }) {
  if (!noPush) {
    if (!hasOrigin) {
      throw new PublishError(
        'No "origin" remote configured in KB repository; configure origin or pass --no-push for local dry-run.'
      );
    }
    const fetchRes = runCmd(['git', '-C', top, 'fetch', 'origin', '--quiet'], { check: false });
    if (fetchRes.status !== 0) {
      const detail =
        (fetchRes.stderr || '').trim() || (fetchRes.stdout || '').trim() || `exit ${fetchRes.status}`;
      throw new PublishError(
        `Failed to fetch from origin before publishing (${detail}); refusing to fall back to local HEAD to prevent leaking unmerged commits.`
      );
    }
    if (base) {
      if (!refExists(top, base)) {
        throw new PublishError(`Specified --base ref "${base}" does not exist.`);
      }
      return base;
    }
    const remoteBase = detectOriginDefaultRef(top, { queryRemote: true });
    if (!remoteBase) {
      throw new PublishError(
        'Cannot determine remote default branch on origin (neither origin/HEAD, origin/main, nor origin/master found); pass --base origin/<branch>.'
      );
    }
    return remoteBase;
  }

  if (base) {
    if (!refExists(top, base)) {
      throw new PublishError(`Specified --base ref "${base}" does not exist.`);
    }
    return base;
  }
  if (hasOrigin) {
    const cachedRemoteBase = detectOriginDefaultRef(top, { queryRemote: false });
    if (cachedRemoteBase) return cachedRemoteBase;
  }
  if (!refExists(top, 'HEAD')) {
    throw new PublishError('KB repository has no commits yet.');
  }
  return 'HEAD';
}

function publishDraft(draftPath, kbRoot, { noPush = false, noPr = false, base = null, jsonOut = false, kbSource = null } = {}) {
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
  const oldEntry=path.join(kbRoot,'kb',entryId+'.md');
  const oldSources=fs.existsSync(oldEntry)?kbMod.parseMarkdownEntry(fs.readFileSync(oldEntry,'utf8')).meta.sources||[]:[];
  const fingerprintChanges=(meta.sources||[]).filter(x=>/@[a-f0-9]{8}$/.test(x)&&!oldSources.includes(x)).map(next=>({old:oldSources.find(x=>x.replace(/@[a-f0-9]{8}$/,'')===next.replace(/@[a-f0-9]{8}$/,''))||'(new)',new:next}));

  const top = runCmd(['git', '-C', kbRoot, 'rev-parse', '--show-toplevel']).stdout.trim();
  const kbRelInGit = path.relative(fs.realpathSync(top), fs.realpathSync(kbRoot)).replace(/\\/g, '/');
  const prefix = !kbRelInGit || kbRelInGit === '.' ? '' : `${kbRelInGit}/`;

  const remotes = (runCmd(['git', '-C', top, 'remote'], { check: false }).stdout || '')
    .split(/\s+/)
    .filter(Boolean);
  const hasOrigin = remotes.includes('origin');
  const baseRef = resolvePublishBaseRef(top, { hasOrigin, noPush, base });

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
            ...fingerprintChanges.map(x=>'Fingerprint: '+x.old+' -> '+x.new),
            '',
            `- **ID**: \`${entryId}\``,
            `- **Title**: ${meta.title || ''}`,
            `- **Summary**: ${meta.summary || ''}`,
            `- **Reviewed Draft SHA-256**: \`${sha256Hex.slice(0, 16)}…\``,
            '',
          ].join('\n');
          const prBodyFile=path.join(wtDir,'.kb-pr-body.md');
          fs.writeFileSync(prBodyFile,prBody,'utf8');
          const ghArgs = ['gh', 'pr', 'create', '--title', commitTitle, '--body-file', prBodyFile, '--head', branch];
          if (baseRef.startsWith('origin/')) {
            ghArgs.push('--base', baseRef.slice('origin/'.length));
          }
          const prRes = runCmd(ghArgs, { cwd: wtDir, check: false });
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

  if (isCacheDraft && pushed) {
    try { fs.unlinkSync(targetFile); } catch {}
  }

  const result = {
    status: 'published',
    kb_source: kbSource || resolveKbRoot(kbRoot).source,
    fingerprint_changes: fingerprintChanges,
    id: entryId,
    target: `${prefix}kb/${domain}/${kind}/${slug}.md`,
    base_ref: baseRef,
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
    console.log(`Published ${entryId} on branch ${branch} (${commitSha}), pushed=${pushed} [kb_source=${result.kb_source}]`);
    if (prUrl) console.log(`PR: ${prUrl}`);
    else if (compareUrl) console.log(`Open PR: ${compareUrl}`);
  }
  return result;
}

function parseCliArgs(argv) {
  const opts = {
    draft: null,
    kbRoot: null,
    base: null,
    noPush: false,
    noPr: false,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--allow-demo-fallback') { opts.allowDemo = true;
    } else if (raw === '--no-push') opts.noPush = true;
    else if (raw === '--no-pr') opts.noPr = true;
    else if (raw === '--json') opts.json = true;
    else if (raw === '--help' || raw === '-h') opts.help = true;
    else if (raw === '--kb-root') {
      opts.kbRoot = argv[++i];
      if (!opts.kbRoot) throw new PublishError('Missing value for --kb-root');
    } else if (raw.startsWith('--kb-root=')) {
      opts.kbRoot = raw.slice('--kb-root='.length);
    } else if (raw === '--base') {
      opts.base = argv[++i];
      if (!opts.base) throw new PublishError('Missing value for --base');
    } else if (raw.startsWith('--base=')) {
      opts.base = raw.slice('--base='.length);
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
      'Usage: node publish.js [--kb-root <dir>] [--base <ref>] [--no-push] [--no-pr] [--json] <draft_path>'
    );
    return a.help ? 0 : 2;
  }
  const { root: kbRoot, source: kbSource } = resolveKbRoot(a.kbRoot);
  if(isPublicEngineRoot(kbRoot)&&!a.allowDemo)throw new PublishError('Bind a private data repository before publishing');
  publishDraft(a.draft, kbRoot, {
    noPush: a.noPush,
    noPr: a.noPr,
    base: a.base,
    jsonOut: a.json,
    kbSource,
  });
  return 0;
}

if (require.main === module) {
  try {
    process.exit(main());
  } catch (err) {
    if (err instanceof Error) {
      console.error(`team-kb-publish: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
}

module.exports = {
  SECRET_CHECKS,
  PublishError,
  resolveKbRoot,
  resolvePublishBaseRef,
  parseGithubSlug,
  publishDraft,
};
