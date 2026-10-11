---
name: inkwash-creation
description: >-
  Use when asked to paint a Chinese ink-wash (水墨/国画/山水) image or make an
  ink-wash animated video procedurally with code, using the inkwash engine and
  Claude Code.
---
# 水墨创作（程序化国画）

用代码画国画：静态山水/花鸟，或带“一笔笔画出来”动画的水墨视频。引擎是纯 Python（numpy + OpenCV + SciPy + Pillow），不靠 AI 出图。

## 0. 找到引擎
- 本机工作副本：`/workspace/inkwash`（包 `inkwash/`：`core.py` 墨模型/宣纸/笔触，`motifs.py` 山水树屋等母题，`text.py` 字幕/印章；`shanshui/` 是静态山水的模块化示例：`brush.py rocks.py massif.py trees.py figures.py atmos.py paint.py annotate.py`）。
- 不在本机就从 GitHub 项目仓库的 `inkwash-engine/`（或 `chengdu-inkwash/`）拉下来；先读 `INKWASH_NOTES.md`（编码要点）和 `shanshui/NOTES.md`（技法→代码对照）。
- 依赖：`pip install -r requirements.txt`；中文字体 `apt install fonts-noto-cjk fonts-noto-cjk-extra`。

## 1. 先定稿再写码
- 静态画：定画幅（立轴竖幅 2400×3200 / 横卷 3840×1600）、构图（三远：高远/深远/平远）、要展示的技法清单、题款内容（诗句须核对原文、落款干支年）。
- 视频：先出脚本（分镜、旁白、时长、标题），旁白用 TTS 生成后按真实音频时长对齐镜头时间轴。

## 2. 让 Claude Code 写场景
- 命令：`cd <engine dir> && ~/.local/bin/claude -p "<任务>" --model opus --dangerously-skip-permissions < /dev/null`；续跑同一会话用 `--continue`/`--resume`。
- 把任务写进 `PROMPT.md` 再让它读，并要求“小文件分步写”，避免长回复中途断线。
- 新作品写在新目录/新脚本里，只 import 引擎，不改旧场景；共用函数要改时（如 `hall()`）确认所有调用点都受益。
- 若报 `403 Request not allowed`：先看 `claude auth status`，等几分钟重试；通常是临时拒绝，不要立刻判断为额度用完。

## 3. 渲染 → 自己看图 → 迭代
每轮渲染预览图并亲眼检查，至少 2–3 轮，每轮存 `rounds/rN.jpg`。按下面清单逐条过：

### 评审清单（必过）
**物理合理**
- [ ] 建筑不悬空：每层屋檐下都有柱/墙，多层殿阁层间有柱；有台基。
- [ ] 树有根、扎在石上；船在水线上，有倒影/水纹；人物在亭内或路上。
**笔墨**
- [ ] 皴法不单一不重复：主峰干笔、侧锋、飞白；坡脚湿笔淡墨；长短、方向、弧度、干湿按区域变化，不像盖章。不同石块用不同皴（披麻/斧劈/米点）。
- [ ] 苔点有聚有散、有大有小、有浓有淡，只点在提神处（峰顶、石缝、树根），不要沿山脊等距成串。
- [ ] 墨分五色清楚（焦浓重淡清）；浓墨块要透气，留淡处和雾隙，不闷不实。
- [ ] 泼墨/前景浓墨是有意图的整块形状，边缘有湿润渐变，不脏不散。
**造型与构图**
- [ ] 中景山形不雷同：大小、轮廓、线重有变化，合并或突出一两座，避免“馒头”。
- [ ] 三远层次：近浓远淡，远景加雾 mask，前景遮挡后景。
- [ ] 瀑布有水口、有断续/叠泉、有石阻、下有落潭和水汽，不是一条笔直白带。
- [ ] 留白有意义（云、水、瀑），空处不显得空洞。
**款印**
- [ ] 有题款（竖排、自右向左、字正确）和名章，与压角印平衡；正式图不出现其它文字。
**视频额外**
- [ ] 字幕不越界、无豆腐块；旁白/配乐音量正常；转场连贯；非修改场景与上一版一致。

## 4. 交付
- 静态：`<name>.png` 高清原图 + `<name>_preview.jpg`（<3 MB）+ 可选 `techniques_annotated.jpg`（技法标注版，标签位置取自实际绘制坐标）+ 修改时的前后对比图。
- 视频：全质量母版 + 聊天/分享用压缩版（H.264 + AAC，`-movflags +faststart`，<45 MB）。
- 可选：一页信息图讲编码技术（HTML + headless Chrome 截图，背景用引擎的 `make_paper`）。
- 大文件不进 git：视频/大图挂 GitHub Release；代码、NOTES 和小图提交到项目仓库对应子目录，开 PR。
- 在本地 git 里提交每个里程碑。

## 5. 回报
说明构图、用了哪些技法、哪些做得好/哪些还弱（诚实），附预览图；用户的新意见先对照清单，必要时把新规则补进本技能的清单。
