---
title: "网关限流变更红线：RateLimitConfig 必须先开启 24 小时 shadow_only 灰度"
summary: "修改 harbor-gateway 的 RateLimitConfig 配额或突发桶（burst）前必须先以 shadow_only 模式运行至少 24 小时，禁止直接下发强拦截 429。"
sources:
  - "harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"
triggers:
  - "RateLimitConfig"
  - "shadow_only"
  - "429 Too Many Requests"
  - "限流"
  - "harbor-gateway"
---

## 红线规则

对 `harbor-gateway` 的任何限流策略修改（包括全局 QPS、租户配额、`burst` 突发容量或路由级令牌桶参数），**严禁直接以强制拦截模式（`shadow_only: false`）上线到生产环境**。

必须遵守两阶段变更：
1. 先下发 `shadow_only: true`，仅记录 `gateway_ratelimit_would_reject_total` 指标与被命中租户采样日志，不返回 `429`。
2. 观察至少 **24 小时**（覆盖完整早晚高峰与定时批处理窗口），确认无核心合作方误杀后，再切换为 `shadow_only: false`。

## 原因与事故背景

多租户网关存在周期性批处理与长连接重连流量，历史上曾因按日均 QPS 估算 `burst` 过小，上线后 3 分钟内触发合作方客户端重试风暴。代码锚点见 `harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig`。
