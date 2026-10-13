# Harbor Mate 测试工作区(pipeline-test)

这个文件夹是一个**独立的 VS Code 工作区**,用来在正式环境测试 Harbor Mate。**请把 `loop-runner/examples/pipeline-test` 本身作为文件夹打开**(不是打开整个仓库),否则插件找不到 `.github/agents`。

## 安装插件

插件在分支 `feat/loop-chat`(PR #14,尚未合并)。在仓库里:

```bash
git checkout feat/loop-chat
cd loop-runner && npm ci && npm run package      # 生成 harbor-mate-1.0.0.vsix
code --install-extension harbor-mate-1.0.0.vsix --force
```

然后 `code loop-runner/examples/pipeline-test`,执行 `Developer: Reload Window`。

## 正式环境要先改的地方

- 4 个 agent 的 frontmatter 里都写了 `model: gpt-4o-mini`。如果正式环境没有这个模型,运行 `Harbor Mate: List Available Models` 看可用的,再把 `model:` 改成其中一个的名字(或删掉这一行,用 `harborMate.modelFamily` 设置)。
- `.loop/policy.json` 是测试用的宽松策略:禁止 `rm`、`curl`、`ssh`、`sudo`,允许 skill 的脚本,`.github/**` 和 `.loop/**` 受保护。正式环境请按需要收紧。
- 测试过程中产生的运行状态(`.loop/queue`、`runs`、`outbox` 等)已被 `.gitignore` 忽略,不会进 git。
- 脚本是 bash,Windows 上需要 Git Bash / WSL。

---

先 `Developer: Reload Window`。点状态栏最左的 Loop 项打开 **控制台**,点 **Start team**(第一次 Copilot 可能弹授权)。
这里有 4 个 agent:

| agent | 用来测什么 |
|---|---|
| `pipeline` | 三步顺序脚本(已验证过) |
| `brancher` | 第一步的输出决定走哪个分支(验证工具结果回传) |
| `reviewer` | **审批、拒绝改稿、草稿被改、提问回答** |
| `watcher` | **定时唤醒**(每分钟零 token 检查,有触发才调用模型) |

想从头测:停掉团队,删掉 `.loop/` 里除 `policy.json` 以外的内容(queue、runs、gates、checkpoints、outbox、memory 等)。

---

## 场景 1:审批 + 拒绝改稿 + 草稿被改 + 提问(reviewer)

1. 控制台 **Give a task** → 选 `reviewer`,任务随便写,例如 `go`。
2. 等几秒,**Needs you** 出现一张审批卡:能看到**将执行的完整命令**和草稿 `draft.md` 的内容(`release notes v1`)。顶部面板标题会变成 `Harbor Mate Console (1)`。
3. **拒绝**:在输入框写 `请把版本号改成 v2`,点 **Reject**。
   - 预期:reviewer 重写草稿,再次出现一张新的审批卡,草稿内容变成含 v2 的文字。
4. **草稿被改**:先别点批准。在编辑器里打开 `.loop/outbox/review/draft.md`,随便改一个字并保存。
   - 预期(最多 5 秒):卡片出现提示「The draft changed after you opened this card…」,**Approve and run 变灰**。点 **I have reviewed the new version** 后才能批准。
   - 这就是「批准的是你看到的那一版」。
5. 点 **Approve and run**。按钮会变成 Running…,不能重复点。
   - 预期:执行 `publish.sh`,`.loop/outbox/review/published.md` 出现。
6. 控制台出现一个**问题**:`Which channel should I announce in?`,有 `#releases`、`#ops` 两个建议答案。
   - 点一个建议答案(会填进输入框),再点 **Send answer**。也可以改用 `@mate`,见场景 4。
7. 预期结果:reviewer 继续,写出 `.loop/outbox/review/announce.md`,运行显示 **Done**。
   - 在 **Recent runs** 展开这次运行:能看到每一步,和 **Files written**(`draft.md`、`published.md`、`announce.md`)。
   - 点顶部 **Latest result** 应该打开这次最新的产出。

## 场景 2:定时唤醒(watcher)

`watcher` 每分钟做一次**不调用模型**的检查(`check.sh`),只有 `.loop/trigger.txt` 存在时才唤醒。

1. 控制台 Agents 里看 `watcher`:有 Next wake 时间,Last check 是 `nothing to do`。
2. 在终端里:`echo "hello from me" > ~/loop-pipeline-test/.loop/trigger.txt`
3. 最多一分钟内:Last check 变成 `found work`,watcher 运行一次。
   - 预期:`.loop/outbox/watch/report.md` 内容是 `Trigger: hello from me`,运行 Done。
   - `trigger.txt` 被改名成 `trigger.consumed.txt`,所以不会重复触发。
4. 不写触发文件时,它每分钟只检查、不会产生运行记录,也不花 token。

## 场景 3:用 `@mate` 改定时和任务

在 Chat 窗口输入(用支持工具调用的模型):

- `@mate /status`:列出 4 个 agent、状态、定时、下次唤醒。
- `@mate 把 watcher 改成每 10 分钟检查一次`
  - 预期:出现一个提案,带 diff(`schedule: "*/10 * * * *"`)和 **Apply / Dismiss**。**点 Apply 之前什么都没改。**
  - Apply 后团队自动重新加载;控制台里 watcher 的 Next wake 变成最近的整 10 分钟。
- `@mate 把 watcher 的定时关掉` → Apply → watcher 不再有 Next wake(manual only)。关掉时 `schedule` 和 `wakeIf` 会变成注释(打开 agent 文件能看到);再 `@mate 把 watcher 改回每分钟` → Apply,两行都会恢复,零 token 的检查也回来了(提案摘要里会写 `wakeIf restored`)。
- `@mate 把 watcher 的任务改成:写报告时用中文` → 看 diff → Apply。
- 故意说错:`@mate 把 watcher 改成每 61 分钟` → 预期:它解释 cron 不合法,**不会给提案**。

## 场景 4:用 `@mate` 回答问题、派任务

- 场景 1 第 6 步停在提问时,在 Chat 里说:`@mate 有什么在等我?`(或 `/pending`),然后 `@mate 回答 #releases`。
  - 预期:提案显示「Answer to send: #releases」,Apply 后 reviewer 继续。
  - 审批**不会**在聊天里决定:对它说「批准吧」,它会让你去控制台。
- `@mate 让 brancher 现在跑一次` → Apply → brancher 开始运行。
- `@mate reviewer 最近一次做了什么?` → 它会查最近的运行并回答(这是只读,不需要 Apply)。

## 场景 5:记忆

1. `@mate 记住:所有 agent 的总结都用中文` → 提案 → Apply。
   - 写入 `.loop/memory/_all.md`,可以直接打开看和改。
2. 再给 `brancher` 派一个任务,看运行摘要(控制台 Recent runs 里展开)。
   - 预期:总结倾向于中文。注意 gpt-4o-mini 不一定每次都遵守;提示词里一定带了这条(可以在 `.loop/runs/<日期>/<chain>.jsonl` 的 start 事件之前的 checkpoint 看不到,但行为会变)。
3. `@mate 忘掉关于中文的那条` → 提案 → Apply,文件被删除。
4. 已经在跑或暂停的运行不会看到新备忘,**下一次运行**才生效。

## 场景 6:控制与护栏

- 点 **Stop team**:状态变 `Team stopped`;`@mate 启动团队` 也能恢复(需 Apply)。
- 在 brancher 运行时点 Stop:运行显示 **Interrupted** 或取消,再 Start 会接着做。
- 防重复:审批卡点 Approve 后立刻再点一次 —— 只会跑一次。
- 过滤:Recent runs 右上角选 **Problems** 只看失败的。

---

遇到不符合预期的地方,把**控制台截图**和 `.loop/runs/<日期>/<chainId>.jsonl` 里对应那次的内容发给我。
