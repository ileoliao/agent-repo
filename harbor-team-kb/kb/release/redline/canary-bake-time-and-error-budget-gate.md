---
title: "Tier-0 核心服务发布红线：5% 金丝雀至少观察 20 分钟且自动熔断阈值 1.5x"
summary: "harbor-gateway、harbor-sense、harbor-store 生产发布必须先停留在 5% 金丝雀流量满 20 分钟，若 error_rate 超过基线 1.5 倍或 P99 翻倍必须立即中止放大。"
sources:
  - "harbor-deploy:rollouts/tier0-canary.yaml#CanaryAnalysisTemplate"
triggers:
  - "CanaryAnalysisTemplate"
  - "tier0-canary"
  - "金丝雀"
  - "error_rate"
  - "发布红线"
---

## 红线规则

所有 Tier-0 核心服务（`harbor-gateway`、`harbor-sense`、`harbor-store`）的生产环境变更，严禁跳过金丝雀直接全量滚动：
1. 首轮金丝雀权重固定不超过 **5%**，最短停留烘焙时间（bake time）**不少于 20 分钟**（覆盖异步消费延迟与连接池预热周期）。
2. 自动分析模板 `harbor-deploy:rollouts/tier0-canary.yaml#CanaryAnalysisTemplate` 中，一旦金丝雀实例 `error_rate > 1.5 * baseline` 或 `p99_latency > 2.0 * baseline` 连续两个采样周期，必须立即自动回退金丝雀权重至 `0%`。

## 例外审批

仅当全站处于 P0 完全不可用状态、且旧版本确定无法恢复时，才允许值班负责人在事故群双人确认后执行紧急全量覆盖修复。
