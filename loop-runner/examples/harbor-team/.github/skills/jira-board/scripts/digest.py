#!/usr/bin/env python3
"""Digest of a Jira board for the daily team brief. Prints one small JSON document.

All counting and comparing happens here, so the model only has to write the story.
Exit codes: 0 ok, 2 configuration or credentials problem, 3 Jira unreachable or erroring (reason on stderr).
"""
import argparse
import datetime as dt
import glob
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jira_client as jc  # noqa: E402

CAT = {'new': 'todo', 'indeterminate': 'doing', 'done': 'done'}


def parse_ts(s):
    if not s:
        return None
    s = re.sub(r'\.\d+', '', s).replace('Z', '+0000')
    s = re.sub(r'([+-]\d\d):(\d\d)$', r'\1\2', s)
    try:
        return dt.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S%z')
    except ValueError:
        return None


def short(text, n=80):
    text = ' '.join((text or '').split())
    return text if len(text) <= n else text[:n - 1] + '…'


def blocked(issue, cfg):
    f = issue['fields']
    labels = {l.lower() for l in f.get('labels') or []}
    if labels & {l.lower() for l in cfg['blockedLabels']}:
        return True
    if (f.get('status') or {}).get('name', '').lower() in [s.lower() for s in cfg['blockedStatuses']]:
        return True
    for link in f.get('issuelinks') or []:
        # "is blocked by": the inward side names the blocker; it only counts while that blocker is open
        inward = link.get('inwardIssue')
        if inward and 'blocked' in (link.get('type', {}).get('inward', '')).lower():
            cat = ((inward.get('fields') or {}).get('status') or {}).get('statusCategory', {}).get('key')
            if cat != 'done':
                return True
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--board')
    ap.add_argument('--now', help='ISO time, for tests')
    ap.add_argument('--snapshot-dir', default='.loop/outbox/briefs/.snapshots')
    ap.add_argument('--no-snapshot', action='store_true')
    a = ap.parse_args()
    try:
        cfg = jc.load_config()
        if a.board:
            cfg['boardId'] = a.board
        now = parse_ts(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
        out = build(cfg, now, a)
    except jc.ConfigError as e:
        print(f'config: {e}', file=sys.stderr)
        return 2
    except jc.ApiError as e:
        print(f'jira: {e}', file=sys.stderr)
        return 3
    print(json.dumps(out, ensure_ascii=False, indent=1))
    return 0


def build(cfg, now, a):
    base = cfg['baseUrl']
    board = jc.get(cfg, f"/rest/agile/1.0/board/{cfg['boardId']}")
    fields = 'summary,status,assignee,priority,duedate,updated,created,resolutiondate,labels,issuelinks,issuetype'
    if cfg.get('storyPointsField'):
        fields += ',' + cfg['storyPointsField']
    sprint = None
    if board.get('type') == 'scrum':
        sprints = jc.paged(cfg, f"/rest/agile/1.0/board/{cfg['boardId']}/sprint", {'state': 'active'}, 'values')
        if sprints:
            sprint = sprints[0]
            issues = jc.paged(cfg, f"/rest/agile/1.0/sprint/{sprint['id']}/issue", {'fields': fields}, 'issues')
        else:
            issues = []
    else:
        jql = 'statusCategory != Done OR resolutiondate >= -7d'
        issues = jc.paged(cfg, f"/rest/agile/1.0/board/{cfg['boardId']}/issue", {'fields': fields, 'jql': jql}, 'issues')

    today = now.astimezone().date() if now.tzinfo else now.date()
    stale_cut = now - dt.timedelta(days=cfg['staleDays'])
    soon = today + dt.timedelta(days=cfg['dueSoonDays'])
    sp_field = cfg.get('storyPointsField')

    rows, by_assignee = {}, {}
    totals = {'todo': 0, 'doing': 0, 'done': 0}
    points = {'done': 0.0, 'all': 0.0}
    risks = {'blocked': [], 'overdue': [], 'dueSoon': [], 'stale': []}
    done_24h = []
    unassigned_open = 0

    def ref(i, extra=None):
        f = i['fields']
        r = {'key': i['key'], 'summary': short(f.get('summary')), 'status': (f.get('status') or {}).get('name'),
             'assignee': (f.get('assignee') or {}).get('displayName'), 'url': f'{base}/browse/{i["key"]}'}
        r.update(extra or {})
        return r

    for i in issues:
        f = i['fields']
        cat = CAT.get(((f.get('status') or {}).get('statusCategory') or {}).get('key'), 'todo')
        name = (f.get('assignee') or {}).get('displayName') or 'Unassigned'
        is_blocked = cat != 'done' and blocked(i, cfg)
        rows[i['key']] = {'cat': cat, 'blocked': is_blocked, 'status': (f.get('status') or {}).get('name')}
        totals[cat] += 1
        pts = float(f.get(sp_field) or 0) if sp_field else 0.0
        points['all'] += pts
        if cat == 'done':
            points['done'] += pts
            rd = parse_ts(f.get('resolutiondate'))
            if rd and now - rd <= dt.timedelta(hours=24):
                done_24h.append(ref(i))
        a_row = by_assignee.setdefault(name, {'todo': 0, 'doing': 0, 'done': 0, 'blocked': 0})
        a_row[cat] += 1
        if cat != 'done':
            if name == 'Unassigned':
                unassigned_open += 1
            if is_blocked:
                a_row['blocked'] += 1
                risks['blocked'].append(ref(i))
            due = f.get('duedate')
            if due:
                d = dt.date.fromisoformat(due)
                if d < today:
                    risks['overdue'].append(ref(i, {'due': due, 'daysLate': (today - d).days}))
                elif d <= soon:
                    risks['dueSoon'].append(ref(i, {'due': due}))
            upd = parse_ts(f.get('updated'))
            if cat == 'doing' and upd and upd < stale_cut:
                risks['stale'].append(ref(i, {'daysSinceUpdate': (now - upd).days}))

    total = sum(totals.values())
    sprint_info = None
    if sprint:
        s0, s1 = parse_ts(sprint.get('startDate')), parse_ts(sprint.get('endDate'))
        sprint_info = {'name': sprint.get('name'), 'goal': short(sprint.get('goal'), 120), 'start': sprint.get('startDate'), 'end': sprint.get('endDate')}
        if s0 and s1 and s1 > s0:
            elapsed = max(0.0, min(1.0, (now - s0) / (s1 - s0)))
            done_ratio = totals['done'] / total if total else 0
            sprint_info.update({'daysLeft': max(0, (s1 - now).days), 'percentElapsed': round(elapsed * 100),
                                'percentDoneByCount': round(done_ratio * 100),
                                'behindSchedule': done_ratio * 100 < elapsed * 100 - 15})

    # Compare with the previous snapshot (the last file dated before today).
    prev, prev_date = None, None
    os.makedirs(a.snapshot_dir, exist_ok=True)
    for f in sorted(glob.glob(os.path.join(a.snapshot_dir, '*.json'))):
        d = os.path.basename(f)[:-5]
        if d < today.isoformat():
            prev, prev_date = f, d
    delta = None
    if prev:
        with open(prev, encoding='utf-8') as fh:
            old = json.load(fh)['issues']
        delta = {'since': prev_date,
                 'newlyDone': [k for k, v in rows.items() if v['cat'] == 'done' and old.get(k, {}).get('cat') not in (None, 'done')],
                 'newlyBlocked': [k for k, v in rows.items() if v['blocked'] and not old.get(k, {}).get('blocked')],
                 'added': [k for k in rows if k not in old],
                 'removed': [k for k in old if k not in rows]}
    if not a.no_snapshot:
        with open(os.path.join(a.snapshot_dir, today.isoformat() + '.json'), 'w', encoding='utf-8') as fh:
            json.dump({'date': today.isoformat(), 'issues': rows}, fh)

    n = cfg['topN']
    return {
        'date': today.isoformat(), 'generatedAt': now.isoformat(), 'board': {'id': cfg['boardId'], 'name': board.get('name'), 'type': board.get('type')},
        'sprint': sprint_info, 'totals': {**totals, 'all': total, 'unassignedOpen': unassigned_open, 'doneLast24h': len(done_24h)},
        'storyPoints': points if sp_field else None,
        'byAssignee': dict(sorted(by_assignee.items(), key=lambda kv: -(kv[1]['doing'] + kv[1]['todo']))[:15]),
        'risks': {k: v[:n] for k, v in risks.items()}, 'riskCounts': {k: len(v) for k, v in risks.items()},
        'doneLast24h': done_24h[:n], 'delta': delta,
    }


if __name__ == '__main__':
    sys.exit(main())
