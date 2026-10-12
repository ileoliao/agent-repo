# Loop Runner 1.0

让 VS Code 自定义 agent 在无人值守下运行的最小运行时，使用 Copilot 模型。

**分工**：能力在 Skill 里，角色就是 VS Code 原生的 `.github/agents/*.agent.md`。Loop Runner 只补 VS Code 原生缺的那一层：

- 定时触发，并在启动模型前做零 token 的唤醒检查
- 角色之间转交
- 提问和审批闸门，处理完从原地续跑
- 策略、凭证、审计

**范围已冻结。** 交互式协作（在 Chat 里跟某个角色对话）直接用 VS Code 原生功能，不在这里重做。

## 同一个角色，两种用法

```markdown
---
name: sentinel                       # ← 以下为 VS Code 原生字段
description: 一句话职责（Chat 里显示，也是队友转交时看到的说明）
model: ['Claude Sonnet 4.5', 'GPT-5.2']
handoffs:
  - label: Hand to techlead
    agent: techlead
    prompt: Investigate the anomaly above.
loop:                                # ← Loop Runner 专用，VS Code 不使用
  skills: [harbor-anomaly-detect]
  schedule: "*/15 9-21 * * 1-5"      # 本机时区的 cron
  wakeIf: python3 .github/skills/harbor-anomaly-detect/scripts/detect.py --exit-code
  task: 唤醒后要做的事
  policy: .loop/policies/sentinel.json   # 可选
  model: claude-sonnet-4.5           # 可选：无人值守时强制指定的模型 family
  maxSteps: 15
---
角色说明（两种模式共用）
```

- **白天**：在 Copilot Chat 的 agent 下拉框里选 `sentinel`，跟它对话，按钮式转交给 techlead
- **无人值守**：Loop Runner 按 `loop:` 块来调度
- 只有带 `loop:` 块的 agent 才会加入团队，纯交互的 agent 不受影响
- 转交对象来自原生的 `handoffs[].agent`
- 模型选择顺序：`loop.model`（按 family 匹配）→ 原生 `model` 列表（按显示名匹配）→ 设置 `loopRunner.modelFamily` → 第一个可用模型
- 打开文件时 VS Code 可能会提示 `loop` 字段不受支持，可以忽略

## wakeIf：没事时不花 token

定时触发时，先按策略运行 `loop.wakeIf`，运行时只看退出码：

| 退出码 | 含义 | 处理 |
|---|---|---|
| 0 | 有事要处理 | 唤醒 agent，脚本的 stdout 作为上下文传入，agent 不必再检测一遍 |
| 1 | 没事 | 不调用模型 |
| 其他 / 超时 | 检测本身坏了 | 提醒你一次，直到恢复；不唤醒模型 |

检测逻辑完全在你的 skill 脚本里，只要给它加一个 `--exit-code` 模式即可。

## 和你协作：提问、审批、续跑

- **`ask_human`**：agent 拿不准时提问，附上它的判断和选项
- **`request_approval`**：需要签字的动作，给出确切命令和可编辑的草稿

两者都会让工作项暂停，并把对话存成 checkpoint。你在资源管理器的 **Loop Inbox** 里处理后，它从原地续跑，之前的上下文都还在：

- 答复后：拿到你的答复继续
- 批准后：执行的是你改过的草稿，并拿到执行结果继续
- 拒绝后：拿到你的反馈修改，再重新申请

其他规则：

- 每轮最多发起一个闸门
- deny 规则在申请时和执行时各检查一次，人工批准也越不过 deny 列表

**通知**：有新问题或审批、工作项 blocked 或出错、`wakeIf` 失败时，VS Code 会弹窗。要推到 VS Code 外，在用户设置里配置 `loopRunner.notifyCommand`，指向你的通知 skill 脚本；事件放在环境变量 `LOOP_EVENT`（JSON）里。

## 运行时给 agent 的通用工具

`read_file`、`list_dir`、`write_file`、`edit_file`、`run_command`、`ask_human`、`request_approval`、`handoff`、`finish`

- 具体能做什么由 skill 决定；分配给某角色的 skill 的 `scripts/` 对它自动放行
- 原生的 `tools` 字段只作用于 Chat 模式；无人值守时的权限由 policy 决定

## 目录

```
.github/agents/*.agent.md            角色（VS Code 原生格式 + loop: 块）
.github/skills/<skill>/              能力（也识别 .agents/skills、.claude/skills、.loop/skills）
.loop/policy.json                    默认策略；.loop/policies/*.json 按角色覆盖
.loop/outbox/                        agent 写草稿的地方，你可以编辑
.loop/queue/<agent>|_waiting|_done   工作项
.loop/gates/                         收件箱（问题、审批）
.loop/checkpoints/                   暂停时的对话快照
.loop/runs/<date>/<chainId>.jsonl    审计，一条转交链一个文件；wake-<date>.jsonl 记录每次唤醒检查
```

## 设计说明

**三条原则**

- 运行时不懂业务
- 状态全部放在 `.loop/` 的文件里
- 模型只能通过工具接触外界，每个工具都先过策略

**模块与职责**

| 模块 | 职责 | 依赖 vscode |
|---|---|---|
| `frontmatter.ts` `team.ts` | 解析角色和 skill，校验团队，选择模型 | 否 |
| `cron.ts` `wake.ts` | 定时匹配，按 wakeIf 退出码决定是否唤醒 | 否 |
| `queue.ts` | 工作项、闸门、checkpoint、审计，全部存为文件 | 否 |
| `policy.ts` `exec.ts` | 命令和写入的准许或拒绝；执行、超时和杀进程树来自 pi，凭证注入、环境变量白名单和脱敏仍是这里的 | 否 |
| `vendor/pi/` | 引入的 pi 本地工具（读、写、改、列目录、shell） | 否 |
| `gates.ts` | 处理答复、批准执行、拒绝；通知 | 否 |
| `tools.ts` | 通用工具的定义和执行 | 仅类型 |
| `runner.ts` | 单个工作项的 agent 循环：运行、暂停、续跑 | 是 |
| `inbox.ts` `extension.ts` | 收件箱界面；调度 tick、单 worker、命令、通知 | 是 |

**一个工作项的一生**

1. 定时触发后先跑 `wakeIf`，有事才入队
2. 单 worker 按先来先处理取出工作项
3. `runner` 循环：发请求、执行工具调用、把结果喂回，直到出现以下情况之一：
   - `handoff`：同一 `chainId` 进入队友的队列
   - 闸门：存 checkpoint，工作项进 `_waiting`
   - `finish`：结束
4. 你在收件箱处理后，结果写入闸门，工作项被唤醒，从断点续跑

**不能破坏的不变量**（完整的 11 条见 `AGENTS.md`）

- 拒绝是一个工具结果，不是异常或弹窗
- 循环里永远不阻塞等人
- deny 规则优先于一切，人工批准也越不过。命令替换、换行或单个 `&` 拼接、把输出重定向到受保护路径，同样越不过
- 凭证永远不进提示词，也不会从父进程环境变量继承进去；读文件的结果同样会脱敏
- 对话以纯数据保存，续跑时逐字节重放
- 提示词静态部分在前，保护缓存

## 给其他 AI 用

| 文件 | 给谁 | 作用 |
|---|---|---|
| `AGENTS.md` | 维护本仓库代码的 AI | 架构、冻结范围、数据契约、不变量、改动清单。Copilot 等工具会自动读取 |
| `.github/copilot-instructions.md` | 本仓库里的 Copilot | 指向 `AGENTS.md` 和 authoring skill |
| `.github/skills/loop-team-authoring/` | 为团队写角色和 Skill 的 AI | 角色文件模板、skill 脚本约定、wakeIf 契约、策略写法、交付前检查清单。**复制到你的工作仓库**，Copilot 帮你新建角色或 Skill 时就会自动按约定来写 |

## 上手

0. **先装好扩展**：本机需要 Node.js（20 或更高）和网络（会用 `npx` 拉取 `@vsce`）。克隆仓库后在 `loop-runner` 目录运行 `npm install && npm run package`，得到 `loop-runner-1.0.0.vsix`；在扩展面板 → `…` → 从 VSIX 安装。
1. **先跑冒烟测试**：克隆本仓库后，单独打开源码里的 `examples/smoke`（不在 vsix 里），按该目录的 `README.md` 操作。10 分钟走通安装、模型、定时、提问、审批和续跑，不碰任何真实系统
2. 把示例的 `.github/agents/` 和 `.loop/policies/` 复制到工作区，按实际 skill 名修改
3. 运行 `Loop Runner: Reload & Validate Team`，会报告缺失的 skill、无法无人值守的转交目标、写错的 cron
4. 运行 `Loop Runner: Set Secret` 配置 `HARBOR_PAT`、`JIRA_TOKEN` 等凭证
5. 运行 `Loop Runner: Start Team`。首次会弹出 Copilot 授权，必须由人点这个命令来触发：授权框在 Start Team 时就会弹出（扩展会对每个还没授权的模型发一个极小的请求），不会拖到第一次无人值守的唤醒。如果此时 Copilot 还没登录好、模型列表为空，会最多等 2 分钟，仍为空就报错，登录好后重新 Start Team。成功启动过之后（按工作区记录，互不影响），再次打开该工作区会自动接着跑，并先处理队列里没做完的项。`Stop Team` 会取消这个自动启动
   - `gh`、`git push` 需要的令牌（`GH_TOKEN`、`GITHUB_TOKEN` 等）不会从 VS Code 的环境继承，请用 `Set Secret` 配置。`SSH_AUTH_SOCK`、DBus、代理（`HTTP(S)_PROXY`、`NO_PROXY`）和自签 CA（`NODE_EXTRA_CA_CERTS`、`SSL_CERT_FILE`）这类非密钥变量会传给命令
   - 代理地址里如果带了用户名密码，会被命令看到，建议改用不带凭据的代理或单独的 skill 脚本
   - 没有在角色里指定模型时，用 Copilot 列表里的第一个，顺序不固定。建议先设置 `loopRunner.modelFamily`（`List Available Models` 能看到可用的 family）
6. 可选：配置 `loopRunner.notifyCommand`，用 `Send a Test Notification` 测试

**日常使用**：状态栏左侧有几个按钮，一点即可：
- `Loop`：显示团队状态和待处理数量，点击打开收件箱。
- `Start` / `Stop`：启动或停止团队，按钮文字随状态切换。
- `Result`：打开最新结果（`.loop/outbox/` 下最近修改的文件）。
- `☰`：打开完整菜单，包含重新加载、派任务、查看状态，以及设置凭证、列出模型等不常用的操作。这些命令在命令面板里被隐藏，但仍可通过菜单使用。

收件箱（侧边栏 Loop Inbox）从上到下：

- **待你处理**：问题和审批，可直接回答、批准或拒绝。
- **Agents**：团队里每个 agent 的状态（running / waiting / idle）、下次运行时间和上次唤醒检查的结果。点一行打开 agent 文件。
- **Recent runs**：最近 15 次运行，显示 agent、状态、步数、时间和摘要。展开一条可以看到它写过的文件，点文件直接打开；点运行本身打开审计日志（JSONL）。

状态栏会显示当前在做什么：`Loop: <agent> · step N`，空闲时显示 `Loop · idle · next HH:MM`。`Result` 按钮打开最近一次运行写出的文件，并说明是哪个 agent、哪次运行产生的。

## 测试

`npm test`：mock 的 vscode 加脚本化的假模型，跑真实的 runner。覆盖：

- 原生格式解析、模型选择
- `wakeIf` 的四种情况
- 转交、被拒后继续
- 三条续跑路径：答复、拒绝附反馈、批准执行
- 通知、凭证脱敏、超时、stdin 关闭、审计
- 命令拼接、重定向到受保护路径、进程树超时、凭证不从环境继承、批准时再次拒绝命令替换、Windows shell 选择
- 冒烟测试工作区按角色说明完整跑一遍（`scripts/py.js` 在 `python3` / `python` / `py` 里自己挑）
- 错过的 cron、`read_file` 的 `startLine` 续读、`list_dir` 的 `limit`、请求一律用 Auto（Copilot 在响应流里才拒绝 Required，假模型在流里抛错也不会让工作项出错）、上下文超限不当作限流、被中断的项从上一轮续跑而不重复转交、答复在同一轮内到达也能续跑、长输出保留真正的尾部、睡眠期间错过的 cron 补跑一次、取消不记成完成

## 限制

- 只在 VS Code 打开时运行，是现有告警的补充
- 单 worker，按先来先处理串行执行
- 闸门等待超过几分钟后，提示缓存会失效，续跑时整段对话按全价重读一次
- 正则策略是启发式的，不是沙箱
- 发给模型的数据需要先确认合规，脱敏放在 skill 脚本里做

## 控制台 (Loop Console)

状态栏左侧的 Loop 项或命令 `Loop Runner: Open Console` 会打开一个页面:顶部是运行状态和 启动/停止/下任务 按钮;「Needs you」里直接回答问题、批准(显示将要执行的完整命令)或拒绝;下面是各 agent 的状态,以及每次运行的步骤时间线和产出的文件(点击打开)。页面每 5 秒自动刷新。

## 防护与写权限建议

- **卡住保护**:同一个调用连续 3 次得到相同结果,或单次运行超过 `loopRunner.maxMinutes`(默认 30 分钟),运行会以 `stalled` 结束并通知你。
- **每日上限**:agent 的 `loop:` 里可加 `maxRunsPerDay: 4`,限制每个本地日的定时唤醒次数。
- **审批绑定内容**:在控制台批准时,页面显示每个草稿文件的内容,批准的是你看到的那一版;文件之后被改动则不会执行,需要重新审核。
- **不要让 agent 直接改工作区**:让 agent 只写 `.loop/outbox/`,把补丁作为草稿放进审批;应用补丁用一个受审批的 skill(在 `loop/<agent>/<item>` 分支的 worktree 里应用并开草稿 PR)。给任何 loop 写权限之前,先在一次性仓库里跑 `npm test` 里的 planted-secret 检查。

## 在 Chat 里和 agent 对话:`@loop`

在 VS Code 的 Chat 窗口输入 `@loop`,可以:

- `@loop /status`:团队、各 agent 的状态、定时和下次唤醒。`@loop /pending`:等你处理的问题和审批。
- 直接说话,例如「把 sentinel 改成工作日 9 点到 18 点每 30 分钟跑一次」「以后所有报告都用中文」「让 collector 现在跑一次,查一下磁盘」「他们问的那个问题,回答 mac-mini」。
- 它先用工具查清现状,然后给出**提案**:改定时/任务/角色指令会显示 diff,长期要求会写成备忘,一次性任务和回答也一样。你点 **Apply** 才生效,点 Dismiss 就作废。它自己不会改文件、不会运行 agent、不会替你回答。
- **备忘**保存在 `.loop/memory/<agent>.md`(`_all.md` 对所有 agent 生效),之后每一次新的运行都会把它放进提示词。想看或改,直接打开这个文本文件。
- **审批**不在聊天里决定:要在控制台看清完整命令和文件内容后再批准。
- 它用的是 Chat 模型选择器里当前选中的模型,需要支持工具调用;不支持时用 `/status`、`/pending` 仍可用。
- 改定时或角色指令后,团队会自动重新加载并校验;有配置错误会弹出提示。

## 聊天:和每个 agent 对话,指挥正在运行的 agent

控制台默认打开「Chat」页签(「Overview」页签保留原来的需要你处理、各 agent、运行记录)。左边是团队里的每个 agent(带状态和待处理数),右边是和选中 agent 的对话:

- **你说的话**在右边(蓝色),**agent 说的话和做的步骤**在左边,运行的开始和结束是中间的状态行(带产出文件)。步骤默认折叠,点开能看每一步。
- **它问你的问题、申请的审批就在对话里**,直接回答、批准或拒绝(批准仍然显示完整命令和文件内容)。
- 底下的输入框:**Enter 发送,Shift+Enter 换行**。中文输入法选字时按 Enter 不会误发送。

**你发的消息什么时候被 agent 读到**(输入框上方会写明):

| agent 现在 | 消息怎么送到 |
|---|---|
| 正在运行 | **下一步之前**读到。它可以据此改变做法;如果它刚好要结束,会先读完你的话再决定 |
| 在等你回答 | 你回答之后它继续时,和你的回答**一起**读到 |
| 排队中 | 开始运行时读到 |
| 空闲 | **开始一次新的运行**,以你的话为任务,并带上最近几句对话作为背景 |

不会丢:消息只有在读到它的那一轮正常结束后才标记为「已读」;模型中途失败,消息仍然是未读,会再给一次。运行结束后才到的消息,如果没有别的会读它,会自动开一次后续运行。

**Cancel this run**(对话标题栏右侧,正在运行时出现,需要点两次确认):把当前这次运行**真正结束**,记为「已取消」,不会重试。这和 Stop team 不同,后者只是停下整个团队,被中断的任务下次启动会接着做。

聊天记录存在 `.loop/chat/<agent>/`(你写的)和 `.loop/runs/`(agent 做的),都是普通文件。给 agent 的长期要求仍然用 `@loop`(「记住……」)或长期备忘,而不是聊天:聊天里说的话只对**这一次**运行和之后的对话有效。
