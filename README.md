# agent-repo

## 项目

- `tank-showcase/`：Blender 程序化建模的 ZTZ-99A 风格主战坦克展示
- `chengdu-inkwash/`：程序化水墨风格的成都历史动画
- [inkwash-engine](inkwash-engine/README.md)：程序化水墨引擎（吸光度叠墨，`纸色 × exp(−ΣA)`），含山水 `shanshui/paint.py` 与笔毛试笔 `brushlab/sheet.py`。
- [heartbeat-probe](heartbeat-probe/README.md)：可观测性平台承诺的主动探测（指标/日志告警闭环、日志与 trace 完整可查询），按租户和副本运行，结果交给 GCP 判定并生成平台 SLO；Grafana 规则与 GCP 告警/SLO 由同一份配置生成。

> 测试：这是一段随便写的说明文字，用于验证 PR 流程。
