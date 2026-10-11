# 冒烟测试：10 分钟走通 Loop Runner

只读写本文件夹内的文件，不访问任何外部系统。逐步确认安装、模型调用、定时、wakeIf、提问、审批、续跑和凭证脱敏。

## 0. 准备

- 本机需要 Node.js（20 或更高；探测脚本和打包都用它）。另外需要 `python3`、`python`、`py` 里的任意一个。探测和发送都走 `scripts/py.js`，它会按这个顺序自己挑，不用改角色文件。
  - Windows 上如果 `python` 打开的是应用商店占位程序，装好真正的 Python，或确认 `py` 能跑。包装脚本会在 `python` 失败后继续试 `py`。
- 在 VS Code 里**单独打开本文件夹**作为工作区。这个文件夹在源码仓库的 `examples/smoke`，不在安装用的 vsix 里。克隆仓库后：文件 → 打开文件夹 → `examples/smoke`。

## 1. 安装与模型（最关键的一步）

0. 生成 VSIX（需要网络，会用 `npx` 拉取 vsce）：在源码仓库的 `loop-runner` 目录运行 `npm install && npm run package`，得到 `loop-runner-1.0.0.vsix`。在 Node 20 上可能出现 `EBADENGINE` 警告，可以忽略
1. 扩展面板 → `…` → 从 VSIX 安装 → 选 `loop-runner-1.0.0.vsix`
2. 命令面板运行 `Loop Runner: List Available Models`
   - ✅ 输出面板列出若干 Copilot 模型，这一步通过
   - ❌ 列表为空或报错：组织可能禁止了扩展调用 Copilot 模型。到这里停下，先解决这个问题

## 2. 启动

1. 运行 `Loop Runner: Reload & Validate Team`，应输出 `Team reloaded OK`
2. 运行 `Loop Runner: Set Secret`，名称填 `SMOKE_TOKEN`，值随便填，比如 `abc12345`
3. 运行 `Loop Runner: Start Team`
   - 首次会在这一步弹出 Copilot 模型授权，选允许（扩展会向每个还没授权的模型发一个极小的请求来触发它）。必须由人点这个命令，扩展激活时不会自己弹授权
   - 冒烟 agent 没指定模型，会用 Copilot 列表里的第一个，顺序不固定，可能不是你想要的。Start 之前先在设置里填 `loopRunner.modelFamily`（用 `List Available Models` 看 family）
   - 状态栏出现 `Loop`
   - 之后关掉 VS Code 再打开这个文件夹，团队会自动接着跑，并先处理队列里没做完的项。点 `Stop Team` 会取消这次自动启动

## 3. 触发

在本文件夹根目录新建文件 `TRIGGER`，内容随便写一句话。

- 最多 1 分钟后，探测脚本发现它，把文件改名为 `TRIGGER.consumed`，然后唤醒 agent
- 不放这个文件时，每分钟的检查都不会调用模型；`.loop/runs/<日期>/wake-<日期>.jsonl` 里能看到每次检查的记录

## 4. 提问 → 续跑

- 右下角弹出通知 "smoke asks: …"，状态栏出现铃铛
- 打开资源管理器里的 **Loop Inbox**，点问题旁的回复按钮，选 `green`
- agent 从原地继续，把颜色写进草稿

## 5. 审批 → 执行 → 续跑

- 收件箱出现审批 "Send …"，点开能看到草稿 `.loop/outbox/smoke/reply.md`
- **先手动改一下草稿**，随便加一行
- 点 ✓，弹窗里显示确切命令，选 Run
- 输出面板应看到：
  - `SMOKE_TOKEN present: True`
  - `value as seen in output: ***`，说明凭证已注入且被脱敏
  - 草稿内容里**包含你刚加的那一行**
- 想测拒绝流程：点 ✗ 并填写反馈，agent 会按反馈修改后重新申请

## 6. 结束

输出面板显示 `■ smoke: done — …`。整条链路的每一步都记录在 `.loop/runs/<日期>/<chainId>.jsonl` 里。

## 常见问题

| 现象 | 原因与处理 |
|---|---|
| Reload 报 skill 找不到 | 打开的文件夹不对，必须是 `examples/smoke` 本身 |
| 弹出 "wakeIf check is failing" | `python3`、`python`、`py` 都不可用，或 `node` 不在 PATH 里 |
| `Copilot returned no models` | Copilot 还没登录好或网络没通（列表为空时会先等最多 2 分钟）。等 Copilot 就绪后重新运行 Start Team；改 `modelFamily` 没用 |
| `no Copilot model matches` | 列表不为空但没有匹配的模型：核对 `loop.model`，或在 `loopRunner.modelFamily` 里填一个 List Available Models 列出的 family |
| 一直没反应 | 运行 `Loop Runner: Show Team Status`，确认 running 为 true；cron 每分钟才检查一次 |

全部走通后，再按根目录的 README 接入真实的角色和 Skill。
