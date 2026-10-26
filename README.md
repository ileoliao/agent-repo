# agent-repo

## 项目

- `tank-showcase/`：Blender 程序化建模的 ZTZ-99A 风格主战坦克展示
- `chengdu-inkwash/`：程序化水墨风格的成都历史动画
- [inkwash-engine](inkwash-engine/README.md)：程序化水墨引擎（吸光度叠墨，`纸色 × exp(−ΣA)`），含山水 `shanshui/paint.py` 与笔毛试笔 `brushlab/sheet.py`。
- [heartbeat-probe](heartbeat-probe/README.md)：可观测性平台承诺的主动探测（指标/日志告警闭环、日志与 trace 完整可查询），按租户运行，多个独立实例跨 zone 部署，每次检查由发起的实例给出唯一结论，交给 GCP 判定并生成平台 SLO；Grafana 规则与 GCP 告警/SLO 由同一份配置生成。
- [otel-allowlist](otel-allowlist/README.md)：OTel Collector 服务白名单，只放行登记过的 `service.name`；官方 contrib 镜像 + filter 处理器，名单由脚本生成为排序后的正则，经 ConfigMap 滚动发布。

- [airflow-run-migrator](airflow-run-migrator/README.md)：纯 REST API 把 Airflow 2.x 失败的 DAG run（任务状态 + 全部 XCom）迁到 Airflow 3.x 并续跑；严格类型校验，歧义值靠类型提示文件，已在 2.9.2 → 3.3.2 端到端实测。

> 测试：这是一段随便写的说明文字，用于验证 PR 流程。
