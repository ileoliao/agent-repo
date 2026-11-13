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

# 运行知识库 9 大套件 50 项真实运行时插拔、分层召回率与 Token 使用率基准测试
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
     本机可丢弃派生索引 ~/.cache/harbor-kb/<hash>/index.sqlite (Porter FTS5 + IDF 加权覆盖度 + 代码拆词 + CJK 兜底)
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
│   │   └── scripts/kb.py                    # 零依赖 Python 3 CLI (Porter FTS5 + IDF 重排 + 代码拆词 + CJK 兜底)
│   └── team-kb-publish/                     # 仅经 request_approval 执行的发布器 Skill
│       ├── SKILL.md
│       └── scripts/publish.py               # 隔离 git worktree 分支推送与 PR 创建
├── agents/
│   └── kb-gardener.agent.md                 # 可选每周一零 Token 锚点漂移巡检 Mate
├── hooks/
│   └── harbor-kb.hooks.json                 # 可选 Copilot sessionStart 红线自动注入钩子
├── kb/                                      # 12 条英文主语料种子知识（兼容少量中文触发词）
│   ├── gateway/{redline,gotcha,postmortem}/
│   ├── observability/{redline,gotcha,runbook,adr}/
│   ├── storage/{redline,gotcha,runbook}/
│   └── release/{redline,runbook}/
└── tests/
    ├── golden_queries.json                  # 48 条 7 维度分层检索评测集（英文词形/自然句/改写/中文/口语极限/邻近负样本）
    └── verify_pluggable.js                  # 对接真实 loop-runner 编译产物与 tiktoken 的 50 项端到端验证
```

### 知识条目最小示例（`kb/gateway/redline/rate-limit-shadow-mode-first.md`）

```markdown
---
title: "Gateway Rate-Limit Redline: Run RateLimitConfig in shadow_only for 24h Before Enforcing 429"
summary: "Any RateLimitConfig quota or burst change on harbor-gateway must run in shadow_only mode for at least 24 hours with zero false-positive hits before enforcing HTTP 429."
sources:
  - "harbor-gateway:pkg/ratelimit/limiter.go#RateLimitConfig"
triggers:
  - "RateLimitConfig"
  - "shadow_only"
  - "429 Too Many Requests"
  - "rate limit"
  - "限流"
---

## Redline Rule
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

## 六、检索召回率分层实测报告（英文主场景 + 少量中文，48 条黄金评测集）

围绕真实工程排障查询习惯构建了 **`tests/golden_queries.json`（7 大类共 48 条查询）**，分别在 **`N = 12`（种子库）** 与 **`N = 500`（注入 488 条跨 10 个基础设施领域的全尺寸三段式真实干扰词条）** 规模下实测 `kb.py`（SQLite FTS5 `porter unicode61` + 英文词干化 + `token_df` 规模归一化 IDF 覆盖度重排 + 词边界 Trigger 提权 + CJK 分句兜底）：

| 查询类别（48 条） | 样本数 | 典型查询示例 | `N = 12` Recall@1 / @5 | `N = 500` Recall@1 / @5 |
|---|---:|---|---|---|
| **1. 精确符号 / 错误码 / 配置键** (`symbol_code`) | 7 | `RateLimitConfig shadow_only`、`SQLSTATE 40P01 batch_upsert_orders` | **100% / 100%** (7/7) | **100% / 100%** (7/7) |
| **2. 英文词形变化（复数/分词/时态）** (`en_inflection`) | 7 | `clients retrying aggressively on 429`、`pods OOMKilled when exporting high cardinality` | **100% / 100%** (7/7) | **100% / 100%** (7/7) |
| **3. 冗长英文自然语言提问** (`en_natural_question`) | 7 | `Why did our gateway return 429 waves every 5 seconds even though total traffic barely rose?` | **100% / 100%** (7/7) | **100% / 100%** (7/7) |
| **4. 同义故障症状改写** (`en_symptom_paraphrase`) | 6 | `synchronized thundering herd from external SDK callers after throttling` | **100% / 100%** (6/6) | **100% / 100%** (6/6) |
| **5. 少量中文与中英混排查询** (`zh_minor`) | 5 | `为什么网关调整限流配置不能直接上线拦截`、`订单批量写入并发死锁` | **100% / 100%** (5/5) | **100% / 100%** (5/5) |
| **核心工程查询小计（1–5 类）** | **32** | 含任一工程术语、服务名、症状词或配置概念 | **100.0% / 100.0%** (`MRR=1.00`) | **100.0% / 100.0%** (`MRR=1.00`) |
| **6. 零符号纯口语极限压测** (`zero_symbol_colloquial`) | 8 | `why do we throw away most normal spans to save disk`（故意回避全部代码符号与标准术语） | 单次 **75.0%** (6/8)<br>Agent 1 次改写后 **100%** (8/8) | 单次 **62.5%** (5/8)<br>Agent 1 次改写后 **100%** (8/8) |
| **7. 领域邻近与跨界强负样本** (`hard_negative`) | 8 | `gateway envoy TLS certificate expired x509`、`Redis cluster failover sentinel split brain` | **误召回率 FPR = 0.0%** (0/8) | **误召回率 FPR = 0.0%** (0/8) |

- **延迟指标**（含 Python 进程冷启动 + SQLite 查询）：`N = 12` 冷建库 **193ms** / 热查询 P50 **157ms**；`N = 500` 冷建库 **1.11s** / 热查询 P50 **211ms**。
- **诚实方法论边界**：纯词法 BM25/FTS5 在完全不含任何共享词根的纯口语表达（如用 `throw away` 指代 `tail sampling`）下存在天然天花板（单次命中 62.5%–75.0%）。`SKILL.md` 已内置 1 句话改写指引（`0 matches` 时换用标准基础设施术语重试 1 次），重试后召回率恢复至 **100%**，无需为 10–20 人团队引入 2GB 本地向量模型。

---

## 七、Token 使用率与 128k 上下文窗口实测报告（`tiktoken: o200k_base`）

使用 GitHub Copilot / GPT-4o 同源分词器 **`tiktoken (o200k_base)`**，对接真实 `loop-runner` 的 `buildPrompt()`、`LONG_SKILL_CHARS (4096)`、`foldedLine()` 与 `foldForRequest()`（以 `128,000` Token 上下文窗口为基准），实测 **1 次完整 5 轮无人值守排障闭环**（`redlines -> search -> get -> write_file + validate -> request_approval + finish`）的真实消耗：

### 1. 单组件 Token 精确拆解

| 组件 | 实测字符数 | 实测 Token (`o200k_base`) | 占 `128k` 窗口比例 | 说明 |
|---|---:|---:|---:|---|
| 未挂载 KB 的原始 `techlead` Prompt | 9,604 | **2,313** | 1.81% | Harbor Mate 基础角色 + 原有 Skills |
| 挂载 `team-kb` 后的常驻静态增量 | +2,623 | **+691** | **+0.54%** | `SKILL.md` (`615` tok, `< 4096` 字符不截断) + 角色简短指引 (`76` tok)，且 **87.1% 位于静态前缀可命中 Prompt Cache** |
| `kb.py redlines --repo harbor-gateway` | 354 | **79** | 0.06% | 按目标仓库精准过滤红线（全量 4 域红线也仅 `316` tok） |
| `kb.py search`（Top-5 紧凑命中列表） | 1,098 | **293** | 0.23% | `N = 12` 与 `N = 500` 输出均为 **293 tok**（严格 `O(1)`） |
| `kb.py get <id>`（按需拉取 1 篇完整词条） | 1,587 | **397** | 0.31% | 含 `[team-kb REFERENCE]` 首行标识与防注入横幅 |
| 超长词条经 `foldForRequest` 折叠后 | 129 | **47** | 0.04% | 旧轮次 `>2000` 字符输出自动折叠为 1 行，保留 `REFERENCE`、ID 与标题 |
| `kb-gardener` 每周无漂移巡检 (`wakeIf`) | 0 | **0** | **0.00%** | 本地代码符号未漂移时 `exit 1`，完全不发起模型请求 |

### 2. 四种方案在 `N = 12 / 100 / 500` 词条规模下的 5 轮实测对比

| 词条规模 | 方案 | 首轮输入 Token | 第 5 轮峰值 Token（占 `128k`） | 5 轮累计输入 Token | 相比 `team-kb` 节省率 |
|---|---|---:|---:|---:|---|
| **无知识库基线** | `No KB` | 2,313 | 2,529 (1.98%) | 12,117 | 基线（无历史经验） |
| **`N = 12`**（起步期） | 全量塞入 Prompt | 6,340 | 6,556 (5.12%) | 32,252 | `team-kb` 省 **46.5%** |
| | 全量摘要塞入 Prompt | 3,511 | 4,084 (3.19%) | 19,547 | `team-kb` 省 **11.8%** |
| | **`team-kb` 渐进披露** | **3,004** | **3,893 (3.04%)** | **17,249**（KB 净增仅 `5,132`） | — |
| **`N = 100`**（成长期） | 全量塞入 Prompt | 31,267 | 31,483 (24.60%) | 156,887 | `team-kb` 省 **89.0%** |
| | 全量摘要塞入 Prompt | 10,441 | 11,014 (8.60%) | 54,197 | `team-kb` 省 **68.2%** |
| | **`team-kb` 渐进披露** | **3,004** | **3,893 (3.04%)** | **17,249** | — |
| **`N = 500`**（成熟期） | 全量塞入 Prompt | **144,567（首轮即爆窗）** | **144,783 (113.11%)** | 723,387 | `team-kb` 省 **97.6%** |
| | 全量摘要塞入 Prompt | 41,941 | 42,514 (33.21%) | 211,697 | `team-kb` 省 **91.9%** |
| | **`team-kb` 渐进披露** | **3,004** | **3,893 (3.04%)** | **17,249** | **`O(1)` 恒定开销** |

---

## 八、全链路运行时验证套件汇总（`tests/verify_pluggable.js` — 9 大套件 50 项断言全绿）

基于真实编译的 Harbor Mate 运行时模块（`team.js`、`skillAuthoring.js`、`manage.js`、`policy.js`、`wake.js`、`tools.js`、`gates.js`、`runner.js`、`fold.js`）完成了 **9 大测试套件、50 项断言** 端到端验证：

1. **Harbor Mate 静态安全审计**：`lintSkill`、`designWarnings`、`validateTeam` 均为 **0 Errors, 0 Warnings**。
2. **分层检索召回率与强负样本压测（`N=12` & `N=500`）**：32 条核心工程查询 **Recall@1 = 100%**，8 条领域邻近强负样本 **FPR = 0%**，口语极限查询经 1 步改写 **Recall@1 = 100%**。
3. **草稿门禁校验**：拦截 `ghp_` 等凭据泄漏、拦截 `/Users/...` 本机路径泄漏、Jaccard 近重复告警。
4. **24 进程冷缓存并发锁压测**：24 个并行子进程同时建库查询 **24/24 退出码 0**，零 SQLite 锁冲突与残留临时文件。
5. **零拷贝热插拔与逐字节无痕卸载**：`symlink` 与 `copy` 双模式安装幂等，卸载后工作区 **100% 逐字节还原**。
6. **最严只读策略（`techlead.json`）+ SHA-256 防篡改 + 双机 Git 同步**：`publish.py` 直接调用被策略硬拦截；审批后篡改 1 字节被 SHA-256 拒绝；合并后第二台克隆通过 `--sync` 自动拉取并在 Top-1 命中新词条。
7. **`runItem` 无人值守闭环 + `kb-gardener` 零 Token 漂移唤醒**：`request_approval(wait: false)` 不阻塞主循环；源码符号重命名后精准唤醒巡检并在 `kb.py get` 实时标红告警。
8. **实况冲突标记（`kb.py dispute`）**：一键生成带原因的争议修订草稿并在检索排序中自动降权。
9. **端到端 Token 使用率与 `foldForRequest` 折叠验证**：实证 `O(1)` 上下文规模不变性与首行 `[team-kb REFERENCE]` 折叠保留能力。

