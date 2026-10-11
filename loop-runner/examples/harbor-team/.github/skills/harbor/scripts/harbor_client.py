"""HarborSense client (standard library only). Everything specific to the HarborSense HTTP API lives in
../config.json (paths, parameter names, where the points are in the JSON). If the real API differs,
change the config first; only then this file.

HARBOR_PAT          required (the env name is config auth.env). Sent as `<scheme> <token>` in the configured header.
HARBOR_BASE_URL     optional override for baseUrl.
"""
import datetime as dt
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
    cfg['baseUrl'] = (os.environ.get('HARBOR_BASE_URL') or cfg.get('baseUrl') or '').rstrip('/')
    if not cfg['baseUrl']:
        raise ConfigError('HarborSense base URL is not set: fill baseUrl in config.json or set HARBOR_BASE_URL')
    return cfg


def parse_when(s, now=None):
    """ISO 8601 or epoch seconds -> aware datetime."""
    s = str(s).strip()
    if s.replace('.', '', 1).isdigit():
        return dt.datetime.fromtimestamp(float(s), dt.timezone.utc)
    d = dt.datetime.fromisoformat(s.replace('Z', '+00:00'))
    return d if d.tzinfo else d.replace(tzinfo=dt.timezone.utc)


def parse_duration(s):
    s = s.strip().lower()
    unit = {'m': 60, 'h': 3600, 'd': 86400}.get(s[-1])
    if not unit or not s[:-1].isdigit():
        raise ConfigError(f'bad duration "{s}": use 30m, 4h or 1d')
    return int(s[:-1]) * unit


def _fmt_time(cfg, d):
    return str(int(d.timestamp())) if cfg['timeseries'].get('timeFormat', 'epoch_s') == 'epoch_s' else d.isoformat()


def _dig(obj, path):
    for part in path.split('.') if path else []:
        obj = obj.get(part) if isinstance(obj, dict) else None
    return obj


def _call(cfg, spec, values):
    params = {k: v.format(**values) for k, v in spec['params'].items()}
    url = cfg['baseUrl'] + spec['path'] + '?' + urllib.parse.urlencode(params)
    auth = cfg.get('auth', {})
    token = os.environ.get(auth.get('env', 'HARBOR_PAT'))
    if not token:
        raise ConfigError(f"{auth.get('env', 'HARBOR_PAT')} is not set (Loop Runner: Set Secret)")
    req = urllib.request.Request(url, headers={auth.get('header', 'Authorization'): f"{auth.get('scheme', 'Bearer')} {token}".strip(), 'Accept': 'application/json'})
    last = None
    for _ in range(3):
        try:
            with urllib.request.urlopen(req, timeout=cfg.get('timeoutSec', 20)) as r:
                return json.loads(r.read().decode('utf-8'))
        except urllib.error.HTTPError as e:
            if e.code in (401, 403):
                raise ApiError(f'HarborSense rejected the credentials (HTTP {e.code})')
            if e.code == 404:
                raise ApiError(f'HarborSense HTTP 404 for {spec["path"]}: check config.json paths')
            last = f'HTTP {e.code}'
            if e.code == 429 or e.code >= 500:
                time.sleep(min(int(e.headers.get('Retry-After', '1') or 1), 10))
                continue
            raise ApiError(f'HarborSense error {last}')
        except (urllib.error.URLError, TimeoutError) as e:
            last = str(getattr(e, 'reason', e))
            time.sleep(1)
    raise ApiError(f'HarborSense unreachable: {last}')


def series(cfg, signal, start, end):
    """[(epoch_seconds, value)] for the signal between two aware datetimes."""
    ts = cfg['timeseries']
    body = _call(cfg, ts, {'signal': signal, 'from': _fmt_time(cfg, start), 'to': _fmt_time(cfg, end), 'step': cfg.get('stepSeconds', 60)})
    pts = _dig(body, ts.get('points', ''))
    if not isinstance(pts, list):
        raise ApiError(f'HarborSense response has no list at "{ts.get("points")}"; adjust timeseries.points in config.json')
    out = []
    for p in pts:
        t, v = p.get(ts.get('time', 't')), p.get(ts.get('value', 'v'))
        if t is None or v is None:
            continue
        out.append((float(t) if not isinstance(t, str) else parse_when(t).timestamp(), float(v)))
    return out


def breakdown(cfg, signal, start, end, by, limit=5):
    spec = cfg.get('breakdown')
    if not spec:
        return []
    body = _call(cfg, spec, {'signal': signal, 'from': _fmt_time(cfg, start), 'to': _fmt_time(cfg, end), 'by': by, 'limit': limit})
    items = _dig(body, spec.get('items', ''))
    return items[:limit] if isinstance(items, list) else []
