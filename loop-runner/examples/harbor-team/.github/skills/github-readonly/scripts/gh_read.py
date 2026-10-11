#!/usr/bin/env python3
"""Read-only access to GitHub code and docs for investigations. No writes, no other repositories.

  gh_read.py repos
  gh_read.py search  --repo ORG/NAME --q "text" [--limit 8]
  gh_read.py file    --repo ORG/NAME --path src/a.go [--ref main] [--start 1] [--end 120]
  gh_read.py tree    --repo ORG/NAME [--path docs] [--ref main]
  gh_read.py commits --repo ORG/NAME [--path src/a.go] [--since 2026-10-10T00:00:00Z] [--limit 10]

GITHUB_TOKEN  required: a fine-grained, read-only token limited to the repositories in config allowedRepos.
Only repositories listed in ../config.json allowedRepos are reachable; anything else is refused before any request.
Exit codes: 0 ok, 2 bad arguments, not allowed, or credentials missing, 3 GitHub unreachable or erroring.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


class Fail(Exception):
    def __init__(self, msg, code):
        super().__init__(msg)
        self.code = code


def load():
    with open(os.path.join(HERE, '..', 'config.json'), encoding='utf-8') as f:
        cfg = json.load(f)
    cfg['apiUrl'] = (os.environ.get('GITHUB_API_URL') or cfg.get('apiUrl') or 'https://api.github.com').rstrip('/')
    return cfg


def api(cfg, path, params=None, accept='application/vnd.github+json', raw=False):
    token = os.environ.get('GITHUB_TOKEN')
    if not token:
        raise Fail('GITHUB_TOKEN is not set (Loop Runner: Set Secret)', 2)
    url = cfg['apiUrl'] + path + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {token}', 'Accept': accept, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'loop-runner'})
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=cfg.get('timeoutSec', 30)) as r:
                body = r.read().decode('utf-8', 'replace')
                return body if raw else json.loads(body)
        except urllib.error.HTTPError as e:
            if e.code in (401, 403) and e.headers.get('X-RateLimit-Remaining') != '0':
                raise Fail(f'GitHub rejected the token (HTTP {e.code}) for {path}', 3)
            if e.code == 404:
                raise Fail(f'GitHub says not found for {path}: wrong repo, path or ref, or the token cannot see it', 3)
            last = f'HTTP {e.code}'
            if e.code in (403, 429) or e.code >= 500:
                time.sleep(min(int(e.headers.get('Retry-After', '1') or 1), 10))
                continue
            raise Fail(f'GitHub error {last} for {path}', 3)
        except (urllib.error.URLError, TimeoutError) as e:
            last = str(getattr(e, 'reason', e))
            time.sleep(1)
    raise Fail(f'GitHub unreachable for {path}: {last}', 3)


def clip(cfg, text):
    return text if len(text) <= cfg['maxChars'] else text[:cfg['maxChars']] + f"\n… (cut at {cfg['maxChars']} characters)"


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    sub.add_parser('repos')
    for name in ('search', 'file', 'tree', 'commits'):
        p = sub.add_parser(name)
        p.add_argument('--repo', required=True)
        p.add_argument('--path', default='')
        p.add_argument('--ref')
        p.add_argument('--q')
        p.add_argument('--start', type=int, default=1)
        p.add_argument('--end', type=int)
        p.add_argument('--since')
        p.add_argument('--limit', type=int, default=10)
    a = ap.parse_args()
    try:
        cfg = load()
        if a.cmd == 'repos':
            print(json.dumps({'allowedRepos': cfg['allowedRepos'], 'docsRepos': cfg.get('docsRepos', [])}))
            return 0
        if a.repo not in cfg['allowedRepos']:
            raise Fail(f'{a.repo} is not in allowedRepos {cfg["allowedRepos"]}', 2)
        if '..' in a.path.split('/'):
            raise Fail('path must not contain ..', 2)
        if a.cmd == 'search':
            if not a.q:
                raise Fail('--q is required', 2)
            res = api(cfg, '/search/code', {'q': f'{a.q} repo:{a.repo}', 'per_page': min(a.limit, 20)}, accept='application/vnd.github.text-match+json')
            items = [{'path': i['path'], 'url': i['html_url'], 'matches': [m.get('fragment', '').strip()[:300] for m in i.get('text_matches', [])[:2]]} for i in res.get('items', [])]
            print(clip(cfg, json.dumps({'repo': a.repo, 'query': a.q, 'total': res.get('total_count'), 'items': items}, ensure_ascii=False, indent=1)))
        elif a.cmd == 'file':
            if not a.path:
                raise Fail('--path is required', 2)
            params = {'ref': a.ref} if a.ref else None
            text = api(cfg, f'/repos/{a.repo}/contents/{urllib.parse.quote(a.path)}', params, accept='application/vnd.github.raw+json', raw=True)
            lines = text.split('\n')
            end = min(a.end or a.start + cfg['maxLines'] - 1, a.start + cfg['maxLines'] - 1, len(lines))
            body = '\n'.join(f'{n:>5}  {lines[n - 1]}' for n in range(a.start, end + 1))
            ref = a.ref or 'HEAD'
            head = f'{a.repo}:{a.path}@{ref}  lines {a.start}-{end} of {len(lines)}  https://github.com/{a.repo}/blob/{ref}/{a.path}#L{a.start}-L{end}'
            print(clip(cfg, head + '\n' + body))
        elif a.cmd == 'tree':
            res = api(cfg, f'/repos/{a.repo}/contents/{urllib.parse.quote(a.path)}', {'ref': a.ref} if a.ref else None)
            if isinstance(res, dict):
                raise Fail(f'{a.path} is a file; use the file command', 2)
            print(clip(cfg, json.dumps({'repo': a.repo, 'path': a.path or '/', 'entries': [{'name': e['name'], 'type': e['type'], 'size': e.get('size')} for e in res]}, indent=1)))
        elif a.cmd == 'commits':
            params = {'per_page': min(a.limit, 30)}
            if a.path:
                params['path'] = a.path
            if a.since:
                params['since'] = a.since
            if a.ref:
                params['sha'] = a.ref
            res = api(cfg, f'/repos/{a.repo}/commits', params)
            print(clip(cfg, json.dumps([{'sha': c['sha'][:10], 'date': c['commit']['author']['date'], 'author': c['commit']['author']['name'],
                                         'message': c['commit']['message'].split('\n')[0][:120], 'url': c['html_url']} for c in res], ensure_ascii=False, indent=1)))
    except Fail as e:
        print(f'github: {e}', file=sys.stderr)
        return e.code
    return 0


if __name__ == '__main__':
    sys.exit(main())
