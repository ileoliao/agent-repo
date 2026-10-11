# 水墨风格的编码要点

> 本项目（锦城千年 · 程序化水墨动画）全部画面由 `numpy + opencv + scipy + Pillow` 生成，没有任何 AI 生图或位图素材。
> 这份笔记按"从纸到成片"的顺序，整理代码里真正起作用的技巧，方便以后复用或继续修改。
> 文中函数名均对应 `inkwash/` 下的真实代码。

---

## 0. 一句话架构

```
Canvas(宣纸 + 公共噪声场)
  └─ Layer × N（每层存 A=吸光度[H,W,3]、T=落笔时刻[H,W]、Wet=湿度）
       ├─ stroke()  一笔
       ├─ dot()     一点
       └─ wash()    一片渲染
  finalize() 墨晕 → save_canvas() 存 .npy + mipmap
Runtime.render(t)：按镜头仿射采样各层 → 只显示 T < t 的像素 → 画面 = 纸色 × exp(−ΣA)
Composer：转场 / 做旧 / 字幕 → render_segment 多进程管道给 ffmpeg
```

核心思想有两条：

1. **墨是吸光度，不是颜色**（Beer–Lambert 减色叠加）。
2. **每个像素都有"被画到的时刻" T**，动画就是让 `t` 扫过 T。

---

## 1. 宣纸纹理 `core.make_paper(h, w, seed)`

宣纸由四部分叠加：

| 成分 | 做法 | 作用 |
| --- | --- | --- |
| 云絮/帘纹 | `fbm(h,w,260,5)` + `fbm(h,w,34,3)` | 大尺度厚薄不匀、中尺度絮团 |
| 纤维 | 约 `h*w/520` 根随机弯曲短线（6 点折线 + `cv2.polylines`，亮 80% / 暗 20%，10% 拉长 3.5 倍） | 宣纸最有辨识度的特征 |
| 颗粒 | 高斯模糊后的白噪声 | 细腻的纸面质感 |
| 旧化 | 大尺度 `fbm(...,600,...)` 在米黄 `base` 与泛黄 `aged` 之间插值 | 边角发黄 |

```python
lum = 1.0 + 0.010*cloud + 0.012*floc + 0.03*fl - 0.03*fd + 0.009*grain
paper = base_aged_col * lum
fiber = clip(0.5 + 0.9*fl + 0.6*fd + 0.12*floc) / 1.6   # 另存一张"纤维图"
```

**关键**：纤维图 `cv.fiber` 会被后面所有笔触和渲染再乘一次（`fib = 0.86 + 0.28*fiber`），
所以墨"吃"进纸里：纤维处深、空处透。这一步是"不像电脑画"的关键之一。

另外 `make_paper` 只在 `Canvas.__init__` 调用一次，同时生成四张公共噪声场：
`nz_edge`(5px 笔边毛涩)、`nz_mid`(40px 渲染扭曲)、`nz_low`(220px 洇开速度)、`nz_gran`(3px 颜料颗粒)。

---

## 2. 墨分五色：吸光度与颜料

```python
# core.py —— 每通道吸光度 (R,G,B)，越大越吸收
INK       = [1.00, 0.97, 0.90]   # 松烟墨，淡处偏冷灰
INK_WARM  = [0.92, 0.97, 1.02]   # 油烟墨，略暖
INDIGO    = [0.95, 0.52, 0.26]   # 花青
OCHRE     = [0.22, 0.45, 0.92]   # 赭石
VERMILION = [0.06, 0.92, 1.00]   # 朱砂
GOLD / MALACHITE / JADE / CRIMSON / UMBER / PINK ...
```

- 最终颜色 `img = paper * exp(-ΣA)`（`Runtime.render`）。淡墨叠淡墨自然加深，赭石叠花青自然得到灰绿——和真实透明水色一样**只能减色、不会盖住下层**。
- 混色直接线性组合向量：`INK*0.45 + INDIGO*0.55`（远山青灰）、`OCHRE*0.6 + INK*0.15`（平原土色）。
- **焦、浓、重、淡、清**五色不靠换颜色，而靠 `ink` / `dens` 系数：
  - 焦墨：`ink≈1.1–1.8`（点苔、印章边、眉）
  - 浓墨：`0.8–1.0`（近景勾线）
  - 重/淡：`0.3–0.6`（皴、中景）
  - 清墨：`wash dens 0.08–0.2`（远山、雾里的田）
- 远近层次 = 同一题材在不同层用不同 `ink/dens/pig`：远景偏 INDIGO、只染不勾；近景偏 INK、勾皴染点俱全。

---

## 3. 笔触模型 `Layer.stroke(pts, w, ...)`

一笔的全部参数：

```python
def stroke(self, pts, w, ink=0.85, pig=INK, t0=0.0, dur=0.6, dry=0.15, wet=0.5,
           taper=(0.12, 0.35), start_w=0.45, end_w=0.05, rough=0.22, wobble=0.10,
           step=None, bristle=1.0, pool=0.35, ease=0.3):
```

实现步骤：

1. **路径**：`catmull(pts, step)` Catmull-Rom 样条 + 按弧长等距重采样。
2. **像素坐标系**：在包围盒里画一条粗 `polylines` 当候选掩膜，再用 `cKDTree(P).query` 求每像素最近的中心线点 → 得到弧长 `s`（沿笔）和横向偏移 `across`（跨笔）。端点外用到端点的距离做圆头。
3. **提按 / taper**：宽度剖面 `prof`：
   - 起笔 `u < taper[0]`：从 `start_w` 正弦升到 1（入锋）；
   - 收笔 `u > 1-taper[1]`：降到 `end_w`（出锋）；
   - `wobble` 用 `noise1d` 做低频粗细抖动（手抖、提按不匀）。
4. **毛涩边 rough**：`cover = clip(W*(1 + rough*nz_edge) - rad + 0.6, 0, 1)`，边界被全局噪声咬出毛边。
5. **笔毛/飞白 dry + bristle**：建一张 `(弧长/18) × 笔毛数` 的随机格子 `grid`，用 `map_coordinates` 映射成"沿笔方向拉长、横向高频"的条纹 `B`。
   ```python
   load  = ink * (1 - dry*0.55*u**1.3)                 # 越往后墨越少
   dness = dry*(0.15 + 1.05*u**1.6) + dry*0.45*nn**2   # 后段、两侧更易干
   keep  = smoothstep(dness-0.12, dness+0.12, B+0.1)   # 低于阈值的笔毛露纸白 → 飞白
   ```
6. **湿边 wet + pool**：`pl = 1 + pool*wet*smoothstep(0.55,1,|nn|)`，笔画两侧积墨形成"水口"；`Wet` 累加供 `finalize` 洇晕。
7. **纸纤维**：再乘 `0.86 + 0.28*fiber`。
8. **作画时间**：`T = t0 + dur*ease(u)`，同像素取最早时刻。

常用组合：

| 效果 | 参数 |
| --- | --- |
| 中锋勾线 | `dry 0.3, taper (0.1,0.4), start_w 0.6, end_w 0.12` |
| 披麻皴 | `w≈1.4, dry 0.45–0.8, wet 0.3, rough 0.35` |
| 干笔飞白长眉 | `w 15, ink 1.45, dry 0.75, bristle 1.0, end_w 0.08, wobble 0.25` |
| 点苔 | `Layer.dot(...)` = 两点一短笔，`dry 0, wet 0.8, taper (0.35,0.5)` |

**`scenes_a.dry_line`** 是更"像人手"的干笔勾线：把一条线随机切成 1–2 段，每段粗细/墨量/飞白不同、段间错位和断口——用于三星堆面具、鱼嘴等需要"笔断意连"的地方。

---

## 4. 墨染 `Layer.wash(...)` 与晕染边缘、颗粒

```python
def wash(self, x0, y0, field, pig, dens=0.4, t0=0.0, seeds=None, speed=500.0, jitter=0.5,
         edge=0.5, gran=0.35, wet=0.9, lo=0.25, hi=0.6, warp=0.22, edge_blur=7, tfield=None, body=None):
```

输入是一张**软形状场 `field`**（任意 0..1 的浮点图：高斯、模糊多边形、噪声都行），然后：

1. **有机边缘**：`m = smoothstep(lo, hi, field + warp*nz_mid*0.5)` —— 先用噪声扭曲再阈值，边缘就不是几何形。
2. **水渍边（边缘积墨）**：`e = clip(m - GaussianBlur(m, edge_blur))`，`m2 = m*(1-0.35*edge) + edge*2.2*e`。中间淡、边缘深，正是水墨渲染干后的"水线"。
3. **颜料颗粒 gran**：乘 `nz_gran`（3px 噪声）+ 纸纤维，模拟赭石、石绿等矿物颜料的沉淀。
4. **洇开的时间场**：默认从 `seeds` 按距离扩散：`T = t0 + d/speed * (1 + jitter*nz_low)`——墨在纸上慢慢洇开；也可直接传 `tfield` 自定义（见第 8 节）。

辅助：`motifs._poly_wash / poly_wash`（多边形 → 模糊 → wash，用于屋面、台基、布面）、
`mist_wash`、`ground_wash`、`scenes_a.band_wash`（横向带状天光/地色）。

### 墨晕 `Layer.finalize()`

每层收尾时执行：把湿度图 `Wet` 做两级模糊（2.5px + 9px），减去自身得到向外渗出的"一圈"，
乘纤维后按邻近颜色加回 `A`；同时把这圈晕的 `T` 设为腐蚀后的 T + 0.28 秒——**墨落纸后稍晚才向外渗**。
`halo` 参数控制强度（面具层 1.1，远山 0.6）。

---

## 5. 留白与雾气

水墨的"白"是纸，不是白颜料，所以留白全靠**不画**和**褪回纸色**：

- **山脚留雾**：`mountain_range` 里 `fogm = 1 - smoothstep(1-fog, 1.02, 深度比)`，山体越往下越淡直至消失；`fog` 越大雾越高。
- **雾带（屏幕后处理）**：每个镜头 `mist = [dict(y=, h=, a=, speed=, oy=, lo=, hi=)]`，`Runtime.apply_mist` 在画面 y 处取一条高斯带 × 漂移的噪声纹理 `mist_tex`，把画面**向纸色混合**：`img = img*(1-a) + paper*a`。不同带速度不同（甚至反向），形成层层流动的云气。
- **田埂/布边留白**：都江堰梯田的田埂就是 `inside` 场里没上色的窄条。
- **主体边缘散入纸**：面具用 `dis = smoothstep(...)` 遮罩让右下颌、耳梢、下巴大片消隐。

---

## 6. 题材的参数化（motifs.py）

### 山 `mountain_range(L, x0, x1, base_y, peaks, ...)`
`peaks=[(x, 高, 宽), ...]`，每个主峰随机再派生 1–3 个副峰；山脊高度 = 洛伦兹型峰的最大值 + 多尺度 `fbm1d` 起伏。然后依次：

1. **染**：脊下按 `exp(-深度/fall)` 渐淡 + `blot`(fbm 墨块) + `streak`(纵向条纹) + 坡向明暗 `shade=1+0.5*tanh(坡度)`，从峰顶种子 `wash` 洇开；
2. **勾**：沿山脊分成 90–320px 一段的断续轮廓线，粗细随机；
3. **结构线**：主峰向下几笔；
4. **皴**：按高度加权随机撒点，每处 3–7 根顺坡平行长线 = **披麻皴**；
5. **点苔**：峰顶附近 `L.dot` 焦墨点；可选 `trees` 小树。

同一函数调 `outline=0, cun=0, fog=0.8, pig=INK*0.35+INDIGO*0.65` 就是远山；全开就是近山。

### 其他
- `rock`：两三笔外轮廓 + 斧劈皴横扫 + 墨染 + 点苔。
- `bamboo`：一节一节写竿、节处留白、"个""介"字叶（`leaf_cluster`）。
- `willow / foliage_tree(kind='round'|'pine') / cypress / tiny_tree`：干 + 枝 + 点叶。
- `river`：两岸断续勾线 + 淡花青染 + 水纹；`width` 可以是 `s -> 宽度` 函数（河越流越宽）。
- `hut`（茅屋）、`hall`（殿阁，见第 11 节）、`wall_segment`（夯土城墙，`rise=True` 自下而上长出来）、`figure / boat / ox / banner`。

所有题材都只接受 **位置 + 尺寸 + 起始时刻 t0 + 墨量**，内部用 `L.rng` 随机化细节，组合起来就能搭景。

---

## 7. 时间轴上的"生长"式揭示动画（T 场 / tfield）

每层 `T[y,x]` 记录该像素被画到的时刻。渲染时：

```python
# render.Runtime.render
v = clip((t - T) / fade, 0, 1); v = v*v*(3-2*v)     # smoothstep 淡入
A += layer_A * v
```

于是：
- **笔触**按 `t0 + dur*ease(s/L)` 从起笔到收笔"写出来"；
- **渲染**从种子点按 `d/speed` 洇开；
- **自定义 tfield** 可以做任意显影顺序：
  - 面具：`tf = 0.3 + 0.8*径向距离 + 噪声`，墨从面中心向外显，积墨/铜绿/锈依次 +0.5/+0.7/+0.9 秒；
  - 都江堰梯田：每块田的 `ct = 5.0 + 到宝瓶口距离/330 + 随机`，**水到哪块田、哪块田就绿**；渠网 `_geom()` 计算水到达每个分叉点的时刻（`CANAL_V=360 px/s`），子渠从那一刻开始流；
  - 蜀锦：`tf = t0 + v/h*1.7 + 0.45*竖向条纹噪声`，像一道道竖笔自上而下"染"出来。
- **整镜揭示**：`scenes_a.reveal_radial / reveal_x` 用 `L.T = max(L.T, f)` 对整张画布再加一个径向/横向的"最早可见时刻"，开场像墨在纸上铺开。
- `finalize` 的晕比墨芯晚 0.28s；每层 `fade` 控制淡入快慢（远景 0.8 慢、勾线 0.3 快）。

---

## 8. 镜头运动

- `SceneBase.keys = [(t, cx, cy, zoom), ...]`，`camera(t)` 用 **PCHIP** 插值（不过冲、不抖），关键帧之外按末段速度 ×0.35 继续漂移，避免转场时画面突然静止。
- **视差**：每层 `parallax`（远山 0.35–0.6，近景 1.12–1.2）。`Runtime.matrix` 中视点和缩放都按 `p` 加权：`zp = z**p`，远层移动更少。
- **mipmap**：`save_canvas` 存 L0/L1/L2 三级；`Runtime.level(zp)` 拉远时取低分辨率级，避免摩尔纹和锯齿。T 通道降采样用 `erode`（取最早时刻）而不是平均。
- **层内仿射** `layer_affine(i, name, t)`：太阳神鸟金箔 `getRotationMatrix2D(disc_c, 3.2*t)` 慢转；蜀锦各层剪切 `[[1,a,-a*y0],[0,1,0]]` 模拟风吹摆动。
- **实时动态层** `dynamic(ctx)`：渠中流水线、雨与涟漪、茶汽、落钱、人群等每帧在屏幕空间直接往 `ctx.A` 加吸光度（`DynCtx.add`）。

### 转场 `Composer.mix` + `transition_field`
2–3 个随机中心的径向距离场 + fbm 扰动 → 归一化 F；阈值 `th` 随时间推进，`inside` 处换新画面，
前沿 `front = exp(-((F-th)/0.018)²)` 叠一道深墨线、前方 `ahead` 略暗——"墨洇换景"。
最后 `aging_map()` 全片乘一个暗角 + 几块淡黄斑（旧画）。

---

## 9. 色彩调色

浅绛 + 青绿的思路：大部分是墨，颜色只点到为止。

| 用途 | 颜料组合 |
| --- | --- |
| 远山青灰 | `INK*0.35 + INDIGO*0.65` |
| 天光 | `OCHRE*0.8 + VERMILION*0.2`，dens 0.10 |
| 平原/地色 | `OCHRE*0.6 + INK*0.15` / `JADE*0.5 + INK*0.2` |
| 江水 | `INDIGO*0.6 + INK*0.3 + JADE*0.1` |
| 台基/夯土 | `UMBER*0.5 + INK*0.3` |
| 青铜 | `INK*0.72 + MALACHITE*0.13 + UMBER*0.15`；铜绿 `MALACHITE*0.45+JADE*0.3+INK*0.25`；土锈 `OCHRE*0.5+UMBER*0.5` |
| 梯田（5 类随机） | `JADE+GOLD` / `MALACHITE+INDIGO+GOLD` / `GOLD+JADE` / `OCHRE+GOLD` / `INDIGO+JADE` 各混少量 INK |
| 印章 | `VERMILION * 1.55` |

经验：**每种颜料都混一点 INK**，颜色就"沉"下来，不会像数码色那样跳。

---

## 10. 印章与字幕（text.py）

- **印章** `seal_absorb(chars, size, seed, style='bai'|'zhu', shape, rot)`：Pillow 在 4× 画布上写 Noto Serif CJK Black；白文 = 朱底挖字，朱文 = 边框 + 字。然后
  边缘用 fbm 咬掉（崩边）、`chip` 随机缺损、`ink` 低频不匀（印泥），最后输出吸光度 `VERMILION*1.55`，以 `exp(-A)` 乘到画面上——**和墨一样是减色**，压在墨上也自然。
  `Runtime.apply_seal`：0.18s 淡入 + 从 1.12 倍缩回 1.0（"按下"感），可配置 `seal_fade`。
- **标题栏** `Caption`：左上标题 + 年代 + 序号小印（壹…拾贰）。
- **字幕** `subtitle_events`：TTS 的 `word_boundaries.json`（数字读作中文）与显示文本用 `difflib` 逐字对齐 → 每个字的时刻；按标点切句、合并短句，每行 ≤16 字。`text_sprite` 带纸色柔光描边 (`glow`) 保证可读。

---

## 11. 多进程渲染与 ffmpeg 合成（render.py / audio.py）

1. **构建** `build_all(workers=3)`：每镜在大画布（如 3600×2000）上一次性作画，`save_canvas` 把每层存成 `(H,W,4)` float32 `.npy`（RGB 吸光度 + T）+ 2 级金字塔，写到 `INK_CACHE`（默认 `/tmp/inkcache`，约 4–5 GB）。大画布先建。
2. **渲染** `video(workers=4, chunk=150)`：3903 帧切成 150 帧一段，`ProcessPoolExecutor` 并行；每段 `render_segment` 开一个 Composer，`np.load(mmap_mode='r')` 内存映射缓存，逐帧 `rgb24` 通过 stdin 管道给 `ffmpeg libx264 -crf 16 -pix_fmt yuv420p`。
3. **拼接**：`ffmpeg -f concat -c copy` → `video_silent.mp4`。
4. **混音** `audio.mix`：旁白作侧链 `sidechaincompress` 压古筝 BGM（说话时让开）、BGM 片尾淡出、**两遍 `loudnorm`** 到 −16 LUFS / −1.5 dBTP。
5. **封装**：视频 copy + AAC 192k，`-movflags +faststart`。

---

## 12. 本次修复要点

对比图：`docs/fix_compare.jpg`（三场景前后）、`docs/hall_fix_compare.jpg`（飞檐补柱前后）。

### 三星堆面具 `S02._mask`（原：卡通脸）
- 按真实**纵目面具**重写轮廓：宽平面、刀形长眉、杏眼、薄阔口、翼状外展大耳（`face` / `ears` 多边形 + `warp()` 轻微不对称）。
- **以墨块写体积、少勾线**：`val` 场 = 两侧/下颌/眼窝/鼻下/口下加深、额与颧留亮；凹处再压一层积墨 `deep`。
- **锈蚀肌理**：细颗粒 `vnoise(5)` × 竖向垂流 `vnoise(6, 70)`；铜绿结壳 `crust`、土锈 `rr_`、蚀坑 `pits` 分别 wash。
- **纵目柱**：每只眼一个向前外伸的短圆柱（透视缩短，`ax,ay=s*62,6`），柱身下侧暗上侧亮、端面椭圆淡染 + 一笔重弧、投影落在面颊；先用 `carve` 在铜面上留出柱身亮面。
- **干笔点睛**：只有耳根、长眉（`dry 0.75`，内端重按外端飞白）、上下睑、鼻梁、闭口线几笔 `dry_line`；面具右下与耳梢散入纸和雾中。

### 都江堰 `S05`（原：格子田、像示意图）
- **三重山**：远山只染不勾（`fog 0.8`）、中山淡勾、近山皴染俱全，`t0` 错开。
- **岷江** `_brush_river`：跨江坐标 `q∈[-1,1]`，近岸深、边缘化入纸；顺流长短水纹笔触（粗细浓淡不一、正弦摆动）；岸线只偶见几段干笔。
- **鱼嘴** `_fish_mouth`：尖嘴迎上游，两道长笔劈江为内外二江；竹笼卵石为弧形短皴 + 石点；几道分流水纹。
- **渠网** `CANALS` + `_geom()`：分叉点错落、按水的到达时刻依次起流。
- **梯田** `_paddies`：不再用 Voronoi 格子，而是**顺等高线的弧形梯田**——`bend` 多尺度 fbm 扭曲 y、行高与田宽随远近变化 `z**0.62`、相邻田块随机合并、田埂留白、边缘逐块侵蚀；大气透视 `aer` 远淡偏冷；横向雾带 `mist_f` 让田畴时隐时现；挖出林盘空地；时间场按到宝瓶口距离依次染绿。

### 蜀锦 `S06`（原：布匹太规则）
- **竹竿弯曲** `_pole_y`：下垂 `sag` + 两个频率的正弦抖动。
- **11 匹锦各不相同** `_bolt(...)`：宽、长、`mode='hang'|'fold'|'gather'|'slant'`、`swag` 下摆弧度、`slant` 风偏都随机；顶端卷折 `R=12` 留高光。
- **纹样不重复** `_pattern`：6 种纹（lozenge 菱格 / cloud 团窠 / stripe / wave / scatter 散花 / band），坐标再加 `jx,jy` 低频抖动（手织感），`var` 让每个循环深浅不同，`dye` 染色不匀，`selv` 布边褪色。
- **不透明遮挡**：锦是不透明的，先用 `cover()` 压暗其下/其后已有的墨，前排遮后排、遮竹竿与柳。
- **风**：`SWAY` 每层不同相位频率的剪切仿射。

### 殿阁多层飞檐补柱 `motifs.hall(..., tiers>1)`（commit 7b27884）
- 原问题：只给底层画柱，上层屋顶与下层屋顶之间是空的，**上层檐悬空**（武侯祠、城门楼、开明城等所有 `tiers=2` 的殿都受影响）。
- 修法：循环每层时记录 `story_top`（上一层屋脊上方的"平座"线）；`tier>0` 时在其上先画：
  1. 一片淡墙洗 `_poly_wash`（即使没有 `wall_pig` 也用 `UMBER*0.35+INK*0.25`），让这一层读作实体；
  2. `ucols = max(3, cols-tier+1)` 根短柱（高 `max(28, w*0.18)`），从下层脊台直通上层檐；
  3. 柱顶一道额枋 + 淡墨带；
  4. 然后再在 `col_top` 上画本层屋顶，并更新 `story_top`。
- 单层殿完全不变；因为所有场景都调用同一个 `hall()`，一处改全片生效。

---

## 13. 如何运行 / 重建视频

```bash
sudo apt install ffmpeg fonts-noto-cjk          # 需要 ffmpeg 与 Noto Serif CJK 字体(text.py 读 /usr/share/fonts/opentype/noto/)
pip install -r requirements.txt                 # numpy scipy opencv-python-headless Pillow

python3 -m inkwash.render video                 # 构建 12 镜 + 渲染 3903 帧 + 混音 → out/chengdu_ink.mp4
WORKERS=8 INK_CACHE=/data/inkcache python3 -m inkwash.render video   # 调并行数 / 缓存位置

# 调试
python3 -m inkwash.render build 5 6             # 只强制重建第 5、6 镜（改了 build() 后必须重建，否则读旧缓存）
python3 -m inkwash.render still 45.0 58.5       # 渲染指定时刻单帧 → out/stills/
python3 -m inkwash.review out/r.png 11 16 43 47 # 多个时刻拼成审阅网格
python3 -m inkwash.contact out/chengdu_ink.mp4 out/contact_sheet.jpg   # 成片联系表
```

- 4 核虚拟机：构建约 25 秒，全片渲染约 15–20 分钟。
- **改了 `motifs.py` 里共用题材（如 `hall`）后**，要 `build` 所有用到它的镜头（或删掉整个缓存目录）再渲染。
- 母版约 120 MB（crf 16）；发布版可两遍压到 5 Mbps（见 README）。

---

## 14. 想让程序画更"像国画"的几条经验

1. **不要用纯色和硬边**：所有形状都过一遍 `噪声扭曲 → smoothstep 阈值`。
2. **墨要吃进纸**：每一笔都乘纸纤维。
3. **少勾多染**：主体靠墨块浓淡出体积，线只在关键处用干笔点几下。
4. **边缘要散**：主体的某一侧要化进雾或纸里，不要整齐收边。
5. **规则 = 机器感**：重复图案（田、布、瓦）必须加低频抖动、随机合并、每个循环深浅不同。
6. **时间也要有笔意**：按真实作画顺序安排 `t0`：先远后近、先勾后皴、先染后点、最后钤印。

---

## 笔毛模型

`Layer.stroke(..., model='bristle')` 才走这一支；默认 `model='classic'`，`core.py` 里经典笔触的像素计算不改。入口是 `brush2.bristle_stroke`，撒点、扩散和水线在 `brush2_ink`。`w` 仍是半宽。山水里用 `shanshui/brush.py` 的 `bk()`，或 `python shanshui/paint.py --brush bristle`。

v2 的原则：**不用噪声代替物理**。边缘不再按噪声啃、不再逐段抖动；不规则只来自笔毛的缓慢游移、纸纤维的吸水差异和毛细渗化。参考笔迹（八大山人、黄庭坚、米芾，公有领域）和观察记录在 `brushlab/ref/`、`brushlab/REF_NOTES.md`。

### 一束毛，不是一根矢量线

`make_bristles(nb, tip, rng, load, rough, bristle)` 造 `nb ≈ 2.3·max(w, max W)` 根毛（5–120，毛距 < 1 px，顿笔鼓起处也不出缝）。每根有横向位置 `o∈[-1,1]`、初始墨 `load0`、耗墨率 `rate`、断墨阈值 `thr`；相邻 2–nb/10 根为一簇（`cid`），共享墨量和耗墨率。

- `tip='zhong'`：对称，笔肚 `load0 ∝ 1.12 − 0.32·o²`，外缘毛耗得快。
- `tip='ce'`：`o=-1` 笔尖（浓、齐），`o=+1` 笔根（墨少、先枯）；`skew`（默认 0.22）让足迹斜置。

毛的横向位置 `off = W·(o·reach·fan + jit·wander)`：`wander` 是簇共享、40–120 px 尺度的缓慢游移，`jit` 只有 0.015–0.1，所以轮廓"平滑但不规则"。弯道上 `splay·|κ|·W` 让外侧毛整体张开；簇间分叉量 `sep` 随 `wet` 减小（湿毛粘在一起）。张开处的落墨权重乘 `fan` 补密度，不出浅缝。

### 提按、藏锋、回锋、顿笔、点

`width_profile`：压力先 `smooth1d`（约 1.5w）再 `p ** 1.1` 乘到半宽 —— 提按是"鼓"，不是台阶。`wobble` 只改很低频的宽度（尺度 `max(6w, 0.3L)`，幅度 0.45·wobble）。`_gesture` 的手势弧尺度 `max(40, L/2)`、幅度 `0.35·wobble·w`：竖画是直中带弧，不再像虫。

| 参数 | 形状 |
| --- | --- |
| `entry='cang'` | 起笔沿法向回转 0.55·W；笔头每根毛延伸 `√(1−0.75o²)` → 圆钝头 |
| `exit='hui'` | 收笔向另一侧回转，钝圆尾 |
| `exit='dun'` | `EXIT['dun']`：收笔前 24% 平缓鼓起到 1.38 倍、末端只提 12%，钝头 |
| `exit='tip'` | 外缘毛先离纸 (`cut`)，在 2 px 内淡出成尖 |
| `pauses` | 停顿处加宽、积墨、多耗墨 |

**点**（弧长 < `max(2.8w, 16)`）：重建成约 2:1 的一笔按—提，`_dot_profile`：笔尖落纸（宽 0.06）→ 60–70% 处按到最宽（半宽 0.68w）→ 提笔略收；尾端圆帽，路径带一点手腕弧。积墨 `pl` 在肚子处最大。

### 墨沿毛耗尽，飞白是丝

`r = load0 · (1 − rate·Kd·cum) ** 0.8`，`Kd = 1.0·dry + 0.6·dry⁴ + 0.30·min(L/(40w), 1.5)/load`（长度项封顶，细长皴线不会写断）。`r` 加簇级低频断墨（60–200 px）低于 `thr` 即断。

纸面接触（第 c 步）：沿**每根毛自己的路径**取纸面高度 `hp = 0.55·fiber + 0.45·gran`，簇内平均后顺笔向平滑 8 px，再加每缕（2 根毛）与单毛 10–45 px 的起伏，得到 `score`；只有墨少的毛（`starve = 1 − r/0.55`）才挑纸：`contact = smoothstep(score + 3.2 − 6.5·starve)`。笔肚的毛加保护项 `1.2·(1−o²)·(1−starve)`。所以飞白只出现在墨少的地方、顺着笔向成长丝，起笔处始终实。细笔（w < 4）的"干"只表现为变淡变细，不断成虚线。擦痕之间用几何足迹 `foot` 补一层只沾纸面高点的淡灰（`(0.08 + 0.4·h²)·dry`）。

### 湿图 / 墨图 / 扩散 / 水线（`_deposit`）

1. `brush2_ink.splat` 把每根毛的采样双线性撒进局部包围盒：覆盖 C、墨量 Q、含水 Wt（水比墨耗得慢：`(r/load0)^0.4`）、时间 U、积墨 PL、起笔饱和 TS、足迹 F；高斯 σ ≈ 0.55。
2. 覆盖 `cov = smoothstep(0.12, 0.42, C + 0.12·(h − 0.5))`：平滑抗锯齿边，纸面吸墨差只让轮廓在 1 px 内进出。
3. 墨图 `Pm = 1.15·ink·paint·(0.52 + 0.48·r̄)·tone·(1 + 0.45·pl)`，`tone` = 起笔饱和 `1 + 0.22·exp(−s/3w)` × 压力；再乘 5% 的低频 `nz_mid`（几十 px 的云状浓淡），颗粒只有 3%·wet。
4. 湿笔里水把颜料抹匀：`lev = wet·(1 − 0.6·dry)`，用 σ = 0.5 + 0.45·w·lev 的归一化模糊混合 90%·lev —— 淡墨湿笔是平的灰，不是海绵。
5. 湿图 `Wm = paint·w̄·wet·(1 + 0.6·pl)`；`brush2_ink.diffuse`：湿区前沿每步向外推 1 px，推进量 = 邻域最大含水 × `conductance(fiber, gran)`（纤维脊上高）× `keep`（逐步 ×0.95）；墨随水外流，浓度 = 芯内浓度 × `mob`（0.22–0.4，纸纤维滤掉颜料）。芯内不变，外圈多出一层顺纤维的淡羽晕。步数 ≈ `1 + 10·wet^1.4·min(1, 0.5 + 0.05w)`（`bleed` 可覆盖）。
6. 水线（Curtis 1997 edge darkening）：`edge_darkening(mask(Wm), σ)` = 湿区内贴边一圈，密度乘 `1 + (0.25 + 0.6·pool)·wet·ed`，约深 10–20%。

结果写入 `Layer.A`、`Layer.Wet`（×0.35·wet，`finalize` 的墨晕仍有效）、`Layer.T`。

### 第二轮评审后的改动 (r6–r7)

r5 太"矢量干净"，这一轮把结构加回来，仍然不用噪声啃边：

- **单根毛的飞白丝**：`contact` 的 `score` 里加每根毛自己的 25–80 px 起伏 `hn` 和各自的断点偏移，簇内耗墨率也各不相同（`rate × U(0.72, 1.3)`）→ 墨尽时一根根先后离纸，丝 1–1.5 px，断在不同长度。枯笔剩下的毛仍是浓墨（`base = 0.52 + 0.22·dry`）。
- **笔向丝理**：每簇/每根毛的墨色乘 `stk`（60–200 px / 30–90 px 的起伏，幅度 `(0.05 + 0.09·dry)·bristle·(1 − 0.6·wet)`）。
- **笔肚与浓淡**：中锋 `belly = 1 + 0.16·(1−o²)·p^0.8 − 0.06`（芯浓、两侧淡）；压力 `p^0.6` 进墨色；低频斑驳 `nz_mid` 7% + `nz_low` 5%；中间调里透出纸纤维（±16%，浓墨处消失）。
- **纤维毛边**：轮廓外 2 px 的环 (`dilate 5×5`) 只在纤维脊上吸一点墨（`0.45·fz·dilate(Pm)`，干笔减 70%），2 倍放大可见。
- **侧锋**：笔根一侧 `jit = 0.02 + 0.45·rough·h³`（笔肚边随簇起伏）、耗墨 `0.75 + 2.6·h^1.8`；受保护的芯在笔尖一侧；`dry > 0.2` 时 22% 的簇在 u≈0.62 后提前离纸 → 收笔前的细裂。
- **细笔 (w < 4，皴线)**：提按更强更频、随长度的轻微波动（≈ `0.06·wobble·L`）、约 30% 的笔蘸墨少（淡一些）、干时整笔按纸面高低 + 墨尽出现几处软断（外缘毛先断，断口渐细）。`brushlab/tests.py` 的披麻一束改成间距不匀、聚散、长短压力各异。
- **点**：长短 1.7–2.7·半宽、肚子位置 0.58–0.76、方向 ±0.12 rad、弧度、干湿 ×(0.45–0.8 | 1.0–1.5) → 有的点带晕。
- **出锋**：圆肩收尖 (`t^0.5`)，最后 `min(0.55L, max(4w, 20))` 内淡 60%（w<2）/35%；极细笔 σ +0.2。
- 修正：去掉每根毛独立的 `reach`（外缘毛错开 2 px，湿笔边内一条浅缝）；回锋回转 0.5W → 0.15W（不再勾）。

试笔页：`python brushlab/sheet.py`。计时：`python brushlab/bench.py`（w=20 L=400：中锋 ≈ 18 ms，侧锋枯 ≈ 18 ms，湿 ≈ 20 ms）。对比图：`python brushlab/make_compare.py <sheet.png> [r5_sheet.png]`。

---

## 破墨/积墨

默认笔触不读纸上已有的水。要让后一笔跟先落的墨起反应，用 `Layer.stroke(..., model='bristle', interact=True)`，或 `Canvas.layer(..., interact=True)`。关着的时候不建状态，经典笔触和 `interact=False` 的毛笔输出不变。

状态在 `inkwash/pomo.py` 的 `PaperState`：整幅三张图 `W`（含水量）、`Tw`（这格水是什么时候写下的）、`P`（本层已落的墨量，标量）。干燥是惰性的，`wet_now(sl, t)` 只在新笔的包围盒里算 `W·exp(−(t−Tw)/tau)`，`tau` 默认 1.2 秒。时钟是 `max(t0, clock)`；`Layer.set_time(t)` / `Layer.dry(dt)` 推它。

`brush2._deposit` 在 `interact` 打开时按这个顺序调：

1. `pomo.prepare(layer, sl, t, cond, it, wet, paint)`：读旧湿 `wo` 和已干旧墨 `dryink`。湿处传导率升高、扩散步数加几步（`brush2_ink.diffuse` 走得更远，仍乘纤维 `conductance`）；干墨处传导率乘 `(1 − 0.78·dryink)`，纸被墨上过胶，水渗得少。
2. `pomo.soften`：新笔落在旧湿区里时，把新墨的边和渗晕按湿度模糊。新墨明显更淡时用更大的 σ，淡破浓才不会留下一条硬边。
3. `pomo.edge_boost`：干墨上把 Curtis 水线加重；湿处把笔自己的水线压掉（水线留给湿区前沿）。
4. `pomo.layer_edge`：干墨上再加一条几像素宽的积墨边，叠进 `dens`。一层干透再叠一层，每层的边都在。
5. 新墨写入 `Layer.A` 之后，`pomo.apply` 改旧墨，`pomo.recolor` 按旧墨颜色写回 `A`。

`apply` 里两件事：

- **淡破浓**：新笔比旧墨淡（`pale`，用新笔芯部密度和旧墨比）时，从旧湿墨里搬走一块，再用宽高斯摊开。摊开的权重在新水芯里低、在纤维脊上高，所以中间变淡，深色往外走成不规则的羽边，不是挖一个硬边的浅坑。
- **湿破湿**：新墨大约是旧墨的两成到一倍半（`sim`）时不挖浅心，而是把交叠处未干的旧墨沿着纤维推到新笔外沿，交叉处多出一圈软的羽边。
- **浓破淡**：浓墨点进淡湿纸时 `pale` 接近 0，旧墨不被推走；新墨自己靠升高的传导率和 `soften` 在湿处化开。
- **积墨**：`t0` 隔开几个 `tau` 之后 `wo≈0`、`dryink` 高，不发生搬运，只留下 `layer_edge` 的层边。

试笔页最后五行（`brushlab/tests.py` 的 `pomo_dan_po_nong`、`pomo_nong_po_dan`、`pomo_shi_po_shi`、`pomo_jimo`、`pomo_control`）两列都是毛笔：左 `interact=off`，右 `interact=on`。图：`brushlab/pomo_rows.jpg`、`brushlab/sheet_full.jpg`。
