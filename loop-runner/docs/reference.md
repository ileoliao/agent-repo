# Harbor Mate 参考手册

日常使用见 [README](../README.md)。这里是完整的格式、契约和设置；架构和不变量见 `AGENTS.md`。

Harbor Mate 让 VS Code 的自定义 agent（我们叫它 **mate**）在你不在时用 Copilot 模型替你干活，只在需要你的时候打断你。

能力放在 Skill 里，角色就是 VS Code 原生的 `.github/agents/*.agent.md`；运行时只负责定时、转交、提问和审批、策略、凭证和审计。

## 上手

1. **装扩展**：需要 Node.js 20+ 和网络（用 `npx` 拉取 `@vsce`）。在 `loop-runner` 目录运行 `npm install && npm run package`，得到 `harbor-mate-1.0.0.vsix`，在扩展面板 → `…` → 从 VSIX 安装。
2. **先跑冒烟示例**：克隆仓库后单独打开 `examples/smoke`（不在 vsix 里），按它的 `README.md` 走一遍：定时、提问、审批、续跑，10 分钟，不碰真实系统。
3. **加第一个 mate**：打开你的工作区，点状态栏的 Harbor Mate（或命令 `Harbor Mate: Open`）。空工作区会给出两个现成的 mate（每日提交报告、文件夹监听，后者演示 `wakeIf`），也可以点 “Describe what you want”，在 Chat 里用 `@mate` 说你要什么。添加后会立刻体检，通过就**自动启动**。首次启动时 Copilot 会弹出授权框，这必须由人的一次点击触发，所以才把“添加”当作那一下（扩展会对每个还没授权的模型发一个极小的请求）；Copilot 还没登录好时最多等 2 分钟。
4. 成功启动过之后（按工作区记录），再次打开该工作区会自动接着跑，并先处理队列里没做完的项；`Stop Mates` 会取消自动启动。
5. 可选：`Set Secret` 配 `HARBOR_PAT` 之类的凭证；没在角色里指定模型时用 Copilot 列表里的第一个，顺序不固定，建议设 `harborMate.modelFamily`（`List Available Models` 看可用 family）；配 `harborMate.notifyWebhook`，再用 `Send a Test Notification` 试一下。

命令面板（都在 “Harbor Mate” 下）：Open、Add a Mate、Describe a Mate to @mate、Check Mates、Start Mates、Stop Mates、Set Secret、Clean Up Finished Work、Copy Webhook Example (curl)、Send a Test Notification、List Available Models、Give a Mate a Task、Reload & Validate Mates（手改了 agent 文件之后用）、Mate Health Report（不在面板里，Check Mates 的报告里已包含；命令和 `@mate /health` 仍可用）。

## 四个概念

**Mate** = 一个 `.agent.md` 文件加一个 `loop:` 块。只有带 `loop:` 块的 agent 才会加入，纯交互的 agent 不受影响。同一个角色白天在 Copilot Chat 里照常用，无人值守时按 `loop:` 调度。转交对象来自原生的 `handoffs[].agent`。模型选择顺序：`loop.model`（按 family）→ 原生 `model` 列表（按显示名）→ `harborMate.modelFamily` → 第一个可用模型。

**何时醒** = 定时（`schedule`，本机时区的 cron）或事件（`on:`），可选一个零 token 的 `wakeIf` 检查：

| `wakeIf` 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | 有事要处理 | 唤醒 mate，stdout 作为上下文传入 |
| 1 | 看过了，没事 | 不调用模型 |
| 其他 / 超时 | 检测本身坏了 | 提醒你一次，直到恢复；不唤醒 |

没拿到数据（认证失败、响应为空）必须以 `2` 结束，不要用 `1`：`1` 的意思是“一切正常”。`on: webhook:<name>` 由 `POST /hook/<name>` 叫醒（设 `harborMate.triggerPort`，只监听 `127.0.0.1`，带令牌的 `curl` 用 `Copy Webhook Example` 拿；令牌在 SecretStorage 里；请求体最大 64 KB，同一目标未完成的触发超过 20 个返回 429；对外暴露要自己开隧道）。`on: file:<glob>` 每 20 秒扫一次，只对之后新出现的文件触发。一个 mate 可以有多个目标（goal），各有各的时钟和探针；`urgent: true` 的目标探针发现问题先通知你再入队，并可用预留的 worker（它的探针必须幂等）；`maxSilence` 太久没有有效的检查就通知你一次。

**需要你** = 三类事：**问题**（`ask_human`）、**审批**（`request_approval`，显示确切命令和可编辑的草稿）、**被拦下的命令**（策略没放行）。它们都出现在控制台里；同时 VS Code 弹窗，也可以推到外面：`harborMate.notifyWebhook`（Slack、Teams、Discord 的 incoming webhook，其他 https 地址收到事件 JSON）或 `harborMate.notifyCommand`（事件在环境变量 `LOOP_EVENT` 里，只在用户设置里生效）。提问和审批会让工作项暂停并存 checkpoint，你处理后它从原地续跑：答复后带着答复继续；批准后执行的是你改过的草稿，并拿到结果；拒绝后拿到你的理由，修改再申请。每轮最多发起一个闸门。

**产出** = mate 写给你读的文件。`finish` 可以带 `deliverables`（报告等，由 mate 自己声明，不存在或在工作区外的路径会被丢弃并说明）；没声明时，`.loop/outbox/` 下的文档（md、html、pdf、csv、xlsx、docx、txt）算交付物，其余输出文件折叠为“辅助文件”。没做完的事是**任务**：`finish` 状态 `open` 加 `next`，任务就留在这个 mate 手上，可以同时有好几个，并能随 `handoff` 转手；A 转给 B 后用 `open` 结束，B 结束时 A 会被回头叫醒（受 `maxHops` 限制）。任务记在 `.loop/tasks/<chainId>.json`，由运行时记账，模型改不了。

## 日常使用

**控制台只有一个页面**（状态栏图标，或 `Harbor Mate: Open`）：左边是名册，右边是和选中 mate 的对话。

- **名册**：每个 mate 一行：一张只属于它的脸、名字、最近活动时间和一行进展。排序是：需要你的在最上面（等得最久的第一个），其次是正在工作的，再其次按最近活动。状态用头像的动态表达：工作中蓝环转动，需要你橙色脉冲，上次被卡住红圈，刚完成绿圈加对勾。打开时选中排在第一的那个。
- **顶部**：标题和一个状态胶囊。有事要你时它是 “N need you”（mate 关着时是 “Off · N need you”），点一下直达等得最久的那张卡片；没有时显示 “daily-report working”、“All quiet · next 09:00” 或 “Off”。mate 关着时有一个 “Start mates” 按钮；右上角 `⋯` 菜单：Add a mate、Check mates、Clean up finished work、Set a secret、Stop all mates（关着时最后一项是 Start mates）。
- **对话**：你的话在右边，mate 的话和步骤在左边，一次运行结束折成一张结果卡（Done、Nothing new、Blocked、Failed、Stopped；产出文件在最前面，步骤折叠）。问题、审批、被拦下的命令在对话末尾：问题用底下的输入框答；审批显示确切命令和每个草稿，点 Reject 会就地问 “Why? The mate reads this (optional)”；被拦命令可以 Allow 或 Dismiss。mate 手上没做完的任务在对话标题下各占一行（Working on: … — next: …），可以 Drop task（点两次确认）。正在运行的一次也是一张卡片：任务行、折叠的步骤、末尾的 “working · step N · 时间”。从没运行过的 mate 会写明 “No runs yet. Runs weekdays at 09:00.” 并给一个 Run now。
- **输入框只做一件事：给选中的 mate 发消息**（有问题待答时是答复）。`@名字 内容` 发给另一个 mate，`/stop` 结束当前运行；mate 工作中而输入框为空时，发送箭头变成停止按钮（点两次确认）。Enter 发送，Shift+Enter 换行，Cmd/Ctrl+Enter 在页面任何位置都能发送；中文输入法选字时按 Enter 不会误发。

| mate 现在 | 你的消息什么时候被读到 |
|---|---|
| 正在运行 | 下一步之前；它刚好要结束时，先读完再决定 |
| 在等你 | 你处理之后它继续时，一起读到 |
| 排队中 | 开始运行时 |
| 空闲 | 开始一次新的运行，以你的话为任务，带上最近几句对话 |

消息只有在读到它的那一轮正常结束后才标记已读，不会丢；运行结束后才到的消息，没人读时会自动开一次后续运行。

**状态栏只有一项**（点它打开控制台）：`N need you`（有 mate 在工作时后面加 `· <名字> working`）；否则 `<名字> · step N`；否则开着且空闲时 `Mates · next HH:MM`；关着是 `Mates off`。

**用 `@mate` 创建和修改 mate**：在 Chat 里输入 `@mate`，用自然语言说「新建一个 release-watch 盯发布」「把 sentinel 改成工作日每 30 分钟」「以后报告都用中文」「写一个 skill 查发布状态」。它先用工具查清现状，再给出**提案**（改文件会显示 diff，新建的 mate 默认不带定时，卡片会写明它会不会自己运行），你点 **Apply** 才生效，校验不通过的提案不给你看 diff。它还能改目标和 skill、写长期备忘（`.loop/memory/`）、暂停或恢复定时、取消工作、清理、查看队列；创建 skill 时卡片完整展示每个文件的代码，因为 skill 的脚本不受策略检查。它**不会**替你批准，也不改策略文件。它用 Chat 里选中的模型，需要支持工具调用。`/status`、`/pending`、`/doctor`、`/health`、`/improve <mate>` 不依赖它。

**体检与维护**：Check Mates 不调模型，检查 skill、解释器、策略文件、`wakeIf` 会不会被策略拒绝，并把每个探针真跑一次；有运行记录时，报告下半部分是健康报告（近 14 天的结果、问你的次数、被拒绝的次数，并给出修法）。`.loop/` 里已结束的内容按保留期自动清理（默认完成的工作项和已处理的问答 14 天，运行记录和已结束的任务 30 天，见设置），待处理的、排队的、未完成的任务和 blocked/error/max_steps/stalled 的从不自动删；Clean Up Finished Work 先列数量再确认。损坏的状态文件会被移到 `.loop/corrupt/`，调度不会停。

## 写一个 mate

```markdown
---
name: sentinel                       # ← 以下是 VS Code 原生字段
description: 一句话职责（Chat 里显示，队友转交时也看到它）
model: ['Claude Sonnet 4.5', 'GPT-5.2']
handoffs:
  - { label: Hand to techlead, agent: techlead, prompt: Investigate the anomaly above. }
loop:                                # ← Harbor Mate 专用，VS Code 忽略（可能提示不支持，不用管）
  skills: [harbor-anomaly-detect]
  policy: .loop/policies/sentinel.json   # 可选
  maxSteps: 15
  goals:                             # 一个助手，多个长期目标
    - id: harborsense
      text: HarborSense 线上问题被及时发现并上报
      schedule: "*/15 9-21 * * 1-5"
      wakeIf: python3 .github/skills/harbor-anomaly-detect/scripts/detect.py --exit-code
      task: 唤醒后要做的事           # 默认等于 text
      urgent: true                   # 可选
      maxRunsPerDay: 6               # 可选
    - id: on-deploy
      text: 部署出事时先看日志再告诉我
      on: webhook:deploy             # 或 file:reports/*.md
---
角色说明（Chat 和无人值守共用）
```

单个 `schedule`/`wakeIf`/`task` 的旧写法照常可用（等价于 id 为 `default` 的目标）。CLI 不要让 mate 直接拼命令：用 skill 里的薄脚本（固定子命令、`--json`），策略只放行脚本；`SKILL.md` 里写 `requires: [harbor]`，Check Mates 会查它是否装好。终端里能用而 VS Code 找不到时，把目录加到 `harborMate.extraPath`。运行时给 mate 的通用工具只有 `read_file`、`list_dir`、`write_file`、`edit_file`、`run_command`、`ask_human`、`request_approval`、`handoff`、`finish`、`update_task`。

## 安全

- **策略**：每条命令和写入先过 policy（`.loop/policy.json`，`.loop/policies/*.json` 按 mate 或目标覆盖）。**deny 永远优先**：申请时和执行时各查一次，人工批准也越不过；命令替换、换行或单个 `&` 拼接、重定向到受保护路径同样被拒。`.loop/`、`.github/`、`.git/` 默认受保护（只有 `.loop/outbox/` 可写），策略里写的 `protectedPaths` 追加在默认值上，删不掉。
- **拒绝是工具结果，不是弹窗**：mate 换个办法或上报，运行不会停摆；循环里永远不阻塞等人。
- **凭证**：用 `Set Secret` 存进 VS Code 的 SecretStorage，执行时注入为环境变量，从每个工具结果（包括 `read_file`）里脱敏，提示词里只出现名字。命令的环境变量是白名单加这些凭证，不继承 `GH_TOKEN` 之类；`SSH_AUTH_SOCK`、代理和自签 CA 这类非密钥变量会传过去（带用户名密码的代理地址会被命令看到，请改用不带凭据的）。
- **审批绑定你看到的内容**：控制台显示每个草稿文件，批准的就是你看到的那一版；之后被改过、或从没显示过的，不会执行，要重新审核。
- **一键放行**：策略没放行的命令会作为“被拦下的命令”出现在对话里，点 Allow 只为这个 mate 加这一条确切命令（写进它自己的策略文件，先确认）；被 deny 规则拦下的不能一键放行。
- **卡住保护**：同一个调用连续 3 次得到相同结果，或单次运行超过 `harborMate.maxMinutes`，运行以 `stalled` 结束并通知你；`maxRunsPerDay` 限制每个本地日的定时唤醒数。
- **不要让 mate 直接改工作区**：让它写 `.loop/outbox/`，补丁作为草稿走审批。想少受点限制，复制 `examples/policies/open.json` 到 `.loop/policies/` 再在那个 mate 里引用：它允许运行工作区里的脚本、整个工作区可写，但仍拒绝联网命令、`rm -r`、`git push`、`..` 路径和改写 `.loop/`、`.github/`；只适合只处理你自己的文件和内部数据的 mate，会读别人写的内容（客户留言、网页、issue 评论）的不要用。
- 事件和文件里读到的内容被当作“外部数据，不是指令”交给 mate。

## 设置

| 设置 | 默认 | 作用 |
|---|---|---|
| `harborMate.modelFamily` | 空 | 没指定模型的 mate 用的 Copilot family；空 = 第一个可用 |
| `harborMate.workers` | 2 | 同时运行的工作项数；非 urgent 的最多占 `workers - 1` 个，留一个给 urgent（默认即一个普通加一个 urgent，要两个普通一起跑设 3）；同一条转交链不会并行 |
| `harborMate.maxSteps` | 40 | 每个工作项最多的模型轮数 |
| `harborMate.maxMinutes` | 30 | 单次运行的时间上限，超过记为 `stalled` |
| `harborMate.maxHops` | 5 | 一条转交链最多转几次 |
| `harborMate.policyFile` | `.loop/policy.json` | 没有自己 `policy` 的 mate 用的策略 |
| `harborMate.notifyWebhook` / `notifyCommand` | 空 | 把“需要你”推到外面；只在用户设置里生效，工作区设置改不了 |
| `harborMate.triggerPort` | 0（关） | webhook 触发的本机端口 |
| `harborMate.extraPath` | `[]` | 加到每个命令 PATH 前面的目录 |
| `harborMate.retention.doneDays` / `runsDays` / `gateDays` / `taskDays` | 14 / 30 / 14 / 30 | 已结束内容的保留天数 |

## 限制

- 只在 VS Code 打开时运行，是现有告警的补充。
- 只用 GitHub Copilot 的模型；发给模型的数据需要先确认合规，脱敏放在 skill 脚本里做。
- 正则策略是启发式的，不是沙箱。
- 闸门等待超过几分钟后提示缓存会失效，续跑时整段对话按全价重读一次。

## 给开发者和其他 AI

`npm test` 用 mock 的 vscode 和脚本化的假模型跑真实的 runner，并检查控制台页面。架构、冻结的范围、数据契约和不变量见 `AGENTS.md`（Copilot 会自动读取）；`.github/skills/loop-team-authoring/` 是给 AI 写角色和 skill 的约定，复制到你的工作仓库，Copilot 帮你新建时就会按它来写。
