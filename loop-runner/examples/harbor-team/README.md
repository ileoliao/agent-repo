# harbor-team:Jira 日报 + HarborSense 流量巡检 + 方案分析

这是一个 Loop Runner 工作区模板,**只包含 agent、策略和对接约定**。Jira、HarborSense、GitHub 的实际能力用你已有的 skill 和命令行,这里不重复实现。**请把 `examples/harbor-team` 本身作为文件夹用 VS Code 打开**(不是整个仓库)。

| 工作流 | agent | 什么时候跑 | 做什么 |
|---|---|---|---|
| 团队进度简报 | `briefer` | 工作日 08:30 | 用 `jira-board` skill 读看板,写 `.loop/outbox/briefs/<日期>.md`(中文),并与上一份简报对比 |
| 生产流量巡检 | `sentinel` | 每天 09:00、13:00、18:00 | 先跑**零 token** 的检查;只有异常才唤醒,写事故文件,交给 techlead |
| 方案分析 | `techlead` | sentinel 交接时 | 查 HarborSense 数据、GitHub 代码和文档,写分析和方案,**问你**选哪个;不改代码、不开 PR |

时间是本机本地时间。想改直接对 `@loop` 说,例如「把 sentinel 改成每 2 小时检查一次」。

```
sentinel ──(异常?)──▶ 事故文件 .loop/outbox/incidents/<日期>-<信号>.md ──▶ techlead
                                                                           │ 查数据 / 代码 / 文档
                                                                           ▼
                                   .loop/outbox/analysis/…-analysis.md ◀── 分析 + 方案
                                                                           │ ask_human(在控制台回答)
                                                                           ▼
                                                                  记录决定,结束
```

## 我假设你已经有的东西

把这些 skill 放进本工作区的 `.github/skills/`(复制或软链接都行)。**名字不同就改 agent 文件 `loop.skills` 里的名字**(`briefer` 一处、`sentinel` 两处:`skills` 和 `wakeIf` 路径、`techlead` 一处)。没放齐时,`Loop Runner: Reload & Validate Team` 会准确报出缺哪一个。

| 需要的 skill | 谁用 | 它必须做到 |
|---|---|---|
| `jira-board` | briefer | 能列出看板当前 sprint(或 kanban 的在途和近 7 天完成项),每条至少有:key、标题、状态、负责人、到期日、最后更新、解决时间、标签/阻塞。`SKILL.md` 里写清命令。 |
| `harbor-anomaly-detect` | sentinel | `scripts/detect.py --window 4h --exit-code`:**有异常退出 0 并在 stdout 打印详情**(信号、时间窗、观测值与基线/目标、correlation id / trace id 等锚点),**无异常退出 1**,**检查自己坏了退出其他值**。这是仓库示例里已经约定的零 token 协议。 |
| `harborsense-investigate` | techlead | 能按信号和时间窗查指标,以及按客户端/路径/trace id 查来源。`SKILL.md` 里写清命令。 |

GitHub 不需要 skill,techlead 直接用本机的 `gh` 和 git:

- **代码和文档放在 `repos/` 下的本地克隆**(例如 `git clone … repos/harbor-service`、`repos/harbor-docs`)。techlead 用 `git -C repos/<名> log/show/grep/blame/fetch` 和 `grep`/`rg` 读,也能 `read_file`。
- 没克隆的,用只读的 `gh`:`gh search code`、`gh repo view`、`gh pr view/list`、`gh api repos/…`(只能 GET)。
- 你本机的 `gh` 需要已登录;建议用只读权限的账号或令牌。

凭证用 `Loop Runner: Set Secret` 设成环境变量(不会进提示词,输出里会被脱敏),具体名字以你那几个 skill 的要求为准。

## 对 agent 的约束(都在 `.loop/policies/`)

- `briefer`、`sentinel`:只能运行自己 skill 的脚本,不能写文件(除 `.loop/outbox/`),也不能用网络命令。
- `techlead`:**只能读**。放行的命令只有 `ls/cat/head/tail/wc/grep/rg/jq`、受限的 `find`、`git -C repos/<名>` 的只读子命令(含 `fetch`)、只读的 `gh` 子命令。明确拒绝:所有 git 写操作(push、commit、checkout、reset、config 等)、`gh` 的创建/评论/合并/删除/登录、`gh api` 的非 GET、`curl/wget/ssh`、`rm`、`find -delete/-exec`、绝对路径和 `..`。拒绝优先于放行;批准也不能绕过。
- 三个 agent 都不能改自己的定义和 `.loop/` 的内容。

## 上线前先手动验证

1. 命令面板:`Loop Runner: Reload & Validate Team`,不应有任何报错。
2. 在本文件夹的终端里手动跑一次 `python3 .github/skills/harbor-anomaly-detect/scripts/detect.py --window 4h --exit-code`,看退出码是不是 0/1/其他三种之一,输出是不是你期望的。
3. 控制台 `Give a task…` 选 `briefer` 跑一次,看 `.loop/outbox/briefs/` 里的简报,核对数字。
4. 想看 sentinel → techlead 的整条链而当前没有异常:临时把你那个检测 skill 的阈值调到容易触发,验证完改回。

## 它不会做的事

- 不会把简报发到邮件或聊天:简报是文件,在控制台 Recent runs 里点开,或用 **Latest result** 打开。要推送需要另加一个发布 skill(并走审批)。
- techlead 不改代码、不开 PR、不评论。让它出补丁是下一阶段(分支加审批的 `fix-pr` 类 skill)。
- 简报里的数字由模型从 skill 的输出里数出来,因此我让它在不确定时写「约」;如果你要精确数字,建议让 `jira-board` skill 自己输出汇总。

## 测试

`npm test` 里的 `test/harbor-team.js` 用**占位的假 skill** 验证属于我们的部分:三个 agent 能加载并通过校验、缺 skill 时报错准确、定时正确、sentinel 的零 token 检查在退出码 0/1/3 下分别是「唤醒 / 不唤醒 / 告警」、techlead 的策略对 50 多条命令放行或拒绝符合预期。这**不证明**你的真实 skill 能对上约定,也**没有**让真实模型跑过这些 agent。
