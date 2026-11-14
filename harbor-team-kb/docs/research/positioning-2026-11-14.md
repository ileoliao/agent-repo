# Harbor team-kb：竞品与定位判断

调研日期：2026-11-14。对照对象是当前 SPEC_V3 的知识层及其 Story 工作流。依据官方文档/源码仓，未部署竞品，也未做同任务效果、总成本或采购评估；相邻产品清单并非完整市场普查。补充商业与 SDD 资料见 [一手资料笔记](competitor-primary-notes.md)。

## 结论

有多类直接相邻方案。Git/Markdown、Agent 记忆、渐进加载、代码关联文档、变更后规格回写都有先例。当前较可信的是特定场景的产品差异：在受管 IDE、已有 Jira DC 和私有 Git 的团队中，以 Node 标准库和少量维护卡片，提供可审查的跨仓导航、业务约束与经验。它尚不是被实证证明的技术护城河。

## 已确认的相邻能力

- **ByteRover**：官方仓库公开描述团队上下文树、版本、审核和同步；知识树是带 Frontmatter 的 Markdown；还可引用其他项目的只读知识源。与团队共享 Agent 记忆的重叠很大。[仓库](https://github.com/campfirein/byterover-cli)、[知识格式](https://docs.byterover.dev/context-tree/local-space-structure)、[跨项目来源](https://docs.byterover.dev/knowledge-sharing/sources)。官方说明本地无需云账号，原生远端同步接其云服务：[本地与云边界](https://docs.byterover.dev/local-vs-cloud)。仓库许可证为 Elastic License 2.0；官网首页另有 MIT 字样，本文只称其“源码可见”，不将其不加区分地列作 MIT 开源项目：[仓库许可证](https://github.com/campfirein/byterover-cli/blob/main/LICENSE)。
- **QMD（开源）**：本地 Markdown 的关键词/向量/混合检索，CLI 可以直接供 Agent 使用，MCP 是可选接入；search→get 并非独有。更丰富的检索组件不自动等于在我们真实业务任务中效果更好，尚无统一评测。[官方仓库](https://github.com/tobi/qmd)。
- **Basic Memory（开源及云产品）**：本地 Markdown、知识图谱与搜索，云版本另提供团队共享空间。[官方仓库](https://github.com/basicmachines-co/basic-memory)、[产品概念](https://docs.basicmemory.com/start-here/what-is-basic-memory)。
- **Serena（开源）**：项目和全局 Markdown 记忆、按需读取、Git/PR 管理，以及记忆引用完整性检查。“Agent 使用可版本化文本记忆”已有清楚的工程先例。[官方设计说明](https://oraios.github.io/serena/02-usage/045_memories.html)。
- **Backstage（开源）**：Software Catalog 通过代码仓中的元数据描述软件与 Owner；TechDocs 提供 docs-as-code。与我们的跨仓职责导航、Git 维护文档有相邻性，但属于开发者门户路线。[Catalog](https://backstage.io/docs/features/software-catalog/)、[TechDocs](https://backstage.io/docs/features/techdocs/)。
- **Swimm（商业）**：代码关联文档及更新机制已有长期产品实践；当前官网叙事进一步覆盖 Agent 所需的业务规则、跨仓影响和经过专家确认的上下文。这是与核心价值主张很接近的商业方案，具体效果仍属厂商公开承诺，未实测。[当前定位](https://swimm.io/context-layer)、[历史 Auto-sync 机制](https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work)。
- **OpenSpec、GitHub Spec Kit（开源）**：前者的 delta→长期规格回写与我们 Spec Delta 很接近；后者当前还支持组织规范、扩展、门禁和私有来源。Story 工作流不能仅凭“规格驱动/可扩展”来声称独特。[OpenSpec](https://github.com/Fission-AI/OpenSpec/blob/main/docs/getting-started.md)、[Spec Kit](https://github.com/github/spec-kit)。
- **Tessl（商业）**：上下文生命周期、规则、技能、私有工作区、版本分发和场景评估也已是产品方向。[官方概念](https://docs.tessl.io/introduction-to-tessl/core-concepts)。

## 我们可聚焦的产品取舍（以下为判断）

1. **服务受限环境。** 不增加常驻服务、MCP、额外模型或专用向量存储；知识共享直接使用现有私有 Git。具体的 Node/Copilot/Harbor Mate 接入和运行预算是目前可验证的实现特点，不是普适的市场唯一性。
2. **维护少量高价值工程知识。** 重点是仓库职责、业务不变量、红线、排障经验；具体算法留在代码和测试。将卡片维护成本控制住，比自动生成更多文档更值得验证。
3. **诚实表达核验状态。** 明确区分未检出、未绑定指纹、内容变化与硬缺失；默认不在普通编辑时刷新旧指纹。整文件指纹只是变化检测：无关改动可能触发提醒，内容一致也不能证明业务解释正确。
4. **顺着既有工作流沉淀。** Jira 保留工单职责，Git 保留知识审核与历史。Story Guard 作为知识变更的一个入口保持可选，先让跨仓找东西、查约束与沉淀经验本身产生价值。它不是知识层获得价值的必要前提。

建议定位：**“让现有研发 Agent 用上团队审阅过、能核对出处的工程知识。”** 面向无法或不愿部署重平台的工程团队，主体验回答三件事：代码和 IaC 在哪、有哪些约束、这条知识现在是否需要重新核实。

## 差异与持续优势的距离

上述技术取舍很容易被复制。持续优势需要来自：真实领域卡片与查询集、误召回/漏召回治理、低干扰的过期提醒、Owner 维护流程，以及可复现的任务收益。当前主要验证了软件机制，尚未证明业务收益。

建议以真实任务比较“仅业务仓/既有指令”“现有开源组合”“Harbor 知识层”，保持任务、代码版本和 Agent 条件一致，观察找到正确仓库的时间、违反既有约束的比例、知识回写率、提醒误报率和每条知识维护成本。没有这些数据前，不应宣称市场唯一、检索领先、知识始终正确或企业级安全闭环。
