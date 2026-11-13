---
title: "PgBouncer transaction 连接池模式下 SQLSTATE 42P05 预处理语句冲突"
summary: "当后端启用 PgBouncer pool_mode = transaction 时，pgx 默认缓存命名的 prepared statement 会跨后端连接串用报 42P05 或 26000，需改用无状态执行模式。"
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

## 现象

服务接入 PgBouncer（`pool_mode = transaction`）后，偶发报错：
- `ERROR: prepared statement "stmtcache_..." already exists (SQLSTATE 42P05)`
- 或 `ERROR: prepared statement "..." does not exist (SQLSTATE 26000)`

## 根因

在 `transaction` 池化模式下，同一个应用连接在两次事务之间会被调度到不同的后端 PostgreSQL 物理会话；Go `pgx` 默认按连接维护会话级命名预处理语句缓存，切换物理会话后即发生状态错位。

## 解决方案

在 `harbor-store:pkg/db/pool.go#NewPgxPool` 初始化配置中设置 `DefaultQueryExecMode = pgx.QueryExecModeCacheDescribe`（或简单协议 `QueryExecModeSimpleProtocol`），避免依赖后端会话级命名语句状态；若使用 PgBouncer `>= 1.21`，也可配合服务端 `max_prepared_statements > 0` 验证后再开启。
