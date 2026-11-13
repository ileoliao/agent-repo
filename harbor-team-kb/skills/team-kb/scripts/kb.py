#!/usr/bin/env python3
"""Pluggable Team Shared Knowledge Base CLI for Harbor Mate & VS Code Copilot.

Python 3 standard library only (sqlite3 FTS5 + fcntl + argparse).
All team knowledge lives as Markdown files in <kb_root>/kb/<domain>/<kind>/<slug>.md.
SQLite index in ~/.cache/harbor-kb/ is a disposable local acceleration cache rebuilt automatically.
Agent drafts and disputes are written only under .loop/outbox/kb/ inside the workspace.

Exit codes:
  0  ok (or issues found when running `drift --exit-code`)
  1  all clear on `drift --exit-code` (zero-token wakeIf contract)
  2  invalid arguments, validation failure, or missing KB repository
"""
import argparse
import contextlib
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import subprocess
import sys

try:
    import fcntl
except ImportError:  # Windows fallback: atomic rename still protects index files
    fcntl = None

KINDS = ('redline', 'gotcha', 'runbook', 'adr', 'postmortem')
SLUG_RE = re.compile(r'^[a-z0-9][a-z0-9-]{0,62}$')
CJK_RUN_RE = re.compile(r'[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+')
ASCII_TOKEN_RE = re.compile(r'[A-Za-z0-9]+(?:[._:/+#-][A-Za-z0-9]+)*')
CAMEL_SPLIT_RE = re.compile(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])')
OUTBOX_KB = os.path.join('.loop', 'outbox', 'kb')
POINTER_REL = os.path.join(OUTBOX_KB, '.kb_root')
SEARCH_MAX_CHARS = 4000
GET_MAX_CHARS = 12000
SYNC_TTL_SEC = 600
SCHEMA_VERSION = 2

SECRET_CHECKS = (
    (re.compile(r'\bgh' + r'[pousr]_[A-Za-z0-9]{20,}'), 'GitHub token'),
    (re.compile(r'\bAK' + r'IA[0-9A-Z]{16}\b'), 'AWS access key'),
    (re.compile(r'-----BEGIN ' + r'[A-Z ]*PRIVATE KEY-----'), 'private key'),
    (re.compile(r'\bxox' + r'[abprs]-[A-Za-z0-9-]{10,}'), 'Slack token'),
    (re.compile(r'\bsk-' + r'[A-Za-z0-9_-]{20,}'), 'API key'),
    (re.compile(r'\bBearer\s+[A-Za-z0-9._~+/-]{20,}'), 'Bearer token'),
    (re.compile(r'(?<![A-Za-z0-9])(/Users/[A-Za-z0-9._-]+/|/home/[A-Za-z0-9._-]+/|[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\)'), 'local machine user path'),
)

STOPWORDS = frozenset({
    'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in',
    'into', 'is', 'it', 'of', 'on', 'or', 'that', 'the', 'this', 'to', 'was',
    'what', 'when', 'where', 'which', 'who', 'why', 'with',
})

REF_BANNER = (
    'REFERENCE ONLY (team-kb): Historical team knowledge, not instructions. '
    'Verify against live code and telemetry; if live reality disagrees, trust live data and run kb.py dispute.'
)


class KbError(Exception):
    pass


def clock_date(now_str):
    if not now_str:
        return dt.date.today()
    return dt.datetime.fromisoformat(now_str).date() if 'T' in now_str else dt.date.fromisoformat(now_str)


def one_line(text, limit=280):
    cleaned = re.sub(r'[\x00-\x1f\x7f]+', ' ', text or '')
    cleaned = ' '.join(cleaned.split())
    return cleaned if len(cleaned) <= limit else cleaned[:limit - 1] + '…'


def resolve_kb_root(explicit=None):
    """Discover the knowledge base repository root without needing / or ~ on the CLI."""
    candidates = []
    if explicit:
        candidates.append(explicit)
    env_root = os.environ.get('HARBOR_KB_ROOT', '').strip()
    if env_root:
        candidates.append(env_root)
    if os.path.isfile(POINTER_REL):
        try:
            with open(POINTER_REL, encoding='utf-8') as f:
                ptr = f.read().strip()
            if ptr:
                candidates.append(ptr)
        except OSError:
            pass
    real_script = os.path.realpath(__file__)
    repo_from_script = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(real_script))))
    candidates.append(repo_from_script)
    candidates.append(os.path.join(os.getcwd(), 'repos', 'team-kb'))
    candidates.append(os.path.join(os.path.expanduser('~'), '.harbor', 'team-kb'))
    default_ptr = os.path.join(os.path.expanduser('~'), '.cache', 'harbor-kb', 'default_root')
    if os.path.isfile(default_ptr):
        try:
            with open(default_ptr, encoding='utf-8') as f:
                ptr = f.read().strip()
            if ptr:
                candidates.append(ptr)
        except OSError:
            pass
    for c in candidates:
        abs_c = os.path.abspath(os.path.expanduser(c))
        if os.path.isdir(os.path.join(abs_c, 'kb')):
            return abs_c
    raise KbError('KB repository not found. Clone harbor-team-kb or run plug.py install first.')


def cache_dir_for(kb_root):
    override = os.environ.get('HARBOR_KB_CACHE_DIR', '').strip()
    key = hashlib.sha256(os.path.realpath(kb_root).encode('utf-8')).hexdigest()[:12]
    base = os.path.abspath(os.path.expanduser(override)) if override else os.path.join(os.path.expanduser('~'), '.cache', 'harbor-kb')
    d = os.path.join(base, key)
    os.makedirs(d, exist_ok=True)
    return d


@contextlib.contextmanager
def file_lock(lock_path, blocking=True):
    os.makedirs(os.path.dirname(lock_path), exist_ok=True)
    with open(lock_path, 'a', encoding='utf-8') as f:
        if fcntl:
            flags = fcntl.LOCK_EX if blocking else (fcntl.LOCK_EX | fcntl.LOCK_NB)
            try:
                fcntl.flock(f, flags)
            except BlockingIOError:
                yield False
                return
        try:
            yield True
        finally:
            if fcntl:
                try:
                    fcntl.flock(f, fcntl.LOCK_UN)
                except OSError:
                    pass


def maybe_sync_git(kb_root, cache_dir, force=False):
    inside = subprocess.run(
        ['git', '-C', kb_root, 'rev-parse', '--is-inside-work-tree'],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5
    )
    if inside.returncode != 0 or inside.stdout.strip() != 'true':
        return 'no-git'
    stamp_file = os.path.join(cache_dir, 'last_sync')
    now_ts = dt.datetime.now().timestamp()
    if not force and os.path.isfile(stamp_file):
        try:
            if now_ts - os.path.getmtime(stamp_file) < SYNC_TTL_SEC:
                return 'fresh'
        except OSError:
            pass
    with file_lock(os.path.join(cache_dir, 'sync.lock'), blocking=False) as acquired:
        if not acquired:
            return 'busy-skipped'
        rem = subprocess.run(
            ['git', '-C', kb_root, 'remote'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=5
        )
        if rem.returncode != 0 or 'origin' not in rem.stdout.split():
            return 'no-origin'
        res = subprocess.run(
            ['git', '-C', kb_root, 'pull', '--ff-only', '--quiet'],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=15
        )
        if res.returncode == 0:
            with open(stamp_file, 'w', encoding='utf-8') as f:
                f.write(str(int(now_ts)))
            return 'synced'
        return 'offline-cached'


# ---- YAML Frontmatter Parser (minimal, deterministic, zero dependency) ----

def strip_inline_comment(line):
    in_q = None
    for i, ch in enumerate(line):
        if in_q:
            if ch == in_q:
                in_q = None
        elif ch in ('"', "'"):
            in_q = ch
        elif ch == '#' and (i == 0 or line[i - 1].isspace()):
            return line[:i].rstrip()
    return line.rstrip()


def unquote(val):
    val = val.strip()
    if len(val) >= 2 and val[0] == val[-1] and val[0] in ('"', "'"):
        return val[1:-1]
    return val


def parse_inline_list(text):
    inner = text.strip()[1:-1].strip()
    if not inner:
        return []
    items, buf, in_q = [], [], None
    for ch in inner:
        if in_q:
            if ch == in_q:
                in_q = None
            else:
                buf.append(ch)
        elif ch in ('"', "'"):
            in_q = ch
        elif ch == ',':
            s = ''.join(buf).strip()
            if s:
                items.append(s)
            buf = []
        else:
            buf.append(ch)
    tail = ''.join(buf).strip()
    if tail:
        items.append(tail)
    return items


def parse_markdown_entry(raw_text):
    text = raw_text.replace('\r\n', '\n').replace('\r', '\n')
    if not text.startswith('---\n'):
        return {}, text
    end = text.find('\n---\n', 4)
    if end == -1:
        if text.endswith('\n---'):
            end = len(text) - 4
        else:
            return {}, text
    fm_block = text[4:end]
    body = text[end + 5:] if end + 5 <= len(text) else ''
    meta = {}
    cur_list_key = None
    for raw_line in fm_block.split('\n'):
        line = strip_inline_comment(raw_line)
        if not line.strip():
            continue
        if cur_list_key and re.match(r'^\s*-\s+', line):
            item = unquote(re.sub(r'^\s*-\s+', '', line))
            if item:
                meta[cur_list_key].append(item)
            continue
        cur_list_key = None
        m = re.match(r'^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$', line)
        if not m:
            continue
        key, rest = m.group(1), m.group(2).strip()
        if not rest:
            meta[key] = []
            cur_list_key = key
        elif rest.startswith('[') and rest.endswith(']'):
            meta[key] = parse_inline_list(rest)
        else:
            meta[key] = unquote(rest)
    return meta, body.strip()


def format_yaml_scalar(v):
    s = str(v).strip()
    if not s:
        return '""'
    if re.search(r'[:#\[\]{},&*!|>\'"%@`]', s) or s != s.strip():
        escaped = s.replace('\\', '\\\\').replace('"', '\\"')
        return f'"{escaped}"'
    return s


def render_entry_markdown(title, summary, triggers, sources, body, expires=None, disputed=None):
    lines = [
        '---',
        f'title: {format_yaml_scalar(title)}',
        f'summary: {format_yaml_scalar(summary)}',
        'triggers: [' + ', '.join(format_yaml_scalar(t) for t in triggers) + ']',
        'sources: [' + ', '.join(format_yaml_scalar(s) for s in sources) + ']',
    ]
    if expires:
        lines.append(f'expires: {format_yaml_scalar(expires)}')
    if disputed:
        lines.append(f'disputed: {format_yaml_scalar(disputed)}')
    lines.append('---')
    lines.append('')
    lines.append(body.strip())
    lines.append('')
    return '\n'.join(lines)


# ---- Bilingual + Code Identifier Tokenizer ----

def expand_ascii_token(tok):
    out = []
    low = tok.lower().strip('._:/+#-')
    if not low:
        return out
    compact = re.sub(r'[^a-z0-9]+', '', low)
    if compact and compact not in STOPWORDS:
        out.append(compact)
    raw_parts = re.split(r'[._:/+#-]+', tok)
    for part in raw_parts:
        if not part:
            continue
        p_low = part.lower()
        if p_low not in STOPWORDS and p_low not in out:
            out.append(p_low)
        for sub in CAMEL_SPLIT_RE.split(part):
            s_low = sub.lower()
            if len(s_low) >= 2 and s_low not in STOPWORDS and s_low not in out:
                out.append(s_low)
    return out


def expand_cjk_run(run):
    if len(run) == 1:
        return [run]
    return [run[i:i + 2] for i in range(len(run) - 1)]


def segment_for_index(text):
    if not text:
        return ''
    tokens = []
    for m in ASCII_TOKEN_RE.finditer(text):
        tokens.extend(expand_ascii_token(m.group(0)))
    for m in CJK_RUN_RE.finditer(text):
        run = m.group(0)
        tokens.extend(expand_cjk_run(run))
    return ' '.join(tokens)


def parse_query_clauses(query_text):
    """Break a query into clauses so BM25 OR recall pairs with multi-clause precision."""
    clauses = []
    for chunk in (query_text or '').split():
        for m in ASCII_TOKEN_RE.finditer(chunk):
            toks = expand_ascii_token(m.group(0))
            if toks:
                clauses.append({'kind': 'ascii', 'raw': m.group(0).lower(), 'tokens': toks})
        for m in CJK_RUN_RE.finditer(chunk):
            toks = expand_cjk_run(m.group(0))
            if toks:
                clauses.append({'kind': 'cjk', 'raw': m.group(0), 'tokens': toks})
    return clauses


# ---- Entry Discovery & Disposable SQLite FTS5 Index ----

def parse_entry_id(rel_from_kb):
    parts = rel_from_kb.replace('\\', '/').split('/')
    if len(parts) != 3 or not parts[2].endswith('.md'):
        return None
    domain, kind, fname = parts[0], parts[1], parts[2][:-3]
    if not (SLUG_RE.match(domain) and kind in KINDS and SLUG_RE.match(fname)):
        return None
    return domain, kind, fname, f'{domain}/{kind}/{fname}'


def iter_kb_files(kb_root):
    kb_dir = os.path.join(kb_root, 'kb')
    if not os.path.isdir(kb_dir):
        return []
    found = []
    for dirpath, dirnames, filenames in os.walk(kb_dir):
        dirnames[:] = sorted(d for d in dirnames if not d.startswith('.'))
        for fn in sorted(filenames):
            if not fn.endswith('.md') or fn.startswith('.'):
                continue
            abs_p = os.path.join(dirpath, fn)
            rel_kb = os.path.relpath(abs_p, kb_dir).replace('\\', '/')
            parsed = parse_entry_id(rel_kb)
            if parsed:
                found.append((abs_p, rel_kb, parsed[0], parsed[1], parsed[2], parsed[3]))
    return found


def corpus_fingerprint(files):
    max_mtime = 0
    total_size = 0
    for abs_p, *_ in files:
        st = os.stat(abs_p)
        if st.st_mtime_ns > max_mtime:
            max_mtime = st.st_mtime_ns
        total_size += st.st_size
    return f'v{SCHEMA_VERSION}:{len(files)}:{total_size}:{max_mtime}'


def load_entry_from_file(abs_p, domain, kind, slug, entry_id):
    with open(abs_p, encoding='utf-8') as f:
        raw = f.read()
    meta, body = parse_markdown_entry(raw)
    triggers = meta.get('triggers') if isinstance(meta.get('triggers'), list) else []
    sources = meta.get('sources') if isinstance(meta.get('sources'), list) else []
    return {
        'id': entry_id,
        'domain': domain,
        'kind': kind,
        'slug': slug,
        'path': f'kb/{entry_id}.md',
        'title': str(meta.get('title', '')).strip(),
        'summary': str(meta.get('summary', '')).strip(),
        'triggers': [str(x).strip() for x in triggers if str(x).strip()],
        'sources': [str(x).strip() for x in sources if str(x).strip()],
        'expires': str(meta.get('expires', '')).strip(),
        'disputed': str(meta.get('disputed', '')).strip(),
        'body': body,
    }


def ensure_index(kb_root):
    cache_dir = cache_dir_for(kb_root)
    db_path = os.path.join(cache_dir, 'index.sqlite')
    files = iter_kb_files(kb_root)
    fp = corpus_fingerprint(files)

    if os.path.isfile(db_path):
        try:
            conn = sqlite3.connect(db_path)
            row = conn.execute("SELECT value FROM meta WHERE key = 'fingerprint'").fetchone()
            if row and row[0] == fp:
                return conn, db_path, False
            conn.close()
        except sqlite3.Error:
            pass

    with file_lock(os.path.join(cache_dir, 'index.lock'), blocking=True):
        if os.path.isfile(db_path):
            try:
                conn = sqlite3.connect(db_path)
                row = conn.execute("SELECT value FROM meta WHERE key = 'fingerprint'").fetchone()
                if row and row[0] == fp:
                    return conn, db_path, False
                conn.close()
            except sqlite3.Error:
                pass

        tmp_db = os.path.join(cache_dir, f'index.{os.getpid()}.tmp.sqlite')
        if os.path.exists(tmp_db):
            os.remove(tmp_db)
        conn = sqlite3.connect(tmp_db)
        try:
            conn.executescript(
                """
                CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
                CREATE TABLE docs (
                    id TEXT PRIMARY KEY,
                    domain TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    slug TEXT NOT NULL,
                    path TEXT NOT NULL,
                    title TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    triggers_json TEXT NOT NULL,
                    sources_json TEXT NOT NULL,
                    expires TEXT NOT NULL,
                    disputed TEXT NOT NULL,
                    body TEXT NOT NULL,
                    all_tokens TEXT NOT NULL
                );
                CREATE VIRTUAL TABLE docs_fts USING fts5(
                    id UNINDEXED,
                    title_seg,
                    triggers_seg,
                    summary_seg,
                    sources_seg,
                    body_seg,
                    tokenize = 'unicode61'
                );
                """
            )
            conn.execute("INSERT INTO meta(key, value) VALUES ('fingerprint', ?)", (fp,))
            for abs_p, _, domain, kind, slug, entry_id in files:
                e = load_entry_from_file(abs_p, domain, kind, slug, entry_id)
                title_seg = segment_for_index(f'{domain} {slug} {e["title"]}')
                trig_seg = segment_for_index(' '.join(e['triggers']))
                sum_seg = segment_for_index(e['summary'])
                src_seg = segment_for_index(' '.join(e['sources']))
                body_seg = segment_for_index(e['body'])
                token_set = sorted(set(f'{title_seg} {trig_seg} {sum_seg} {src_seg} {body_seg}'.split()))
                conn.execute(
                    'INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
                    (
                        e['id'], e['domain'], e['kind'], e['slug'], e['path'],
                        e['title'], e['summary'],
                        json.dumps(e['triggers'], ensure_ascii=False),
                        json.dumps(e['sources'], ensure_ascii=False),
                        e['expires'], e['disputed'], e['body'],
                        ' '.join(token_set),
                    ),
                )
                conn.execute(
                    'INSERT INTO docs_fts VALUES (?, ?, ?, ?, ?, ?)',
                    (e['id'], title_seg, trig_seg, sum_seg, src_seg, body_seg),
                )
            conn.commit()
        finally:
            conn.close()
        os.replace(tmp_db, db_path)

    return sqlite3.connect(db_path), db_path, True


def is_expired_date(expires_str, today):
    if not expires_str:
        return False
    try:
        return today > dt.date.fromisoformat(expires_str)
    except ValueError:
        return False


def rank_search(conn, query_text, today, domain=None, kind=None, limit=5, exclude_id=None):
    clauses = parse_query_clauses(query_text)
    if not clauses:
        return []
    unique_q_tokens = []
    for cl in clauses:
        for t in cl['tokens']:
            if t not in unique_q_tokens:
                unique_q_tokens.append(t)
    if not unique_q_tokens:
        return []

    fts_expr = ' OR '.join(f'"{t}"' for t in unique_q_tokens)
    sql = """
        SELECT d.id, d.domain, d.kind, d.path, d.title, d.summary,
               d.triggers_json, d.sources_json, d.expires, d.disputed, d.all_tokens,
               bm25(docs_fts, 0.0, 6.0, 8.0, 4.0, 3.0, 1.0) AS raw_bm25
        FROM docs_fts
        JOIN docs d ON d.id = docs_fts.id
        WHERE docs_fts MATCH ?
    """
    params = [fts_expr]
    if domain:
        sql += ' AND d.domain = ?'
        params.append(domain)
    if kind:
        sql += ' AND d.kind = ?'
        params.append(kind)
    if exclude_id:
        sql += ' AND d.id != ?'
        params.append(exclude_id)
    sql += ' ORDER BY raw_bm25 ASC LIMIT 50'

    rows = conn.execute(sql, params).fetchall()
    scored = []
    q_low = query_text.lower()
    for row in rows:
        (entry_id, dom, knd, rel_path, title, summary,
         trig_json, src_json, expires, disputed, all_tokens_str, raw_bm25) = row
        doc_tokens = set(all_tokens_str.split())
        triggers = json.loads(trig_json)
        sources = json.loads(src_json)

        clause_hits = 0.0
        for cl in clauses:
            matched = sum(1 for t in cl['tokens'] if t in doc_tokens)
            if cl['kind'] == 'ascii':
                if cl['tokens'][0] in doc_tokens:
                    clause_hits += 1.0
                elif matched > 0:
                    clause_hits += 0.55 * (matched / len(cl['tokens']))
            else:
                if matched > 0:
                    ratio = matched / len(cl['tokens'])
                    clause_hits += 1.0 if ratio >= 0.5 else (0.5 * ratio)

        coverage = clause_hits / len(clauses)
        if len(clauses) >= 2 and coverage < 0.34:
            continue
        if len(clauses) == 1 and clause_hits < 0.5:
            continue

        base = max(0.1, -float(raw_bm25))
        trig_boost = 0.0
        for tr in triggers:
            tr_low = tr.lower()
            if tr_low and tr_low in q_low:
                trig_boost += 4.5
        kind_boost = 1.5 if knd == 'redline' else 0.0
        expired = is_expired_date(expires, today)
        penalty = (4.0 if expired else 0.0) + (2.5 if disputed else 0.0)
        final_score = round(base * (0.4 + 1.6 * (coverage ** 1.5)) + trig_boost + kind_boost - penalty, 3)
        if final_score <= 0.35:
            continue

        flags = []
        if knd == 'redline':
            flags.append('REDLINE')
        if expired:
            flags.append(f'EXPIRED:{expires}')
        if disputed:
            flags.append('DISPUTED')
        scored.append({
            'id': entry_id,
            'domain': dom,
            'kind': knd,
            'path': rel_path,
            'title': title,
            'summary': summary,
            'triggers': triggers,
            'sources': sources,
            'expires': expires or None,
            'disputed': disputed or None,
            'flags': flags,
            'coverage': round(coverage, 2),
            'score': final_score,
        })

    scored.sort(key=lambda x: (-x['score'], x['id']))
    return scored[:max(1, min(limit, 20))]


# ---- Anchor Verification & Validation Helpers ----

def find_anchor_target(workspace_root, source_spec):
    """Check whether a source file or file#symbol exists in workspace_root.

    Returns ('ok'|'skip'|'file_missing'|'symbol_missing', detail).
    """
    raw = source_spec.strip()
    if not raw or '://' in raw:
        return 'skip', 'external URL or empty'
    file_part, sep, symbol = raw.partition('#')
    rel = file_part.strip().replace('\\', '/')
    while rel.startswith('./'):
        rel = rel[2:]
    if ':' in rel and not re.match(r'^[A-Za-z]:/', rel):
        repo_prefix, _, rest_path = rel.partition(':')
        rest_path = re.sub(r':\d+(?:-\d+)?$', '', rest_path)
        if repo_prefix and rest_path and '/' not in repo_prefix:
            rel = f'{repo_prefix}/{rest_path.lstrip("/")}'
    if not rel or os.path.isabs(rel) or '..' in rel.split('/'):
        return 'skip', 'non-workspace anchor'

    candidates = [rel]
    if not rel.startswith('repos/'):
        candidates.append(f'repos/{rel}')

    for cand in candidates:
        parts = cand.split('/')
        if len(parts) >= 2:
            repo_dir = os.path.join(workspace_root, parts[0], parts[1]) if parts[0] == 'repos' and len(parts) >= 3 else os.path.join(workspace_root, parts[0])
            if os.path.isdir(repo_dir):
                target_abs = os.path.join(workspace_root, cand)
                if not os.path.isfile(target_abs):
                    return 'file_missing', f'{cand} missing inside present repo'
                if sep and symbol.strip():
                    try:
                        with open(target_abs, encoding='utf-8', errors='replace') as f:
                            content = f.read()
                        if symbol.strip() not in content:
                            return 'symbol_missing', f'symbol "{symbol.strip()}" not found in {cand}'
                    except OSError as exc:
                        return 'file_missing', str(exc)
                return 'ok', cand
    return 'skip', 'target repo not checked out in this workspace'


def normalize_entry_id(raw_id):
    s = (raw_id or '').strip().replace('\\', '/')
    for prefix in ('.loop/outbox/kb/', 'kb/'):
        if s.startswith(prefix):
            s = s[len(prefix):]
    if s.endswith('.md'):
        s = s[:-3]
    parsed = parse_entry_id(f'{s}.md')
    if not parsed:
        raise KbError(
            f'Invalid entry ID "{raw_id}". Expected <domain>/<kind>/<slug> '
            f'where kind is one of: {", ".join(KINDS)}'
        )
    return parsed  # (domain, kind, slug, entry_id)


def validate_entry_file(file_path, expected_id=None, conn=None, today=None):
    errors = []
    warnings = []
    if not os.path.isfile(file_path):
        return [f'File not found: {file_path}'], []
    with open(file_path, encoding='utf-8') as f:
        raw = f.read()

    for rx, label in SECRET_CHECKS:
        if rx.search(raw):
            errors.append(f'Contains {label}; strip secrets and local user home paths before sharing.')

    rel_norm = file_path.replace('\\', '/')
    inferred_id = expected_id
    if not inferred_id:
        for marker in ('.loop/outbox/kb/', '/kb/', 'kb/'):
            idx = rel_norm.find(marker)
            if idx != -1:
                tail = rel_norm[idx + len(marker):]
                parsed = parse_entry_id(tail)
                if parsed:
                    inferred_id = parsed[3]
                    break
    if not inferred_id:
        errors.append(
            f'Path "{file_path}" must end with <domain>/<kind>/<slug>.md '
            f'(allowed kinds: {", ".join(KINDS)}).'
        )
    else:
        try:
            normalize_entry_id(inferred_id)
        except KbError as e:
            errors.append(str(e))

    meta, body = parse_markdown_entry(raw)
    if not meta:
        errors.append('Missing YAML frontmatter block (`--- ... ---`).')
        return errors, warnings

    title = str(meta.get('title', '')).strip()
    summary = str(meta.get('summary', '')).strip()
    triggers = meta.get('triggers')
    sources = meta.get('sources')
    expires = str(meta.get('expires', '')).strip()

    if len(title) < 6 or len(title) > 140:
        errors.append('Frontmatter `title` is required (6..140 chars).')
    if len(summary) < 10 or len(summary) > 300:
        errors.append('Frontmatter `summary` is required (10..300 chars).')
    if not isinstance(triggers, list) or len([t for t in triggers if str(t).strip()]) < 2:
        errors.append('Frontmatter `triggers` must be a list of at least 2 search trigger terms.')
    if not isinstance(sources, list) or len([s for s in sources if str(s).strip()]) < 1:
        errors.append('Frontmatter `sources` must list at least 1 code path, config file, or incident ref.')
    if expires:
        try:
            dt.date.fromisoformat(expires)
        except ValueError:
            errors.append('Frontmatter `expires` must be YYYY-MM-DD when provided.')
    if len(body.strip()) < 20:
        errors.append('Markdown body is too short (< 20 chars); state symptom/rule, cause, and verified action.')
    if len(raw.encode('utf-8')) > 32 * 1024:
        errors.append('Entry exceeds 32 KB; split into focused atomic entries.')

    if conn is not None and title and isinstance(triggers, list) and not errors:
        q = f'{title} ' + ' '.join(str(x) for x in triggers[:6])
        sim = rank_search(conn, q, today or dt.date.today(), limit=3, exclude_id=inferred_id)
        cand_tokens = set(segment_for_index(f'{title} {" ".join(str(x) for x in triggers)}').split())
        for hit in sim:
            hit_tokens = set(segment_for_index(f'{hit["title"]} {" ".join(hit["triggers"])}').split())
            union = len(cand_tokens | hit_tokens)
            jaccard = (len(cand_tokens & hit_tokens) / union) if union else 0.0
            if jaccard >= 0.45:
                warnings.append(
                    f'Near-duplicate of existing entry "{hit["id"]}" ({hit["title"]}, overlap={jaccard:.0%}). '
                    'Prefer updating the existing entry instead of creating a duplicate.'
                )
    return errors, warnings


# ---- CLI Commands ----

def cmd_search(a):
    kb_root = resolve_kb_root(a.kb_root)
    cache_dir = cache_dir_for(kb_root)
    if a.sync:
        maybe_sync_git(kb_root, cache_dir, force=False)
    query_text = (a.query or ' '.join(a.terms or [])).strip()
    if not query_text:
        raise KbError('Provide a search query, e.g. `kb.py search "RateLimit 429"`.')
    today = clock_date(a.now)
    conn, _, _ = ensure_index(kb_root)
    try:
        hits = rank_search(conn, query_text, today, domain=a.domain, kind=a.kind, limit=a.limit)
    finally:
        conn.close()

    if a.json:
        print(json.dumps({'query': query_text, 'count': len(hits), 'results': hits}, ensure_ascii=False, indent=2))
        return

    if not hits:
        print(f'0 matches in team-kb for: {one_line(query_text, 120)}')
        return

    lines = [REF_BANNER, f'Found {len(hits)} match(es) for "{one_line(query_text, 100)}":']
    for i, h in enumerate(hits, 1):
        badge = (' [' + ', '.join(h['flags']) + ']') if h['flags'] else ''
        lines.append(f'{i}. [{h["id"]}]{badge} (score={h["score"]}) — {h["title"]}')
        lines.append(f'   Summary: {h["summary"]}')
        lines.append(f'   Sources: {", ".join(h["sources"][:4])}')
    lines.append('Read full details before acting: python3 <team-kb>/scripts/kb.py get <id>')
    out = '\n'.join(lines)
    print(out if len(out) <= SEARCH_MAX_CHARS else out[:SEARCH_MAX_CHARS] + '\n… (truncated)')


def cmd_get(a):
    kb_root = resolve_kb_root(a.kb_root)
    domain, kind, slug, entry_id = normalize_entry_id(a.id)
    abs_p = os.path.join(kb_root, 'kb', domain, kind, f'{slug}.md')
    if not os.path.isfile(abs_p):
        raise KbError(f'Entry not found: {entry_id}')
    today = clock_date(a.now)
    e = load_entry_from_file(abs_p, domain, kind, slug, entry_id)
    expired = is_expired_date(e['expires'], today)
    anchor_checks = [
        {'source': s, 'status': st, 'detail': det}
        for s in e['sources']
        for st, det in [find_anchor_target(a.workspace_root, s)]
    ]

    if a.json:
        e['expired'] = expired
        e['anchor_checks'] = anchor_checks
        print(json.dumps(e, ensure_ascii=False, indent=2))
        return

    lines = [REF_BANNER, f'ID: {e["id"]} ({e["path"]})', f'Title: {e["title"]}', f'Summary: {e["summary"]}']
    if expired:
        lines.append(f'WARNING [EXPIRED {e["expires"]}]: Temporary workaround passed its expiry date; verify before using.')
    if e['disputed']:
        lines.append(f'WARNING [DISPUTED]: {e["disputed"]}')
    drift_bad = [c for c in anchor_checks if c['status'] in ('file_missing', 'symbol_missing')]
    if drift_bad:
        for c in drift_bad:
            lines.append(f'WARNING [ANCHOR DRIFT]: {c["source"]} -> {c["detail"]}')
    lines.append(f'Sources: {", ".join(e["sources"])}')
    lines.append('---')
    lines.append(e['body'])
    out = '\n'.join(lines)
    print(out if len(out) <= GET_MAX_CHARS else out[:GET_MAX_CHARS] + '\n… (truncated)')


def cmd_redlines(a):
    kb_root = resolve_kb_root(a.kb_root)
    today = clock_date(a.now)
    conn, _, _ = ensure_index(kb_root)
    try:
        rows = conn.execute(
            "SELECT id, domain, title, summary, triggers_json, sources_json, expires, disputed "
            "FROM docs WHERE kind = 'redline' ORDER BY id ASC"
        ).fetchall()
    finally:
        conn.close()

    repo_q = (a.repo or '').strip().lower()
    dom_q = (a.domain or '').strip().lower()
    items = []
    for entry_id, dom, title, summary, trig_json, src_json, expires, disputed in rows:
        if is_expired_date(expires, today):
            continue
        if dom_q and dom.lower() != dom_q:
            continue
        triggers = json.loads(trig_json)
        sources = json.loads(src_json)
        if repo_q:
            hay = ' '.join([dom, entry_id, *triggers, *sources]).lower()
            if repo_q not in hay:
                continue
        items.append({
            'id': entry_id,
            'domain': dom,
            'title': title,
            'summary': summary,
            'disputed': disputed or None,
        })
    items = items[:max(1, min(a.limit, 15))]

    if a.json:
        print(json.dumps({'count': len(items), 'redlines': items}, ensure_ascii=False, indent=2))
        return
    if not items:
        print('No active team redlines matched.')
        return
    lines = ['TEAM REDLINES (team-kb guardrails; verify live context if disputed):']
    for it in items:
        disp = ' [DISPUTED]' if it['disputed'] else ''
        lines.append(f'- [{it["id"]}]{disp} {it["title"]}: {it["summary"]}')
    print('\n'.join(lines))


def cmd_propose(a):
    kb_root = resolve_kb_root(a.kb_root)
    domain, kind, slug, entry_id = normalize_entry_id(a.id)
    triggers = [t.strip() for t in (a.triggers or '').split(',') if t.strip()]
    sources = [s.strip() for s in (a.sources or '').split(',') if s.strip()]
    body = a.body
    if a.body_file:
        if os.path.isabs(a.body_file) or '..' in a.body_file.replace('\\', '/').split('/'):
            raise KbError('--body-file must be a workspace-relative path without ..')
        if not os.path.isfile(a.body_file):
            raise KbError(f'--body-file not found: {a.body_file}')
        with open(a.body_file, encoding='utf-8') as f:
            body = f.read()
    if not body:
        raise KbError('Provide --body or --body-file with the Markdown content.')

    draft_rel = os.path.join(OUTBOX_KB, domain, kind, f'{slug}.md').replace('\\', '/')
    if os.path.exists(draft_rel) and not a.force:
        raise KbError(f'Draft already exists at {draft_rel}; pass --force to overwrite.')

    content = render_entry_markdown(a.title, a.summary, triggers, sources, body, expires=a.expires)
    os.makedirs(os.path.dirname(draft_rel), exist_ok=True)
    tmp = f'{draft_rel}.{os.getpid()}.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        f.write(content)
    os.replace(tmp, draft_rel)

    conn, _, _ = ensure_index(kb_root)
    try:
        errors, warnings = validate_entry_file(draft_rel, expected_id=entry_id, conn=conn, today=clock_date(a.now))
    finally:
        conn.close()
    if errors:
        os.remove(draft_rel)
        raise KbError('Draft validation failed:\n- ' + '\n- '.join(errors))

    payload = {
        'status': 'drafted',
        'id': entry_id,
        'draft': draft_rel,
        'warnings': warnings,
        'approval_file': draft_rel,
    }
    if a.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return
    print(f'Drafted valid KB proposal: {draft_rel}')
    for w in warnings:
        print(f'WARNING: {w}')


def cmd_dispute(a):
    kb_root = resolve_kb_root(a.kb_root)
    domain, kind, slug, entry_id = normalize_entry_id(a.id)
    src_abs = os.path.join(kb_root, 'kb', domain, kind, f'{slug}.md')
    if not os.path.isfile(src_abs):
        raise KbError(f'Cannot dispute missing entry: {entry_id}')
    reason = one_line(a.reason, 200)
    if len(reason) < 8:
        raise KbError('--reason must explain what live evidence contradicted the entry (>= 8 chars).')
    today = clock_date(a.now).isoformat()
    e = load_entry_from_file(src_abs, domain, kind, slug, entry_id)
    content = render_entry_markdown(
        e['title'], e['summary'], e['triggers'], e['sources'], e['body'],
        expires=e['expires'] or None,
        disputed=f'{today}: {reason}',
    )
    draft_rel = os.path.join(OUTBOX_KB, domain, kind, f'{slug}.md').replace('\\', '/')
    os.makedirs(os.path.dirname(draft_rel), exist_ok=True)
    with open(draft_rel, 'w', encoding='utf-8') as f:
        f.write(content)
    if a.json:
        print(json.dumps({'status': 'dispute_drafted', 'id': entry_id, 'draft': draft_rel}, ensure_ascii=False, indent=2))
    else:
        print(f'Drafted dispute update: {draft_rel}')


def cmd_validate(a):
    kb_root = resolve_kb_root(a.kb_root)
    today = clock_date(a.now)
    conn, _, _ = ensure_index(kb_root)
    try:
        targets = []
        if a.all:
            for abs_p, _, _, _, _, entry_id in iter_kb_files(kb_root):
                targets.append((abs_p, entry_id))
        else:
            if not a.path:
                raise KbError('Pass a draft file path or --all.')
            targets.append((a.path, None))

        all_errors = []
        all_warnings = []
        for path_item, exp_id in targets:
            errs, warns = validate_entry_file(path_item, expected_id=exp_id, conn=conn, today=today)
            for e in errs:
                all_errors.append(f'{path_item}: {e}')
            for w in warns:
                all_warnings.append(f'{path_item}: {w}')
    finally:
        conn.close()

    if a.json:
        print(json.dumps({
            'checked': len(targets),
            'valid': len(all_errors) == 0,
            'errors': all_errors,
            'warnings': all_warnings,
        }, ensure_ascii=False, indent=2))
        if all_errors:
            sys.exit(2)
        return

    if all_errors:
        raise KbError('Validation failed:\n- ' + '\n- '.join(all_errors))
    print(f'OK: {len(targets)} file(s) validated clean.')
    for w in all_warnings:
        print(f'WARNING: {w}')


def cmd_drift(a):
    kb_root = resolve_kb_root(a.kb_root)
    today = clock_date(a.now)
    files = iter_kb_files(kb_root)
    issues = []
    entries = []
    for abs_p, _, domain, kind, slug, entry_id in files:
        e = load_entry_from_file(abs_p, domain, kind, slug, entry_id)
        entries.append(e)
        if is_expired_date(e['expires'], today):
            issues.append({
                'kind': 'WORKAROUND_EXPIRED',
                'id': entry_id,
                'detail': f'Temporary workaround expired on {e["expires"]}',
            })
        if e['disputed']:
            issues.append({
                'kind': 'ENTRY_DISPUTED',
                'id': entry_id,
                'detail': e['disputed'],
            })
        for src in e['sources']:
            st, det = find_anchor_target(a.workspace_root, src)
            if st == 'file_missing':
                issues.append({'kind': 'ANCHOR_FILE_MISSING', 'id': entry_id, 'source': src, 'detail': det})
            elif st == 'symbol_missing':
                issues.append({'kind': 'ANCHOR_SYMBOL_MISSING', 'id': entry_id, 'source': src, 'detail': det})

    token_sets = [
        (e['id'], e['domain'], set(segment_for_index(f'{e["title"]} {" ".join(e["triggers"])}').split()))
        for e in entries
    ]
    for i in range(len(token_sets)):
        id_a, dom_a, set_a = token_sets[i]
        for j in range(i + 1, len(token_sets)):
            id_b, dom_b, set_b = token_sets[j]
            if dom_a != dom_b:
                continue
            union = len(set_a | set_b)
            jacc = (len(set_a & set_b) / union) if union else 0.0
            if jacc >= 0.55:
                issues.append({
                    'kind': 'NEAR_DUPLICATE',
                    'id': id_a,
                    'other_id': id_b,
                    'detail': f'High title/trigger token overlap ({jacc:.0%}) between {id_a} and {id_b}',
                })

    report = {'checked_entries': len(entries), 'issue_count': len(issues), 'issues': issues}
    if a.json or a.exit_code:
        if issues or not a.exit_code:
            print(json.dumps(report, ensure_ascii=False, indent=2 if a.json and not a.exit_code else None))
        else:
            print('all clear')
    else:
        if not issues:
            print(f'Healthy: {len(entries)} entries checked, 0 drift/expiry/dispute issues.')
        else:
            print(f'Found {len(issues)} issue(s) across {len(entries)} entries:')
            for it in issues:
                print(f'- [{it["kind"]}] {it["id"]}: {it["detail"]}')

    if a.exit_code:
        sys.exit(0 if issues else 1)


def cmd_stats(a):
    kb_root = resolve_kb_root(a.kb_root)
    cache_dir = cache_dir_for(kb_root)
    sync_state = maybe_sync_git(kb_root, cache_dir, force=True) if a.sync else 'not-requested'
    conn, db_path, rebuilt = ensure_index(kb_root)
    try:
        total = conn.execute('SELECT COUNT(*) FROM docs').fetchone()[0]
        by_domain = dict(conn.execute('SELECT domain, COUNT(*) FROM docs GROUP BY domain ORDER BY domain').fetchall())
        by_kind = dict(conn.execute('SELECT kind, COUNT(*) FROM docs GROUP BY kind ORDER BY kind').fetchall())
    finally:
        conn.close()
    info = {
        'kb_root': kb_root,
        'index_db': db_path,
        'rebuilt': rebuilt,
        'sync': sync_state,
        'total_entries': total,
        'by_domain': by_domain,
        'by_kind': by_kind,
    }
    if a.json:
        print(json.dumps(info, ensure_ascii=False, indent=2))
    else:
        print(f'KB root: {kb_root} ({total} entries, index rebuilt={rebuilt}, sync={sync_state})')
        print(f'Domains: {json.dumps(by_domain, ensure_ascii=False)}')
        print(f'Kinds:   {json.dumps(by_kind, ensure_ascii=False)}')


def build_parser():
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--now', default=argparse.SUPPRESS, help='Override clock ISO date/datetime for deterministic tests')
    common.add_argument('--kb-root', default=argparse.SUPPRESS, help='Optional KB repo path override (prefer HARBOR_KB_ROOT)')
    common.add_argument('--json', action='store_true', default=argparse.SUPPRESS, help='Emit machine-readable JSON')

    ap = argparse.ArgumentParser(description='Team Shared Knowledge Base CLI')
    ap.add_argument('--now', default=None, help='Override clock ISO date/datetime for deterministic tests')
    ap.add_argument('--kb-root', default=None, help='Optional KB repo path override (prefer HARBOR_KB_ROOT)')
    ap.add_argument('--json', action='store_true', default=False, help='Emit machine-readable JSON')
    sub = ap.add_subparsers(dest='cmd', required=True)

    p = sub.add_parser('search', parents=[common], help='Search team knowledge (BM25 + CJK bigram + code identifier split)')
    p.add_argument('terms', nargs='*', help='Search query words')
    p.add_argument('--query', '-q', help='Search query string')
    p.add_argument('--domain', help='Filter by domain folder')
    p.add_argument('--kind', choices=KINDS, help='Filter by entry kind')
    p.add_argument('--limit', type=int, default=5, help='Max results (default 5)')
    p.add_argument('--sync', action='store_true', help='Non-blocking git pull --ff-only if TTL expired')

    p = sub.add_parser('get', parents=[common], help='Read full KB entry and check live anchors')
    p.add_argument('id', help='Entry ID (<domain>/<kind>/<slug>)')
    p.add_argument('--workspace-root', default='.', help='Workspace root for anchor verification')

    p = sub.add_parser('redlines', parents=[common], help='List active one-line redline guardrails (Push path)')
    p.add_argument('--repo', help='Filter redlines matching a repository or service name')
    p.add_argument('--domain', help='Filter redlines by domain')
    p.add_argument('--limit', type=int, default=10, help='Max guardrails (default 10)')

    p = sub.add_parser('propose', parents=[common], help='Write and validate a draft KB entry under .loop/outbox/kb/')
    p.add_argument('--id', required=True, help='Target entry ID (<domain>/<kind>/<slug>)')
    p.add_argument('--title', required=True)
    p.add_argument('--summary', required=True)
    p.add_argument('--triggers', required=True, help='Comma-separated search triggers')
    p.add_argument('--sources', required=True, help='Comma-separated source file#symbol or incident refs')
    p.add_argument('--body', help='Markdown body text')
    p.add_argument('--body-file', help='Workspace-relative file holding Markdown body')
    p.add_argument('--expires', help='Optional YYYY-MM-DD expiry (temporary workarounds only)')
    p.add_argument('--force', action='store_true', help='Overwrite existing draft in outbox')

    p = sub.add_parser('dispute', parents=[common], help='Draft a dispute marker when live reality contradicts an entry')
    p.add_argument('--id', required=True, help='Existing entry ID (<domain>/<kind>/<slug>)')
    p.add_argument('--reason', required=True, help='What live code/telemetry contradicted this entry')

    p = sub.add_parser('validate', parents=[common], help='Validate a draft file or the whole KB')
    p.add_argument('path', nargs='?', help='Draft Markdown path under .loop/outbox/kb/')
    p.add_argument('--all', action='store_true', help='Validate every entry in kb/')

    p = sub.add_parser('drift', parents=[common], help='Detect anchor drift, expired workarounds, disputes, and near-duplicates')
    p.add_argument('--workspace-root', default='.', help='Workspace root containing checked-out repos')
    p.add_argument('--exit-code', action='store_true', help='Exit 0 if issues found, 1 if clean (wakeIf contract)')

    p = sub.add_parser('stats', parents=[common], help='Show KB counts and index status')
    p.add_argument('--sync', action='store_true', help='Force non-blocking git pull --ff-only before stats')
    return ap


def main():
    ap = build_parser()
    a = ap.parse_args()
    dispatch = {
        'search': cmd_search,
        'get': cmd_get,
        'redlines': cmd_redlines,
        'propose': cmd_propose,
        'dispute': cmd_dispute,
        'validate': cmd_validate,
        'drift': cmd_drift,
        'stats': cmd_stats,
    }
    try:
        dispatch[a.cmd](a)
    except KbError as e:
        print(f'team-kb: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
