# `team-kb` 团队使用说明书（Copilot Chat & Harbor Mate）

> **核心原则：你不需要背任何命令行、不需要记 YAML 格式、也不需要手动建目录。**
> 装好之后，无论你是在普通业务仓库里直接用 **VS Code Copilot Chat**，还是用 **Harbor Mate**，全程只需要**说大白话 + 花 30 秒点一次审核**。

---

## 一、30 秒一次性安装

先把知识库克隆到本机固定目录（例如 `~/work/harbor-team-kb`），然后按你的使用方式选 **1 行命令**执行：

### 方式 A：只用日常 VS Code Copilot Chat
```sh
python3 ~/work/harbor-team-kb/plug.py install
```
> 唯一前置：确认 VS Code 设置中已勾选 **`chat.useAgentSkills`: `true`**（Settings 搜索 `useAgentSkills` 即可）。

### 方式 B：同时使用 Harbor Mate 工作区 + Copilot Chat
```sh
python3 ~/work/harbor-team-kb/plug.py install -w /path/to/your-mate-workspace --copilot
```
> 默认会自动把 `team-kb` 挂到工作区内所有 Mate 上，并装好每周一零 Token 代码漂移巡检员 `kb-gardener`。（只想挂载指定 Mate 可加 `--agents sentinel,techlead`；不想装巡检员可加 `--no-gardener`。）

### 随时检查是否装好 / 一键无痕卸载
```sh
# 自检（查看知识库条数、Copilot 技能状态、Harbor Mate 挂载状态）
python3 ~/work/harbor-team-kb/plug.py status

# 无痕卸载（工作区逐字节恢复原状）
python3 ~/work/harbor-team-kb/plug.py uninstall -w /path/to/your-mate-workspace --copilot
```

---

## 二、场景一：在 VS Code 里直接用 Copilot Chat

打开**任意业务微服务仓库**（例如 `harbor-gateway`），切到 **Copilot Chat（Agent 模式）**，直接按下面 **4 个日常动作**对话即可：

### 1. 改不熟的服务 / 配置前：先查红线（防踩坑）
直接在对话框输入：
> `Check team-kb redlines before I change RateLimitConfig.`
> *(或中文：`改这个配置前先查下 team-kb 有没有红线`)*

- **自动发生的事**：Copilot 自动识别你当前打开的仓库名（如 `harbor-gateway`），只拉取跟当前仓库相关的团队红线（例如 *“改限流阈值必须先开 `shadow_only` 跑满 24 小时”*），不会把无关领域的文档塞进上下文。

### 2. 线上报警 / 本地遇到诡异报错：查历史根因
直接把报错码、配置键、函数名或症状丢给 Copilot：
> `We are seeing HTTP 429 waves every 5s on harbor-gateway. Check team-kb and verify against current code.`

- **自动发生的事**：
  1. Copilot 自动按需检索 `team-kb`（若远端有队友新合并的经验会自动 `git pull` 同步）；
  2. 拉取命中词条的同时，**自动拿词条里的代码锚点（如 `pkg/ratelimit/limiter.go#RateLimitConfig`）去核对你当前打开仓库里的真实代码**——如果那个函数已经被别人重构改名了，当场就会提示 `WARNING [ANCHOR DRIFT]`，防止被过期文档误导。

### 3. 刚定位并修好一个隐蔽坑：一句话沉淀给全队
当你刚排完障、确认根因和修法有效后，直接顺手发一句：
> `Save this verified fix to team-kb and open a PR.`
> *(或中文：`把刚才验证过的根因和解法沉淀到 team-kb 提个 PR`)*

- **自动发生的事**：
  1. Copilot 自动生成规范词条并跑校验（自动拦截密钥泄漏、拦截本机 `/Users/...` 路径、检查是否跟已有词条重复）；
  2. 草稿自动暂存在系统缓存目录 `~/.cache/harbor-kb/drafts/`，**绝不会在你当前的业务代码仓库里留下任何未跟踪脏文件（`git status` 保持 100% 干净）**；
  3. 给你看一眼标题和摘要，你在终端确认执行 `publish.py` 后，它会在后台临时 `git worktree` 推好分支并直接创建 GitHub PR（若本机未登录 `gh` CLI，也会直接打印一键提 PR 的网页链接，Cmd+Click 即可）。

### 4. 发现知识库某条经验已经过时：一句话打标降权
当你发现某条旧经验与现网实况不符，没空长篇重写时，直接说：
> `Mark gateway/gotcha/grpc-keepalive-rst-stream-burst as disputed in team-kb because Envoy MaxConnectionIdle is now 600s, and open a PR.`

- **自动发生的事**：该词条立即被标上 `[DISPUTED]` 并在检索排序中大幅降权，后续队友和 Agent 读到时都会收到醒目告警。

#### （可选）每次开新会话自动注入当前仓库红线
如果你希望在某个仓库打开 Copilot 会话时连问都不用问就自动加载该仓库红线，在安装时加上 `--with-hooks`（或把 `harbor-team-kb/hooks/harbor-kb.hooks.json` 拷到 `.github/hooks/harbor-kb.json`）即可。

---

## 三、场景二：在 Harbor Mate 里使用

接入 Harbor Mate 工作区后，**读取是全自动的，写入是“AI 起草 + 你花 30 秒点批”**。

### 1. 后台自动发生的事（平时完全不用管）
- **排障自动避坑与查库**：`sentinel`、`techlead` 等无人值守 Mate 在处理告警、巡检或执行任务时，会自动先查相关仓库红线（`redlines`）、按症状查历史案例（`search -> get`），只消耗约 `0.5%–3%` 的上下文窗口。
- **每周一零 Token 自动体检**：`kb-gardener` 每周一早上自动跑一次纯本地脚本（`kb.py drift --exit-code`），逐条核对知识库引用的代码文件与函数名在本地 `repos/` 里是否还存在：
  - **没漂移**：脚本直接退出，**消耗 0 个大模型 Token，也不会打扰你**；
  - **有漂移 / 临时方案已过期**：自动唤醒 `kb-gardener` 核实代码变更并把修订草稿推到你的审批栏。
- **安全硬隔离**：无人值守 Mate **没有权限直接往远端推分支**（直接调 `publish.py` 会被策略层硬拦截），且发起审批采用非阻塞模式（`wait: false`），绝不会卡死它手头的排障主任务。

### 2. 在 Harbor Mate Console 对话
跟在 Copilot Chat 里一模一样，直接用自然语言跟 `@mate` 交代任务即可：
- `@techlead Investigate why postgres batch_upsert_orders is hitting 40P01 deadlocks; check team-kb first.`
- `@techlead Distill this incident root cause into team-kb for the team.`

### 3. 弹出 Approval Card（审批卡片）时的 30 秒三看清单
当 Mate 沉淀了一条新经验（或 `kb-gardener` 提交了一条漂移修订），Harbor Mate Console 会出现一张审批卡片（绑定了草稿文件的 **SHA-256 防篡改指纹**）。你只需花 **30 秒扫三眼**：

1. **看结论实不实**：是不是经过实锤验证的**非显性经验**？（有明确的 `sources` 代码/配置锚点；拒绝“建议重启观察”之类的空话或未证实猜测。）
2. **看有没有敏感业务信息**：脚本已经自动拦过一轮 Token/密钥和本机路径，人眼只需扫一眼有没有不该进团队库的客户隐私数据。
3. **看要不要设保质期**：如果是等上游发版就会作废的**临时绕过方案（Workaround）**，确认顶部带有 `expires: YYYY-MM-DD`。

- 点击 **Approve**：自动在隔离的临时 `git worktree` 推送分支并建好 GitHub PR，相关领域 Owner 合并后全队即刻共享。
- 点击 **Reject**：直接丢弃草稿，零副作用。

---

## 四、不设专职管理员，团队日常靠哪 3 条铁律保持干净？

1. **3 秒分流法则（什么该进 `team-kb`，什么不该进？）**
   - 能写成 Linter、单元测试、CI 检查的规则 ➡️ **直接写进代码/CI**，别写文档；
   - 单个仓库每次写代码都要遵守的常驻规范（`< 100` 行） ➡️ 放该仓库自己的 **`.github/instructions/`**；
   - **跨服务上线红线（`redline`）、反直觉深坑（`gotcha`）、3 分钟排障步骤（`runbook`）、架构取舍原因（`adr`）、真实故障复盘（`postmortem`）** ➡️ 放 **`team-kb`**。
2. **“只改原帖，不堆新帖” + 临时方案必带过期日**
   - 校验器会自动计算标题与触发词相似度：遇到已有同类词条时，直接更新原词条，绝不堆出“新、新2、最终版”。
   - 永久机制不写 `expires`；临时 Workaround 必写 `expires: YYYY-MM-DD`（到期自动降权告警，彻底消灭“半年前的临时补丁把新人带沟里”）。
3. **现网代码永远大于旧文档**
   - 任何时候看到 `[ANCHOR DRIFT]` 或 `[DISPUTED]` 告警，一律以当前仓库真实源码和线上监控为准，顺手让 Copilot / Mate 更新或删除旧词条。

---

## 附录：常见排错与极简命令行速查（仅终端党按需查阅）

<details>
<summary>点击展开：常见问题 & 手动 CLI 速查</summary>

### 常见问题
1. **Copilot Chat 里没自动调用 `team-kb`？**
   - 运行 `python3 ~/work/harbor-team-kb/plug.py status` 看 `Copilot skills` 是否为 `symlink` 或 `copy`；
   - 打开 VS Code Settings，确认 `"chat.useAgentSkills": true` 已开启；或在提问里直接带上关键词 `team-kb`。
2. **本机没装 `gh` CLI 能提知识库 PR 吗？**
   - 可以。只要 Git 配好了 `origin` 推送权限，`publish.py` 推完分支后会自动在终端打印形如 `https://github.com/<org>/<repo>/compare/kb/...?expand=1` 的链接，点开就能一键建 PR。

### 手动终端速查（AI 背后实际执行的命令）
```sh
# 自动按当前目录仓库名查红线
python3 ~/.copilot/skills/team-kb/scripts/kb.py redlines --auto

# 检索知识库（--sync 会在距上次同步超 10 分钟时自动静默 git pull）
python3 ~/.copilot/skills/team-kb/scripts/kb.py search --sync "40P01 deadlock"

# 查看单篇详情（自动核对当前仓库代码符号是否漂移）
python3 ~/.copilot/skills/team-kb/scripts/kb.py get storage/gotcha/pg-deadlock-lock-ordering

# 检查全库是否有锚点漂移 / 过期 / 争议词条
python3 ~/.copilot/skills/team-kb/scripts/kb.py drift
```

</details>
