---
title: "OTel Collector 红线：memory_limiter 必须位于 processors 首位"
summary: "所有 OpenTelemetry Collector pipeline 中 memory_limiter 必须排在 batch 与 tail_sampling 之前，否则突发流量下内存缓冲不受控会导致 OOMKilled 静默丢数。"
sources:
  - "harbor-sense:deploy/otelcol-config.yaml#memory_limiter"
triggers:
  - "memory_limiter"
  - "otelcol"
  - "OOMKilled"
  - "tail_sampling"
  - "processors"
---

## 红线规则

修改任何 OpenTelemetry Collector 配置（如 `harbor-sense:deploy/otelcol-config.yaml`）时：
1. 每个 `traces`、`metrics`、`logs` pipeline 的 `processors` 列表**第一项必须是 `memory_limiter`**（位于 `batch`、`attributes`、`tail_sampling` 之前）。
2. `limit_percentage` 与 `spike_limit_percentage` 之和不得超过容器 `resources.limits.memory` 的 **85%**，且必须设置 `GOMEMLIMIT` 为容器内存上限的 **80%**。

## 违反后果

若 `batch` 或 `tail_sampling` 排在 `memory_limiter` 之前，数据会先堆积在下游算子内存队列中，触发软限流时已无法释放上游积压，导致 Pod 反复 `OOMKilled` 并丢失整批在途监控数据。
