---
title: "PostgreSQL DDL redline: tables over 1M rows require non-transactional CREATE INDEX CONCURRENTLY"
summary: "Never run CREATE/DROP INDEX inside a migration transaction on PostgreSQL tables above 1M rows; disable transactions and use CONCURRENTLY with lock_timeout = 2s to avoid AccessExclusiveLock."
sources:
  - "harbor-store:migrations/runner.go#RunNonTransactional"
triggers:
  - "CREATE INDEX"
  - "CONCURRENTLY"
  - "AccessExclusiveLock"
  - "RunNonTransactional"
  - "锁表"
  - "migration"
---

## Guardrail

When adding, rebuilding, or dropping indexes on any `harbor-store` PostgreSQL table over `1,000,000` rows or on a hot OLTP path:
1. Always use `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`.
2. Annotate the migration header with `-- migrate:no-transaction` so `harbor-store:migrations/runner.go#RunNonTransactional` executes outside a transaction block.
3. Set `SET lock_timeout = '2s'` so lock acquisition aborts fast instead of queueing behind long queries and blocking all reads/writes.

## Recovery Note

If `CREATE INDEX CONCURRENTLY` aborts mid-build, PostgreSQL leaves an `INVALID` index behind; run `DROP INDEX CONCURRENTLY IF EXISTS <idx_name>` before retrying.
