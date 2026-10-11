#!/usr/bin/env python3
"""Read-only HarborSense queries for an investigation.

  query.py series    --signal request_rate --from 2026-10-12T00:00:00Z --to 2026-10-12T09:00:00Z
  query.py breakdown --signal request_rate --from ... --to ... --by client|path|status [--limit 10]

`series` prints summary statistics and at most 48 evenly spaced points, not the raw data.
Exit codes: 0 ok, 2 bad arguments or configuration, 3 HarborSense unreachable or erroring.
"""
import argparse
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harbor_client as hc  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name in ('series', 'breakdown'):
        p = sub.add_parser(name)
        p.add_argument('--signal', required=True)
        p.add_argument('--from', dest='start', required=True)
        p.add_argument('--to', dest='end', required=True)
        if name == 'breakdown':
            p.add_argument('--by', required=True)
            p.add_argument('--limit', type=int, default=10)
    a = ap.parse_args()
    try:
        cfg = hc.load_config()
        start, end = hc.parse_when(a.start), hc.parse_when(a.end)
        if a.cmd == 'series':
            pts = hc.series(cfg, a.signal, start, end)
            if not pts:
                print(json.dumps({'signal': a.signal, 'points': 0}))
                return 0
            vals = [v for _, v in pts]
            keep = pts if len(pts) <= 48 else [pts[int(i * (len(pts) - 1) / 47)] for i in range(48)]
            print(json.dumps({'signal': a.signal, 'from': start.isoformat(), 'to': end.isoformat(), 'points': len(pts),
                              'min': min(vals), 'max': max(vals), 'mean': round(statistics.mean(vals), 4), 'median': statistics.median(vals),
                              'peakAt': hc.dt.datetime.fromtimestamp(max(pts, key=lambda p: p[1])[0], hc.dt.timezone.utc).isoformat(),
                              'sample': [[int(t), round(v, 4)] for t, v in keep]}, ensure_ascii=False))
        else:
            print(json.dumps({'signal': a.signal, 'by': a.by, 'items': hc.breakdown(cfg, a.signal, start, end, a.by, a.limit)}, ensure_ascii=False))
    except (hc.ConfigError, ValueError) as e:
        print(f'harbor: {e}', file=sys.stderr)
        return 2
    except hc.ApiError as e:
        print(f'harbor: {e}', file=sys.stderr)
        return 3
    return 0


if __name__ == '__main__':
    sys.exit(main())
