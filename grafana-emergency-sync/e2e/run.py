"""Real Docker/Grafana integration checks. Run with Python 3.11+; no dependencies."""
import base64
import json
import os
from pathlib import Path
import subprocess
import time
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent
CMD = ['docker', 'compose', '-p', 'grafana-emergency-e2e', '-f', str(ROOT / 'compose.yaml')]
ENV = os.environ.copy()
RESULTS = []


def compose(*args, check=True):
    result = subprocess.run(CMD + list(args), env=ENV, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    return result


def api(port, path, body=None, method=None):
    auth = base64.b64encode(b'admin:local-e2e-only').decode()
    req = Request(f'http://127.0.0.1:{port}{path}',
                  data=json.dumps(body).encode() if body is not None else None,
                  method=method, headers={'Authorization': 'Basic ' + auth,
                                          'Content-Type': 'application/json',
                                          'X-Disable-Provenance': 'true'})
    with urlopen(req, timeout=10) as r:
        return json.load(r)


def ready(port):
    for _ in range(120):
        try:
            if api(port, '/api/health')['database'] == 'ok':
                return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError(f'Grafana on {port} did not become ready')


def passed(name, **details):
    RESULTS.append({'check': name, 'status': 'passed', **details})
    print('PASS', name, flush=True)


def state(port):
    return {p: api(port, p) for p in ['/api/folders', '/api/search?type=dash-db',
             '/api/datasources', '/api/datasources/uid/e2e-prom', '/api/v1/provisioning/alert-rules',
             '/api/dashboards/uid/e2e-board']}


def job(success=True, **env):
    ENV.update(env)
    r = compose('run', '--rm', '--no-deps', 'sync', check=False)
    assert (r.returncode == 0) == success, r.stdout + r.stderr
    print(r.stdout + r.stderr, flush=True)
    return r


def main():
    compose('up', '-d', 'primary', 'emergency', 'prometheus')
    ready(13701)
    ready(13702)
    compose('build', 'sync')
    for port, key, role in [(13701, 'SOURCE_GRAFANA_TOKEN', 'Viewer'),
                             (13702, 'TARGET_GRAFANA_TOKEN', 'Admin')]:
        sa = api(port, '/api/serviceaccounts', {'name': 'e2e-sync', 'role': role})
        ENV[key] = api(port, f'/api/serviceaccounts/{sa["id"]}/tokens', {'name': 'e2e'})['key']
    api(13701, '/api/folders', {'uid': 'e2e-folder', 'title': 'E2E folder'})
    ds = {'uid': 'e2e-prom', 'name': 'E2E Prometheus', 'type': 'prometheus',
          'access': 'proxy', 'url': 'http://prometheus:9090',
          'jsonData': {'httpHeaderName1': 'X-E2E'},
          'secureJsonData': {'httpHeaderValue1': 'local-e2e-dummy-value'}}
    api(13701, '/api/datasources', ds)
    board = {'uid': 'e2e-board', 'title': 'E2E dashboard', 'schemaVersion': 39,
             'panels': [{'id': 1, 'type': 'timeseries', 'title': 'Prometheus up',
                         'datasource': {'type': 'prometheus', 'uid': 'e2e-prom'},
                         'targets': [{'refId': 'A', 'expr': 'up'}],
                         'gridPos': {'h': 8, 'w': 12, 'x': 0, 'y': 0}}]}
    api(13701, '/api/dashboards/db', {'dashboard': board, 'folderUid': 'e2e-folder'})
    rule = {'uid': 'e2e-rule', 'title': 'E2E rule', 'folderUID': 'e2e-folder',
            'ruleGroup': 'e2e', 'condition': 'A', 'for': '1m', 'noDataState': 'OK',
            'execErrState': 'Error', 'isPaused': False,
            'data': [{'refId': 'A', 'relativeTimeRange': {'from': 600, 'to': 0},
                      'datasourceUid': '__expr__', 'model': {'refId': 'A',
                      'type': 'math', 'expression': '1 > 2'}}]}
    api(13701, '/api/v1/provisioning/alert-rules', rule)
    api(13702, '/api/folders', {'uid': 'target-only', 'title': 'Keep me'})
    source = state(13701)
    before = api(13702, '/api/folders')
    job(False, DRY_RUN='false', DATA_SOURCE_SECRETS_FILE='')
    assert api(13702, '/api/folders') == before
    passed('missing datasource secret aborts before folder writes')
    job(DRY_RUN='true', DATA_SOURCE_SECRETS_FILE='/fixtures/datasources.json')
    assert api(13702, '/api/folders') == before
    assert api(13702, '/api/search?type=dash-db') == []
    passed('dry run leaves destination unchanged')
    job(DRY_RUN='false')
    dest = state(13702)
    assert dest['/api/dashboards/uid/e2e-board']['meta']['folderUid'] == 'e2e-folder'
    assert dest['/api/datasources/uid/e2e-prom']['secureJsonFields']['httpHeaderValue1']
    assert dest['/api/v1/provisioning/alert-rules'][0]['uid'] == 'e2e-rule'
    assert state(13701) == source
    passed('folders dashboards secure datasources and alert rules sync; source unchanged')
    job(DATA_SOURCE_SECRETS_FILE='')
    assert state(13702) == dest
    passed('repeat sync preserves resources and dashboard version without resupplying secrets')
    board['title'] = 'E2E dashboard updated'
    api(13701, '/api/dashboards/db', {'dashboard': board, 'folderUid': 'e2e-folder', 'overwrite': True})
    rule['title'] = 'E2E rule updated'
    api(13701, '/api/v1/provisioning/alert-rules/e2e-rule', rule, method='PUT')
    job()
    assert api(13702, '/api/dashboards/uid/e2e-board')['dashboard']['title'] == board['title']
    assert api(13702, '/api/v1/provisioning/alert-rules/e2e-rule')['title'] == rule['title']
    assert any(f['uid'] == 'target-only' for f in api(13702, '/api/folders'))
    passed('updates propagate and destination-only folder survives')
    dest = state(13702)
    compose('stop', 'primary')
    job(False)
    assert state(13702) == dest
    passed('primary outage aborts sync and emergency configuration survives')
    query = api(13702, '/api/datasources/proxy/uid/e2e-prom/api/v1/query?query=up')
    assert query['status'] == 'success' and query['data']['result']
    passed('emergency Grafana queries real Prometheus while primary is stopped')
    compose('restart', 'emergency')
    ready(13702)
    assert state(13702) == dest
    passed('emergency SQLite volume survives container restart')
    settings = api(13702, '/api/admin/settings')
    assert settings['unified_alerting']['execute_alerts'] == 'false'
    passed('emergency alert execution disabled')
    compose('start', 'primary')
    ready(13701)
    report = {'grafana_version': api(13702, '/api/health')['version'], 'checks': RESULTS}
    (ROOT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
