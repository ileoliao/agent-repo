'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawnSync}=require('child_process');
const SCHEMA_VERSION=7,SLEEP_ARRAY=new Int32Array(new SharedArrayBuffer(4));
class KbError extends Error {}
function sleepMs(ms){Atomics.wait(SLEEP_ARRAY,0,0,ms);}
function expandHome(p){return p && p.startsWith('~/') ? path.join(os.homedir(),p.slice(2)) : p;}
const KINDS = ['map', 'spec', 'redline', 'gotcha', 'runbook', 'adr', 'postmortem'];
const KIND_SET = new Set(KINDS);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
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

const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
const CJK_TEST_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const CJK_SPLIT_RE = /(?:为什么|为何|怎么处理|怎么解决|怎么办|怎么|如何|是不是|能不能|多长时间|多久|请问|突然|偶发|已经|需要|才能|之后|时候|[的了在是把被对与和或而且但却也都就还只当因按将吗呢吧啊])+/;
const ASCII_TOKEN_RE = /[A-Za-z0-9]+(?:[._:/+#-][A-Za-z0-9]+)*/g;
const CAMEL_SPLIT_RE = /(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/;
const STOPWORDS = new Set([
  'a', 'about', 'after', 'all', 'also', 'an', 'and', 'any', 'are', 'as', 'at',
  'be', 'because', 'been', 'before', 'being', 'between', 'both', 'but', 'by',
  'can', 'could', 'did', 'do', 'does', 'doing', 'done', 'during', 'each',
  'even', 'for', 'from', 'get', 'getting', 'got', 'had', 'has', 'have',
  'having', 'here', 'how', 'if', 'in', 'into', 'is', 'it', 'its', 'just',
  'make', 'may', 'more', 'most', 'much', 'must', 'need', 'new', 'not', 'now',
  'of', 'on', 'only', 'onto', 'or', 'other', 'our', 'out', 'over', 'same',
  'see', 'seeing', 'should', 'since', 'so', 'some', 'still', 'such', 'than',
  'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'this',
  'those', 'though', 'through', 'to', 'too', 'under', 'until', 'up', 'upon',
  'use', 'using', 'very', 'via', 'want', 'was', 'way', 'we', 'well', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with',
  'without', 'would', 'you', 'your',
]);

const TECH_SYNONYMS = Object.assign(Object.create(null), {
  postgresql: 'postgres',
  postgres: 'postgresql',
  k8s: 'kubernetes',
  kubernetes: 'k8s',
});

function toNullProto(obj) {
  const out = Object.create(null);
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      out[k] = v;
    }
  }
  return out;
}

const STEM_KEEP = new Set([
  'series', 'species', 'kubernetes', 'postgres', 'status', 'prometheus', 'redis',
]);

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

// ---- Bilingual + Code Identifier + Porter/Infra Morphological Tokenizer ----

function vcMeasure(s) {
  return (s.match(/[aeiouy]+[^aeiouy]+/g) || []).length;
}

function stemEn(word) {
  let w = word;
  if (w.length < 4 || !/^[a-z]+$/.test(w) || STEM_KEEP.has(w)) return w;

  if (w.endsWith('ies') && w.length > 4) {
    w = `${w.slice(0, -3)}y`;
  } else if (
    w.endsWith('es') &&
    w.length > 4 &&
    (w.slice(0, -2).endsWith('sh') ||
      w.slice(0, -2).endsWith('ch') ||
      w.slice(0, -2).endsWith('x') ||
      w.slice(0, -2).endsWith('z') ||
      w.slice(0, -2).endsWith('ss'))
  ) {
    w = w.slice(0, -2);
  } else if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) {
    w = w.slice(0, -1);
  }

  if (w.endsWith('ation') && w.length >= 8) {
    w = `${w.slice(0, -5)}at`;
  } else if (w.endsWith('ition') && w.length >= 8) {
    w = w.slice(0, -5);
  } else if (w.endsWith('ction') && w.length >= 7) {
    w = `${w.slice(0, -4)}ct`;
  } else if ((w.endsWith('tion') || w.endsWith('sion')) && w.length >= 7) {
    w = w.slice(0, -3);
  } else if (w.endsWith('ing') && w.length >= 6) {
    let base = w.slice(0, -3);
    if (
      base.length >= 3 &&
      base[base.length - 1] === base[base.length - 2] &&
      !'aeioulsz'.includes(base[base.length - 1])
    ) {
      base = base.slice(0, -1);
    } else if (base.endsWith('i')) {
      base = `${base.slice(0, -1)}y`;
    } else if (base.length === 3 && /^[^aeiou][aeiou][^aeiouwxy]$/.test(base)) {
      base = `${base}e`;
    }
    w = base;
  } else if (w.endsWith('ed') && w.length >= 5) {
    let base = w.slice(0, -2);
    if (
      base.length >= 3 &&
      base[base.length - 1] === base[base.length - 2] &&
      !'aeioulsz'.includes(base[base.length - 1])
    ) {
      base = base.slice(0, -1);
    } else if (base.endsWith('i')) {
      base = `${base.slice(0, -1)}y`;
    } else if (base.length === 3 && /^[^aeiou][aeiou][^aeiouwxy]$/.test(base)) {
      base = `${base}e`;
    }
    w = base;
  } else if (
    w.endsWith('er') &&
    w.length >= 6 &&
    ['pool', 'limit', 'work', 'consum', 'produc', 'rout', 'scrap', 'ingest', 'call', 'handl', 'retry'].some(s =>
      w.slice(0, -2).endsWith(s)
    )
  ) {
    w = w.slice(0, -2);
    if (w.endsWith('i')) w = `${w.slice(0, -1)}y`;
  } else if (w.endsWith('ly') && w.length >= 6) {
    w = w.slice(0, -2);
  }

  if (w.endsWith('e') && w.length >= 5 && !w.endsWith('ee')) {
    w = w.slice(0, -1);
  }
  if (w.endsWith('at') && vcMeasure(w.slice(0, -2)) > 1) {
    w = w.slice(0, -2);
  }
  return w;
}

function ftsKey(tok) {
  return /^[a-z]{4,}$/.test(tok) ? stemEn(tok) : tok;
}

function expandAsciiToken(tok) {
  const out = [];
  const low = tok.toLowerCase().replace(/^[._:/+#-]+|[._:/+#-]+$/g, '');
  if (!low) return out;
  const pushWithSyn = t => {
    if (!t || STOPWORDS.has(t) || out.includes(t)) return;
    out.push(t);
    const syn = TECH_SYNONYMS[t];
    if (syn && !out.includes(syn)) out.push(syn);
  };
  const compact = low.replace(/[^a-z0-9]+/g, '');
  if (compact) pushWithSyn(compact);
  for (const part of tok.split(/[._:/+#-]+/)) {
    if (!part) continue;
    pushWithSyn(part.toLowerCase());
    for (const sub of part.split(CAMEL_SPLIT_RE)) {
      const sLow = sub.toLowerCase();
      if (sLow.length >= 2) pushWithSyn(sLow);
    }
  }
  return out;
}

function expandCjkRun(run) {
  if (run.length === 1) return [run];
  const out = [];
  for (let i = 0; i < run.length - 1; i++) {
    out.push(run.slice(i, i + 2));
  }
  return out;
}

function segmentTokens(text) {
  if (!text) return [];
  const tokens = [];
  for (const m of String(text).matchAll(ASCII_TOKEN_RE)) {
    tokens.push(...expandAsciiToken(m[0]));
  }
  for (const m of String(text).matchAll(CJK_RUN_RE)) {
    tokens.push(...expandCjkRun(m[0]));
  }
  return tokens;
}

function segmentForIndex(text) {
  return segmentTokens(text).join(' ');
}

function enrichWithStems(tokens) {
  const out = new Set(tokens);
  for (const t of tokens) {
    if (/^[a-z]{4,}$/.test(t)) {
      out.add(`~${stemEn(t)}`);
    }
  }
  return out;
}

function parseQueryClauses(queryText) {
  const clauses = [];
  for (const chunk of String(queryText || '').split(/\s+/).filter(Boolean)) {
    for (const m of chunk.matchAll(ASCII_TOKEN_RE)) {
      const toks = expandAsciiToken(m[0]);
      if (toks.length) {
        const stems = toks
          .filter(t => /^[a-z]{4,}$/.test(t))
          .map(t => `~${stemEn(t)}`)
          .filter(s => !toks.includes(s));
        clauses.push({
          kind: 'ascii',
          orig: m[0],
          raw: m[0].toLowerCase(),
          fts_tokens: toks,
          match_tokens: [...toks, ...stems],
        });
      }
    }
    for (const m of chunk.matchAll(CJK_RUN_RE)) {
      const rawRun = m[0];
      let subRuns = rawRun.split(CJK_SPLIT_RE).filter(Boolean);
      if (!subRuns.length) subRuns = [rawRun];
      for (const sr of subRuns) {
        const bigrams = expandCjkRun(sr);
        if (sr.length <= 3) {
          clauses.push({ kind: 'cjk', raw: sr, fts_tokens: bigrams, match_tokens: bigrams });
        } else {
          for (const bg of bigrams) {
            clauses.push({ kind: 'cjk_bg', raw: bg, fts_tokens: [bg], match_tokens: [bg] });
          }
        }
      }
    }
  }
  return clauses;
}

// ---- Entry Discovery & Disposable Derived JSON BM25 Index ----


function parseEntryId(relFromKb) {
  const parts = String(relFromKb).replace(/\\/g, '/').split('/');
  if (parts.length !== 3 || !parts[2].endsWith('.md')) return null;
  const [domain, kind, file] = parts;
  const slug = file.slice(0, -3);
  if (!SLUG_RE.test(domain) || !KIND_SET.has(kind) || !SLUG_RE.test(slug)) return null;
  return [domain, kind, slug, `${domain}/${kind}/${slug}`];
}

function iterKbFiles(kbRoot) {
  const kbDir = path.join(kbRoot, 'kb');
  if (!fs.existsSync(kbDir)) return [];
  const found = [];
  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const absP = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(absP);
      } else if (ent.isFile() && ent.name.endsWith('.md')) {
        const relKb = path.relative(kbDir, absP).replace(/\\/g, '/');
        const parsed = parseEntryId(relKb);
        if (parsed) {
          found.push([absP, relKb, parsed[0], parsed[1], parsed[2], parsed[3]]);
        }
      }
    }
  }
  walk(kbDir);
  return found;
}

function corpusFingerprint(files) {
  let maxMtime = 0n;
  let totalSize = 0;
  for (const [absP] of files) {
    const st = fs.statSync(absP, { bigint: true });
    if (st.mtimeNs > maxMtime) maxMtime = st.mtimeNs;
    totalSize += Number(st.size);
  }
  return `v${SCHEMA_VERSION}:${files.length}:${totalSize}:${maxMtime.toString()}`;
}

function loadEntryFromFile(absP, domain, kind, slug, entryId) {
  const raw = fs.readFileSync(absP, 'utf8');
  const { meta, body } = parseMarkdownEntry(raw);
  const triggers = Array.isArray(meta.triggers) ? meta.triggers : [];
  const sources = Array.isArray(meta.sources) ? meta.sources : [];
  return {
    id: entryId,
    domain,
    kind,
    slug,
    path: `kb/${entryId}.md`,
    title: String(meta.title || '').trim(),
    summary: String(meta.summary || '').trim(),
    triggers: triggers.map(x => String(x).trim()).filter(Boolean),
    sources: sources.map(x => String(x).trim()).filter(Boolean),
    expires: String(meta.expires || '').trim(),
    disputed: String(meta.disputed || '').trim(),
    verified_at: String(meta.verified_at || '').trim(),
    body,
  };
}

function hydrateIndex(raw) {
  raw.token_df = toNullProto(raw.token_df);
  raw.bm25_df = toNullProto(raw.bm25_df);
  raw.postings = toNullProto(raw.postings);
  if (Array.isArray(raw.docs)) {
    for (const d of raw.docs) {
      if (d && typeof d === 'object') {
        d.tf = toNullProto(d.tf);
      }
    }
  }
  return raw;
}

function readCachedIndex(indexPath, expectedFp) {
  if (!fs.existsSync(indexPath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (parsed && parsed.fingerprint === expectedFp) return hydrateIndex(parsed);
  } catch {}
  return null;
}

function ensureIndex(kbRoot) {
  const cacheDir = cacheDirFor(kbRoot);
  const indexPath = path.join(cacheDir, 'index.json');
  const files = iterKbFiles(kbRoot);
  const fp = corpusFingerprint(files);

  const warm = readCachedIndex(indexPath, fp);
  if (warm) return { index: warm, indexPath, rebuilt: false };

  return withFileLock(path.join(cacheDir, 'index.lock'), true, () => {
    const afterLock = readCachedIndex(indexPath, fp);
    if (afterLock) return { index: afterLock, indexPath, rebuilt: false };

    const tokenDf = Object.create(null);
    const bm25Df = Object.create(null);
    const postings = Object.create(null);
    const docs = [];
    let totalDl = 0;

    const FIELD_WEIGHTS = [
      ['title', 6.0],
      ['triggers', 8.0],
      ['summary', 4.0],
      ['sources', 3.0],
      ['body', 1.0],
    ];

    files.forEach(([absP, , domain, kind, slug, entryId], docIdx) => {
      const e = loadEntryFromFile(absP, domain, kind, slug, entryId);
      const fieldToks = {
        title: segmentTokens(`${domain} ${slug} ${e.title}`),
        triggers: segmentTokens(e.triggers.join(' ')),
        summary: segmentTokens(e.summary),
        sources: segmentTokens(e.sources.join(' ')),
        body: segmentTokens(e.body),
      };

      const tf = Object.create(null);
      let dl = 0;
      const allBase = [];
      for (const [fName, weight] of FIELD_WEIGHTS) {
        const arr = fieldToks[fName];
        dl += arr.length;
        for (const t of arr) {
          allBase.push(t);
          const k = ftsKey(t);
          tf[k] = (tf[k] || 0) + weight;
        }
      }
      totalDl += dl;

      for (const k of Object.keys(tf)) {
        bm25Df[k] = (bm25Df[k] || 0) + 1;
        if (!postings[k]) postings[k] = [];
        postings[k].push(docIdx);
      }

      const tokenSet = Array.from(enrichWithStems(allBase)).sort();
      for (const tok of tokenSet) {
        tokenDf[tok] = (tokenDf[tok] || 0) + 1;
      }

      docs.push({
        id: e.id,
        domain: e.domain,
        kind: e.kind,
        slug: e.slug,
        path: e.path,
        title: e.title,
        summary: e.summary,
        triggers: e.triggers,
        sources: e.sources,
        expires: e.expires,
        disputed: e.disputed,
        dl,
        tf,
        tokens: tokenSet,
      });
    });

    const built = {
      fingerprint: fp,
      doc_count: docs.length,
      avgdl: docs.length ? totalDl / docs.length : 1,
      token_df: tokenDf,
      bm25_df: bm25Df,
      postings,
      docs,
    };

    const nonce = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
    const tmpPath = path.join(cacheDir, `index.${nonce}.tmp.json`);
    fs.writeFileSync(tmpPath, JSON.stringify(built), 'utf8');
    fs.renameSync(tmpPath, indexPath);
    return { index: built, indexPath, rebuilt: true };
  });
}

function computeIdf(totalDocs, df) {
  const n = Math.max(1, totalDocs);
  const d = Math.min(Math.max(0, df), n);
  return Math.log(1.0 + (n - d + 0.5) / (d + 0.5));
}

function rankSearch(index, queryText, todayStr, { domain = null, kind = null, limit = 5, excludeId = null } = {}) {
  const clauses = parseQueryClauses(queryText);
  if (!clauses.length) return [];

  const uniqueFtsKeys = [];
  for (const cl of clauses) {
    for (const t of cl.fts_tokens) {
      const k = ftsKey(t);
      if (!uniqueFtsKeys.includes(k)) uniqueFtsKeys.push(k);
    }
  }
  if (!uniqueFtsKeys.length) return [];

  const totalDocs = Math.max(1, index.doc_count || 1);
  const rareIdf = Math.max(1.0, computeIdf(totalDocs, 1));
  const dfMap = index.token_df || Object.create(null);
  const bm25DfMap = index.bm25_df || Object.create(null);
  const postingsMap = index.postings || Object.create(null);
  const hasCjkQuery = clauses.some(cl => cl.kind === 'cjk' || cl.kind === 'cjk_bg');

  const clauseWeights = clauses.map(cl => {
    const primary = cl.match_tokens[0];
    const stemAlt = /^[a-z]{4,}$/.test(primary) ? `~${stemEn(primary)}` : primary;
    let bestDf = Object.prototype.hasOwnProperty.call(dfMap, primary) ? dfMap[primary] : undefined;
    if (bestDf === undefined && Object.prototype.hasOwnProperty.call(dfMap, stemAlt)) {
      bestDf = dfMap[stemAlt];
    }
    let w;
    if (bestDf === undefined) {
      const orig = cl.orig || '';
      const isTechSym =
        /[0-9_.:/-]/.test(orig) ||
        (orig.length >= 2 && orig === orig.toUpperCase() && /[A-Z]/.test(orig)) ||
        CAMEL_SPLIT_RE.test(orig);
      w = isTechSym ? rareIdf : 0.72 * rareIdf;
    } else {
      w = Math.max(0.35, computeIdf(totalDocs, bestDf));
    }
    if (cl.kind === 'cjk_bg') w *= 0.65;
    return w;
  });
  const totalWeight = clauseWeights.reduce((a, b) => a + b, 0) || 1.0;

  const candidateIdxs = new Set();
  for (const key of uniqueFtsKeys) {
    const list = Object.prototype.hasOwnProperty.call(postingsMap, key) ? postingsMap[key] : null;
    if (Array.isArray(list)) {
      for (const idx of list) candidateIdxs.add(idx);
    }
  }

  const k1 = 1.2;
  const b = 0.75;
  const avgdl = Math.max(1, index.avgdl || 1);
  const candidates = [];

  for (const idx of candidateIdxs) {
    const doc = index.docs[idx];
    if (!doc) continue;
    if (domain && doc.domain !== domain) continue;
    if (kind && doc.kind !== kind) continue;
    if (excludeId && doc.id === excludeId) continue;

    const normDl = 1 - b + b * (doc.dl / avgdl);
    let rawBm25Pos = 0;
    const docTf = doc.tf || Object.create(null);
    for (const key of uniqueFtsKeys) {
      const wf = Object.prototype.hasOwnProperty.call(docTf, key) ? docTf[key] : 0;
      if (!wf) continue;
      const dfVal = Object.prototype.hasOwnProperty.call(bm25DfMap, key) ? bm25DfMap[key] : 1;
      const idf = computeIdf(totalDocs, dfVal || 1);
      rawBm25Pos += idf * ((wf * (k1 + 1)) / (wf + k1 * normDl)) * 0.95;
    }
    candidates.push({ doc, rawBm25Pos });
  }

  candidates.sort((a, b2) => b2.rawBm25Pos - a.rawBm25Pos);
  const topCandidates = candidates.slice(0, 60);

  const scored = [];
  const qLow = String(queryText).toLowerCase();

  for (const { doc, rawBm25Pos } of topCandidates) {
    const docTokens = new Set(doc.tokens);
    let matchedWeight = 0;
    let matchedClauses = 0;
    let maxMatchedIdf = 0;

    for (let i = 0; i < clauses.length; i++) {
      const cl = clauses[i];
      const w = clauseWeights[i];
      const mt = cl.match_tokens;
      const primary = mt[0];
      const stemAlt = /^[a-z]{4,}$/.test(primary) ? `~${stemEn(primary)}` : null;
      let hitStrength = 0;

      if (cl.kind === 'ascii') {
        if (docTokens.has(primary)) {
          hitStrength = 1.0;
        } else if (stemAlt && docTokens.has(stemAlt)) {
          hitStrength = 0.92;
        } else {
          let subHits = 0;
          for (let j = 1; j < mt.length; j++) {
            if (docTokens.has(mt[j])) subHits++;
          }
          if (subHits > 0) {
            hitStrength = 0.65 * (subHits / Math.max(1, mt.length - 1));
          }
        }
      } else if (cl.kind === 'cjk_bg') {
        if (docTokens.has(primary)) hitStrength = 1.0;
      } else {
        let hits = 0;
        for (const t of mt) {
          if (docTokens.has(t)) hits++;
        }
        if (hits > 0) {
          const ratio = hits / mt.length;
          hitStrength = ratio >= 0.5 ? 1.0 : 0.65 * ratio;
        }
      }

      if (hitStrength > 0) {
        matchedWeight += w * hitStrength;
        matchedClauses += hitStrength;
        if (w > maxMatchedIdf) maxMatchedIdf = w;
      }
    }

    const idfCoverage = matchedWeight / totalWeight;
    let trigBoost = 0;
    let cjkTrigHit = false;
    let strongTrigHit = false;

    for (const tr of doc.triggers) {
      const trLow = tr.toLowerCase().trim();
      if (!trLow) continue;
      if (CJK_TEST_RE.test(trLow)) {
        if (qLow.includes(trLow)) {
          trigBoost += 4.5;
          cjkTrigHit = true;
        }
      } else {
        const re = new RegExp(`(?<![a-z0-9])${escapeRegExp(trLow)}(?![a-z0-9])`);
        if (re.test(qLow)) {
          trigBoost += 4.5;
          if (trLow.length >= 8 || trLow.includes(' ') || trLow.includes('_') || CAMEL_SPLIT_RE.test(tr)) {
            strongTrigHit = true;
          }
        }
      }
    }

    const nClauses = clauses.length;
    if (nClauses === 1) {
      if (matchedClauses < 0.5 || (maxMatchedIdf < 0.35 * rareIdf && trigBoost === 0)) continue;
    } else if (hasCjkQuery && cjkTrigHit) {
      // Allow direct CJK trigger match
    } else if (nClauses <= 3) {
      const minCov = strongTrigHit ? 0.26 : 0.34;
      if (idfCoverage < minCov) continue;
    } else {
      const minCov = strongTrigHit ? 0.24 : 0.33;
      if (matchedClauses < 1.8 || idfCoverage < minCov || maxMatchedIdf < 0.40 * rareIdf) continue;
    }

    const normWeight = matchedWeight / rareIdf;
    const base = Math.max(0.1, rawBm25Pos);
    const kindBoost = doc.kind === 'redline' ? 1.2 : 0.0;
    const expired = isExpiredDate(doc.expires, todayStr);
    const penalty = (expired ? 4.5 : 0.0) + (doc.disputed ? 2.8 : 0.0);
    const finalScore = Number(
      (
        base * (0.45 + 1.55 * Math.pow(idfCoverage, 1.3)) +
        0.8 * normWeight +
        trigBoost +
        kindBoost -
        penalty
      ).toFixed(3)
    );
    if (finalScore <= 0.45) continue;

    const flags = [];
    if (doc.kind === 'redline') flags.push('REDLINE');
    if (expired) flags.push(`EXPIRED:${doc.expires}`);
    if (doc.disputed) flags.push('DISPUTED');

    scored.push({
      id: doc.id,
      domain: doc.domain,
      kind: doc.kind,
      path: doc.path,
      title: doc.title,
      summary: doc.summary,
      triggers: doc.triggers,
      sources: doc.sources,
      expires: doc.expires || null,
      disputed: doc.disputed || null,
      flags,
      coverage: Number(idfCoverage.toFixed(2)),
      score: finalScore,
    });
  }

  scored.sort((a, b2) => (b2.score !== a.score ? b2.score - a.score : a.id.localeCompare(b2.id)));
  return scored.slice(0, Math.max(1, Math.min(limit, 20)));
}

// ---- Anchor Verification & Validation Helpers ----

function detectRepoNames(workspaceRoot = '.') {
  const names = [];
  const absWs = fs.realpathSync(path.resolve(workspaceRoot));
  const base = path.basename(absWs).trim();
  const res = spawnSync('git', ['-C', absWs, 'remote', 'get-url', 'origin'], {
    encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_TERMINAL_PROMPT:'0'},
  });
  let originName = '';
  if (res.status === 0 && (res.stdout || '').trim()) {
    const url = res.stdout.trim().replace(/\/+$/, '').replace(/\.git$/, '');
    originName = url.replace(/:/g, '/').split('/').pop() || '';
  }
  if (originName) {
    names.push(originName);
  } else {
    const top = spawnSync('git', ['-C', absWs, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8', timeout: 3000, env: {...process.env, GIT_TERMINAL_PROMPT:'0'},
    });
    if (top.status === 0) names.push(path.basename(top.stdout.trim()));
  }
  if (base && !names.includes(base)) names.push(base);
  const reposSub = path.join(absWs, 'repos');
  if (fs.existsSync(reposSub)) {
    try {
      for (const d of fs.readdirSync(reposSub).sort()) {
        if (!d.startsWith('.') && fs.statSync(path.join(reposSub, d)).isDirectory() && !names.includes(d)) {
          names.push(d);
        }
      }
    } catch {}
  }
  return names;
}

function anchorInfo(workspaceRoot, sourceSpec) {
  const raw = String(sourceSpec || '').trim();
  if (raw.includes('://') || /^(JIRA|INC|PR|CVE)[-:][A-Za-z0-9-]+$/.test(raw)) return {status:'external_ref'};
  const m = /^(?:([A-Za-z0-9._-]+):)?([^#@]+?)(?:#([^@]+))?(?:@([a-f0-9]{8}))?$/.exec(raw);
  if (!m || path.isAbsolute(m[2]) || m[2].replace(/\\/g,'/').split('/').includes('..')) return {status:'file_missing'};
  const [,repo,rel,symbol,pin] = m;
  const roots = repo ? [path.join(workspaceRoot,'repos',repo),path.join(workspaceRoot,repo)] : [workspaceRoot];
  if (repo && detectRepoNames(workspaceRoot).includes(repo) && !roots.some(p=>fs.existsSync(p))) roots.unshift(workspaceRoot);
  const root = roots.find(p=>fs.existsSync(p));
  if (!root) return {status:'unverified_repo_absent'};
  const target = path.resolve(root,rel);
  if (!target.startsWith(path.resolve(root)+path.sep)) return {status:'file_missing'};
  if (!fs.existsSync(target)) return {status:'file_missing',target};
  if (!fs.realpathSync(target).startsWith(fs.realpathSync(root)+path.sep)) return {status:'file_missing'};
  if (rel.endsWith('/') && fs.statSync(target).isDirectory()) return {status:'present_unpinned',target};
  if (!fs.statSync(target).isFile()) return {status:'file_missing',target};
  const content = fs.readFileSync(target,'utf8');
  if (symbol && !content.includes(symbol)) return {status:'symbol_missing',target};
  const buf = Buffer.from(content.replace(/\r\n/g,'\n'),'utf8');
  const fingerprint = crypto.createHash('sha1').update('blob '+buf.length+'\0').update(buf).digest('hex').slice(0,8);
  return {status: !pin ? 'present_unpinned' : pin === fingerprint ? 'verified' : 'content_changed',target,fingerprint};
}
function findAnchorTarget(workspaceRoot, sourceSpec) {
  const info = anchorInfo(workspaceRoot, sourceSpec);
  return [info.status, info.target || sourceSpec];
}


module.exports={stripInlineComment,unquote,parseInlineList,parseMarkdownEntry,formatYamlScalar,renderEntryMarkdown,vcMeasure,stemEn,ftsKey,expandAsciiToken,expandCjkRun,segmentTokens,segmentForIndex,enrichWithStems,parseQueryClauses,parseEntryId,iterKbFiles,loadEntryFromFile,ensureIndex,rankSearch,detectRepoNames,anchorInfo,findAnchorTarget};
