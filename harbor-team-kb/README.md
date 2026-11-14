# Harbor Team KB v3

零依赖 Node.js 工具引擎，支持 VS Code Copilot Chat 与 Harbor Mate。真实知识存入团队私有 Git 数据仓；本目录的 kb/ 和 standards/ 仅为公开演示样本。

## 一次性安装

```sh
node plug.js init-data-repo ~/work/team-kb-data
# 将数据仓 CODEOWNERS 中 @your-org/ 替换为真实团队，配置私有 origin 并提交
node plug.js install --data-repo ~/work/team-kb-data
# 同时安装到 Harbor Mate
node plug.js install -w /path/to/workspace --copilot --data-repo ~/work/team-kb-data
```

安装三个自包含技能：team-kb（检索、map、锚点）、team-kb-publish（审批后 PR）、story-guard（standard/check/audit/verify）。支持符号链接与受管复制安装，安装归属清单保护卸载。

## v3 能力

- map 跨仓导航；spec 记录代码无法表达的业务不变量、跨服务契约和意图，避免双写算法。
- 锚点 `<repo>:<path>#<symbol>@<blob8>` 用 LF 归一化指纹识别内容变化。普通 propose 保留旧指纹；显式 --reverify 仅核实干净代码文件。
- Story 检查 Spec Delta、全库引用和分类输入输出样例，自动输出 REQUIRED / STANDARD 风险路由。
- audit 从同一 Git 快照读取标准和卡片，生成随机 Nonce 隔离的质检包与审批哈希行；verify 检测标题或原始描述的审后变更。
- 私有仓配置失效立即退出；公开演示库默认拒绝 audit 和发布。草稿保存在 ~/.harbor/drafts/ 或 Mate outbox，缓存可安全删除。

设计理念、海图/暗礁模型与严谨金融业务落地范式见 [CORE_CONCEPTS.md](CORE_CONCEPTS.md)，完整操作流程见 [USER_GUIDE.md](USER_GUIDE.md)，详细接口与演进规格见 [SPEC_V3.md](SPEC_V3.md)。当前代码已实现 Phase 1/2 工具能力；Phase 2.5（金融强内控 6 项增强）与 Phase 3（代码仓反向 CI 提醒）见 [SPEC_V3.md](SPEC_V3.md) 路线图。

## 验证

```sh
node tests/verify_v3.js
node tests/verify_jira_mock_e2e.js --report tests/evidence/jira-mock-e2e.json
node tests/verify_pluggable.js
```

验证使用隔离临时 HOME；完整套件依赖相邻 loop-runner 的编译产物与已有开发依赖。story-guard 不实现 Jira HTTP 客户端；真实 Jira 联调前必须确认 Jira Editor 支持原样写文件导出。
