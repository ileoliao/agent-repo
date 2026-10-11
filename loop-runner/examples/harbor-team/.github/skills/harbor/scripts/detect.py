#!/usr/bin/env python3
"""Zero-token check for abnormal HarborSense traffic. Compares the last window with the same window of day
on each of the previous baselineDays days (median of the daily means), per signal in ../config.json.

  detect.py --window 4h --exit-code     -> exit 0 anomalies (JSON on stdout), 1 all clear, 3 check is broken
  detect.py --window 4h                 -> always exit 0 on success (for a human or Chat), 3 when broken

The exit-0 output is self-sufficient: signal, window, current vs baseline, anchors, and the incident file
that already tracks the signal (if any), so the agent does not need to re-run detection.
"""
import argparse
import datetime as dt
import glob
import json
import os
import statistics
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import harbor_client as hc  # noqa: E402


def existing_incident(signal, now):
    for f in sorted(glob.glob(f'.loop/outbox/incidents/*-{signal}.md'), reverse=True):
        if now.timestamp() - os.path.getmtime(f) < 24 * 3600:
            return f.replace('\\', '/')
    return None


def check(cfg, sig, now, window):
    start = now - window
    cur = hc.series(cfg, sig['name'], start, now)
    if not cur:
        return {'gap': f"no data for {sig['name']} in the last window"}
    current = statistics.mean(v for _, v in cur)
    days = []
    for d in range(1, int(sig.get('baselineDays', 7)) + 1):
        shift = dt.timedelta(days=d)
        pts = hc.series(cfg, sig['name'], start - shift, now - shift)
        if pts:
            days.append(statistics.mean(v for _, v in pts))
    if len(days) < cfg.get('minBaselineDays', 3):
        return {'gap': f"only {len(days)} days of baseline for {sig['name']}", 'current': current}
    baseline = statistics.median(days)
    res = {'current': round(current, 4), 'baseline': round(baseline, 4), 'baselineDays': len(days)}
    ratio = current / baseline if baseline else None
    res['ratio'] = round(ratio, 2) if ratio is not None else None
    rule = None
    if baseline >= sig.get('minBaseline', 0) and ratio is not None:
        if ratio >= sig.get('high', float('inf')):
            rule = f"current is {ratio:.1f}x the baseline (limit {sig['high']}x)"
        elif ratio <= sig.get('low', -1):
            rule = f"current is {ratio:.2f}x the baseline (floor {sig['low']}x)"
    if sig.get('absoluteHigh') is not None and current >= sig['absoluteHigh']:
        rule = (rule + '; ' if rule else '') + f"current {current:.4f} is above the absolute limit {sig['absoluteHigh']}"
    res['rule'] = rule
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--window', default='4h')
    ap.add_argument('--now', help='ISO time, for tests')
    ap.add_argument('--exit-code', action='store_true')
    a = ap.parse_args()
    try:
        cfg = hc.load_config()
        now = hc.parse_when(a.now) if a.now else dt.datetime.now(dt.timezone.utc)
        window = dt.timedelta(seconds=hc.parse_duration(a.window))
        anomalies, clear, gaps = [], [], []
        for sig in cfg['signals']:
            r = check(cfg, sig, now, window)
            if 'gap' in r:
                gaps.append(r['gap'])
                continue
            item = {'signal': sig['name'], 'unit': sig.get('unit'), **{k: r[k] for k in ('current', 'baseline', 'ratio', 'baselineDays')}}
            if r['rule']:
                item.update({'rule': r['rule'], 'windowStart': (now - window).isoformat(), 'windowEnd': now.isoformat(), 'anchors': {}, 'existingIncident': existing_incident(sig['name'], now)})
                for by in ('client', 'path'):
                    try:
                        item['anchors'][by] = hc.breakdown(cfg, sig['name'], now - window, now, by, 5)
                    except hc.ApiError:
                        pass  # anchors are a bonus; the anomaly stands without them
                anomalies.append(item)
            else:
                clear.append(item)
    except (hc.ConfigError, hc.ApiError) as e:
        print(f'harbor: {e}', file=sys.stderr)
        return 3
    except Exception as e:  # a broken check must say so, not look like "all clear"
        print(f'harbor: unexpected {type(e).__name__}: {e}', file=sys.stderr)
        return 3
    out = {'checkedAt': now.isoformat(), 'window': a.window, 'anomalies': anomalies, 'clear': clear, 'dataGaps': gaps}
    print(json.dumps(out, ensure_ascii=False, indent=1))
    if a.exit_code:
        return 0 if anomalies else 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
