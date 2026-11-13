---
title: "含数据库结构变更（Schema Migration）版本的两阶段安全回滚手册"
summary: "当待回滚的应用版本包含数据库新增列或双写变更时，必须先运行 verify_backward_compat 确认旧镜像兼容当前表结构，禁止直接执行破坏性反向 DDL 回滚。"
sources:
  - "harbor-deploy:scripts/rollback_tier0.sh#verify_backward_compat"
triggers:
  - "verify_backward_compat"
  - "rollback_tier0.sh"
  - "回滚"
  - "schema migration"
  - "Expand-Contract"
---

## 适用场景

线上新版本发布后因错误率或延迟恶化需要紧急**回滚**（rollback），且本次发布或前序相邻版本执行过数据库 Schema 变更。

## 安全回滚步骤

1. **只回滚无状态计算层，不执行 `DROP COLUMN` 反向迁移**：遵循 Expand-Contract 原则，新列必须允许 `NULL` 或具备默认值；禁止在故障期间执行反向删列/删表，避免丢失金丝雀期间已写入的线上数据。
2. **执行兼容性预检**：运行 `harbor-deploy:scripts/rollback_tier0.sh#verify_backward_compat`，检查：
   - 新增列是否含有 `NOT NULL` 且无 `DEFAULT`（若是，旧版代码 `INSERT` 会直接报非空约束错误，必须先 `ALTER COLUMN ... DROP NOT NULL` 再回滚镜像！）。
   - 消息队列 / 缓存中是否已写入旧版反序列化器无法忽略的新枚举值。
3. **切换流量与复核**：确认兼容性通过后回退 Deployment 镜像版本，并观察 `error_rate` 与数据库约束错误日志 10 分钟。
