import copy
import os
import unittest
from unittest.mock import patch

from sync.main import (Options, SyncError, clean_alert_rule, clean_datasource,
                       page_list, plan, snapshot, sort_folders, sync_all, run,
                       env_bool, read_folders, inline_library_panels, check_plugins)


class DummyClient:
    def __init__(self, values=None):
        self.values = values or {}
        self.calls = []

    def call(self, method, path, payload=None, extra_headers=None):
        self.calls.append((method, path, copy.deepcopy(payload)))
        key = (method, path)
        if key not in self.values:
            raise AssertionError(f"Unexpected call: {key}")
        result = self.values[key]
        if isinstance(result, BaseException):
            raise result
        return copy.deepcopy(result)

    def maybe_get(self, path):
        self.calls.append(('GET?', path, None))
        return copy.deepcopy(self.values.get(('GET?', path)))


class SyncTests(unittest.TestCase):
    def test_invalid_boolean_aborts_before_constructing_clients(self):
        with patch.dict(os.environ, {'DRY_RUN': 'treu'}), patch('sync.main.GrafanaClient') as client:
            self.assertEqual(run(), 1)
            client.assert_not_called()
        for value, expected in [(' TRUE ', True), ('false', False), ('0', False)]:
            with patch.dict(os.environ, {'DRY_RUN': value}):
                self.assertEqual(env_bool('DRY_RUN', True), expected)

    def test_folder_walk_recovers_parent_metadata_and_rejects_duplicate_uid(self):
        source = DummyClient({
            ('GET', '/api/folders?limit=500&page=1'): [
                {'id': -1, 'uid': 'sharedwithme', 'title': 'Shared with me'},
                {'uid': 'root', 'title': 'Root'}],
            ('GET', '/api/folders?parentUid=root&limit=500&page=1'): [{'uid': 'child', 'title': 'Child'}],
            ('GET', '/api/folders?parentUid=child&limit=500&page=1'): [],
        })
        folders = read_folders(source)
        self.assertEqual([f['parentUid'] for f in folders], ['', 'root'])
        source.values[('GET', '/api/folders?parentUid=child&limit=500&page=1')] = [{'uid': 'root'}]
        with self.assertRaisesRegex(SyncError, 'Duplicate'):
            read_folders(source)

    def test_folder_move_and_rename_reloads_version_and_can_move_to_root(self):
        state = dict(folders=[{'uid': 'child', 'title': 'Renamed'}], dashboards=[], datasources=[], rules=[])
        target = DummyClient({
            ('GET?', '/api/folders/child'): {'title': 'Old', 'parentUid': 'parent', 'version': 1},
            ('POST', '/api/folders/child/move'): {},
            ('GET', '/api/folders/child'): {'title': 'Old', 'version': 2},
            ('PUT', '/api/folders/child'): {},
        })
        sync_all(target, state, Options(dry_run=False))
        self.assertIn(('POST', '/api/folders/child/move', {'parentUid': ''}), target.calls)
        self.assertIn(('PUT', '/api/folders/child', {'title': 'Renamed', 'version': 2}), target.calls)

    def test_library_panel_snapshot_uses_latest_model_and_keeps_instance_position(self):
        source = DummyClient({('GET', '/api/library-elements/lib'): {'result': {
            'kind': 1, 'model': {'type': 'text', 'title': 'Latest', 'id': 99,
                                'options': {'content': 'Current library content'}}}}})
        original = [{'type': 'row', 'panels': [{'id': 3, 'gridPos': {'x': 12},
                     'title': 'Stale', 'libraryPanel': {'uid': 'lib'}}]}]
        result = inline_library_panels(source, original, {})
        panel = result[0]['panels'][0]
        self.assertEqual((panel['title'], panel['id'], panel['gridPos']), ('Latest', 3, {'x': 12}))
        self.assertNotIn('libraryPanel', panel)
        self.assertIn('libraryPanel', original[0]['panels'][0])

    def test_missing_plugin_fails_preflight(self):
        target = DummyClient({('GET', '/api/plugins'): [{'id': 'text', 'enabled': True}]})
        with self.assertRaisesRegex(SyncError, 'custom-panel'):
            check_plugins(target, {'datasources': [], 'dashboards': [{'dashboard': {
                'panels': [{'type': 'row', 'panels': [{'type': 'custom-panel'}]}]}}]})
        self.assertEqual(len(target.calls), 1)

    def test_alert_api_not_read_by_default(self):
        source = DummyClient({
            ('GET', '/api/health'): {'database': 'ok'},
            ('GET', '/api/folders?limit=500&page=1'): [],
            ('GET', '/api/search?type=dash-db&limit=500&page=1'): [],
            ('GET', '/api/datasources'): [],
        })
        self.assertEqual(snapshot(source, Options())['rules'], [])

    def test_snapshot_reads_datasource_details_for_secret_preflight(self):
        source = DummyClient({
            ('GET', '/api/health'): {'database': 'ok'},
            ('GET', '/api/folders?limit=500&page=1'): [],
            ('GET', '/api/search?type=dash-db&limit=500&page=1'): [],
            ('GET', '/api/datasources'): [{'uid': 'secured'}],
            ('GET', '/api/datasources/uid/secured'): {
                'uid': 'secured', 'secureJsonFields': {'httpHeaderValue1': True}},
            ('GET', '/api/v1/provisioning/alert-rules'): [],
        })
        state = plan(snapshot(source, Options()))
        target = DummyClient()
        with self.assertRaisesRegex(SyncError, 'requires destination secrets'):
            sync_all(target, state, Options(dry_run=False))
        self.assertFalse([c for c in target.calls if c[0] in ('POST', 'PUT', 'DELETE')])

    def test_no_primary_db_health_no_other_reads(self):
        source = DummyClient({('GET', '/api/health'): {'database': 'failed'}})
        with self.assertRaisesRegex(SyncError, 'database health'):
            snapshot(source, Options())
        self.assertEqual(len(source.calls), 1)

    def test_pagination_and_zero_resources(self):
        source = DummyClient({('GET', '/api/folders?limit=500&page=1'): []})
        self.assertEqual(page_list(source, '/api/folders'), [])

    def test_nested_folder_order(self):
        folders = [dict(uid='child', title='C', parentUid='parent'), dict(uid='parent', title='P')]
        self.assertEqual([x['uid'] for x in sort_folders(folders)], ['parent', 'child'])

    def test_missing_folder_cycle_rejected(self):
        with self.assertRaises(SyncError):
            sort_folders([{'uid': 'x', 'parentUid': 'missing'}])

    def test_dashboard_folder_validation(self):
        obj = dict(folders=[], dashboards=[{'dashboard': {'uid': 'd'}, 'meta': {'folderUid': 'absent'}}], datasources=[], rules=[])
        with self.assertRaisesRegex(SyncError, 'missing folder'):
            plan(obj)

    def test_alert_rule_requires_existing_folder(self):
        obj = dict(folders=[], dashboards=[], datasources=[], rules=[{'uid': 'r', 'folderUID': 'missing'}])
        with self.assertRaisesRegex(SyncError, 'missing folder'):
            plan(obj)

    def test_clean_datasource_id_and_org_removed(self):
        result = clean_datasource(dict(uid='u', id=100, orgId=7, name='P', type='prometheus', url='http://prom:9090'), {})
        self.assertNotIn('id', result)
        self.assertNotIn('orgId', result)
        self.assertEqual(result['uid'], 'u')

    def test_sync_preserves_uids_upserts_and_never_deletes(self):
        state = plan(dict(folders=[{'uid': 'folder', 'title': 'My folder'}],
                          dashboards=[{'dashboard': {'uid': 'board', 'id': 4, 'version': 23, 'title': 'Board'}, 'meta': {'folderUid': 'folder'}}],
                          datasources=[{'uid': 'prom', 'type': 'prometheus', 'name': 'Prometheus', 'url': 'http://prom:9090'}],
                          rules=[{'uid': 'rule1', 'folderUID': 'folder', 'ruleGroup': 'core', 'title': 'High CPU', 'condition': 'A', 'data': [], 'isPaused': False}]))
        target = DummyClient({
            ('POST', '/api/folders'): {'uid': 'folder'},
            ('POST', '/api/datasources'): {'uid': 'prom'},
            ('POST', '/api/dashboards/db'): {'uid': 'board'},
            ('POST', '/api/v1/provisioning/alert-rules'): {'uid': 'rule1'},
        })
        result = sync_all(target, state, Options(dry_run=False))
        self.assertEqual(result, {'folders': 1, 'datasources': 1, 'dashboards': 1, 'alert_rules': 1})
        writes = [x for x in target.calls if x[0] in ('POST', 'PUT', 'DELETE')]
        self.assertEqual([x[0] for x in writes], ['POST'] * 4)
        self.assertEqual(writes[2][2]['dashboard']['id'], None)
        self.assertEqual(writes[2][2]['dashboard']['version'], 0)
        self.assertEqual(writes[2][2]['folderUid'], 'folder')
        self.assertEqual(writes[3][2]['uid'], 'rule1')
        self.assertEqual(writes[3][2]['isPaused'], False)
        self.assertNotIn('id', writes[3][2])

    def test_dry_run_writes_nothing(self):
        state = plan(dict(folders=[], dashboards=[{'dashboard': {'uid': 'test'}, 'meta': {}}], datasources=[], rules=[]))
        target = DummyClient()
        sync_all(target, state, Options(dry_run=True))
        self.assertFalse([x for x in target.calls if x[0] in ('POST', 'PUT', 'DELETE')])

    def test_unavailable_secure_datasource_secret_refuses_create(self):
        state = plan(dict(folders=[], dashboards=[], datasources=[{'uid': 'ds', 'name': 'D', 'type': 'prometheus',
              'secureJsonFields': {'httpHeaderValue1': True}}], rules=[]))
        target = DummyClient()
        with self.assertRaisesRegex(SyncError, 'requires destination secrets'):
            sync_all(target, state, Options(dry_run=False))
        self.assertFalse([x for x in target.calls if x[0] in ('POST', 'PUT', 'DELETE')])

    def test_secret_preflight_happens_before_folder_write(self):
        state = plan(dict(folders=[{'uid': 'folder', 'title': 'Production'}], dashboards=[],
                          datasources=[{'uid': 'ds', 'name': 'D', 'type': 'prometheus',
                                        'secureJsonFields': {'httpHeaderValue1': True}}], rules=[]))
        target = DummyClient()
        with self.assertRaisesRegex(SyncError, 'requires destination secrets'):
            sync_all(target, state, Options(dry_run=False))
        self.assertFalse([x for x in target.calls if x[0] in ('POST', 'PUT', 'DELETE')])

    def test_unchanged_dashboard_avoids_write(self):
        board = {'uid': 'dash1', 'id': 99, 'version': 3, 'title': 'No change'}
        state = plan(dict(folders=[], dashboards=[{'dashboard': board, 'meta': {}}],
                          datasources=[], rules=[]))
        target = DummyClient({('GET?', '/api/dashboards/uid/dash1'):
                              {'dashboard': {**board, 'id': 10, 'version': 14}, 'meta': {}}})
        sync_all(target, state, Options(dry_run=False))
        self.assertFalse([x for x in target.calls if x[0] in ('POST', 'PUT', 'DELETE')])

    def test_existing_secure_datasource_keeps_existing_secure_field(self):
        state = plan(dict(folders=[], dashboards=[], datasources=[{'uid': 'ds', 'name': 'D', 'type': 'prometheus',
              'secureJsonFields': {'httpHeaderValue1': True}}], rules=[]))
        target = DummyClient({('GET?', '/api/datasources/uid/ds'):
                              {'uid': 'ds', 'secureJsonFields': {'httpHeaderValue1': True}},
                             ('PUT', '/api/datasources/uid/ds'): {'uid': 'ds'}})
        sync_all(target, state, Options(dry_run=False))
        payload = [x[2] for x in target.calls if x[0] == 'PUT'][0]
        self.assertNotIn('secureJsonData', payload)

    def test_missing_health_database_fails_before_any_write(self):
        source = DummyClient({('GET', '/api/health'): {'database': 'failed'}})
        target = DummyClient()
        with self.assertRaises(SyncError):
            state = plan(snapshot(source, Options()))
            sync_all(target, state, Options(dry_run=False))
        self.assertEqual(target.calls, [])


if __name__ == '__main__':
    unittest.main()

# Exercises the real urllib client against a local in-process HTTP mock, not Grafana itself.
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from sync.main import GrafanaClient


class HttpApiTests(unittest.TestCase):
    def test_http_headers_json_and_404(self):
        records = []

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                records.append((self.path, self.headers.get('Authorization')))
                if self.path == '/api/not-found':
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"database":"ok"}')

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with patch.dict(os.environ, {'ALLOW_HTTP': 'true'}):
                client = GrafanaClient(f'http://127.0.0.1:{server.server_port}', 'secret123')
                self.assertEqual(client.call('GET', '/api/health')['database'], 'ok')
                self.assertIsNone(client.maybe_get('/api/not-found'))
            self.assertEqual(records, [('/api/health', 'Bearer secret123'),
                                       ('/api/not-found', 'Bearer secret123')])
        finally:
            server.shutdown()
            worker.join(timeout=2)
            server.server_close()

    def test_plain_http_rejected_without_explicit_allow(self):
        with patch.dict(os.environ, {'ALLOW_HTTP': 'false'}):
            with self.assertRaisesRegex(SyncError, 'plain HTTP'):
                GrafanaClient('http://example.com', 'token')
