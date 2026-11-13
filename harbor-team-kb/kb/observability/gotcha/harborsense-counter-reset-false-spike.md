---
title: "harbor-ingester 滚动发布期间计数器重置导致 error_rate 假阳性突刺"
summary: "对单调计数器 harborsense_ingest_total 误用裸减法或短窗口外推会把 Pod 重启的 counter reset 误判为 10 倍流量异常，必须使用带重置处理的 rate()/increase()。"
sources:
  - "harbor-sense:internal/metrics/prom_queries.go#BuildErrorRateQuery"
triggers:
  - "harborsense_ingest_total"
  - "BuildErrorRateQuery"
  - "error_rate"
  - "counter reset"
  - "假阳性"
---

## 现象

每次 `harbor-ingester` 执行常规滚动重启后的 5 分钟内，部分自定义巡检查询报告 `error_rate` 或吞吐量出现瞬时跳变或负值截断，但网关真实错误日志无增长。

## 根因

PromQL 的 `rate()` 与 `increase()` 会自动识别单调 Counter 从高值归零（Pod 重启），但直接用偏移相减（`metric - metric offset 5m`）或在 SQL/ClickHouse 聚合层未按 `(pod, instance)` 处理单调重置时，会把新 Pod 的初始值或归零差值算错。

## 排查准则

分析发布窗口内的 `error_rate` 异常时：
1. 先核对窗口内是否有 `kube_pod_container_status_restarts_total` 或 Deployment rollout。
2. 确认查询语句走 `harbor-sense:internal/metrics/prom_queries.go#BuildErrorRateQuery` 中的 `sum(rate(...[5m])) / clamp_min(sum(rate(...[5m])), 1)` 口径。
