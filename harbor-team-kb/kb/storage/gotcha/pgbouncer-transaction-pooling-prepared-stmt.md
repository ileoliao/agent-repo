---
title: "PgBouncer transaction pooling causes SQLSTATE 42P05 / 26000 prepared statement errors"
summary: "Under PgBouncer pool_mode = transaction, pgx session-scoped named prepared statements collide across backend connections with 42P05 or 26000; switch to QueryExecModeCacheDescribe."
sources:
  - "harbor-store:pkg/db/pool.go#NewPgxPool"
triggers:
  - "42P05"
  - "26000"
  - "prepared statement"
  - "pgbouncer"
  - "NewPgxPool"
  - "QueryExecModeCacheDescribe"
---

## Symptom

Services behind PgBouncer (`pool_mode = transaction`) intermittently fail with:
- `ERROR: prepared statement "stmtcache_..." already exists (SQLSTATE 42P05)`
- `ERROR: prepared statement "..." does not exist (SQLSTATE 26000)`

## Root Cause

In `transaction` pooling mode, consecutive transactions on one client connection are multiplexed onto different backend PostgreSQL server sessions, breaking Go `pgx`'s default per-connection named prepared statement cache.

## Fix

Configure `DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe` (or `QueryExecModeSimpleProtocol`) in `harbor-store:pkg/db/pool.go#NewPgxPool` so queries do not rely on server-side session statement state (or enable PgBouncer `>= 1.21` `max_prepared_statements > 0` after staging verification).
