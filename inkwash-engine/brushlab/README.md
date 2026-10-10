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
| `sheet.py` / `tests.py` | 12 行测试页：左旧右新；输出 `sheet.png` 并打印每笔耗时 |
| `rounds/r1..r5.png` | 每轮迭代的测试页 |
| `sheet_compare.jpg` | 最终新旧对比 (JPEG) |
| `bench.py` | 典型笔触计时 |
| `check_classic.py` | 经典笔触回归：`save` 生成参考，`cmp` 用 `np.array_equal` 比对 |

## 工作原理（真实函数与参数）

`bristle_stroke(layer, pts, w, ink, pig, t0, dur, tip, load, dry, wet, pressure, entry, exit, pauses, splay,
skew, nb, bleed, taper, start_w, end_w, rough, wobble, bristle, pool, ease, seed)`；
`w` 与经典笔触相同，是**半宽**；经典参数 (`taper/start_w/end_w/rough/wobble/bristle/pool/ease`) 都兼容。

1. **路径** `path_frame`：Catmull-Rom 稠密化(步长 0.5 px)，求切向、法向、平滑曲率 κ。
2. **笔宽** `width_profile`：起收笔渐变 + `pressure`(标量/数组/callable(u)，宽 ∝ p^0.8) + `wobble`。
   - `entry`：`'cang'` 藏锋（圆头、起笔略鼓、积墨）、`'lu'` 露锋（尖入；侧锋时为斜切）。
   - `exit`：`'hui'` 回锋（圆钝、略鼓）、`'tip'` 出锋（笔毛收拢、外侧毛先离纸，参差出尖）、`'dun'` 顿笔（按下鼓起 1.28 倍 + 积墨）。
   - `pauses=[u…]`：停顿处加宽 16%、积墨（更深、更湿 → 渗化更远）、多耗墨。
   - 圆头：路径两端沿切向延伸，每根毛的延伸长度 = √(1−o²)·W·(簇随机)，所以头部是不规则的圆。
3. **笔毛** `make_bristles`：`nb ≈ 2.3·w`(5–90) 根，横向偏移 o∈[−1,1]。
   - 中锋 `tip='zhong'`：对称、芯部略密且墨多 (`load0 ∝ 1.1−0.3o²`)，外侧毛耗墨快。
   - 侧锋 `tip='ce'`：o=−1 为笔尖(浓、整齐、锐边)，o=+1 为笔根(墨少、耗墨快、横向抖动大 → 毛糙破边)；
     `skew`(默认 0.22) 让足迹相对路径斜置，起收笔成斜切。
   - **成簇**：相邻 2–nb/6 根毛组成一簇，共享墨量起伏、游移、断墨阈值与耗墨率。整簇断墨才会露出几像素宽的白丝，
     这是飞白像"丝"而不像"噪点"的关键。
4. **墨量递减**：每根毛 `r_b(s) = load0_b · (1 − rate_b·Kd·cum(s))^0.8`，近似线性耗尽（毛含墨直到突然断）；
   `cum` 为累计落墨量(含压力、停顿)，`Kd = 1.6·dry + 1.2·dry⁴ + L/(2w)/(110·load)`，长笔自然墨尽。
   `r_b` 加上沿笔向的簇噪声(20–60 px)与单毛噪声后低于阈值 `thr_b` 即断 → 顺笔向的飞白，从外侧毛、笔末开始。
5. **转折散锋**：`splay·clip(|κ|·W)` 让弯道外侧的毛按簇随机散开、出现缝隙并提前枯竭。
6. **落墨** `_deposit`：所有毛的采样点以双线性亚像素 splat (`brush2_ink.splat`，`np.bincount`) 写入 bbox 缓冲，
   同时累积墨量 Q、时间 U、积墨 PL、条纹 SK；高斯 σ≈0.45+0.018w+0.25wet。
   - 覆盖 `cov = 1−exp(−2.2C)`，再用 `纤维图 + nz_edge` 做门限 → 边缘清楚但毛涩，枯笔边缘再被纸纹啃碎。
   - 墨色 = `ink·(0.5+0.5·r)·(1+0.38·积墨)·条纹·纤维吸墨·颗粒(granulation)`。
   - 纸纹门限：墨少处只沾到纸面纤维/颗粒高点。
   - 湿笔水渍边：`cov − blur(cov)` 的正部加深边缘。
   - **毛细渗化** `brush2_ink.capillary`：湿墨掩膜做 `it ≈ min(12·wet^1.1, 1+w)` 次 3×3 膨胀，
     每步乘以纤维图决定的传导率 → 墨顺纤维爬出毛边；只在 bbox 内计算。
   - 写入 `Layer.A`、`Layer.Wet`（finalize 的墨晕仍有效）和 `Layer.T`（按 U/C 求每像素 u，渗出部分稍晚）。

## 在山水画中启用

`shanshui/brush.py` 的模块级开关 `BRUSH`（环境变量 `BRUSH=bristle`，或 `paint.py --brush bristle`）；
`bk(**extra)` 在 classic 时返回 `{}`，所以默认输出不变。启用后用于：
斧劈皴 `fupi`、侧锋 `cefeng` / `bundles`（`tip='ce'`）、披麻 `pima_long`、树干飞白勾边、枝(`splay`)、松针(`exit='tip'`)。

```bash
python3 shanshui/paint.py --scale 1 --brush bristle --out /tmp/ssb --name shanshui_brush
```

结果：`shanshui/shanshui_brush_preview.jpg`（全尺寸 png 约 11 MB，未入库）。

## 性能（8 核 VM，单线程，`bench.py`）

| 笔触 | classic | bristle |
| --- | --- | --- |
| w=20, L≈400 中锋 | 12.7 ms | 10.9 ms |
| w=20, L≈400 侧锋 dry 0.8 | 13.0 ms | 8.6 ms |
| w=20, L≈400 湿笔 wet 1.0 | 12.6 ms | 12.3 ms |
| w=3, L≈200 皴 | 2.0 ms | 3.8 ms |
| w=1.1, L≈70 松针 | 0.65 ms | 1.4 ms |

整幅山水 (2400×3200) 作画 ≈ 17–18 s（classic 相近）。

## 回归验证

- `brushlab/check_classic.py`：改动前用 HEAD 代码保存参考，改动后 `A`、`T` 均 `np.array_equal`。
- 成都短片：用当前代码把第 4、8 镜重建到新缓存，15+15 个图层 `.npy` 与原缓存逐一 `np.array_equal` 相等。

## 已知局限

- 顿笔收笔仍偏"棒槌"形，缺少顿后提笔的转折小尖。
- 渗化只按纤维**强度**，没有纤维**方向**场；纤维稀的纸区渗化偏各向同性。
- 自交笔画按加权平均 u 取时间，交叉处动画时刻是平均值而不是"先到者"。
- 松树树干勾边启用后比经典版柔，飞白边不如经典版锐利；树干填色仍用经典笔触。
- 笔毛之间没有真实的墨水再分配（湿毛蹭干毛），也没有纸面已有墨对后笔的影响（破墨/积墨的物理交互）。
