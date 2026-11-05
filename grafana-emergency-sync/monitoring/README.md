# Reuse existing monitoring

No exporter, extra database, or monitoring service is installed by this project.
The Kubernetes CronJob controller records `.status.lastSuccessfulTime` only when
the sync Job completes successfully. Failed or partially applied runs do not
advance it. Job TTL cleanup does not remove the CronJob's success timestamp.
Keep the supplied CronJob's `DRY_RUN=false`: a dry-run Job would otherwise count
as a successful Kubernetes execution without updating Grafana.

Inspect directly:

```bash
kubectl -n monitoring-emergency get cronjob grafana-emergency-sync \
  -o jsonpath='{.status.lastSuccessfulTime}{"\n"}'
kubectl -n monitoring-emergency get jobs --sort-by=.metadata.creationTimestamp
kubectl -n monitoring-emergency logs job/JOB_NAME
```

Successful runs log `result={...}` with `status`, `dry_run`, `completed_at_unix`,
`duration_seconds`, and processed resource counts. Failed runs exit nonzero.
Only `status=ok` with `dry_run=false` means configuration writes completed;
this does not prove datasource credentials or queries work. Inspect counts after
account/permission changes, and regularly query a critical dashboard.

## Alert rules

If your existing Prometheus/ruler already scrapes kube-state-metrics, load the
`groups` from [alerts.yaml](alerts.yaml) into its rule configuration. With an
existing Prometheus Operator, put these groups into your own `PrometheusRule`.
`deploy.sh` intentionally does not apply this file or install any monitoring stack.

The rules detect:

- Last success older than 15 minutes (two-minute grace).
- A CronJob older than 15 minutes that has **never** succeeded, including when
  kube-state-metrics omits its last-success series.
- Missing CronJob telemetry for ten minutes (deleted CronJob or scrape problem).

Use your existing notification route. Evaluate these rules outside the primary
Grafana/Cloud SQL failure path. If you have no kube-state-metrics, use your
existing Kubernetes monitoring/log system to check the timestamp and nonzero
job exits instead. Verify the last-success metric is actually exposed by your
installed kube-state-metrics version; missing that metric cannot be distinguished
from a never-successful Job by PromQL alone.

For multi-cluster metric aggregation, run these rules per cluster or add your
cluster label to selectors and the `unless on(...)` match keys. If you rename
the namespace or CronJob, update all selectors too.

Validate without deploying anything:

```bash
docker run --rm --entrypoint /bin/promtool \
  -v "$PWD/monitoring:/rules:ro" -w /rules \
  prom/prometheus:v3.5.0 test rules alerts.test.yaml
```

The tests cover recent success, stale success, no previous success, and missing
telemetry. The rule file is not activated merely by running these tests.

Reference: [kube-state-metrics CronJob metrics](https://github.com/kubernetes/kube-state-metrics/blob/main/docs/metrics/workload/cronjob-metrics.md).
