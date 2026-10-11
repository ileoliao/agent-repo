"""Tiny Jira client (standard library only). Credentials come from the environment, never from files.

JIRA_TOKEN                required. With JIRA_EMAIL it is Jira Cloud basic auth (email + API token);
                          without JIRA_EMAIL it is sent as a Bearer token (Jira Server / Data Center PAT).
JIRA_BASE_URL, JIRA_BOARD_ID   optional overrides for baseUrl / boardId in ../config.json.
"""
import base64
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


class ConfigError(Exception):
    pass


class ApiError(Exception):
    pass


def load_config():
    with open(os.path.join(HERE, '..', 'config.json'), encoding='utf-8') as f:
        cfg = json.load(f)
    cfg['baseUrl'] = (os.environ.get('JIRA_BASE_URL') or cfg.get('baseUrl') or '').rstrip('/')
    cfg['boardId'] = str(os.environ.get('JIRA_BOARD_ID') or cfg.get('boardId') or '')
    if not cfg['baseUrl']:
        raise ConfigError('Jira base URL is not set: fill baseUrl in config.json or set JIRA_BASE_URL')
    if not cfg['boardId']:
        raise ConfigError('Jira board id is not set: fill boardId in config.json or set JIRA_BOARD_ID')
    return cfg


def _auth():
    token = os.environ.get('JIRA_TOKEN')
    if not token:
        raise ConfigError('JIRA_TOKEN is not set (Loop Runner: Set Secret)')
    email = os.environ.get('JIRA_EMAIL')
    if email:
        return 'Basic ' + base64.b64encode(f'{email}:{token}'.encode()).decode()
    return 'Bearer ' + token


def get(cfg, path, params=None):
    url = cfg['baseUrl'] + path + ('?' + urllib.parse.urlencode(params) if params else '')
    req = urllib.request.Request(url, headers={'Authorization': _auth(), 'Accept': 'application/json'})
    last = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=cfg.get('timeoutSec', 30)) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise ApiError(f'Jira rejected the credentials (HTTP {e.code}) for {path}')
            if e.code == 404:
                raise ApiError(f'Jira says not found (HTTP 404) for {path}: check the board id and base URL')
            last = f'HTTP {e.code}'
            if e.code == 429 or e.code >= 500:
                time.sleep(min(int(e.headers.get('Retry-After', '1') or 1), 10))
                continue
            raise ApiError(f'Jira error {last} for {path}')
        except (urllib.error.URLError, TimeoutError) as e:
            last = str(getattr(e, 'reason', e))
            time.sleep(1)
    raise ApiError(f'Jira unreachable for {path}: {last}')


def paged(cfg, path, params, key, cap=20):
    """Follow the agile API's startAt/maxResults paging; at most `cap` pages."""
    out, start = [], 0
    for _ in range(cap):
        page = get(cfg, path, {**params, 'startAt': start, 'maxResults': 50})
        items = page.get(key, [])
        out.extend(items)
        if page.get('isLast') or not items or (page.get('total') is not None and len(out) >= page['total']):
            break
        start += len(items)
    return out
