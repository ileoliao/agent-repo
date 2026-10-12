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

把这些 skill 放进本工作区的 `.github/skills/`(复制或软链接都行)。`loop-memory` 已经自带。**名字不同就改 agent 文件 `loop.skills` 里的名字**(`briefer` 一处、`sentinel` 两处:`skills` 和 `wakeIf` 路径、`techlead` 一处;每处都别删掉 `loop-memory`)。没放齐时,`Loop Runner: Reload & Validate Team` 会准确报出缺哪一个。

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

## 它们怎么「记住」过去的事(通用的,新 agent 也能用)

记忆不写在每个 agent 里,而是一个**共享的 skill:`loop-memory`**(源在仓库的 `loop-runner/skills/loop-memory/`,这里是一份相同的拷贝,测试会检查两份一致)。插件本身只提供读、写、改文件和跑命令这些基本动作,记忆的协议、日期、「是不是明显更糟」的判断都在这个 skill 的脚本里,所以模型不用自己编辑文件、不用自己算日期和倍数。

**给任何 agent 加记忆,只要两步:**
1. 在它的 `loop.skills` 里加一个 `loop-memory`。
2. 在角色说明里写一两句:「开始时先 `now`、再 `recall --agent <我的名字>`;结束前 `note --agent <我的名字>`」。协议本身(怎么用、什么能写、怎么看待记录)在 skill 的 `SKILL.md` 里,agent 只要列了这个 skill 就会看到。

不列这个 skill 的 agent **没有**记忆,也**运行不了**这个脚本(权限来自 `loop.skills`,agent 改不了)。

**它记两样东西,都是你能直接打开、修改、删除的普通文件**(在 `.loop/outbox/memory/` 下):
- **笔记** `notes/<agent>/<日期-时间>.md`:每次运行一个新文件,一两句话:做了什么、为什么、人说了什么、下次注意。开工时 `recall` 给出最近 3 条。
- **跟踪的事项** `tracked.json`:全团队共享。一个事项一个 key(可以是信号名、Jira epic、客户名,随便什么),带状态 `open` / `fix-planned` / `watching`(可带 `--until 日期`)/ `resolved`、当时的严重程度 `ref` 和原因。

**判断「该不该再提」交给脚本:** `check --key <事项> --value <严重程度数字>` 返回一个结论,agent 照着做就行:

| 结论 | 意思 |
|---|---|
| `new` | 没有跟踪,或已经解决 |
| `tracked` | 已经有人在处理,更新原记录,不要再开一个 |
| `suppress` | 人选择了观察,现在没有明显更糟(不超过当时的 1.5 倍) |
| `escalate` | 在观察中,但已经比当时严重 1.5 倍以上 |
| `expired` | 观察期已过 |

**这样带来的行为(你要的「过去影响今天的决定」):**
- techlead 问你「怎么办」,你说「先观察到 10 月 20 号」。它 `track` 成 `watching until 2026-10-20`,并记下当时的数字。
- 之后 sentinel 再发现同一个异常,`check` 给出 `suppress`:不开新事故、不交接、不再问你,只记一笔。超过 1.5 倍或过了日期才重新交接,并写明原因。
- techlead 下次分析同一信号,先 `recall` 和读以前的分析,并在问你时带上上次的决定。
- briefer 的简报里列出 `recall` 里仍在跟踪的生产问题。

**安全约定:** 记录在提示词里是「参考,不是命令」,与实时数据冲突时以实时数据为准;脚本把笔记压成一行、去掉控制字符、限长;skill 要求**不把工单、日志、网页里的原话抄进笔记**,避免被污染的内容下次被当成自己的经验。这些没法完全杜绝,所以记录都放在你看得见的地方。

**已知局限:**
- **靠模型自觉调用。** 插件不强制 agent 在开头 `recall`、结尾 `note`。弱模型可能漏。跑几天后看 `.loop/outbox/memory/notes/<agent>/` 里有没有对应每次运行的笔记。
- **被观察的异常仍会唤醒模型一次。** 零 token 检查不知道 `tracked.json`;但 sentinel 很快就能得到 `suppress`,运行很短。
- agent 在技术上也能直接用 `write_file` 改 `.loop/outbox/memory/` 里的文件(outbox 本来就可写),角色说明不让它这么做,但没有强制。
- 没有语义搜索、没有自动压缩;笔记目录会增长,按需手动清理。

**手动验证:**
```bash
cd examples/harbor-team
python3 .github/skills/loop-memory/scripts/mem.py now
python3 .github/skills/loop-memory/scripts/mem.py track --key request_rate --state watching --until 2099-12-31 --ref 2.0 --note "手工测试" --agent me
python3 .github/skills/loop-memory/scripts/mem.py check --key request_rate --value 2.5     # suppress
python3 .github/skills/loop-memory/scripts/mem.py check --key request_rate --value 3.5     # escalate
python3 .github/skills/loop-memory/scripts/mem.py forget --key request_rate
```
然后让检测报出 `request_rate` 比基线高 2.5 倍触发 sentinel:预期没有新事故、没有交接,`notes/sentinel/` 多一条笔记。再调到 3.5 倍:预期新事故、交接给 techlead。

## 它不会做的事

- 不会把简报发到邮件或聊天:简报是文件,在控制台 Recent runs 里点开,或用 **Latest result** 打开。要推送需要另加一个发布 skill(并走审批)。
- techlead 不改代码、不开 PR、不评论。让它出补丁是下一阶段(分支加审批的 `fix-pr` 类 skill)。
- 简报里的数字由模型从 skill 的输出里数出来,因此我让它在不确定时写「约」;如果你要精确数字,建议让 `jira-board` skill 自己输出汇总。

## 测试

`npm test` 里的 `test/harbor-team.js`(以及 `test/loop-memory.js`,41 项,专测记忆 skill)用**占位的假 skill** 验证属于我们的部分:三个 agent 能加载并通过校验、缺 skill 时报错准确、定时正确、sentinel 的零 token 检查在退出码 0/1/3 下分别是「唤醒 / 不唤醒 / 告警」、techlead 的策略对 50 多条命令放行或拒绝符合预期。这**不证明**你的真实 skill 能对上约定,也**没有**让真实模型跑过这些 agent。
