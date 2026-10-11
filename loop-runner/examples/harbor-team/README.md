# harbor-team:Jira 日报 + HarborSense 流量巡检 + 方案分析

一个 Loop Runner 工作区模板,包含两条工作流。**请把 `examples/harbor-team` 本身作为文件夹用 VS Code 打开**(不是整个仓库)。

| 工作流 | agent | 什么时候跑 | 做什么 |
|---|---|---|---|
| 团队进度简报 | `briefer` | 工作日 08:30 | 读 Jira 看板,写 `.loop/outbox/briefs/<日期>.md`(中文) |
| 生产流量巡检 | `sentinel` | 每天 09:00、13:00、18:00 | 先做**零 token** 的检查;只有异常才唤醒,写事故文件,交给 techlead |
| 方案分析 | `techlead` | sentinel 交接时 | 查 HarborSense 数据、GitHub 代码和文档,写分析和方案,**问你**选哪个;不改代码、不开 PR |

时间都是本机本地时间,想改直接对 `@loop` 说,例如「把 sentinel 改成每 2 小时检查一次」。

```
sentinel ──(异常?)──▶ 事故文件 .loop/outbox/incidents/<日期>-<信号>.md ──▶ techlead
                                                                           │ 查数据 / 代码 / 文档
                                                                           ▼
                                   .loop/outbox/analysis/…-analysis.md ◀── 分析 + 方案
                                                                           │ ask_human(控制台里回答)
                                                                           ▼
                                                                  记录决定,结束
```

## 上线前要填的东西

脚本都只用 Python 3 标准库,不需要 pip。Windows 上如果没有 `python3` 命令,把 agent 文件里的 `python3` 改成 `python` 或 `py`。

**1. 凭证**(命令面板 `Loop Runner: Set Secret`;不会进入提示词,输出里也会被脱敏)

| 名字 | 用途 | 备注 |
|---|---|---|
| `JIRA_TOKEN` | Jira API token | Jira Cloud 还要设 `JIRA_EMAIL`(账号邮箱);Jira Server/Data Center 用个人访问令牌,**不要**设 `JIRA_EMAIL` |
| `JIRA_EMAIL` | 同上 | 仅 Jira Cloud |
| `HARBOR_PAT` | HarborSense 的访问令牌 | 只读即可 |
| `GITHUB_TOKEN` | GitHub 只读令牌 | 用 fine-grained token,只授权下面列出的仓库,权限只给 Contents 和 Metadata 的 read |

**2. 非密钥配置**(直接改文件)

- `.github/skills/jira-board/config.json`:`baseUrl`(如 `https://yourco.atlassian.net`)、`boardId`、可选的 `storyPointsField`(如 `customfield_10016`),以及 `blockedLabels` / `blockedStatuses` / `staleDays`。
- `.github/skills/harbor/config.json`:`baseUrl`,以及**接口形状**:`timeseries.path / params / points / time / value` 和 `breakdown`。这是我对 HarborSense 接口的**假设**(见下),与真实接口不同就改这里。`signals` 里列出要巡检的指标和阈值:`high`/`low` 是相对基线的倍数,`minBaseline` 防止基线太小时误报,`absoluteHigh` 是绝对上限。
- `.github/skills/github-readonly/config.json`:`allowedRepos`(techlead 能读的仓库,**只有这些**)和 `docsRepos`。现在是 `your-org/...` 占位符。

**3. 模型**:agent 文件没写 `model:`,会用 `loopRunner.modelFamily` 设置或第一个可用模型。需要固定时在 frontmatter 加 `model:`。

## 我对外部系统的假设(请核对)

- **Jira**:用 Agile REST API。Scrum 看板取当前 active sprint 的 issue;Kanban 看板取未完成加最近 7 天完成的。「阻塞」= 带 `blockedLabels` 里的标签、或状态名在 `blockedStatuses` 里、或有一个未完成的「is blocked by」链接。
- **HarborSense**:我不知道它的真实接口,所以做成可配置。默认假设是 `GET {baseUrl}/api/v1/metrics/query?signal=…&from=…&to=…&step=…` 返回 `{"data":{"points":[{"t":<epoch秒>,"v":<数值>}]}}`,`GET …/api/v1/traffic/top?by=client|path|status` 返回 `{"data":{"items":[…]}}`,Bearer 令牌。
- **异常的定义**:最近一个窗口(默认 4 小时)的平均值,对比前 N 天**同一时段**的平均值的中位数。基线不足 3 天会报 `dataGaps`,**不会**当成异常或正常。
- **GitHub**:`github.com` 的 REST API;企业版把 `apiUrl` 改成你的地址。代码搜索有延迟,且不索引很大的文件。

## 先手动跑一遍(推荐)

在这个文件夹里的终端:

```bash
python3 .github/skills/jira-board/scripts/digest.py                      # 看数字对不对
python3 .github/skills/harbor/scripts/detect.py --window 4h               # 看当前有没有异常
python3 .github/skills/harbor/scripts/query.py series --signal request_rate --from 2026-10-12T00:00:00Z --to 2026-10-12T09:00:00Z
python3 .github/skills/github-readonly/scripts/gh_read.py repos
```

退出码:`0` 成功(`detect.py --exit-code` 时表示有异常);`1` 无异常;`2` 配置或凭证问题;`3` 外部系统不可达或报错。**检查本身坏了(3)时运行时会告警并且不唤醒模型**,不会静默当成「一切正常」。

然后在控制台 `Give a task…` 选 `briefer` 先跑一次。想看 sentinel → techlead 的整条链,但此刻没有真实异常:把 `harbor/config.json` 里 `request_rate` 的 `high` 临时改成很小的值(比如 `0.1`)触发,验证完改回来。

## 它不会做的事

- 不会把简报发到邮件或聊天工具:简报是 `.loop/outbox/briefs/` 下的文件,在控制台 Recent runs 里点开,或用 **Latest result** 打开。要推送需要再加一个发布 skill(并走审批)。
- techlead 不改代码、不开 PR、不能访问允许列表以外的仓库,也不能直接用网络命令(策略禁止,网络只在 skill 脚本里)。要它出补丁是下一阶段(`fix-pr` 类 skill,走分支和审批)。
- agent 不能修改自己的定义和 `.loop/` 的内容;只有你(或你在 `@loop` 里点了 Apply 的提案)能改。

## 测试

`npm test`(在 `loop-runner/`)里的 `test/harbor-team.js` 用本地的 Jira、HarborSense、GitHub 模拟服务器跑这些脚本,覆盖统计、阻塞/逾期/过期、与昨天的对比、异常检测的各种退出码、基线不足、事故去重、仓库白名单。这只证明脚本按**上面假设的接口**工作,**没有**连过真实的 Jira、HarborSense 或 GitHub。
