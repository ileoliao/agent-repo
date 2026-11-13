---
title: "2026-02 复盘：固定 Retry-After 导致合作方 Webhook 429 重试风暴（request_rate 3.4x）"
summary: "网关返回固定整数 Retry-After: 5 使上万个客户端在同一秒对齐重试，放大 request_rate 至基线 3.4 倍；改为随机抖动退避后恢复。"
sources:
  - "harbor-gateway:pkg/middleware/retry_after.go#WriteRetryHeader"
triggers:
  - "request_rate"
  - "Retry-After"
  - "WriteRetryHeader"
  - "429"
  - "重试风暴"
  - "webhook"
---

## 事故摘要

`sentinel` 检测到 `harbor-gateway` 的 `request_rate` 突增至基线 **3.4x**，同时 `429` 比例升至 38%，且流量呈严格 5 秒周期的锯齿状脉冲。

## 根因分析

1. 某合作方批量任务瞬时超出租户突发桶（`burst`），首次触发 `429`。
2. `WriteRetryHeader` 当时硬编码返回 `Retry-After: 5`（无抖动），导致被拒绝的所有并发 Worker 在精确 5.0 秒后同步重发，每次重发再次耗尽令牌桶并叠加新流量，形成自维持同步振荡。

## 永久改进与核查点

- `harbor-gateway:pkg/middleware/retry_after.go#WriteRetryHeader` 已改为在基础退避窗口上叠加 `[base, base * 1.8]` 均匀随机抖动，并对连续超限的同一 `client_id` 递增退避上限至 `60s`。
- 后续排查 `request_rate` 呈固定秒级锯齿脉冲时，优先核查响应头 `Retry-After` 与单一 `client_id` 占比。
