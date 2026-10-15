# heartbeat-probe：告警链路端到端拨测

持续验证"指标上报 → Nginx → OTel Collector → Mimir → Grafana 规则评估 → Webhook 通知"整条链路是否通畅，并在 GCP 上对中断、探测服务失效和延迟告警。支持多副本部署。

```
副本 0 ─┐                                                 
副本 1 ─┼─OTLP─> Nginx ─> OTel Collector ─> Mimir ─> Grafana 规则（每个副本一个告警实例）
副本 N ─┘                                                  │
   ▲                                                       │ webhook（带 probe_id + replica）
   └──────────── Service 负载均衡到任意副本 ◄──────────────┘
   │
 stdout JSON ──直接──> Cloud Logging ──> 基于日志的指标（带 replica 标签）──> Cloud Monitoring 告警
```

## 工作方式

| 时间（默认） | 发生了什么 |
|---|---|
| 每 300 秒 | 每个副本开始一次新探测，`probe_id` = 本周期起始时间（epoch 秒，按周期对齐） |
| 前 120 秒 | `heartbeat_probe_state{replica}=1`，Grafana 为该副本触发告警，webhook 带回 `probe_id` |
| 后 180 秒 | `heartbeat_probe_state{replica}=0`，告警恢复，webhook 带回 resolved |

### 多副本：无状态配对

webhook 经过 Service 可能落到任意副本，所以配对不依赖本地内存：

- `probe_id` 就是探测的开始时间，接收方直接用 `当前时间 − probe_id` 算出端到端延迟。
- 校验规则：`probe_id` 必须按周期对齐，且在超时窗口内（不能太旧，也不能来自未来）。不满足的记为 `matched=false` 并注明原因。
- 日志中的 `replica` 是**发出探测的副本**（来自告警标签），`received_by` 是实际收到 webhook 的副本。
- "超时"不再由服务自己判断，而是由 GCP 按副本检测"一段时间内没有验证成功的心跳"。

### 日志事件（`jsonPayload.event`）

| 事件 | 含义 |
|---|---|
| `probe_sent` | 副本进入触发阶段（`replica` = 自己） |
| `probe_cleared` | 副本进入恢复阶段 |
| `alert_received` | 收到 webhook；字段 `status`、`matched`、`latency_seconds`、`reason`、`replica`、`received_by` |
| `webhook_unauthorized` | webhook 鉴权失败 |

`reason` 的取值：`late`（超时后才到）、`from_future`、`probe_id_not_aligned`（编号格式丢失精度）、`missing_or_bad_probe_id`、`duplicate`（同一副本收到重复通知，仅尽力标记）。

### 服务自身的运行指标（标准 OTel SDK）

探测服务通过同一个 OTLP 地址上报自己的运行指标，方便在 Grafana 中回顾它的工作情况。资源属性带 `service.name=heartbeat-probe` 和 `service.instance.id=<副本名>`。

| OTel 指标 | 类型 | 属性 | Mimir 中的名称（默认转换） |
|---|---|---|---|
| `heartbeat.probe.sent` | Counter | probe, replica | `heartbeat_probe_sent_total` |
| `heartbeat.probe.notifications` | Counter | probe, replica（发出方）, received_by, status, matched, reason | `heartbeat_probe_notifications_total` |
| `heartbeat.probe.latency` | Histogram（秒） | probe, replica, status | `heartbeat_probe_latency_seconds_bucket` 等 |
| `heartbeat.probe.webhook.rejected` | Counter | probe, received_by, reason | `heartbeat_probe_webhook_rejected_total` |

常用查询示例（名称以你们 Mimir 中的实际转换结果为准）：

```promql
# 每个副本每小时验证成功的心跳数（正常应约为 3600/300 = 12）
sum by (replica) (increase(heartbeat_probe_notifications_total{matched="true", status="firing"}[1h]))

# 端到端延迟 p95
histogram_quantile(0.95, sum by (le, replica) (rate(heartbeat_probe_latency_seconds_bucket{status="firing"}[1h])))

# 配对失败的原因分布
sum by (reason) (increase(heartbeat_probe_notifications_total{matched="false"}[1d]))
```

这些指标走的正是被检测的链路，**只用于回顾和分析，不用于判断链路是否中断**。链路中断时它们也会一起消失，判断由 GCP 完成。

### GCP 告警（`gcp/setup.sh` 创建，均按副本分别触发）

| 告警 | 条件 | 发现的问题 |
|---|---|---|
| Alerting pipeline broken | 某个副本 15 分钟内没有验证成功的心跳 | 该副本所在的链路中断；所有副本同时触发 = 整条链路中断（含 Grafana 挂掉） |
| Probe replica not sending | 某个副本 15 分钟内没有 `probe_sent` | 探测副本本身挂了 |
| Alerting pipeline slow | 端到端延迟 p95 > 180 秒 | 链路未断但严重变慢 |

## 部署步骤

1. **构建镜像**：`docker build -t REGISTRY/heartbeat-probe:1.1.0 .`
2. **部署到 GKE**：修改 `k8s/deployment.yaml` 中的 OTLP 地址、团队凭证、webhook token，`kubectl apply -f k8s/`。
   - 使用 **StatefulSet**：副本名称固定（`heartbeat-probe-0`、`-1`），Mimir 中的 series 和 GCP 的按副本告警在重启后保持不变。
   - 日志直接写 stdout，由 GKE 送到 Cloud Logging，**不能经过你们自己的 OTel/Loki 管道**。
   - 让 Grafana 告警实例能访问到 `heartbeat-probe` Service 的 `/webhook`（内部负载均衡或 Ingress）。
3. **Grafana**：把 `grafana/*.yaml` 放到 provisioning/alerting 目录。
   - 替换 `MIMIR_DATASOURCE_UID` 为探测服务所在租户的数据源。
   - 在 Grafana 上设置环境变量 `HEARTBEAT_WEBHOOK_TOKEN`。
4. **GCP**：`PROJECT_ID=... CHANNEL_ID=... ./gcp/setup.sh`。通知渠道必须独立于被监控的系统。

## 上线前需要核对

- **Mimir 中的指标名**：OTel 的 `heartbeat.probe.state` / `heartbeat.probe.id` 默认转换为 `heartbeat_probe_state` / `heartbeat_probe_id`。如果你们的转换方式加了后缀，改 `alert-rule.yaml` 中的查询。
- **`$values.B.Value` 是否可用**：在 Grafana 规则编辑页预览注解，确认每个副本的告警实例取到的是自己的编号。如果取不到，加一个 Reduce 表达式 D（对 B 取 last），改用 `$values.D.Value`。
- **`printf "%.0f"` 不能省**：默认格式会变成 `1.76054e+09`，精度丢失，会被判为 `probe_id_not_aligned`，不会误判为成功。
- **`notification_settings`** 需要 Grafana 支持按规则配置通知；否则删掉该段，在 UI 中加一条子策略：匹配 `probe=e2e`，发往 `heartbeat-probe-webhook`，group_by 包含 `replica`，group_wait 0s、group_interval 30s。
- **`noDataState` / `execErrState` 必须是 OK**：任何异常都应表现为"没有通知"，由 GCP 发现中断，而不是发出一条假通知。
- **各副本的时钟需要同步**（NTP）：配对依赖时间窗口，允许 60 秒误差。

## 运维注意

- **缩容会触发告警**：被移除副本的心跳消失，GCP 会对它发出一次"中断"告警，属于预期行为，可以在缩容前临时静默。扩容不会有问题。
- **重复通知**：Grafana 多实例去重失效时，同一通知可能被多个副本各收一次，GCP 上的计数会偏多，但只用来判断"有没有"，不影响告警。

## 上线后演练

1. 删除一个副本的 Pod → 预期不告警（StatefulSet 会以同名重建）；如果它起不来，预期收到 *Probe replica not sending*。
2. 在 Grafana 中暂停该规则 → 预期所有副本都触发 *Alerting pipeline broken*。
3. 在 Collector 中临时丢弃 `heartbeat_probe_*` → 同上。
4. 记录每次从故障到收到 GCP 告警的时间，作为告警链路的基线。

## 本地测试

```bash
pip install -r requirements.txt pytest
python -m pytest -q tests
```

集成测试启动两个副本和一个假的 OTLP 接收端（解码 protobuf），把副本 0 的探测通知发给副本 1，验证跨副本配对、指标上的 `replica` 属性、凭证头和鉴权。
