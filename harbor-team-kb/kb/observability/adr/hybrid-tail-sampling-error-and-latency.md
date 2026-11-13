---
title: "ADR：链路追踪采用 100% 错误与慢请求尾部采样 + 5% 基线头部采样"
summary: "为兼顾故障根因定位与存储成本，harbor-sense 对错误链路和超 2500ms 慢链路执行 100% 尾部采样，正常链路仅保留 5% 概率采样。"
sources:
  - "harbor-sense:deploy/otelcol-config.yaml#tail_sampling"
triggers:
  - "tail_sampling"
  - "链路采样"
  - "2500ms"
  - "trace missing"
  - "采样率"
---

## 背景与决策

全量 100% 保存分布式 Trace 在峰值流量下占可观测存储成本的 72%，而其中 95% 以上是无异常的 `200 OK` 快请求；但纯头部随机采样（如 5%）又会导致低频线上故障丢失关键 Trace。

因此架构决策如下（配置见 `harbor-sense:deploy/otelcol-config.yaml#tail_sampling`）：
1. **错误必留**：`status_code == ERROR` 或 HTTP `status >= 500` 的整条 Trace 100% 保留。
2. **慢请求必留**：端到端耗时 `>= 2500ms` 的慢链路 100% 保留。
3. **正常基线**：其余正常链路按 `trace_id` 一致性哈希保留 **5%**，用于对比正常路径延迟分布。

## 对排障的影响

不能直接用 Trace 数量统计真实请求总量（QPS 统计必须查 Metrics 而非 Trace 条数），因为成功快请求已被放大采样比压缩。
