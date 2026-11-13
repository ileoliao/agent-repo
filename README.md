# agent-repo

## 项目

- `tank-showcase/`：Blender 程序化建模的 ZTZ-99A 风格主战坦克展示
- `chengdu-inkwash/`：程序化水墨风格的成都历史动画
- [inkwash-engine](inkwash-engine/README.md)：程序化水墨引擎（吸光度叠墨，`纸色 × exp(−ΣA)`），含山水 `shanshui/paint.py` 与笔毛试笔 `brushlab/sheet.py`。
- [heartbeat-probe](heartbeat-probe/README.md)：可观测性平台承诺的主动探测（指标/日志告警闭环、日志与 trace 完整可查询），按租户运行，多个独立实例跨 zone 部署，每次检查由发起的实例给出唯一结论，交给 GCP 判定并生成平台 SLO；Grafana 规则与 GCP 告警/SLO 由同一份配置生成。
- [grafana-emergency-sync](grafana-emergency-sync/README.md)：在独立应急 Grafana 中同步用户创建的仪表盘、嵌套文件夹和数据源，附 GKE 部署清单、Docker 实测与同步过期告警规则；告警规则复制默认关闭。
- [otel-allowlist](otel-allowlist/README.md)：OTel Collector 服务白名单，只放行登记过的 `service.name`；官方 contrib 镜像 + filter 处理器，名单由脚本生成为排序后的正则，经 ConfigMap 滚动发布。

- [harbor-extensions](harbor-extensions/README.md)：内部系统的统一受治理访问层原型（网关原样透传 + 按能力绑定 AD 组授权 + 沙箱扩展门户 + CLI/agent 同一通道），平台不存业务数据；含 outage 团队服务接入的参考实现，FastAPI + React，85 个测试含浏览器端到端。
- [airflow-run-migrator](airflow-run-migrator/README.md)：纯 REST API 把 Airflow 2.x 失败的 DAG run（任务状态 + 全部 XCom）迁到 Airflow 3.x 并续跑；严格类型校验，歧义值靠类型提示文件，已在 2.9.2 → 3.3.2 端到端实测。
- [harbor-team-kb](harbor-team-kb/README.md)（[2 分钟使用说明书](harbor-team-kb/USER_GUIDE.md)）：面向 10–20 人团队的 Harbor Mate 与 VS Code Copilot 可插拔共享知识库（无 MCP 约束下的路径即 ID Markdown + 零依赖 Node.js Porter BM25F/IDF 混合检索 + 单仓/多仓锚点漂移核验 + SHA-256 审批隔离发布 + 一键插拔 `plug.js`，含 48 条分层召回评测、`tiktoken` Token 窗口基准与 58 项端到端运行时实测）。

> 测试：这是一段随便写的说明文字，用于验证 PR 流程。
