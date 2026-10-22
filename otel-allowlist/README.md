# otel-allowlist: only registered services reach the observability backends

The OTel Collector drops traces, metrics and logs from any `service.name` that is not on a reviewed list. It runs on the **official otelcol-contrib image** with the stock `filter` processor: no custom Collector build.

People maintain one file, `services.txt` (one service per line). A script turns it into a regex; the Collector reads that regex from a ConfigMap and is rolled when the list changes.

## How it works

1. `services.txt` changes go through a pull request.
2. CI runs `gen_allowlist.py verify` and `release.sh`, which builds the `otel-allowlist` ConfigMap (`services.txt` + `allowlist.regex`) and prints the checksum for Helm.
3. `helm upgrade` with `values.yaml` rolls the Collector: a new pod must be ready before an old one stops.
4. The `filter/allowlist` processor drops every resource whose `service.name` is not an exact, case-sensitive match. Data without `service.name` is dropped too.

## Why a sorted regex

- The list is matched with one `IsMatch` on `^(?:a|b|...)$`. Go's regexp parser merges common prefixes of **adjacent** alternatives, so sorting the list keeps matching fast at any size:

  | 1000 services | Unsorted | Sorted (generated) |
  |---|---|---|
  | One match | 44 µs | 1.5 µs |

  At 3000 services the sorted regex still takes about 1–2.5 µs; unsorted takes about 150–180 µs. Run `cd bench && go test -run XXX -bench .`.
- The conditions only read resource attributes, so each resource is checked once, not every span: 5000 spans from one service took 0.39 ms in the filter.
- The lookup processor would allow a hash lookup but is **not** in the official contrib image (checked against the v0.163.x build manifest and binary).

## Usage

```bash
python3 gen_allowlist.py build  services.txt allowlist.regex   # generate + self-check
python3 gen_allowlist.py verify services.txt allowlist.regex   # CI: regenerate and compare
python3 gen_allowlist.py check  allowlist.regex payments-api    # will this service pass?

./release.sh services.txt allowlist.regex out/                  # ConfigMap + Helm checksum
OTELCOL=/path/to/otelcol-contrib ./e2e/run.sh services.txt allowlist.regex   # end-to-end
```

`services.txt` rules: one name per line, `#` starts a comment, names use only `A-Z a-z 0-9 . _ -`. See `services.example.txt`.

## Files

| Path | What it is |
|---|---|
| `gen_allowlist.py` | Generator and checker, Python standard library only |
| `values.yaml` | Values for the official `opentelemetry-collector` Helm chart |
| `release.sh` | CI steps: verify, build the ConfigMap, print the checksum |
| `e2e/` | Runs an official Collector binary and sends listed, near-miss and unlisted services |
| `tests/` | Generator tests (`python3 -m pytest tests`) and a 1000-service test list |
| `bench/` | Go (RE2) equivalence check and the sorted vs unsorted benchmark |

## Gotchas

- `allowlist.regex` must be the bare regex: no quotes, no trailing newline. `${file:}` pastes the file's raw text into the condition string; it is not parsed as YAML.
- `.` is written as `[.]` so the file has no backslashes to escape in YAML or OTTL strings.
- Default names such as `unknown_service:java` are dropped unless listed.
- Error spans from unregistered services are dropped too. If "always keep errors" must cover them, add a condition.
- A regex that is valid but wrong (a missing service) still passes the readiness probe; only `verify` and list review catch it.
- The image is built `FROM scratch`, so `preStop` uses the native Kubernetes `sleep` action (1.30+), not `exec sleep`.

Verified with Helm chart `opentelemetry-collector` 0.177.0 and otelcol-contrib 0.163.2.
