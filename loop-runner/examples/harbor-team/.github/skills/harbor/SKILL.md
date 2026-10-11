---
name: harbor
description: Check production HarborSense traffic against its own baseline, and query metrics and traffic breakdowns during an investigation. Read-only.
---
# HarborSense traffic (read-only)

Two scripts. Credentials (`HARBOR_PAT`) come from the environment; never print or ask for them.

## detect.py: is the traffic abnormal?

```
python3 .github/skills/harbor/scripts/detect.py --window 4h
```

Compares the last window with the same window of day on each of the previous days, per signal in `config.json` (request rate, error rate by default). Prints JSON with `anomalies` (signal, current vs baseline, the rule that fired, `windowStart`, `windowEnd`, `anchors` such as top clients and paths, and `existingIncident` when an incident file for that signal is already open in the last 24 hours), `clear`, and `dataGaps` (signals it could not judge for lack of data).

With `--exit-code` it exits 0 when there are anomalies, 1 when all clear, 3 when the check itself is broken. Scheduled runs use that form; you normally receive its output as context and should not run it again.

## query.py: look closer during an investigation

```
python3 .github/skills/harbor/scripts/query.py series --signal request_rate --from <ISO> --to <ISO>
python3 .github/skills/harbor/scripts/query.py breakdown --signal request_rate --from <ISO> --to <ISO> --by client --limit 10
```

`series` gives min, max, mean, median, the time of the peak and at most 48 sample points. `breakdown` lists the top contributors (`--by client`, `path` or `status`). Use a window around the anomaly and the same window on earlier days to compare. Times are ISO 8601 (UTC if no offset) or epoch seconds.

Exit codes: 0 ok, 2 bad arguments or configuration, 3 HarborSense unreachable or erroring. On 2 or 3, report it; do not substitute guesses.
