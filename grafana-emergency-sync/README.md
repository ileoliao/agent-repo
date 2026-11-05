# Grafana Emergency Sync — GKE / Single Region / Three Zones

An independent **always-on emergency Grafana** that can display dashboards when the primary Grafana's Cloud SQL HA failover stalls. The primary Grafana and Cloud SQL HA stay unchanged. A Python CronJob **copies configuration** in one direction via HTTP APIs; the emergency Grafana stores its own metadata in SQLite on a zonal GKE Persistent Disk.

**What this delivers:** source-to-emergency synchronization of folders, dashboards, data sources, and Grafana-managed alert rules; a Grafana Deployment+PVC+Service and a 5-minute CronJob. No write calls go to the primary Grafana, no destination resources are deleted, and an unhealthy primary database causes the job to abort without changing the emergency environment.

**What it does not deliver automatically:** notification contact points or policies, alert group evaluation intervals, user accounts and permissions, plugin installation, SSO configuration, secrets from the source, alert silences, historical alert state, automatic traffic switching or automatic failover/failback. These are not reliably obtainable via a naive API copy. Emergency alerts **remain disabled** until you deliberately activate them and have fenced the primary alert sender. Dashboards can be viewed immediately at the independent emergency endpoint, provided underlying data sources are reachable.

**Compatibility:** uses the Grafana legacy HTTP endpoints for dashboards/folders/datasources and the Alerting Provisioning API, supported by recent Grafana releases (legacy routes are being deprecated in Grafana 13). Run the **same Grafana version and plugins** in both instances. Validate compatibility on staging, particularly alert rule formats and nested folders.

## Architecture

Local Docker validation and repeatable integration checks: [e2e/README.md](e2e/README.md).

```text
                     Same GCP region
  Zone A                           Zone B                 Zone C
  +---------------------+          +----------------+     +---------------------------------+
  | Primary Grafana     |          | Cloud SQL      |     | Emergency Grafana (1 Pod)       |
  | Cloud SQL Primary   |<--HA---->| Standby        |     | SQLite / Zonal PVC              |
  +----------+----------+          +----------------+     +------------------+--------------+
             |                                          independent| ^
             | Read Grafana APIs                                  | | Upsert Grafana APIs
             +-----------------------------------------+          | |
                                                       |          | |
                                           Sync CronJob, Zone C --+-+
                                              every 5 minutes

 Both Grafanas query the same reachable Prometheus / Loki / Tempo endpoints.
 Normal use: primary Grafana. On Cloud SQL incident: independent emergency URL.
```

## Quick start on GKE

Requirements: an existing regional GKE cluster with nodes in Zone C; access to Artifact Registry; the primary Grafana API reachable from Zone C; `kubectl`, `docker`, and `python3` installed locally; RBAC to create resources in a namespace. The example uses `standard-rwo` (CSI PD) and a **single Pod with a zonal disk**. It deliberately does NOT attempt cross-zone SQLite volume migration.

### 1. Set deployment variables

```bash
export GCP_ZONE_C=asia-east1-c                    # Replace with your actual independent Zone
export GRAFANA_IMAGE=grafana/grafana:12.2.0       # Pin to EXACTLY the primary Grafana version
export SYNC_IMAGE=asia-east1-docker.pkg.dev/MY_PROJECT/MY_REPO/grafana-emergency-sync:v1
export SOURCE_GRAFANA_URL=https://grafana-primary.example.com
export EMERGENCY_GRAFANA_ROOT_URL=https://grafana-emergency.example.com/
export EMERGENCY_ADMIN_PASSWORD='YOUR_STRONG_PASSWORD'   # preferably read interactively
```

`SOURCE_GRAFANA_URL` must be reachable from the GKE CronJob, and may be internal. Source should use HTTPS; target uses in-cluster HTTP, enabled explicitly in the supplied CronJob. No public endpoint is provisioned by default.

### 2. Build the sync image and bootstrap the emergency Grafana

```bash
./scripts/build-and-push.sh
./scripts/bootstrap-admin.sh
# First create emergency resources: running the full script temporarily creates a
# CronJob whose early runs can fail until you create the tokens in the next step.
./scripts/deploy.sh
kubectl -n monitoring-emergency rollout status deployment/emergency-grafana
kubectl -n monitoring-emergency port-forward service/emergency-grafana 3000:3000
```

Open `http://localhost:3000` in a browser (in another terminal), sign in with your admin credentials, create an **emergency service account** with sufficient permissions, and generate a token. Independently create a **read-only or scoped service account** in the primary Grafana covering folders, dashboards, datasources and alert rules. Admin privileges can simplify the initial POC but should be tightened before production.

The primary Grafana service account must have access to all dashboards/folders to be synchronized. API search obeys Grafana permissions; inaccessible dashboards do not appear. The target service account needs write access. The scripts assume organization 1; multi-org syncing is out of scope.

### 3. Provide the tokens and data-source credentials

```bash
export PRIMARY_GRAFANA_TOKEN='SOURCE_TOKEN'
export EMERGENCY_GRAFANA_TOKEN='DESTINATION_TOKEN'
# An empty map is fine if all data sources are public and require no secret.
# For secured data sources, create a protected JSON file mapping each datasource UID
# to its secret fields (e.g., httpHeaderValue1, basicAuthPassword).
# export DATASOURCE_SECRETS_JSON_FILE=/private/path/datasources.json
./scripts/create-secrets.sh
```

The optional file's JSON schema is illustrated in `examples-datasource-secrets.json` (dummy values only). **Grafana does not return saved secrets in plaintext.** You must provide missing secrets from your own secret store and configure credentials for authentication/SSO separately. A source data source with a secure field will fail the sync until its secret is available on the emergency data source (or injected for creation), protecting against a silently broken replica.

Store credentials in Kubernetes Secrets (the examples show the minimal mechanism) and restrict their access with RBAC and optionally GCP Secret Manager / External Secrets. Do not commit real values or pass them in Git.

### 4. Force one sync and inspect results

```bash
kubectl -n monitoring-emergency create job --from=cronjob/grafana-emergency-sync sync-first-run
kubectl -n monitoring-emergency wait --for=condition=complete job/sync-first-run --timeout=240s
kubectl -n monitoring-emergency logs job/sync-first-run
```

Successful log output resembles:

```text
INFO result={"status": "ok", "dry_run": false, "folders": 3, "datasources": 4, "dashboards": 25, "alert_rules": 8}
WARNING Alert notification routing, contact points, group intervals, and secrets must be configured separately
```

The counts indicate processed resources, not necessarily changed resources. The job is idempotent for UIDs and uses dashboard `overwrite=true`; it does not remove emergency-only resources.

### 5. Provide a **separate, independently reachable** emergency URL

Integrate `service/emergency-grafana:3000` with your approved internal GKE Ingress/Gateway or internal HTTPS load balancer, preferably requiring company SSO or private-network authorization. Do not reuse the primary Grafana entry point or route through primary-only proxies. The starter manifests intentionally do not expose an open public LoadBalancer. Configure the emergency Grafana's data sources, plugins, and SSO to match your operational requirements. Network routes to Prometheus/Loki/Tempo must survive the cloud incident being planned for.

### 6. Alerting activation runbook (manual by design)

Emergency Grafana runs with `GF_UNIFIED_ALERTING_EXECUTE_ALERTS=false`; copying rules is not the same as activating notifications. Before relying on it for alerts:

1. Provision/test the **contact points, notification policy tree, mute timings, rule-group intervals, and any secrets** on the emergency Grafana. Those components are not auto-synchronized by this project.
2. During an incident, confirm the primary is **fenced or cannot send notifications**. This avoids duplicate or conflicting alerts after recovery.
3. Enable alert evaluation on the emergency instance (requires a Pod restart):

```bash
kubectl -n monitoring-emergency set env deployment/emergency-grafana GF_UNIFIED_ALERTING_EXECUTE_ALERTS=true
kubectl -n monitoring-emergency rollout status deployment/emergency-grafana
```

After restoring the primary, disable emergency alert evaluation and **restart** the emergency Pod; ensure only one environment sends notifications. This is manual and is not a zero-interruption alert failover mechanism. Alert rules whose `isPaused=true` on the primary remain paused on the emergency. Grafana-managed alert rules are covered; data-source-managed alert rules require separate design.

### Dry-run locally

```bash
export SOURCE_GRAFANA_URL=https://primary.example.com
export TARGET_GRAFANA_URL=https://emergency.example.com
export SOURCE_GRAFANA_TOKEN=... TARGET_GRAFANA_TOKEN=...
export DRY_RUN=true
python3 -m sync.main
```

Dry-run still reads from **both** APIs and verifies access, destination UID matches, and data-source secret requirements, but does not write to Grafana. Default is dry-run unless explicitly set to false.

## Safety behavior

- **Read-all-first:** source database health and the requested source configuration snapshot must be readable before the first destination write. An API timeout/403/500 stops the run.
- **No deletes:** the sync never calls a destination DELETE API. Incomplete snapshots cannot wipe existing emergency dashboards.
- **One-way:** no writes to the source Grafana; source and target URLs must differ.
- **Secret safety:** API credentials are read from secrets; tokens and JSON payloads are not logged. Any TLS certificate issues are fatal (no TLS verification bypass).
- **Only eventual consistency:** with a five-minute schedule, latest changes might be missing when a failure begins. A job can also partially apply updates on a write failure; the next successful run converges. There is no cross-resource transaction.
- **Dangerous config drift:** dashboards created directly on the emergency side may be overwritten if their UID matches a primary dashboard. Dedicate the emergency instance to this workflow.
- **Data source secrets:** the encrypted values are never returned in plaintext by Grafana. This project cannot automatically copy them from the primary. Plugin-specific auth/JSON fields may require additional manual setup.
- **Alerting limitations:** the standard Alerting Provisioning API is being deprecated. Source and target versions may require adjustments. Contact points, notification policies, alert group evaluation intervals, and alert runtime state are not synced, so validate on staging before relying on emergency notifications.
- **Independent but not HA:** single-Pod SQLite emergency Grafana can itself fail with Zone C; the solution specifically protects the observability interface during Cloud SQL / Zone A/B incidents, not against all failures. Keep primary HA.

## Test

```bash
python3 -m unittest discover -s tests -v
```

Tests mock Grafana HTTP API operations. They cover stale primary detection, pagination checks, folder ordering, UID preservation, dry-run, data-source secret checks, and nondeletion behavior. They do **not** constitute live Grafana version compatibility or GKE integration tests. Run a staging smoke test and a simulated primary Cloud SQL outage before production.

## Official API references

- https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/
- https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/data_source/
- https://grafana.com/docs/grafana/latest/developer-resources/api-reference/http-api/api-legacy/folder_dashboard_search/
- https://grafana.com/docs/grafana/latest/alerting/set-up/provision-alerting-resources/http-api-provisioning/
- https://grafana.com/docs/grafana/latest/setup-grafana/configure-grafana/
