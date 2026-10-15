# heartbeat-probe：告警链路端到端拨测

持续验证"指标上报 → Nginx → OTel Collector → Mimir → Grafana 规则评估 → Webhook 通知"整条链路是否通畅，并在 GCP 上对中断、配对失败和延迟告警。

```
heartbeat-probe ──OTLP──> Nginx ──> OTel Collector ──> Mimir
      ▲                                                  │
      │ webhook (probe_id)                         Grafana 规则
      └──────────────────────────────────────────────────┘
      │
   stdout JSON 日志 ──直接──> Cloud Logging ──> 基于日志的指标 ──> Cloud Monitoring 告警
```

## 工作方式

| 时间（默认） | 发生了什么 |
|---|---|
| 每 300 秒 | 开始一次新的探测，`probe_id` = 本周期起始时间（epoch 秒） |
| 前 120 秒 | `heartbeat_probe_state=1`，Grafana 规则触发，webhook 带回 `probe_id` |
| 后 180 秒 | `heartbeat_probe_state=0`，规则恢复，webhook 带回 resolved |
| 300 秒内未收到配对的 firing | 写 `probe_timeout`（ERROR） |

服务把每个 webhook 和自己发出的探测按 `probe_id` 配对，并记录端到端延迟。

### 日志事件（`jsonPayload.event`）

| 事件 | 含义 |
|---|---|
| `probe_sent` | 探测进入触发阶段 |
| `probe_cleared` | 探测进入恢复阶段 |
| `alert_received` | 收到 webhook；字段 `status`、`matched`、`latency_seconds`、`reason` |
| `probe_timeout` | 发出的探测在超时内没有收到配对的 firing 通知 |
| `resolve_timeout` | 没有收到配对的 resolved 通知 |
| `webhook_unauthorized` | webhook 鉴权失败 |

### GCP 告警（`gcp/setup.sh` 创建）

| 告警 | 条件 | 发现的问题 |
|---|---|---|
| Alerting pipeline broken | 15 分钟内没有配对成功的心跳 | 整条链路中断（含 Grafana 挂掉） |
| Probe service not sending | 15 分钟内没有 `probe_sent` | 探测服务本身挂了 |
| Repeated probe timeouts | 30 分钟内超时 ≥ 2 次 | 间歇性丢失、部分失效 |
| Alerting pipeline slow | 端到端延迟 p95 > 180 秒 | 链路未断但严重变慢 |

## 部署步骤

1. **构建镜像**：`docker build -t REGISTRY/heartbeat-probe:1.0.0 .`
2. **部署到 GKE**：修改 `k8s/deployment.yaml` 中的 OTLP 地址、团队凭证、webhook token，`kubectl apply -f k8s/`。
   - 副本数必须为 1（状态在内存中）。
   - 日志直接写 stdout，由 GKE 送到 Cloud Logging，**不能经过你们自己的 OTel/Loki 管道**。
   - 让 Grafana 告警实例能访问到 `/webhook`（内部负载均衡或 Ingress）。
3. **Grafana**：把 `grafana/*.yaml` 放到 provisioning/alerting 目录。
   - 替换 `MIMIR_DATASOURCE_UID` 为探测服务所在租户的数据源。
   - 在 Grafana 上设置环境变量 `HEARTBEAT_WEBHOOK_TOKEN`。
4. **GCP**：`PROJECT_ID=... CHANNEL_ID=... ./gcp/setup.sh`。通知渠道必须独立于被监控的系统。

## 上线前需要核对

- **Mimir 中的指标名**：OTel 的 `heartbeat.probe.state` / `heartbeat.probe.id` 默认转换为 `heartbeat_probe_state` / `heartbeat_probe_id`。如果你们的转换方式加了后缀，改 `alert-rule.yaml` 中的查询。
- **`$values.B.Value` 是否可用**：在 Grafana 规则编辑页预览注解。如果取不到，加一个 Reduce 表达式 D（对 B 取 last），改用 `$values.D.Value`。
- **`printf "%.0f"` 不能省**：默认格式会变成 `1.76054e+09`，精度丢失，永远无法配对（服务会记为 `matched=false`，不会误判为成功）。
- **`notification_settings`** 需要 Grafana 支持按规则配置通知；否则删掉该段，在 UI 中加一条子策略：匹配 `probe=e2e`，发往 `heartbeat-probe-webhook`，group_wait 0s、group_interval 30s。
- **`noDataState` / `execErrState` 必须是 OK**：任何异常都应表现为"没有通知"，由 GCP 发现中断，而不是发出一条假通知。

## 设计上的取舍

- 探测 ID 放在指标的**值**里，不放在标签里，避免每次探测产生新的 series。
- 规则查询 A 带了新鲜度判断（样本超过 90 秒未更新就视为无数据），采集或写入中断时能更快暴露。
- 收到通知一律返回 200，避免 Grafana 无意义重试；配对结果只体现在日志里。

## 上线后演练

1. 停掉探测服务 → 预期收到 *Probe service not sending*。
2. 在 Grafana 中暂停该规则 → 预期收到 *Alerting pipeline broken*。
3. 在 Collector 中临时丢弃 `heartbeat_probe_*` → 同上。
4. 记录每次从故障到收到 GCP 告警的时间，作为告警链路的基线。

## 本地测试

```bash
pip install -r requirements.txt pytest
python -m pytest -q tests
```

集成测试会启动一个假的 OTLP 接收端解码 protobuf，模拟 Grafana 回调，验证指标名、凭证头、配对、鉴权和超时。
