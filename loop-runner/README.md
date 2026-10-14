# Harbor Mate

Harbor Mate 让 VS Code 的自定义 agent（我们叫它 **mate**）在你不在时用 GitHub Copilot 的模型替你干活，只在需要你的时候打断你：问你一个问题、请你批准一条命令、或者告诉你它被拦住了。

## 上手

1. **装扩展**：需要 Node.js 20+ 和网络。在 `loop-runner` 目录运行 `npm install && npm run package`，得到 `harbor-mate-1.0.0.vsix`；在扩展面板 → `…` → 从 VSIX 安装。
2. **登录 GitHub Copilot**（VS Code 左下角的账户菜单）。mate 用的是你的 Copilot 模型。
3. **加第一个 mate**：打开你的工作区，点状态栏的 Harbor Mate。空工作区里有两个现成的 mate（每日提交报告、文件夹监听），点 **Add this**；也可以点 “Describe what you want”，在 Chat 里用 `@mate` 说你要什么。添加后会立刻体检，通过就**自动启动**，控制台直接停在新 mate 上。首次启动时 Copilot 会弹出授权框，点允许。
4. 想先走一遍完整流程（定时、提问、审批、续跑）：克隆仓库后单独打开 `examples/smoke`，按它的 `README.md` 做，10 分钟，不碰真实系统。

## 每天怎么用

打开控制台（点状态栏，或命令 `Harbor Mate: Open`）。它只有一个页面，左边是名册，右边是和选中 mate 的对话：

- **名册**：每个 mate 一行，需要你的排在最上面（等得最久的第一个），然后是正在工作的，再是其余的。
- **顶部的胶囊**：有事要你时写 “N need you”（mate 关着时是 “Off · N need you”），点一下直达等得最久的那张卡片；没事时显示谁在工作、下次几点醒、或 “Off”。
- **对话末尾的卡片**：问题、审批、被拦下的命令都在这里处理。审批会显示确切的命令和草稿，Reject 会就地问一句理由；被拦下的命令可以 Allow（只对这个 mate、只这一条）或 Dismiss。
- **输入框**只做一件事：给选中的 mate 发消息（有问题待答时就是答复）。`@名字 内容` 发给另一个 mate，`/stop` 结束当前这次运行。
- **一次运行**结束后折成一张结果卡：Done、Nothing new、Blocked、Failed 或 Stopped，产出的文件在最前面，步骤折叠起来。
- **右上角 `⋯`**：Add a mate、Check mates（体检，有运行记录时附带健康报告）、Clean up finished work、Set a secret、Stop all mates。
- **状态栏只有一项**：`N need you`、`<mate> · step N`、`Mates · next 09:00` 或 `Mates off`，点它打开控制台。

**用 `@mate` 创建和修改 mate**：在 VS Code 的 Chat 里输入 `@mate`，用自然语言说「新建一个 release-watch 盯发布」「把 sentinel 改成工作日每 30 分钟」「写一个 skill 查发布状态」。它先查清现状再给出**提案**，你点 **Apply** 才生效；它不会替你批准任何命令。

## 安全

- 每条命令和写入都先过策略；**deny 规则永远优先**，人工批准也越不过。
- 凭证（`Set Secret`）只在执行时注入，不进提示词，输出里会被遮掉。
- 你批准的就是你看到的那一版草稿；之后被改过的不会执行，要重新审核。
- mate 默认只能写 `.loop/outbox/`，`.loop/`、`.github/`、`.git/` 受保护。

## 更多

完整的 mate 文件格式、`wakeIf` 退出码、事件触发、设置、命令和限制见 [docs/reference.md](docs/reference.md)。给维护代码的 AI 看的架构和不变量在 `AGENTS.md`。
