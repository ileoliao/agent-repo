#!/usr/bin/env python3
"""Migrate FAILED DAG runs (task states + XCom) from Airflow 2.x to Airflow 3.x, REST API only.

What it does, per run:
  1. Reads the run, its task instances and every XCom of the SUCCESS tasks from the Airflow 2 API (v1).
  2. Resolves each XCom back to a typed Python value (see "Type recovery" below) and builds a plan.
  3. In Airflow 3 (API v2): pauses the DAG, creates the run with the same run_id / logical_date /
     data_interval / conf, marks the SUCCESS tasks as success, writes their XComs, then reads every
     XCom back and compares it with exact types.
  4. Leaves the DAG PAUSED. Unpause it to let the scheduler re-run only the unfinished tasks.

Typical use:
  # 1) dry run: prints a compatibility report, writes nothing. In strict mode (default) it stops and
  #    prints a hints snippet if some XCom types cannot be determined from the Airflow 2 API.
  python migrate_failed_run.py --src-url http://af2:8080 --src-user u --src-password p \\
      --dst-url http://af3:8080 --dst-user u --dst-password p \\
      --dag-id my_dag --run-id scheduled__2024-09-30T00:00:00+00:00 --dry-run
  # 2) save the snippet into hints.json, fix the types if needed, then run for real
  python migrate_failed_run.py ... --hints hints.json

Airflow 2 prerequisites:
  - [api] auth_backends includes airflow.api.auth.backend.basic_auth
  - [api] enable_xcom_deserialize_support = True  (otherwise datetimes etc. come back as internal strings)
Airflow 3 prerequisites:
  - the DAG file is deployed and parsed (the script pauses it; it must NOT be running the run yet)
  - auth: --dst-user/--dst-password (POST /auth/token), or --dst-token, or neither for
    SimpleAuthManager with simple_auth_manager_all_admins=True

Type recovery (why hints exist):
  The Airflow 2.9 XCom API returns str(value). Values inside containers come back as repr() and are
  exact (str vs int, None, bool, float, datetime(...), Decimal(...), tuple, set). TOP-LEVEL scalars are
  ambiguous: the int 7 and the string "7" both come back as "7"; likewise "True"/"None", numbers,
  "2024-09-30 08:30:15+00:00" (datetime or str?) and "2024-09-30" (date or str?). Such keys need a hint:
      {"task_id.key": "str"}      also "task_id.*" and "*.key" (no other glob patterns)
      types: str int float bool none decimal datetime date json
  --no-strict guesses instead (the literal type) and only warns.

Type policy in Airflow 3 (its POST xcomEntries accepts plain JSON only; serde forms with
__classname__/__type are rejected with 422). Exact round trip: None, bool, int, float, str, list,
dict with str keys. DOWNGRADED and listed in the report, so DAG code must parse them:
    datetime/date/time -> ISO 8601 str   Decimal -> str   timedelta -> total seconds (float)
    tuple -> list   set -> sorted list   UUID -> str   non-str dict keys -> str   other objects -> str
"""
import argparse
import ast
import datetime as dt
import decimal
import json
import re
import sys
import time
import uuid

SKIP_KEYS_DEFAULT = "skipmixin_key,_skipmixin"
HINT_TYPES = ("str", "int", "float", "bool", "none", "decimal", "datetime", "date", "json")
EXIT_OK, EXIT_VERIFY_FAILED, EXIT_BLOCKED = 0, 1, 2


def log(*a):
    print(*a, flush=True)


# ====================================================================== safe repr parser
class _Unparseable(Exception):
    pass


def _tz(name=None, *a, **kw):
    if name in (None, "UTC", "utc", "Etc/UTC", "+00:00"):
        return dt.timezone.utc
    try:
        from zoneinfo import ZoneInfo
        return ZoneInfo(name)
    except Exception as e:  # pragma: no cover
        raise _Unparseable(f"unknown timezone {name!r}") from e


def _fixed_tz(offset, *a, **kw):
    secs = offset.total_seconds() if isinstance(offset, dt.timedelta) else float(offset)
    return dt.timezone(dt.timedelta(seconds=secs))


def _datetime(*a, **kw):
    return dt.datetime(*a, **kw)


def _date(*a, **kw):
    return dt.date(*a, **kw)


# Constructors that appear in repr() of values Airflow 2 deserialized (stdlib + pendulum names).
_CALLS = {
    "datetime.datetime": _datetime, "datetime": _datetime, "DateTime": _datetime,
    "pendulum.DateTime": _datetime,
    "datetime.date": _date, "date": _date, "Date": _date, "pendulum.Date": _date,
    "datetime.time": dt.time, "time": dt.time, "Time": dt.time,
    "datetime.timedelta": dt.timedelta, "timedelta": dt.timedelta, "Duration": dt.timedelta,
    "datetime.timezone": lambda off=None, *a, **k: dt.timezone.utc if off is None else _fixed_tz(off),
    "timezone": lambda off=None, *a, **k: dt.timezone.utc if off is None else _fixed_tz(off),
    "Timezone": _tz, "pendulum.Timezone": _tz, "zoneinfo.ZoneInfo": _tz, "ZoneInfo": _tz,
    "FixedTimezone": _fixed_tz, "pendulum.tz.timezone.FixedTimezone": _fixed_tz,
    "Decimal": decimal.Decimal, "decimal.Decimal": decimal.Decimal,
    "UUID": uuid.UUID, "uuid.UUID": uuid.UUID,
    "set": set, "frozenset": frozenset,
}
_ATTRS = {"datetime.timezone.utc": dt.timezone.utc, "timezone.utc": dt.timezone.utc,
          "UTC": dt.timezone.utc, "pendulum.UTC": dt.timezone.utc}


def _dotted(node):
    parts = []
    while isinstance(node, ast.Attribute):
        parts.append(node.attr)
        node = node.value
    if isinstance(node, ast.Name):
        parts.append(node.id)
        return ".".join(reversed(parts))
    raise _Unparseable("unsupported expression")


def _ev(node):
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.List):
        return [_ev(x) for x in node.elts]
    if isinstance(node, ast.Tuple):
        return tuple(_ev(x) for x in node.elts)
    if isinstance(node, ast.Set):
        return {_ev(x) for x in node.elts}
    if isinstance(node, ast.Dict):
        if any(k is None for k in node.keys):
            raise _Unparseable("dict unpacking")
        return {_ev(k): _ev(v) for k, v in zip(node.keys, node.values)}
    if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.USub, ast.UAdd)):
        v = _ev(node.operand)
        if not isinstance(v, (int, float)):
            raise _Unparseable("unary op on non-number")
        return -v if isinstance(node.op, ast.USub) else v
    if isinstance(node, (ast.Name, ast.Attribute)):
        name = _dotted(node)
        if name in _ATTRS:
            return _ATTRS[name]
        if name in ("nan", "inf"):
            return float(name)
        raise _Unparseable(f"unknown name {name}")
    if isinstance(node, ast.Call):
        name = _dotted(node.func)
        fn = _CALLS.get(name)
        if fn is None:
            raise _Unparseable(f"unknown constructor {name}")
        args = [_ev(a) for a in node.args]
        kwargs = {k.arg: _ev(k.value) for k in node.keywords if k.arg}
        if "tzinfo" in kwargs and kwargs["tzinfo"] is not None and not isinstance(kwargs["tzinfo"], dt.tzinfo):
            raise _Unparseable("bad tzinfo")
        kwargs.pop("fold", None) if name in ("DateTime", "pendulum.DateTime") else None
        try:
            return fn(*args, **kwargs)
        except Exception as e:
            raise _Unparseable(f"{name}(...) failed: {e}") from e
    raise _Unparseable(f"unsupported node {type(node).__name__}")


def safe_eval(text):
    """Evaluate a Python repr() made of literals and a whitelist of date/decimal/uuid constructors."""
    try:
        tree = ast.parse(text.strip(), mode="eval")
    except (SyntaxError, ValueError) as e:
        raise _Unparseable("not a Python literal") from e
    return _ev(tree.body)


# ====================================================================== type recovery for top-level values
_DT_RE = re.compile(r"^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?([+-]\d{2}:?\d{2}|Z)?$")
_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def recover(raw):
    """raw str from the Airflow 2 API -> (value, candidate_types or None if unambiguous, note)."""
    try:
        v = safe_eval(raw)
    except _Unparseable:
        v = _Unparseable
    if v is not _Unparseable:
        if isinstance(v, (dict, list, tuple, set, frozenset)):
            return v, None, ""
        if isinstance(v, str):
            return raw, None, ""  # str(some_str) is the string itself
        if isinstance(v, bool):
            return v, ["bool", "str"], ""
        if v is None:
            return None, ["none", "str"], ""
        if isinstance(v, int):
            return v, ["int", "str", "decimal", "float"], ""
        if isinstance(v, float):
            return v, ["float", "str", "decimal"], ""
        return v, None, ""
    if _DT_RE.match(raw):
        try:
            return dt.datetime.fromisoformat(raw.replace("Z", "+00:00")), ["datetime", "str"], ""
        except ValueError:
            pass
    if _DATE_RE.match(raw):
        try:
            return dt.date.fromisoformat(raw), ["date", "str"], ""
        except ValueError:
            pass
    note = "looks like str() of a non-literal object" if re.match(r"^<.* at 0x[0-9a-f]+>$", raw) else ""
    return raw, None, note


def apply_hint(raw, hint):
    if hint == "str":
        return raw
    if hint == "int":
        return int(raw)
    if hint == "float":
        return float(raw)
    if hint == "bool":
        if raw not in ("True", "False"):
            raise ValueError(f"{raw!r} is not a bool")
        return raw == "True"
    if hint == "none":
        return None
    if hint == "decimal":
        return decimal.Decimal(raw)
    if hint == "datetime":
        return dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    if hint == "date":
        return dt.date.fromisoformat(raw)
    if hint == "json":
        return safe_eval(raw)
    raise ValueError(f"unknown hint type {hint!r}")


def find_hint(hints, task_id, key):
    # Only three forms, most specific first. No glob patterns: "task.s*" would silently catch "task.set".
    for pat in (f"{task_id}.{key}", f"{task_id}.*", f"*.{key}"):
        if pat in hints:
            return hints[pat]
    return None


# ====================================================================== Airflow 3 type policy
def to_json(v, path, downgrades):
    """Python value -> plain JSON value accepted by Airflow 3, recording any lossy conversion."""
    def note(to, extra=""):
        downgrades.append({"path": path or "$", "from": type(v).__name__, "to": to, "note": extra})

    if v is None or isinstance(v, (bool, int, str)):
        return v
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            note("str", "nan/inf is not valid JSON")
            return repr(v)
        return v
    if isinstance(v, (dt.datetime, dt.date, dt.time)):
        note("str", "ISO 8601")
        return v.isoformat()
    if isinstance(v, dt.timedelta):
        note("float", "total seconds")
        return v.total_seconds()
    if isinstance(v, (decimal.Decimal, uuid.UUID)):
        note("str")
        return str(v)
    if isinstance(v, list):
        return [to_json(x, f"{path}[{i}]", downgrades) for i, x in enumerate(v)]
    if isinstance(v, tuple):
        note("list")
        return [to_json(x, f"{path}[{i}]", downgrades) for i, x in enumerate(v)]
    if isinstance(v, (set, frozenset)):
        note("list", "sorted")
        items = sorted(v, key=lambda x: (type(x).__name__, repr(x)))
        return [to_json(x, f"{path}[{i}]", downgrades) for i, x in enumerate(items)]
    if isinstance(v, dict):
        out = {}
        for k, x in v.items():
            if not isinstance(k, str):
                downgrades.append({"path": path or "$", "from": f"dict key {type(k).__name__}", "to": "str", "note": ""})
            out[str(k)] = to_json(x, f"{path}.{k}", downgrades)
        return out
    note("str")
    return str(v)


def strict_eq(a, b):
    """Deep equality including exact types (1 != 1.0 != True != "1")."""
    if type(a) is not type(b):
        return False
    if isinstance(a, dict):
        return a.keys() == b.keys() and all(strict_eq(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return len(a) == len(b) and all(strict_eq(x, y) for x, y in zip(a, b))
    return a == b


# ====================================================================== REST
class Api:
    def __init__(self, base, prefix, auth=None, token=None, verify_tls=True):
        import requests
        self.base = base.rstrip("/") + prefix
        self.s = requests.Session()
        self.s.verify = verify_tls
        if auth:
            self.s.auth = auth
        if token:
            self.s.headers["Authorization"] = f"Bearer {token}"

    def req(self, method, path, ok=(200, 201, 204), quiet=(), **kw):
        r = self.s.request(method, self.base + path, timeout=60, **kw)
        if r.status_code not in ok and r.status_code not in quiet:
            log(f"  !! {method} {path} -> HTTP {r.status_code}: {r.text[:400]}")
        return r

    def paged(self, path, key, params=None, limit=100):
        out, off = [], 0
        while True:
            r = self.req("GET", path, params=dict(params or {}, limit=limit, offset=off))
            r.raise_for_status()
            j = r.json()
            out += j[key]
            off += limit
            if off >= j.get("total_entries", 0) or not j[key]:
                return out


def dst_token(args):
    import requests
    if args.dst_token:
        return args.dst_token
    b = args.dst_url.rstrip("/")
    if args.dst_user:
        r = requests.post(b + "/auth/token", json={"username": args.dst_user, "password": args.dst_password},
                          timeout=30, verify=not args.insecure)
    else:  # SimpleAuthManager with simple_auth_manager_all_admins=True
        r = requests.get(b + "/auth/token", timeout=30, verify=not args.insecure)
    r.raise_for_status()
    return r.json()["access_token"]


def q(s):
    from urllib.parse import quote
    return quote(s, safe="")


# ====================================================================== read source run
def read_source(src, dag_id, run_id, skip, hints):
    base = f"/dags/{q(dag_id)}/dagRuns/{q(run_id)}"
    run = src.req("GET", base)
    run.raise_for_status()
    run = run.json()
    tis = src.paged(f"{base}/taskInstances", "task_instances")
    xcoms, skipped, ambiguous, notes, problems = [], [], [], [], []
    deser_disabled = False
    for ti in sorted(tis, key=lambda t: (t["task_id"], t["map_index"])):
        if ti["state"] != "success":
            continue
        if ti["map_index"] != -1:
            problems.append(f"mapped task {ti['task_id']}[{ti['map_index']}] is not supported by this script")
            continue
        tbase = f"{base}/taskInstances/{q(ti['task_id'])}/xcomEntries"
        for e in src.paged(tbase, "xcom_entries"):
            key = e["key"]
            if key in skip:
                skipped.append(f"{ti['task_id']}.{key} (internal key)")
                continue
            u = f"{tbase}/{q(key)}"
            r = src.req("GET", u, ok=(200,), quiet=(400, 500), params={"deserialize": "true"})
            if r.status_code == 400 and "deserialization is disabled" in r.text:
                deser_disabled = True
                r = src.req("GET", u, ok=(200,), quiet=(500,))
            hint = find_hint(hints, ti["task_id"], key)
            ref = f"{ti['task_id']}.{key}"
            if r.status_code == 500 and "None is not of type" in r.text:
                # Airflow 2.9 API cannot render a None XCom value (HTTP 500); the value is None.
                xcoms.append({"task_id": ti["task_id"], "key": key, "value": None, "raw": None})
                notes.append(f"{ref}: source API returned 500 for a None value -> None")
                continue
            r.raise_for_status()
            raw = r.json()["value"]
            if not isinstance(raw, str):
                value, cands = raw, None
            elif hint:
                try:
                    value, cands = apply_hint(raw, hint), None
                except Exception as ex:
                    problems.append(f"{ref}: hint {hint!r} cannot convert {raw!r}: {ex}")
                    continue
            else:
                value, cands, note = recover(raw)
                if note:
                    notes.append(f"{ref}: {note}: {raw[:80]!r}")
            if cands:
                ambiguous.append({"ref": ref, "raw": raw, "candidates": cands, "guess": cands[0]})
            xcoms.append({"task_id": ti["task_id"], "key": key, "value": value, "raw": raw})
    if deser_disabled:
        problems.append("Airflow 2 has [api] enable_xcom_deserialize_support=False: datetimes and other "
                        "serialized objects come back as internal strings. Enable it and restart the webserver.")
    return {"dag_id": dag_id, "run": run, "tis": tis, "xcoms": xcoms, "skipped": skipped,
            "ambiguous": ambiguous, "notes": notes, "problems": problems}


def build_plan(src_data):
    plan, downgrades, types = [], [], {}
    for x in src_data["xcoms"]:
        ds = []
        val = to_json(x["value"], "", ds)
        for d in ds:
            downgrades.append(dict(d, ref=f"{x['task_id']}.{x['key']}"))
        tn = type(x["value"]).__name__
        types[tn] = types.get(tn, 0) + 1
        plan.append({"task_id": x["task_id"], "key": x["key"], "value": val})
    return plan, downgrades, types


# ====================================================================== destination checks
def dst_precheck(dst, src_data, dst_run_id, verify_only=False):
    dag_id = src_data["dag_id"]
    issues = []
    r = dst.req("GET", f"/dags/{q(dag_id)}", ok=(200,), quiet=(404,))
    if r.status_code == 404:
        return [f"DAG {dag_id} is not parsed in Airflow 3 (deploy the DAG file first)"], None
    r.raise_for_status()
    r = dst.req("GET", f"/dags/{q(dag_id)}/tasks")
    r.raise_for_status()
    dst_tasks = {t["task_id"] for t in r.json()["tasks"]}
    src_tasks = {t["task_id"] for t in src_data["tis"]}
    missing = sorted(src_tasks - dst_tasks)
    if missing:
        issues.append("tasks missing in the Airflow 3 DAG: " + ", ".join(missing))
    extra = sorted(dst_tasks - src_tasks)
    r = dst.req("GET", f"/dags/{q(dag_id)}/dagRuns/{q(dst_run_id)}", ok=(200,), quiet=(404,))
    existing = r.json() if r.status_code == 200 else None
    if verify_only and not existing:
        issues.append(f"run {dst_run_id} does not exist in Airflow 3 (nothing to verify)")
    elif not verify_only and existing and existing["state"] not in ("queued",):
        issues.append(f"run {dst_run_id} already exists in Airflow 3 with state={existing['state']}")
    ld = src_data["run"].get("logical_date") or src_data["run"].get("execution_date")
    if ld and not existing and not verify_only:
        # (dag_id, logical_date) is unique in Airflow 3 as well
        r = dst.req("GET", f"/dags/{q(dag_id)}/dagRuns", params={"logical_date_gte": ld, "logical_date_lte": ld})
        if r.status_code == 200:
            clash = [x["dag_run_id"] for x in r.json()["dag_runs"]]
            if clash:
                issues.append(f"Airflow 3 already has run(s) {', '.join(clash)} with logical_date {ld} "
                              "((dag_id, logical_date) must be unique)")
    return issues, {"extra_tasks": extra, "existing": existing}


# ====================================================================== report
def report(src_data, plan, downgrades, types, dst_info, run_id):
    run = src_data["run"]
    ok_tis = [t for t in src_data["tis"] if t["state"] == "success" and t["map_index"] == -1]
    rest = [t for t in src_data["tis"] if t not in ok_tis]
    log("=" * 72)
    log(f"COMPATIBILITY REPORT  dag={src_data['dag_id']}  run={run_id}")
    log(f"  source run: state={run['state']} logical_date={run.get('logical_date') or run.get('execution_date')}")
    log(f"              data_interval={run.get('data_interval_start')} .. {run.get('data_interval_end')}")
    log(f"              conf={json.dumps(run.get('conf') or {}, ensure_ascii=False)}")
    if run["state"] != "failed":
        log(f"  WARNING: source run state is {run['state']!r}, not 'failed'")
    log(f"  mark SUCCESS ({len(ok_tis)}): " + (", ".join(t["task_id"] for t in ok_tis) or "-"))
    log(f"  left to RE-RUN ({len(rest)}): " + (", ".join(f"{t['task_id']}[{t['state']}]" for t in rest) or "-"))
    if dst_info and dst_info["extra_tasks"]:
        log("  tasks only in Airflow 3 (will run): " + ", ".join(dst_info["extra_tasks"]))
    if dst_info and dst_info["existing"]:
        log("  run already exists in Airflow 3 (queued) -> will be reused")
    log(f"  XComs to write: {len(plan)}   by type: " + ", ".join(f"{k}={v}" for k, v in sorted(types.items())))
    log("  skipped keys: " + (", ".join(src_data["skipped"]) or "none"))
    log(f"  TYPE DOWNGRADES ({len(downgrades)}): DAG code in Airflow 3 must parse these")
    for d in downgrades:
        p = "" if d["path"] == "$" else d["path"]
        log(f"    {d['ref']}{p}: {d['from']} -> {d['to']}" + (f" ({d['note']})" if d["note"] else ""))
    if not downgrades:
        log("    none, every value round-trips exactly")
    if src_data["ambiguous"]:
        log(f"  AMBIGUOUS TOP-LEVEL VALUES ({len(src_data['ambiguous'])}): type cannot be told from the 2.x API")
        for a in src_data["ambiguous"]:
            log(f"    {a['ref']}: raw={a['raw']!r} could be {'/'.join(a['candidates'])} (guess: {a['guess']})")
    for n in src_data["notes"]:
        log("  NOTE:", n)
    for p in src_data["problems"]:
        log("  PROBLEM:", p)
    log("=" * 72)


def hints_snippet(all_ambiguous):
    return json.dumps({a["ref"]: a["guess"] for a in all_ambiguous}, ensure_ascii=False, indent=2)


# ====================================================================== write + verify
def write_run(dst, src_data, plan, run_id, dst_info):
    dag_id, run = src_data["dag_id"], src_data["run"]
    dq = q(dag_id)
    dst.req("PATCH", f"/dags/{dq}", json={"is_paused": True}).raise_for_status()
    if not dst_info["existing"]:
        body = {"dag_run_id": run_id,
                "logical_date": run.get("logical_date") or run.get("execution_date"),
                "data_interval_start": run.get("data_interval_start"),
                "data_interval_end": run.get("data_interval_end"),
                "conf": run.get("conf") or {},
                "note": f"migrated from Airflow 2 run {run['dag_run_id']} (state={run['state']})"}
        body = {k: v for k, v in body.items() if v is not None}
        r = dst.req("POST", f"/dags/{dq}/dagRuns", json=body)
        if r.status_code not in (200, 201):
            raise SystemExit(f"cannot create run {run_id}")
        log(f"[dst] run {run_id} created (DAG paused)")
    rbase = f"/dags/{dq}/dagRuns/{q(run_id)}"
    for _ in range(30):
        dst_tis = dst.paged(f"{rbase}/taskInstances", "task_instances")
        if dst_tis:
            break
        time.sleep(1)
    else:
        raise SystemExit("task instances did not appear in Airflow 3")
    for t in src_data["tis"]:
        if t["state"] != "success" or t["map_index"] != -1:
            continue
        r = dst.req("PATCH", f"{rbase}/taskInstances/{q(t['task_id'])}", json={"new_state": "success"})
        log(f"[dst] {t['task_id']} -> success (HTTP {r.status_code})")
        if r.status_code != 200:
            raise SystemExit("cannot set task state")
    for x in plan:
        xb = f"{rbase}/taskInstances/{q(x['task_id'])}/xcomEntries"
        r = dst.req("POST", xb, ok=(200, 201), quiet=(409,), json={"key": x["key"], "value": x["value"]})
        if r.status_code == 409:
            r = dst.req("PATCH", f"{xb}/{q(x['key'])}", json={"value": x["value"]})
        if r.status_code not in (200, 201):
            raise SystemExit(f"cannot write XCom {x['task_id']}.{x['key']}")
    log(f"[dst] {len(plan)} XComs written")


def verify(dst, dag_id, run_id, plan):
    bad = 0
    rbase = f"/dags/{q(dag_id)}/dagRuns/{q(run_id)}"
    for x in plan:
        # Do NOT pass deserialize=true: Airflow 3.3 then json-decodes string values again ("7" -> 7).
        r = dst.req("GET", f"{rbase}/taskInstances/{q(x['task_id'])}/xcomEntries/{q(x['key'])}")
        got = r.json().get("value") if r.status_code == 200 else f"<HTTP {r.status_code}>"
        if not strict_eq(got, x["value"]):
            bad += 1
            log(f"[verify] FAIL {x['task_id']}.{x['key']} expected={x['value']!r} got={got!r}")
    log(f"[verify] {len(plan) - bad}/{len(plan)} XComs identical (exact types)")
    tis = dst.paged(f"{rbase}/taskInstances", "task_instances")
    log("[verify] Airflow 3 task states: " + ", ".join(f"{t['task_id']}={t['state']}" for t in tis))
    return bad == 0


# ====================================================================== main
def load_hints(path):
    if not path:
        return {}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if path.endswith((".yaml", ".yml")):
        import yaml
        hints = yaml.safe_load(text) or {}
    else:
        hints = json.loads(text)
    bad = {k: v for k, v in hints.items() if v not in HINT_TYPES}
    if bad:
        raise SystemExit(f"invalid hint types {bad}; allowed: {', '.join(HINT_TYPES)}")
    return hints


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--src-url", required=True, help="Airflow 2 webserver base URL")
    p.add_argument("--src-user", required=True)
    p.add_argument("--src-password", required=True)
    p.add_argument("--dst-url", required=True, help="Airflow 3 api-server base URL")
    p.add_argument("--dst-user")
    p.add_argument("--dst-password")
    p.add_argument("--dst-token", help="JWT for Airflow 3 (instead of user/password)")
    p.add_argument("--dag-id", required=True)
    p.add_argument("--run-id", required=True, action="append", help="repeatable")
    p.add_argument("--dst-run-id", help="different run_id in Airflow 3 (only with a single --run-id)")
    p.add_argument("--hints", help="JSON/YAML {'task.key': type}; wildcards task.* and *.key")
    p.add_argument("--hint", action="append", default=[], metavar="TASK.KEY=TYPE", help="inline hint, repeatable")
    p.add_argument("--no-strict", action="store_true", help="guess ambiguous types instead of stopping")
    p.add_argument("--skip-keys", default=SKIP_KEYS_DEFAULT)
    p.add_argument("--dry-run", action="store_true", help="report only, write nothing")
    p.add_argument("--verify-only", action="store_true", help="only re-run the comparison")
    p.add_argument("--insecure", action="store_true", help="skip TLS verification")
    args = p.parse_args()
    if args.dst_run_id and len(args.run_id) > 1:
        raise SystemExit("--dst-run-id needs a single --run-id")

    hints = load_hints(args.hints)
    for h in args.hint:
        k, _, v = h.partition("=")
        if v not in HINT_TYPES:
            raise SystemExit(f"bad --hint {h!r}")
        hints[k] = v
    skip = set(filter(None, args.skip_keys.split(",")))
    src = Api(args.src_url, "/api/v1", auth=(args.src_user, args.src_password), verify_tls=not args.insecure)
    dst = Api(args.dst_url, "/api/v2", token=dst_token(args), verify_tls=not args.insecure)

    # phase 1: read and check everything before writing anything
    jobs, all_amb, blocked = [], [], False
    for rid in args.run_id:
        out_id = args.dst_run_id or rid
        data = read_source(src, args.dag_id, rid, skip, hints)
        plan, downgrades, types = build_plan(data)
        issues, dst_info = dst_precheck(dst, data, out_id, args.verify_only)
        data["problems"] += issues
        report(data, plan, downgrades, types, dst_info, out_id)
        all_amb += data["ambiguous"]
        if data["problems"] or (data["ambiguous"] and not args.no_strict):
            blocked = True
        jobs.append((data, plan, out_id, dst_info))

    if all_amb and not args.no_strict:
        log("Ambiguous values need type hints (strict mode). Save this as hints.json, correct the types,")
        log("then re-run with --hints hints.json (types: " + ", ".join(HINT_TYPES) + "):")
        log(hints_snippet(all_amb))
    if blocked:
        log("BLOCKED: nothing was written.")
        return EXIT_BLOCKED
    if args.dry_run:
        log("[dry-run] checks passed, nothing written.")
        return EXIT_OK

    ok = True
    for data, plan, out_id, dst_info in jobs:
        if not args.verify_only:
            write_run(dst, data, plan, out_id, dst_info)
        ok &= verify(dst, data["dag_id"], out_id, plan)
    log("DONE. The DAG is still PAUSED in Airflow 3: check Variables/Connections, then unpause it to resume.")
    return EXIT_OK if ok else EXIT_VERIFY_FAILED


if __name__ == "__main__":
    sys.exit(main())
