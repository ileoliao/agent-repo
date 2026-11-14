# Harbor team-kb v3：直接相邻产品的一手资料

核查日期：2026-11-14。只使用产品官方文档、官方源码仓和厂商发布的插件页面。以下是对公开资料的对照，不代表实际购买或部署验证；“未在本次资料中看到”不能推导为产品没有该能力。

## 判断

这套设计有明确的相邻方案，不能把 Git 知识、代码关联文档、Spec Delta、按需加载 Skill 或质量门禁分别称为独创。比较有机会的切入点是：面向受管 IDE / Jira Data Center 团队，以很低部署成本，把少量业务不变量和排障经验作为可审查、带状态的 Agent 上下文使用。这个定位属于产品取舍与组合，不是已证明的技术壁垒。

## 直接对照

| 对象 | 一手资料可确认的机制 | 与 Harbor 的重叠 | 可作出的有限差异判断 |
| --- | --- | --- | --- |
| Swimm（商业） | 历史 Continuous Documentation 提供代码关联文档、Git 中存储、IDE 展示、Auto-sync 和 CI 检查。Auto-sync 的技术说明使用文件历史、行/标记、周围 token 等信号，简单变更可自动更新，信息不足时要求人工重选。 | 代码与文档绑定、防陈旧、共享知识与开发流程联动。 | Harbor 的整文件 LF 指纹、固定 7 态、显式 --reverify 是更简单、更保守的实现选择；不能据此声称比 Swimm 更懂代码变化。来源：[官方机制解释](https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work)、[官方 CI 文档](https://docs.swimm.io/continuous-integration/)、[厂商 VS 插件](https://marketplace.visualstudio.com/items?itemName=Swimm.SwimmVS)。 |
| Swimm 的当前 AI Operability / grounding layer | 官网描述经过专家验证的业务规则、跨仓影响、代码溯源、随提交选择性更新，以及通过 MCP 给既有 Agent 提供上下文；页面明确该服务由专家交付，结果继续存在 Swimm 平台，可在本地部署。 | “跨仓地图 + 业务规则 + Agent 可用上下文 + 守护流程”与我们核心叙事高度接近。 | Harbor 的具体差异是零常驻服务、无需 MCP、私有 Git 数据仓、团队自行维护少量卡片。官网的覆盖率/准确率是厂商声明，示例 API 明示 illustrative，未验证这些效果。来源：[官方当前产品页](https://swimm.io/context-layer)。 |
| OpenSpec（MIT 开源） | `openspec/specs/` 保存当前行为；每个变更含 proposal、design、tasks 和 delta specs；delta 区分 ADDED/MODIFIED/REMOVED；完成后归档并合并回主规格。支持 AI 编程工具中的工作流。 | “Spec Delta 在开发前提出，结束时回写长期规格”高度重叠。 | Harbor 把长期知识缩到不变量、跨服务契约、红线和 gotcha，并将 Jira 保留为工单源；OpenSpec 核心文档的主要单位是项目内的系统行为与变更。不能泛称 OpenSpec 不支持团队治理：它有可扩展工作流。来源：[官方入门及 delta 机制](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md)、[MIT 仓库](https://github.com/Fission-AI/OpenSpec)。 |
| GitHub Spec Kit（MIT 开源） | 官方当前版本包括 constitution、specify、plan、tasks、implement、converge；还提供扩展、工作流、门禁、组织 preset、私有 catalog、自托管/离线来源。 | 可复用规范、Agent 工作流、提需求至实现、团队治理和分发。 | 不应沿用“只是单仓生成模板”的旧印象。Harbor 如主打泛化 SDD，容易与该生态正面竞争；较适合将自己做成其可调用的团队知识/约束来源。来源：[官方仓库当前说明](https://github.com/github/spec-kit)。 |
| Tessl（商业平台） | 官方文档把 context 当作软件维护：rules、skills、版本化 plugins、团队私有 workspace、registry、结构评审与场景 eval；factory loops 可由事件或计划触发，运行于 Tessl cloud。 | 公开能力与团队私有上下文分离、跨 Agent 技能分发、质量检查、按需加载、持续维护。 | Harbor 的轻量本地执行与私有 Git PR 审核是部署和控制权上的不同选择；“有私有知识和 Skill 分发”本身不是差异。来源：[官方核心概念](https://docs.tessl.io/introduction-to-tessl/core-concepts)。 |
| Kiro（产品） | feature specs 提供 requirements/design/tasks；支持 requirements-first 和 design-first，EARS 条件需求，阶段性评审及需求矛盾/歧义分析。 | Story 结构化、需求澄清、设计实现链路。 | Harbor 更像既有 IDE/Jira 工作流中的小工具与团队知识约束层，Kiro 在 Agent 产品内提供完整开发体验。未核查其所有插件或 Jira 集成，不能声称其绝对没有相同集成。来源：[官方 Feature Specs](https://kiro.dev/docs/specs/feature-specs/)、[官方 Quick Spec 与审批阶段差异](https://kiro.dev/docs/specs/quick-plan/)。 |

## 对“独特性”的务实判断

- **最直接的知识层相邻产品是 Swimm。** 当前公开叙事已经包含代码溯源、业务规则、跨仓影响与 Agent 上下文，不能只把它当成普通 Wiki。
- **最直接的 Spec Delta 开源替代是 OpenSpec。** 单凭“改需求时声明 delta，关单时更新 spec”不足以独立定位。
- **独特性主要在受限环境的产品取舍**：Node 标准库、无服务、无 MCP、保留 Jira DC、显式展示未核实与变化状态、知识进入私有 Git 审核。适合不能部署重平台、不能引入任意模型/外部服务的小团队。
- **这些取舍容易被复刻。** 若要形成持续优势，需要真实团队积累：高价值不变量/排障卡片、触发与路由质量、低维护成本、具体接入配方，以及对 Agent 是否少犯错的对照评估。哈希只能检测字节变化，不能证明业务含义正确；Jira 审批身份仍必须依赖权限与可信来源。
- **建议避免过宽定位。** “更好的企业知识库”会与搜索/Wiki/RAG 平台混战；“通用规格开发框架”会与 Spec Kit/OpenSpec/Kiro 混战。更聚焦的表达可以是“让现有编程 Agent 使用团队已审阅、可核验的工程约束与经验”。其中“已审阅”与“可核验”要有工程证据，不应靠审批评论中的自声明文字。

本笔记没有证明市场上不存在相同组合，也不含规模、客户数、成本或 ROI 对比；这些需要进一步采购试用与团队试点数据。
