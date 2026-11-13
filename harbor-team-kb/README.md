# Harbor Mate 可插拔团队共享知识库（`harbor-team-kb`）

面向 **10 至 20 人工程团队**、在 **仅使用 VS Code + GitHub Copilot、禁用 MCP（Model Context Protocol）、不设专职知识库管理员** 约束下的可插拔团队共享知识库参考实现与全链路验证套件。

支持通过单行命令**无侵入热插拔（Plug & Unplug）**到任意 [Harbor Mate (`loop-runner`)](../loop-runner/README.md) 工作区与日常 VS Code Copilot Chat，零第三方 Python/Node 依赖。

---

## 一、快速插拔指南（Quickstart）

### 1. 一键接入 Harbor Mate 工作区与个人 Copilot

```sh
# 1) 插入 Harbor Mate 工作区（默认软链零拷贝，自动为指定 Mate 挂载 team-kb，可选挂载每周巡检员与 Hook）
python3 harbor-team-kb/plug.py install \
  --workspace /path/to/your-harbor-workspace \
  --agents sentinel,techlead \
  --with-gardener \
  --with-hooks

# 2) （可选）同时接入本机日常 VS Code Copilot Chat (~/.copilot/skills/)
python3 harbor-team-kb/plug.py install --copilot

# 3) 检查插拔健康度、SQLite FTS5 支持与检索探针
python3 harbor-team-kb/plug.py status --workspace /path/to/your-harbor-workspace
```

### 2. 一键无痕拔除（Byte-Exact Unplug）

```sh
python3 harbor-team-kb/plug.py uninstall --workspace /path/to/your-harbor-workspace --copilot
```

拔除命令会清理 `.github/skills/team-kb*`、移除 `plug.py` 在 `.agent.md` 中注入的 `loop.skills` 项与提示块、移除可选 `kb-gardener.agent.md` 与 Hook，将工作区逐字节恢复至接入前状态。

### 3. 运行全链路验证套件

```sh
# 编译并运行 Harbor Mate 本体全部测试（含软链 Skill 加载测试）
cd loop-runner && npm test

# 运行知识库 8 大场景 43 项真实运行时插拔与检索基准测试
node harbor-team-kb/tests/verify_pluggable.js
```

---

## 二、第一性原理架构设计（v2）

从第一性原理出发，团队共享知识库只需解决三个核心问题：**不重踩已知红线（Push）**、**30 秒内按症状/符号召回历史根因（Pull）**、**把新验证的经验低摩擦变成全队资产且不腐败（ Accumulate & Decay）**。

```
┌────────────────── Git 知识仓库: harbor-team-kb (分支保护 + CODEOWNERS) ──────────────────┐
│  kb/<domain>/<kind>/<slug>.md          # 路径即 ID + 4 必填字段极简 Frontmatter          │
│  skills/team-kb/                       # 只读检索/红线/校验/草稿 (挂载到 loop.skills)    │
│  skills/team-kb-publish/               # 独立 git worktree 推分支建 PR (不进 loop.skills)│
│  agents/kb-gardener.agent.md           # 可选每周零 Token 锚点漂移巡检 Mate              │
│  plug.py                               # 一键热插拔 / 状态自检 / 无痕卸载 CLI            │
└──────────────────────────▲─────────────────────────────────────────▲─────────────────────┘
      读取时按需 git pull --ff-only (--sync)             人工点批后隔离 worktree push + gh pr create
                           │                                         │
    ┌──────────────────────┴──────────────────────┐                  │
    ▼                                             ▼                  │
┌──────────────────────────┐      ┌───────────────────────────────┐  │
│ 日常交互式 Copilot Chat  │      │ Harbor Mate 无人值守运行引擎  │  │
│ - ~/.copilot/skills/     │      │ - .github/skills/team-kb (软链)│  │
│ - sessionStart 红线 Hook │      │ - write_file -> .loop/outbox/ │  │
└───────────┬──────────────┘      │ - request_approval(wait:false)│──┘ (SHA-256 哈希防篡改绑定)
            └──────────────┬──────┴───────────────────────────────┘
                           ▼
     本机可丢弃派生索引 ~/.cache/harbor-kb/<hash>/index.sqlite (FTS5 + 中文双字 + 代码拆词)
```

### 结合 `loop-runner` 源码核实的 6 项关键工程决策

1. **双 Skill 最小权限分离（`team-kb` vs `team-kb-publish`）**：
   - Harbor Mate 的 `skillScriptRule` 会对 Mate 在 `loop.skills` 中列出的所有 Skill 脚本**自动免审批放行**。
   - 若将 `git push` / `gh pr create` 写进 `team-kb/scripts/kb.py`，无人值守 Mate 就能绕过人类审批直接向远端推分支。
   - 因此拆分为两个独立目录：Mate 仅在 `loop.skills` 中声明只读/校验型的 **`team-kb`**；负责外发分支与 PR 的 **`team-kb-publish`** 安装在 `.github/skills/` 但**不加入 `loop.skills`**，任何直接 `run_command` 调用都会被策略拦截（`deny`），只能通过 `request_approval` 由人类在 Harbor Mate Console 核对草稿后触发 `approveAndRun`。
2. **工作区 `.loop/outbox/kb/` 草稿暂存 + SHA-256 防篡改闭环**：
   - Harbor Mate 的 `request_approval(files: [...])` 仅允许工作区内部路径，且 `approveAndRun` 会校验审批卡片展示时的文件 SHA-256。
   - 同时，最严格的只读策略（如 `examples/harbor-team/.loop/policies/techlead.json`，`writablePaths: []` 且拒绝含 `/` 或 `~` 前缀的命令行参数）仍然对 `.loop/outbox/**` 开放 `write_file`。
   - Agent 先用 `write_file` 将草稿写入 `.loop/outbox/kb/<domain>/<kind>/<slug>.md`，运行 `kb.py validate` 校验，再发起 `request_approval(..., wait: false)`：既完全兼容最严只读策略，又让人类审批与最终发布的字节内容通过 SHA-256 强绑定，且 `wait: false` 绝不阻塞主排障任务。
3. **无环境变量依赖的自动寻址（适配 `exec.ts` 环境隔离）**：
   - Harbor Mate 的 `buildShellEnv`（`src/exec.ts`）为防凭据泄漏，不会继承父进程的自定义环境变量（仅放行 `HOME`、`PATH` 等基础变量）。
   - `kb.py` 与 `publish.py` 在**软链模式**下通过 `os.path.realpath(__file__)` 直接反解回知识库根目录；在**拷贝模式**下通过工作区 `.loop/outbox/kb/.kb_root` 与 `$HOME/.cache/harbor-kb/default_root` 自动寻址，全程无需环境变量、无需在命令行传绝对路径。
4. **修复 `loadSkills` 软链目录识别，支持零拷贝热插拔**：
   - Node.js `fs.readdirSync(..., { withFileTypes: true })` 对指向目录的软链接返回 `d.isDirectory() === false`。本次在 `loop-runner/src/team.ts` 补齐 `d.isSymbolicLink() && isDir(...)` 支持（坏链安全跳过），使外部知识库修改立即对工作区生效。
5. **砍掉中间 `inbox/` 与每日搬运工 Mate，直走 Git 分支 + PR**：
   - Harbor Mate 是运行在每位工程师各自 VS Code 里的单机扩展，而非中心服务器；本机 `inbox/` 无法被队友看到，跨机推共享 `inbox` 又会产生并发冲突与二次审批延迟。
   - `publish.py` 在本机审批通过后直接拉起**隔离的临时 `git worktree`**（绝不污染工程师当前检出的工作树），提交至 `kb/<domain>-<slug>-<timestamp>` 分支并创建 GitHub PR。只有经过 `kb-gardener` 每周零 Token 巡检确有漂移时才唤醒模型。
6. **路径即 ID + 4 字段极简 Schema + Push/Pull 双模**：
   - 文件路径 `kb/<domain>/<kind>/<slug>.md` 本身即承载领域、类型（`redline` | `gotcha` | `runbook` | `adr` | `postmortem`）与唯一 ID，并天然映射 GitHub `CODEOWNERS`。
   - Frontmatter 仅保留 **4 个必填字段**（`title`、`summary`、`triggers`、`sources`）与 2 个按需生命周期字段（`expires` 仅用于临时绕过方案、`disputed` 用于实况冲突标记）。
   - **Push 通道（`kb.py redlines`）**：按 `--repo` / `--domain` 推送单行服务红线（防“不知道自己不知道”）；**Pull 通道（`kb.py search` -> `kb.py get`）**：两阶段渐进加载防上下文膨胀。

---

## 三、目录结构与知识条目规范

```text
harbor-team-kb/
├── plug.py                                  # 一键插拔 / 状态检查 / 无痕卸载管理器
├── CODEOWNERS                               # 按 /kb/<domain>/ 与 /skills/ 分级审核模板
├── skills/
│   ├── team-kb/                             # 挂载至 Mate loop.skills 的检索/校验 Skill (< 4KB)
│   │   ├── SKILL.md
│   │   └── scripts/kb.py                    # 零依赖 Python 3 CLI (FTS5 + CJK Bigram + 锁)
│   └── team-kb-publish/                     # 仅经 request_approval 执行的发布器 Skill
│       ├── SKILL.md
│       └── scripts/publish.py               # 隔离 git worktree 分支推送与 PR 创建
├── agents/
│   └── kb-gardener.agent.md                 # 可选每周一零 Token 锚点漂移巡检 Mate
├── hooks/
│   └── harbor-kb.hooks.json                 # 可选 Copilot sessionStart 红线自动注入钩子
├── kb/                                      # 12 条跨领域种子知识 (gateway/observability/storage/release)
│   ├── gateway/{redline,gotcha,postmortem}/
│   ├── observability/{redline,gotcha,runbook,adr}/
│   ├── storage/{redline,gotcha,runbook}/
│   └── release/{redline,runbook}/
└── tests/
    ├── golden_queries.json                  # 中英双字词、驼峰/下划线符号与负样本黄金评测集
    └── verify_pluggable.js                  # 对接真实 loop-runner 编译产物的 43 项端到端验证
```

### 知识条目最小示例（`kb/gateway/redline/rate-limit-shadow-mode-first.md`）

```markdown
---
title: "网关限流变更红线：RateLimitConfig 必须先开启 24 小时 shadow_only 灰度"
summary: "修改 harbor-gateway 的 RateLimitConfig 配额或突发桶前必须先以 shadow_only 模式运行至少 24 小时，禁止直接下发强拦截 429。"
sources:
  - "harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"
triggers:
  - "RateLimitConfig"
  - "shadow_only"
  - "429 Too Many Requests"
  - "限流"
---

## 红线规则
...
```

---

## 四、CLI 命令速查

所有路径参数均为工作区相对路径（不含前导 `/`、`~` 或 `..`），兼容 Harbor Mate 最严格的 `strict` 策略档位：

```sh
# 1. Push 路径：读取当前服务/领域必须遵守的红线（单行摘要）
python3 .github/skills/team-kb/scripts/kb.py redlines --repo harbor-gateway

# 2. Pull 路径：混合检索（支持 2 字中文词、camelCase、snake_case、错误码；--sync 按 TTL 拉取远端更新）
python3 .github/skills/team-kb/scripts/kb.py search --sync "RateLimitConfig 限流 429"

# 3. 按需精读全文（自动打印 REFERENCE ONLY 防注入横幅，并实时核查本地 repos/ 代码符号锚点是否漂移）
python3 .github/skills/team-kb/scripts/kb.py get gateway/redline/rate-limit-shadow-mode-first

# 4. 校验 .loop/outbox/kb/ 下的知识草稿（Schema + 密钥/本机路径泄漏阻断 + Jaccard 近重复检测）
python3 .github/skills/team-kb/scripts/kb.py validate .loop/outbox/kb/gateway/gotcha/my-entry.md

# 5. 当线上实况与旧条目相悖时，一键生成带 disputed 标记的修订草稿
python3 .github/skills/team-kb/scripts/kb.py dispute --id gateway/gotcha/grpc-keepalive-rst-stream-burst --reason "..."

# 6. 零 Token 唤醒探针（无异常退出码 1 不调模型；发现符号漂移/过期/争议退出码 0 输出 JSON）
python3 .github/skills/team-kb/scripts/kb.py drift --exit-code

# 7. 审批通过后执行发布（仅放入 request_approval 的 command 字段）
python3 .github/skills/team-kb-publish/scripts/publish.py .loop/outbox/kb/gateway/gotcha/my-entry.md
```

---

## 五、技术选型对比结论（面向 10–20 人无 MCP 团队）

| 方案类别 | 代表技术 | 核心优劣判断 | 结论 |
|---|---|---|---|
| **Git 原生 Markdown + 本地可丢弃 SQLite FTS5 Skill（本方案）** | Git + Python `sqlite3` FTS5 + CJK Bigram/代码拆词 | 零服务端运维、天然具备 PR / `CODEOWNERS` / 分支保护、离线可用、毫秒级检索、不消耗外部模型 API | **首选落地方案** |
| **VS Code / Copilot 原生规则能力** | `AGENTS.md`、`.github/instructions/`、Copilot Spaces | Spaces/Connectors 强依赖 MCP（排除）；Instructions 适合 `<100` 行常驻规则，不适合装数百条排障案例 | **搭配用作顶层常驻规则层** |
| **本地混合向量 CLI** | `tobi/qmd` (`sqlite-vec` + 本地 GGUF) | 需额外运行时与约 2.1GB 本地模型；默认分词对中文双字词支持不佳 | 仅当未来词条超数千且词法召回不足时按需选配 |
| **自建企业 Wiki / 重型 RAG 集群** | BookStack / Outline / RAGFlow / Dify / Mem0 | 需常驻服务器与数据库运维，RAG/记忆框架强依赖外部 Embedding/LLM API，缺乏原子化 Agent PR 审核流 | **对 10–20 人团队属于过度设计，排除** |

---

## 六、全链路实测验证报告（`tests/verify_pluggable.js`）

基于真实编译的 Harbor Mate 运行时模块（`team.js`、`skillAuthoring.js`、`manage.js`、`policy.js`、`wake.js`、`tools.js`、`gates.js`、`runner.js`）完成了 **8 大测试套件、43 项断言** 实测验证：

| 验证维度 | 实测方法 | 实测指标 / 结果 |
|---|---|---|
| **1. Harbor Mate 静态安全审计** | 调用真实 `lintSkill` 扫描 `team-kb` 与 `team-kb-publish`，`designWarnings` + `validateTeam` 扫描 `kb-gardener` | **0 Errors, 0 Warnings**（无受保护路径引用、无密钥/网络违规，`SKILL.md` `< 4KB`） |
| **2. 黄金检索准确率（12 种子词条）** | 覆盖中文双字词（`限流`、`死锁`、`回滚`）、`camelCase`、`snake_case`、SQLSTATE/HTTP 错误码及无关噪声查询 | **Recall@1 = 100% (13/13)**，**Recall@5 = 100%**，**MRR = 1.0**，噪声误召回 **0**；冷启动建索引 **165ms**，热查询 P50 **147ms**（含 Python 启动） |
| **3. 500 词条团队规模与抗干扰压测** | 注入 488 条多领域干扰词条 + 12 条种子词条（共 500 条）重跑全部黄金评测 | 冷启动全量建索引 **545ms**，热查询 P50 **170ms**，**Recall@1 = 100%**，**Recall@5 = 100%** |
| **4. 24 进程冷缓存并发锁压测** | 清空缓存后同时拉起 **24 个并行 `kb.py` 子进程** 并发建库与检索 | **24/24 退出码 0**，零 `database is locked` 报错，原子替换后残留 `.tmp` 文件数为 **0** |
| **5. 零拷贝热插拔与逐字节卸载** | 对 `examples/harbor-team` 分别执行 `symlink` 与 `copy` 模式重复安装 + 卸载 | 安装幂等、`loadSkills` 识别软链成功，卸载后目录快照 **100% 逐字节还原** |
| **6. 最严只读策略与 SHA-256 防篡改** | 在 `techlead.json`（`writablePaths: []`）与隔离 `buildShellEnv` 下执行读写、篡改拦截与双克隆同步 | `kb.py` 读写校验全部 `allow`；直接调 `publish.py` 被 `deny` 拦截；审批后篡改草稿 1 字节被 SHA-256 硬拦截；合并 PR 后第二台克隆通过 `--sync` 自动拉取重建索引并 Top-1 命中新知识 |
| **7. `runItem` 闭环与零 Token 漂移唤醒** | 驱动真实 `runner.js` 完成排障提案，随后重命名 `repos/` 中的 `RateLimitConfig` 测试 `checkWake` | 主任务不因 `request_approval(wait: false)` 挂起；代码未改时 `wakeIf` 退出码 `1`（**0 Token**），符号重命名后退出码 `0` 精准唤醒并报告漂移，`kb.py get` 同步输出实时漂移告警 |
| **8. 线上实况冲突标记（Dispute）** | 执行 `kb.py dispute` 并复验输出草稿 | 自动生成带日期与原因的 `disputed` 草稿并通过 Schema 校验，检索结果自动降权提示 |
