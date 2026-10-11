# 冒烟测试：10 分钟走通 Loop Runner

只读写本文件夹内的文件，不访问任何外部系统。逐步确认安装、模型调用、定时、wakeIf、提问、审批、续跑和凭证脱敏。

## 0. 准备

- 在终端运行 `python3 --version`（没有的话试 `python --version`）。
  - 示例里的探测命令写的是 `python`。只有 `python3` 能用时，把 `.github/agents/smoke.agent.md` 里的 `python` 换成 `python3`。自动化测试会在 `python3`、`python`、`py` 里选一个能用的。
  - 如果只有 `py` 能用（Windows 常见），把同样的 `python` 改成 `py`。
  - Windows 上如果 `python` 打开的是应用商店，说明它是商店的占位程序，用 `py`。
- 在 VS Code 里**单独打开本文件夹**作为工作区：文件 → 打开文件夹 → `examples/smoke`。

## 1. 安装与模型（最关键的一步）

1. 扩展面板 → `…` → 从 VSIX 安装 → 选 `loop-runner-1.0.0.vsix`
2. 命令面板运行 `Loop Runner: List Available Models`
   - ✅ 输出面板列出若干 Copilot 模型，这一步通过
   - ❌ 列表为空或报错：组织可能禁止了扩展调用 Copilot 模型。到这里停下，先解决这个问题

## 2. 启动

1. 运行 `Loop Runner: Reload & Validate Team`，应输出 `Team reloaded OK`
2. 运行 `Loop Runner: Set Secret`，名称填 `SMOKE_TOKEN`，值随便填，比如 `abc12345`
3. 运行 `Loop Runner: Start Team`
   - 首次会弹出 Copilot 模型授权，选允许
   - 状态栏出现 `Loop`

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
| 弹出 "wakeIf check is failing" | 探测命令跑不起来，多半是 `python` 不可用，改成 `py` |
| `no Copilot model matches` | 在设置 `loopRunner.modelFamily` 里填一个 List Available Models 列出的 family |
| 一直没反应 | 运行 `Loop Runner: Show Team Status`，确认 running 为 true；cron 每分钟才检查一次 |

全部走通后，再按根目录的 README 接入真实的角色和 Skill。
