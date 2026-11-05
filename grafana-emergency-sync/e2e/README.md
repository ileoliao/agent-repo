# Local Docker integration test

Run from the `grafana-emergency-sync` directory with Docker Compose and Python 3.11+:

```bash
python3 e2e/run.py
```

Start with empty test volumes. To reset **only this test environment** before a new run:

```bash
docker compose -p grafana-emergency-e2e -f e2e/compose.yaml down -v
```

The script builds the actual sync Dockerfile, creates Grafana service accounts
(Viewer on the source, Admin on the target), seeds real resources, and runs the
sync CLI in a container. Tokens remain in the runner's memory. The checked-in
datasource secret is a dummy fixture. These local admin credentials are for this
isolated test only: `admin` / `local-e2e-only`.

After success, both Grafanas and Prometheus remain running for inspection:

- Primary: http://localhost:13701
- Emergency: http://localhost:13702/d/e2e-board

The test covers missing-secret preflight, dry run, initial sync, source preservation,
repeat sync without dashboard version churn, updates, preservation of a target-only
folder, source outage, actual Prometheus queries through the emergency datasource,
SQLite persistence across emergency restart, and disabled emergency alert execution.
It restores the primary after the outage exercise. A failed run may leave the
primary stopped; use `docker compose -p grafana-emergency-e2e -f e2e/compose.yaml start primary`.

## Recorded run — 2026-11-05

All 9 integration checks passed; see [results.json](results.json).
All 17 unit tests passed inside the Python 3.12 sync container.

Docker Desktop engine: 27.5.1, linux/amd64. Both Grafanas: **11.4.0**.
Prometheus: **v3.5.0**. Python: **3.12.16**.

Grafana 12.2.0 and the stock Python image could not be downloaded: Docker Hub and
two mirrors repeatedly returned EOF or retried layers. This run used cached
images via the following overrides:

```bash
GRAFANA_IMAGE=grafana/grafana:11.4.0 PYTHON_IMAGE=harbor-extensions:sim python3 e2e/run.py
```

The cached Python base provided Python 3.12.16; the project's Dockerfile still
copies the real sync code, replaces its entrypoint, and runs as UID 65532.
The defaults remain Grafana 12.2.0 and python:3.12-slim for future reruns.

### Bug found and fixed

Grafana's `/api/datasources` response omitted `secureJsonFields` even for the admin.
The original sync therefore treated a secured source as public and created a
destination without its credential. Snapshot now fetches each datasource by UID
before performing destination writes. With this fix, a missing credential aborts
before folder creation, and supplying the fixture allows a successful sync.
A unit regression test covers the collection/detail response difference.

### Scope

Both local Grafanas use separate SQLite volumes. The outage exercise stops the
primary container; it does not reproduce a real Cloud SQL HA failover. GKE zone
placement, Persistent Disk attachment, Kubernetes CronJob scheduling, ingress/SSO,
production datasource credentials, Grafana 12.2.0 compatibility, and notification
delivery still require validation in the intended deployment environment.
