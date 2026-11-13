---
title: "高基数指标爆炸（ErrSeriesLimitExceeded）应急隔离手册"
summary: "当 Prometheus 或 Loki 报 ErrSeriesLimitExceeded 且活跃时间序列突破 200 万时，先通过 relabel drop 隔离泄漏标签，严禁直接盲目调高全局 max_global_series_per_user。"
sources:
  - "harbor-sense:deploy/relabel-rules.yaml#drop_unbounded_labels"
triggers:
  - "ErrSeriesLimitExceeded"
  - "high cardinality"
  - "高基数"
  - "drop_unbounded_labels"
  - "max_global_series"
---

## 触发信号

采集侧出现大量 `HTTP 400: ErrSeriesLimitExceeded` 或 TSDB 内存突增，核心 SLI 面板出现断点。

## 处置步骤

1. **定位Top基数标签**：查询 TSDB 状态接口（`/api/v1/status/tsdb`），检查 `seriesCountByLabelValuePair` 与 `labelValueCountByLabelName`，识别混入 `request_id`、完整 URL 路径或时间戳的异常标签。
2. **执行标签剥离（止血）**：在 `harbor-sense:deploy/relabel-rules.yaml#drop_unbounded_labels` 中添加 `action: labeldrop`（保留指标聚合值但丢弃无界标签），若整个调试指标无用则使用 `action: drop`。
3. **禁止事项**：在未定位泄漏源前，**禁止**直接翻倍 `max_global_series_per_user`，否则会拖垮查询节点导致全站告警失明。
