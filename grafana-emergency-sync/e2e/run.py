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
    result = {p: api(port, p) for p in ['/api/folders', '/api/search?type=dash-db',
             '/api/folders/e2e-child',
             '/api/datasources', '/api/datasources/uid/e2e-prom', '/api/v1/provisioning/alert-rules',
             '/api/dashboards/uid/e2e-board']}
    # Folder creator display names can be resolved differently after restart.
    # Compare persisted configuration rather than these computed identity fields.
    folder = result['/api/folders/e2e-child']
    result['/api/folders/e2e-child'] = {k: folder.get(k) for k in ['uid', 'title', 'parentUid', 'version']}
    return result


def job(success=True, error=None, **env):
    ENV.update(env)
    r = compose('run', '--rm', '--no-deps', 'sync', check=False)
    assert (r.returncode == 0) == success, r.stdout + r.stderr
    if error:
        assert error in r.stdout + r.stderr, r.stdout + r.stderr
    if success:
        logged = next(line.split('result=', 1)[1] for line in (r.stdout + r.stderr).splitlines()
                      if 'result=' in line)
        outcome = json.loads(logged)
        assert outcome['status'] == 'ok' and outcome['completed_at_unix'] > 0
        assert outcome['duration_seconds'] >= 0
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
    api(13701, '/api/folders', {'uid': 'e2e-child', 'title': 'E2E child', 'parentUid': 'e2e-folder'})
    # Moving a child to root removes inherited permissions. Keep the read-only
    # sync account explicitly authorized through all move scenarios.
    api(13701, '/api/folders/e2e-child/permissions', {'items': [
        {'role': 'Viewer', 'permission': 1}, {'role': 'Editor', 'permission': 2}]})
    api(13701, '/api/folders', {'uid': 'e2e-other', 'title': 'E2E other'})
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
    library = api(13701, '/api/library-elements', {'name': 'E2E library', 'kind': 1,
                  'model': {'type': 'text', 'title': 'Library current content',
                            'options': {'mode': 'markdown', 'content': 'Shared incident notes'}}})['result']
    board['panels'].append({'id': 2, 'type': 'row', 'collapsed': True,
                           'gridPos': {'h': 1, 'w': 24, 'x': 0, 'y': 8}, 'panels': [
        {'id': 3, 'type': 'text', 'title': 'Stale library title',
         'gridPos': {'h': 4, 'w': 12, 'x': 0, 'y': 9},
         'libraryPanel': {'uid': library['uid'], 'name': library['name']}}]})
    board['templating'] = {'list': [{'name': 'instance', 'type': 'query',
        'datasource': {'type': 'prometheus', 'uid': 'e2e-prom'},
        'query': 'label_values(up, instance)', 'refresh': 1}]}
    api(13701, '/api/dashboards/db', {'dashboard': board, 'folderUid': 'e2e-child'})
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
    job(False, error='Invalid boolean for DRY_RUN', DRY_RUN='treu')
    assert api(13702, '/api/folders') == before
    passed('invalid dry-run value fails before any writes')
    job(False, error='requires destination secrets', DRY_RUN='false', DATA_SOURCE_SECRETS_FILE='')
    assert api(13702, '/api/folders') == before
    passed('missing datasource secret aborts before folder writes')
    job(DRY_RUN='true', DATA_SOURCE_SECRETS_FILE='/fixtures/datasources.json')
    assert api(13702, '/api/folders') == before
    assert api(13702, '/api/search?type=dash-db') == []
    passed('dry run leaves destination unchanged')
    job(DRY_RUN='false')
    dest = state(13702)
    copied = dest['/api/dashboards/uid/e2e-board']
    assert copied['meta']['folderUid'] == 'e2e-child'
    assert dest['/api/folders/e2e-child']['parentUid'] == 'e2e-folder'
    assert copied['dashboard']['templating'] == board['templating']
    panel = copied['dashboard']['panels'][1]['panels'][0]
    assert panel['title'] == 'Library current content' and panel['id'] == 3
    assert 'libraryPanel' not in panel
    assert dest['/api/datasources/uid/e2e-prom']['secureJsonFields']['httpHeaderValue1']
    assert dest['/api/v1/provisioning/alert-rules'] == []
    assert state(13701) == source
    passed('nested folders variables library panels and secure datasources sync; source unchanged')
    passed('alert synchronization disabled by default')
    job(DATA_SOURCE_SECRETS_FILE='')
    assert state(13702) == dest
    passed('repeat sync preserves resources and dashboard version without resupplying secrets')
    board['title'] = 'E2E dashboard updated'
    api(13701, '/api/dashboards/db', {'dashboard': board, 'folderUid': 'e2e-child', 'overwrite': True})
    rule['title'] = 'E2E rule updated'
    api(13701, '/api/v1/provisioning/alert-rules/e2e-rule', rule, method='PUT')
    job()
    assert api(13702, '/api/dashboards/uid/e2e-board')['dashboard']['title'] == board['title']
    assert api(13702, '/api/v1/provisioning/alert-rules') == []
    assert any(f['uid'] == 'target-only' for f in api(13702, '/api/folders'))
    passed('updates propagate and destination-only folder survives')
    api(13701, '/api/folders/e2e-child/move', {'parentUid': 'e2e-other'})
    child = api(13701, '/api/folders/e2e-child')
    api(13701, '/api/folders/e2e-child', {'title': 'E2E renamed child', 'version': child['version']}, method='PUT')
    job()
    child = api(13702, '/api/folders/e2e-child')
    assert child['parentUid'] == 'e2e-other' and child['title'] == 'E2E renamed child'
    api(13701, '/api/folders/e2e-child/move', {'parentUid': ''})
    job()
    assert not api(13702, '/api/folders/e2e-child').get('parentUid')
    passed('folder move plus rename and move back to root converge')
    library_model = {**library['model'], 'title': 'Updated shared content'}
    api(13701, '/api/library-elements/' + library['uid'], {
        'name': library['name'], 'kind': 1, 'version': library['version'],
        'model': library_model}, method='PATCH')
    job()
    assert api(13702, '/api/dashboards/uid/e2e-board')['dashboard']['panels'][1]['panels'][0]['title'] == 'Updated shared content'
    passed('library edits propagate into independent emergency panels')
    dest = state(13702)
    broken = json.loads(json.dumps(board))
    broken['panels'][0]['type'] = 'missing-e2e-plugin'
    api(13701, '/api/dashboards/db', {'dashboard': broken, 'folderUid': 'e2e-child', 'overwrite': True})
    job(False, error='Missing/disabled destination plugins')
    assert state(13702) == dest
    passed('missing plugin aborts before destination changes')
    api(13701, '/api/dashboards/db', {'dashboard': board, 'folderUid': 'e2e-child', 'overwrite': True})
    job(SYNC_ALERT_RULES='true')
    assert api(13702, '/api/v1/provisioning/alert-rules/e2e-rule')['title'] == rule['title']
    passed('alert rules still synchronize when explicitly enabled')
    ENV['SYNC_ALERT_RULES'] = 'false'
    dest = state(13702)
    compose('stop', 'primary')
    job(False, error='Network error calling GET /api/health')
    assert state(13702) == dest
    passed('primary outage aborts sync and emergency configuration survives')
    query = api(13702, '/api/datasources/proxy/uid/e2e-prom/api/v1/query?query=up')
    assert query['status'] == 'success' and query['data']['result']
    passed('emergency Grafana queries real Prometheus while primary is stopped')
    compose('restart', 'emergency')
    ready(13702)
    after = state(13702)
    assert after == dest, json.dumps({k: {'before': dest[k], 'after': after[k]}
                                    for k in dest if dest[k] != after[k]}, indent=2)
    passed('emergency SQLite volume survives container restart')
    settings = api(13702, '/api/admin/settings')
    assert settings['unified_alerting']['execute_alerts'] == 'false'
    passed('emergency alert execution disabled')
    compose('start', 'primary')
    ready(13701)
    report = {'tested_at_unix': int(time.time()),
              'grafana_version': api(13702, '/api/health')['version'], 'checks': RESULTS}
    (ROOT / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    try:
        main()
    finally:
        compose('start', 'primary', check=False)
