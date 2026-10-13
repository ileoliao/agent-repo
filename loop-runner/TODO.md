# TODO

## Harbor CLI 配套(Harbor Mate 与 Harbor CLI 协同)

Harbor Mate 和 Harbor CLI 都是 Harbor 的产品。目标:agent 通过 Harbor CLI 访问 Harbor 产品的功能和上下文,两者尽量配合,而不是各自为政。

已有的通用基础(与 harbor 无关,任何 CLI 都能用):
- skill 的 `SKILL.md` 里 `requires: [harbor]`,Doctor 检查是否安装、能否 `--version`。
- 设置 `harborMate.extraPath`,让 CLI 所在目录进入 agent 命令的 PATH。

待做(需要先拿到 `harbor --help` 和常用子命令的真实输出,当前环境没有 CLI):
- [ ] 梳理 harbor CLI 的子命令,分成只读(查询、状态、日志)和写操作(部署、修改)。
- [ ] 写一个 `harbor` 配套 skill:每个意图一个包装脚本,固定子命令、用 `--json`,Mate 的 policy 自动放行脚本。
- [ ] 只读 policy 预设:只放行只读子命令;写操作一律走 `request_approval`,审批里显示确切命令。
- [ ] 给 agent 的 Harbor 上下文:让 agent 启动时能拿到当前项目、环境、最近的发布或事件等上下文(CLI 提供、Mate 在运行前注入或由 skill 读取)。
- [ ] 认证:`HARBOR_PAT` 等凭证用 `Set Secret` 注入;确认 CLI 支持纯环境变量认证、不弹交互提示。
- [ ] CLI 侧的要求(与 CLI 团队对齐):所有命令非交互、稳定退出码、全部支持 `--json`,最好有自描述命令(如 `harbor commands --json`),让 `@mate` 能据此生成 skill。
- [ ] 反向配合:Mate 的运行结果、审批、任务能否在 harbor 产品里看到(需要对方提供入口)。
- [ ] Doctor 增强:检查 CLI 版本下限、已登录状态(`harbor whoami` 之类,以真实命令为准)。

## 其他待定
- [ ] 把 `feat/*` 分支清理掉(都已合并到本地 `main`),并决定是否 push。
- [ ] 真实 Copilot 下手点验证:`@mate` 对话、`Get Started`、`/doctor`、`/health`、webhook 通知。
