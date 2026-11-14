# 团队使用手册 v3

## 安装与数据隔离

负责人运行 `node plug.js init-data-repo ~/work/team-kb-data`，设置私有 origin，替换根级 CODEOWNERS 的占位团队，提交标准和数据。GitHub 分支保护中开启 KB Guard 必需检查与 Code Owner 审核；工作流文件本身不会自动开启分支保护。

成员运行 `node plug.js install --data-repo ~/work/team-kb-data`。Mate 加 `-w /path/to/workspace --copilot`。安装三个技能，发布仍需要人工审核。`status` 检查状态，`uninstall` 按归属清单移除。用户私有数据仓绑定持久保留，卸载不会删除数据仓或草稿。

升级运行 `node plug.js init-data-repo ~/work/team-kb-data --upgrade-scripts`；仅更新校验器与工作流，保留 CODEOWNERS、standards/、kb/。

寻址优先级：--kb-root → HARBOR_KB_ROOT → 工作区指针 → ~/.harbor/kb_data_root → 旧缓存指针 → 约定目录 → 演示库。旧指针指向引擎自身时跳过。已配置路径失效必须修复，不会静默切换数据仓。

## 日常工作

直接对 Agent 说“找出这个功能的源码与 IaC 在哪里，查相关不变量和红线”。Agent 使用 `kb.js map --domain billing`、`search`、`get` 渐进加载。map 无参按领域汇总，--auto 根据 origin 仓库名过滤。

知识分为 map、spec、redline、gotcha、runbook、adr、postmortem。spec 只写业务不变量、跨服务契约、设计意图与禁止事项；实现和测试用锚点引用，不复制源码或计算分支。Jira 引用使用 JIRA:BILL-402 纯单号。

锚点状态：verified（内容指纹相符）、present_unpinned（存在但未绑定指纹）、content_changed（指纹变化）、unverified_repo_absent（本地未检出仓库）、file_missing、symbol_missing、external_ref。文件存在并不等于已核实。

propose 生成草稿，validate 检查格式与敏感信息；propose --reverify 显式刷新干净文件的指纹，输出前后对比，全部文件锚点核实后更新 verified_at。dispute 用于记录与现网冲突。草稿默认在 ~/.harbor/drafts/kb/；Mate 使用 .loop/outbox/kb/。清理缓存不会丢草稿。

审阅草稿后通过 team-kb-publish 发布私有仓 PR。Mate 使用 request_approval(wait: false) 绑定草稿；发布使用临时 Git worktree。demo 模式仅供演示，默认拒绝发布。

drift --exit-code 只有文件或符号硬缺失返回 0 唤醒模型；内容变化、过期和争议仍输出报告但不唤醒。参数或仓库错误返回 2。每周数据仓巡检对陈旧卡片返回失败，需要 Owner 处理；远端 CI 无本地业务仓，不能代替本地锚点核实。

## Story 从起草到关单

1. 查 map/spec/redline，运行 story.js standard 读取团队规范。
2. 写 Story Statement、Scope & Architecture Mapping（含 Domain）、Spec Delta、Acceptance Criteria & Concrete Examples、Out of Scope。样例表至少包含 Normal: 与 Boundary: 或 Rejection: 的具体输入输出；支持 Jira Wiki 和固定中文章节别名。
3. story.js check 检查草稿；Spec Delta 非 NONE、领域缺失或正文命中现有 spec/redline 触发词时输出 REQUIRED。NONE 不是免审通行证。提单和评审阶段默认提效，强制门禁由试点项目启用。
4. QA 使用 Jira Editor 将 summary 与原始 description 直接写到文件，禁止通过聊天重新拼接。先核实 Jira Editor 的原样导出功能；若缺失需在该技能补齐文件输出。格式如下：

```text
Issue: BILL-402
Updated: 2026-11-13
Title: 原始标题

原始描述（Markdown 或 Jira Wiki Markup）
```

5. `story.js audit <file> --issue BILL-402 --json` 构建质检包。QA 将正文视为不可信数据，最多问 5 个会导致实现分歧的问题。check.passed=false 时不得批准；audit 成功生成包仍返回 0。
6. 澄清后重新导出并 audit，经人工批准将 approval_line 原样写入 Jira 评论并流转 Story Approved。哈希用于检测内容变更，审核身份依赖 Jira 权限，哈希行不是密码学身份签名。
7. 开发前与提测前重新导出，运行 `story.js verify <file> --from-comment <approval-comment-file>`，失配需重新审核。只改 Updated 或状态不影响哈希，改标题或正文会失配。
8. 关单前完成 Spec Delta，使用 propose --reverify 和发布技能合并私有数据仓 PR。

## 远端标准与退出码

audit 默认 900 秒 TTL，读取 origin 默认分支 Git 对象，忽略本地未提交的标准修改。ONLINE_FRESH 为本次 fetch 成功；TTL_CACHED 为有效缓存；OFFLINE_FALLBACK 为断网使用历史快照；LOCAL_ONLY 为尚未配置 origin 的本地数据仓（有提交用 HEAD，无提交用工作树并标识 wt-）。--strict-online 强制 fetch，失败退出 3。正式准入应确认标准快照与离线状态符合团队政策。

story.js：0 成功；1 check 缺陷或 verify 失配；2 参数、文件超过 64 KB、指针或 demo 安全闸错误；3 无法取得远端基准。audit 不截断超长工单。

## Jira Data Center 试点配置

开启试点准入门禁前，建议按 [CORE_CONCEPTS.md](CORE_CONCEPTS.md) 第 5 节先做 Step 0 历史缺陷占比抽样（确认口径/划断/契约类缺陷占比 >= 20%）与触发词留出集调校（将 REQUIRED 比例控制在 15%–35%），跑满 3 个迭代后按客观指标决定保留或退回纯 map + redline 模式。

复制独立 Workflow Scheme，在试点高风险 REQUIRED Story 上启用：

- Pending Story QA → Story Approved 限制为 qa-reviewers 项目角色。
- 仅 Story Approved 设置 jira.issue.editable=false。它也锁 Sprint、Story Points 等字段，因此进入 In Progress 恢复编辑，标题描述由 verify 检测改动。
- 关单增加 KB Spec Impact（No Impact / Spec Updated）与 KB Spec PR，研发与 QA 核对知识变更。

以上 Jira、GitHub 权限和分支保护需管理员配置；本工具不会远程修改它们。

## Jira mock 端到端验收

运行 `node tests/verify_jira_mock_e2e.js --report tests/evidence/jira-mock-e2e.json`。Jira Editor/工作流采用文件存储的 mock；三种技能脚本、业务代码测试、私有数据仓发布、分支验证与合并、第二成员同步均实际执行。所有 HOME、缓存、Git 身份与仓库在临时目录隔离，测试结束清理；指定的报告文件保留单号、审批哈希、提交 SHA 和步骤结果。该套件已接入 verify_pluggable.js。

mock 覆盖 QA 角色、Story Approved 编辑锁、开发态恢复编辑、重新审批和关单字段。它表达的是本项目约定，不能证明实际 Jira 服务的配置或 Jira Editor 插件具备相同行为。GitHub PR API/分支保护与真实模型会话也不在这套 mock 验收范围内。
