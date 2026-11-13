#!/usr/bin/env python3
"""Publish a validated .loop/outbox/kb/<domain>/<kind>/<slug>.md draft to a Git branch / GitHub PR.

Designed to run ONLY after human approval via Harbor Mate `request_approval` (or interactive developer CLI).
Uses an isolated temporary `git worktree` so the user's active checkout is never disturbed.
Python 3 standard library only.
"""
import argparse
import datetime as dt
import hashlib
import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

POINTER_REL = os.path.join('.loop', 'outbox', 'kb', '.kb_root')


class PublishError(Exception):
    pass


def resolve_kb_root(explicit=None):
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
    candidates.append(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(real_script)))))
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
    raise PublishError('KB repository not found. Clone harbor-team-kb or run plug.py install first.')


def load_kb_module(kb_root):
    kb_py = os.path.join(kb_root, 'skills', 'team-kb', 'scripts', 'kb.py')
    if not os.path.isfile(kb_py):
        local_adj = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'team-kb', 'scripts', 'kb.py')
        kb_py = local_adj if os.path.isfile(local_adj) else kb_py
    if not os.path.isfile(kb_py):
        raise PublishError(f'Cannot locate kb.py validator at {kb_py}')
    spec = importlib.util.spec_from_file_location('harbor_kb_mod', kb_py)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def run_cmd(args, cwd=None, check=True):
    res = subprocess.run(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=60)
    if check and res.returncode != 0:
        raise PublishError(f'Command failed ({" ".join(args[:3])}...): {res.stderr.strip() or res.stdout.strip()}')
    return res


def parse_github_slug(origin_url):
    m = re.search(r'github\.com[:/]([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+?)(?:\.git)?/?$', (origin_url or '').strip())
    return m.group(1) if m else None


def resolve_draft_target(draft_path, kb_mod):
    raw_norm = draft_path.replace('\\', '/').strip()
    if '..' in raw_norm.split('/'):
        raise PublishError('Draft path must not contain .. path traversal.')
    expanded = os.path.expanduser(raw_norm)
    is_cache_draft = False

    if not os.path.isabs(expanded):
        norm = expanded
        while norm.startswith('./'):
            norm = norm[2:]
        if not norm.startswith('.loop/outbox/kb/'):
            raise PublishError('Relative draft path must live under .loop/outbox/kb/<domain>/<kind>/<slug>.md.')
        rel_tail = norm[len('.loop/outbox/kb/'):]
        target_file = norm
    else:
        cache_base = os.environ.get('HARBOR_KB_CACHE_DIR', '').strip() or os.path.join(os.path.expanduser('~'), '.cache', 'harbor-kb')
        drafts_root = os.path.realpath(os.path.join(os.path.abspath(os.path.expanduser(cache_base)), 'drafts'))
        real_draft = os.path.realpath(expanded)
        if not real_draft.startswith(drafts_root + os.sep):
            raise PublishError(f'Absolute draft path must live inside {drafts_root}/<domain>/<kind>/<slug>.md.')
        rel_tail = os.path.relpath(real_draft, drafts_root).replace('\\', '/')
        target_file = real_draft
        is_cache_draft = True

    if not os.path.isfile(target_file):
        raise PublishError(f'Draft file not found: {draft_path}')
    parsed = kb_mod.parse_entry_id(rel_tail)
    if not parsed:
        raise PublishError(f'Invalid draft path {draft_path}; expected <domain>/<kind>/<slug>.md.')
    return target_file, parsed, is_cache_draft


def publish_draft(draft_path, kb_root, no_push=False, no_pr=False, json_out=False):
    kb_mod = load_kb_module(kb_root)
    norm, parsed, is_cache_draft = resolve_draft_target(draft_path, kb_mod)
    domain, kind, slug, entry_id = parsed

    errors, warnings = kb_mod.validate_entry_file(norm, expected_id=entry_id)
    if errors:
        raise PublishError('Refusing to publish invalid draft:\n- ' + '\n- '.join(errors))

    with open(norm, 'rb') as f:
        raw_bytes = f.read()
    sha256_hex = hashlib.sha256(raw_bytes).hexdigest()
    meta, _ = kb_mod.parse_markdown_entry(raw_bytes.decode('utf-8'))

    top = run_cmd(['git', '-C', kb_root, 'rev-parse', '--show-toplevel']).stdout.strip()
    kb_rel_in_git = os.path.relpath(os.path.realpath(kb_root), os.path.realpath(top)).replace('\\', '/')
    prefix = '' if kb_rel_in_git == '.' else f'{kb_rel_in_git}/'

    remotes = run_cmd(['git', '-C', top, 'remote'], check=False).stdout.split()
    has_origin = 'origin' in remotes
    base_ref = 'HEAD'
    if has_origin and not no_push:
        fetch_res = run_cmd(['git', '-C', top, 'fetch', 'origin', '--quiet'], check=False)
        if fetch_res.returncode == 0:
            sym = run_cmd(['git', '-C', top, 'symbolic-ref', 'refs/remotes/origin/HEAD'], check=False)
            if sym.returncode == 0 and sym.stdout.strip():
                base_ref = sym.stdout.strip().replace('refs/remotes/', '')
            else:
                for cand in ('origin/main', 'origin/master'):
                    if run_cmd(['git', '-C', top, 'rev-parse', '--verify', cand], check=False).returncode == 0:
                        base_ref = cand
                        break

    stamp = dt.datetime.now().strftime('%Y%m%d-%H%M%S')
    branch = f'kb/{domain}-{slug}-{stamp}'
    cache_dir = kb_mod.cache_dir_for(kb_root)
    lock_file = os.path.join(cache_dir, 'publish.lock')

    with kb_mod.file_lock(lock_file, blocking=True):
        wt_dir = tempfile.mkdtemp(prefix='harbor-kb-wt-')
        try:
            run_cmd(['git', '-C', top, 'worktree', 'add', '-b', branch, wt_dir, base_ref])
            dest_rel = f'{prefix}kb/{domain}/{kind}/{slug}.md'
            dest_abs = os.path.join(wt_dir, dest_rel)
            existed = os.path.isfile(dest_abs)
            os.makedirs(os.path.dirname(dest_abs), exist_ok=True)
            with open(dest_abs, 'wb') as out_f:
                out_f.write(raw_bytes)

            user_ok = run_cmd(['git', '-C', wt_dir, 'config', 'user.email'], check=False)
            if not user_ok.stdout.strip():
                run_cmd(['git', '-C', wt_dir, 'config', 'user.name', 'Harbor Mate KB'])
                run_cmd(['git', '-C', wt_dir, 'config', 'user.email', 'harbor-kb@localhost'])

            run_cmd(['git', '-C', wt_dir, 'add', '--', dest_rel])
            diff_cached = run_cmd(['git', '-C', wt_dir, 'diff', '--cached', '--quiet'], check=False)
            if diff_cached.returncode == 0:
                raise PublishError(f'Entry {entry_id} is already identical in {base_ref}; nothing to publish.')

            verb = 'update' if existed else 'add'
            commit_title = f'kb({domain}): {verb} {kind}/{slug}'
            run_cmd(['git', '-C', wt_dir, 'commit', '-m', commit_title])
            commit_sha = run_cmd(['git', '-C', wt_dir, 'rev-parse', '--short', 'HEAD']).stdout.strip()

            pushed = False
            pr_url = None
            compare_url = None
            if has_origin and not no_push:
                run_cmd(['git', '-C', wt_dir, 'push', '-u', 'origin', branch])
                pushed = True
                origin_url = run_cmd(['git', '-C', wt_dir, 'remote', 'get-url', 'origin'], check=False).stdout.strip()
                gh_slug = parse_github_slug(origin_url)
                if gh_slug:
                    compare_url = f'https://github.com/{gh_slug}/compare/{branch}?expand=1'
                if not no_pr and gh_slug and shutil.which('gh'):
                    pr_body = (
                        f'## Summary\n\n'
                        f'- **ID**: `{entry_id}`\n'
                        f'- **Title**: {meta.get("title", "")}\n'
                        f'- **Summary**: {meta.get("summary", "")}\n'
                        f'- **Reviewed Draft SHA-256**: `{sha256_hex[:16]}…`\n'
                    )
                    pr_res = run_cmd(
                        ['gh', 'pr', 'create', '--title', commit_title, '--body', pr_body, '--head', branch],
                        cwd=wt_dir, check=False,
                    )
                    if pr_res.returncode == 0:
                        pr_url = pr_res.stdout.strip().splitlines()[-1]
        finally:
            run_cmd(['git', '-C', top, 'worktree', 'remove', '--force', wt_dir], check=False)

    if is_cache_draft:
        try:
            os.remove(norm)
        except OSError:
            pass

    result = {
        'status': 'published',
        'id': entry_id,
        'target': f'{prefix}kb/{domain}/{kind}/{slug}.md',
        'branch': branch,
        'commit': commit_sha,
        'draft_sha256': sha256_hex,
        'pushed': pushed,
        'pr_url': pr_url,
        'compare_url': compare_url,
        'warnings': warnings,
    }
    if json_out:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(f'Published {entry_id} on branch {branch} ({commit_sha}), pushed={pushed}')
        if pr_url:
            print(f'PR: {pr_url}')
        elif compare_url:
            print(f'Open PR: {compare_url}')
    return result


def main():
    ap = argparse.ArgumentParser(description='Publish approved team-kb draft from .loop/outbox/kb/')
    ap.add_argument('draft', help='Draft path (.loop/outbox/kb/<domain>/<kind>/<slug>.md)')
    ap.add_argument('--kb-root', help='Optional KB repo path override')
    ap.add_argument('--no-push', action='store_true', help='Create local branch + commit only without git push')
    ap.add_argument('--no-pr', action='store_true', help='Push branch without calling gh pr create')
    ap.add_argument('--json', action='store_true', help='Emit JSON result')
    a = ap.parse_args()
    try:
        kb_root = resolve_kb_root(a.kb_root)
        publish_draft(a.draft, kb_root, no_push=a.no_push, no_pr=a.no_pr, json_out=a.json)
    except PublishError as e:
        print(f'team-kb-publish: {e}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
