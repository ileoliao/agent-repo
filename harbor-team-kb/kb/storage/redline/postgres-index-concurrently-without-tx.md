---
title: "PostgreSQL 大表迁移红线：超过百万行建删索引必须脱离事务并使用 CONCURRENTLY"
summary: "对超过 100 万行的核心表执行 CREATE/DROP INDEX 时，严禁包裹在数据库迁移事务中，必须显式关闭事务并使用 CONCURRENTLY 防止 AccessExclusiveLock 锁表。"
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

## 红线规则

在 `harbor-store` 对任何行数 `> 1,000,000` 或处于核心读写路径的 PostgreSQL 表新增、重建或删除索引时：
1. 必须使用 `CREATE INDEX CONCURRENTLY` / `DROP INDEX CONCURRENTLY`。
2. 迁移脚本头部必须标记 `-- migrate:no-transaction`，由 `harbor-store:migrations/runner.go#RunNonTransactional` 执行（PostgreSQL 不允许在事务块内运行 `CONCURRENTLY`）。
3. 必须同时设置会话级 `SET lock_timeout = '2s'`，宁可迁移自动失败重试，也绝不允许阻塞在线读写队列。

## 补充注意

若 `CREATE INDEX CONCURRENTLY` 中途超时失败，会留下 `INVALID` 状态的残余索引；重跑前需先 `DROP INDEX CONCURRENTLY IF EXISTS <idx_name>`。
