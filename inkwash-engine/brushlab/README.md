# brushlab · 毛笔(笔毛)模型

经典笔触 `Layer.stroke` 是"矢量线 + 噪声"：没有笔毛结构，飞白是随机噪点，墨量不随笔递减。
本目录给出一个 **可选(opt-in)** 的笔毛模型 `inkwash/brush2.py`（+ 栅格部分 `inkwash/brush2_ink.py`），
以及对比测试页。默认 `model='classic'` 输出逐字节不变（见下文"回归验证"）。

```python
L.stroke(pts, w, model='bristle', tip='ce', entry='cang', exit='hui', dry=0.6, wet=0.3,
         load=1.0, pressure=[0.8, 1.2, 1.0], pauses=[0.45], splay=0.6)
L.dot(x, y, r, model='bristle', exit='dun')          # dot() 透传参数
```

| 文件 | 作用 |
| --- | --- |
| `sheet.py` / `tests.py` | 试笔页：前 12 行左旧右新；后 5 行破墨/积墨，左 `interact=off`、右 `interact=on` |
| `rounds/r1..r5.png` | PR3 每轮迭代 |
| `rounds/b2_r1..b2_r7.jpg` | v2 每轮迭代 (r6–r7 = 第二轮评审) |
| `compare_final3.jpg` | PR3 · v2 r5 · 最终 r7 三列对比 |
| `sheet_compare.jpg` | PR3 新旧对比 |
| `compare_pr3_new.jpg` | v2：左 PR3 笔毛列、右 v2 笔毛列，逐行对齐 |
| `ref_vs_new.jpg` | 真迹参考裁切 vs 最接近的新笔触 |
| `make_compare.py` | 生成上面两张图 |
| `ref/`、`REF_NOTES.md` | 公有领域参考笔迹 (LICENSES.md) 与观察记录 |
| `PROGRESS_b2.md` | v2 工作记录 |
| `bench.py` | 典型笔触计时 |
| `check_classic.py` | 经典笔触回归：`save` 生成参考，`cmp` 用 `np.array_equal` 比对 |

## 工作原理（v2，真实函数与参数）

`bristle_stroke(layer, pts, w, ink, pig, t0, dur, tip, load, dry, wet, pressure, entry, exit, pauses, splay,
skew, nb, bleed, taper, start_w, end_w, rough, wobble, bristle, pool, ease, seed)`；`w` 是**半宽**，经典参数都兼容。
v2 去掉了 PR3 的 `_edge_warp`（按噪声挪边）、`poke/chatter`（外缘高频毛刺）、颗粒斑点和逐段抖动；管线是：

1. **路径/笔宽** `path_frame` + `width_profile`：压力先平滑再 `p^1.1`；`wobble` 只做低频宽度起伏 (尺度 ≥ 6w)；
   `_gesture` 只有藏锋/回锋/顿笔的回转和一条很缓的手势弧（尺度 ≥ L/2）。
   点：`_dot_profile` —— 尖落、按到 65% 处最宽、提笔略收的 2:1 瓜子形。
2. **笔毛** `make_bristles`：`nb ≈ 2.3·max W` 根，簇 2–nb/10 根共享墨量/耗墨率；横向只有缓慢的簇游移 (40–120 px)。
   弯道 `splay` 外侧张开，湿笔不分叉；落墨权重 × `fan` 补密度。
3. **墨量** `r = load0·(1 − rate·Kd·cum)^0.8`，`Kd = 1.0·dry + 0.6·dry⁴ + 0.3·min(L/40w, 1.5)/load`。
4. **纸面接触 (飞白)**：沿每根毛的路径采纸面高度 (fiber+gran)，簇平均、顺笔向平滑 8 px，加每缕/单毛起伏；
   `contact = smoothstep(score + 3.2 − 6.5·starve)`，`starve = 1 − r/0.55`；笔肚的毛受保护。
   → 断墨只在墨少处、顺笔向成丝；细笔 (w<4) 只变淡不断；擦痕间补纸面高点的淡灰 (几何足迹 `foot`)。
5. **湿图/墨图** `_deposit`：`splat` 出 C/Q/水/时间/积墨/起笔饱和/足迹；
   `cov = smoothstep(0.12, 0.42, C + 0.12(h−0.5))`；墨图 = 墨量 × 起笔饱和 × 积墨 × 5% 低频浓淡；
   湿笔按 `lev = wet·(1−0.6dry)` 把墨抹匀（淡墨是平的灰）。
6. **渗化** `brush2_ink.diffuse`：湿区前沿顺纤维 (`conductance`) 每步外推 1 px，墨按芯内浓度 × `mob` 带出 → 淡羽晕；
   **水线** `brush2_ink.edge_darkening` (Curtis 1997)：湿区贴边一圈深 10–20%。
7. 写入 `Layer.A`、`Layer.Wet`、`Layer.T`。

## 在山水画中启用

`shanshui/brush.py` 的模块级开关 `BRUSH`（环境变量 `BRUSH=bristle`，或 `paint.py --brush bristle`）；
`bk(**extra)` 在 classic 时返回 `{}`，所以默认输出不变。启用后用于：
斧劈皴 `fupi`、侧锋 `cefeng` / `bundles`（`tip='ce'`）、披麻 `pima_long`、树干飞白勾边、枝(`splay`)、松针(`exit='tip'`)。

```bash
python3 shanshui/paint.py --scale 1 --brush bristle --out /tmp/ssb --name shanshui_brush
```

结果：`shanshui/shanshui_brush_preview.jpg`（全尺寸 png 约 11 MB，未入库）。

## 性能（8 核 VM，单线程，`bench.py`）

| 笔触 | classic | PR3 bristle | v2 r5 | v2 r7 |
| --- | --- | --- | --- | --- |
| w=20, L≈400 中锋 | 13.4 ms | 13.4 ms | 16.8 ms | 18.1 ms |
| w=20, L≈400 侧锋 dry 0.8 | 13.2 ms | 11.4 ms | 16.2 ms | 17.9 ms |
| w=20, L≈400 湿笔 wet 1.0 | 13.0 ms | 14.2 ms | 18.3 ms | 20.3 ms |
| w=3, L≈200 皴 | 2.1 ms | 5.4 ms | 4.7 ms | 5.4 ms |
| w=1.1, L≈70 松针 | 1.1 ms | 2.3 ms | 2.0 ms | 2.2 ms |

整幅山水 (2400×3200) `--brush bristle` 作画 ≈ 25 s。预览：`shanshui/shanshui_brush_v2_preview.jpg`。

破墨打开后（`bench.py` 末尾，毛笔 w=20、L≈400）：干纸上 18 ms（关 17 ms），湿破湿 30 ms（关 16 ms），干后积墨 18 ms（关 15 ms）。试笔页里湿破湿那一行开着大约 55 ms/笔。

## 回归验证

- `brushlab/check_classic.py`：改动前用 HEAD 代码保存参考，改动后 `A`、`T` 均 `np.array_equal`。
- 成都短片：用当前代码把第 4、8 镜重建到新缓存，15+15 个图层 `.npy` 与原缓存逐一 `np.array_equal` 相等。

## 已知局限 (r7)

第二轮评审的改动 (单毛飞白丝、笔向丝理、笔肚浓淡、纤维毛边、侧锋破边、皴线变化、点的差异、出锋淡尖) 见 `INKWASH_NOTES.md` 笔毛模型一节。

- 1 倍下浓墨笔仍比真迹"整"；纤维毛边只在放大时看得出。
- 侧锋的外形仍由测试路径 + `skew` 决定，偏刀形；收笔前的裂缝在收尖处不明显。
- 披麻皴的软断偶尔仍成两三段虚线；松针仍偏硬直。
- 湿笔的羽晕只有 2–4 px，大片晕染靠 `wash` / `finalize`。
- 自交笔画时间取加权平均。

## 破墨 / 积墨（`inkwash/pomo.py`）

`Layer.stroke(..., model='bristle', interact=True)` 或 `layer(..., interact=True)` 才打开。纸面状态是 `PaperState`（`W` / `Tw` / `P`），干燥用 `wet_now`。`brush2._deposit` 依次调用 `prepare`、`soften`、`edge_boost`、`layer_edge`、`apply`、`recolor`。

- 淡破浓：`apply` 把未干的旧墨从新水芯部推开，宽高斯摊到纤维脊上 → 中间淡、外边是软的羽状深边。
- 浓破淡：旧湿区提高 `conductance` 和扩散步数，`soften` 把交界晕开；浓墨不把淡墨推走。
- 湿破湿：色阶接近时 `apply` 把交叠处的旧墨沿纤维推到新笔外沿，交叉处的羽边更散。
- 积墨：旧墨干透后 `layer_edge` 在新层边上加一条明显的水线。

试笔：`python brushlab/sheet.py`。只看这几行用 `brushlab/pomo_rows.jpg`（列题是「关 · interact=off / 开 · interact=on」）。计时里 `bench.py` 末尾有 interact 开/关。细节见 `INKWASH_NOTES.md`「破墨/积墨」。
