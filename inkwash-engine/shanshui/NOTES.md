# 溪山亭渡图 · procedural shanshui notes

`python3 shanshui/paint.py` renders `shanshui.png` (2400×3200 portrait 立轴, seed 1086, about 45 s), then
`shanshui_preview.jpg` (1200×1600) and `labels.json`. `python3 shanshui/annotate.py` then draws
`techniques_annotated.jpg`. The main painting has no text. It carries two text-free red seals: a square one
and a small oval one, each carved with an abstract lattice meander rather than characters.

Everything is drawn with the existing `inkwash.core` engine (`Layer.stroke / dot / wash`, Beer–Lambert compositing,
`finalize` ink bleed). No files outside `shanshui/` were modified.

## Modules
| file | role |
| --- | --- |
| `brush.py` | design→render scale, label registry, 斧劈 stroke, 米点 dot, 点苔, 破墨, 泼墨, field washes |
| `massif.py` | **mountains as lobes painted front→back with an occlusion mask**: contour 勾, two-pass 积墨 wash darkening into each lobe's foot, 披麻 / 斧劈 / vertical textures following the contour, 点苔 on crowns |
| `rocks.py` | `Clip` (paint into a scratch layer, add only inside a mask) and broken 勾勒 contour strokes |
| `trees.py` | 飞白 trunks, root claws + moss, pines with 鳞皴 bark and 松针 fan plates, 介字点 / 个字点 trees, bare 蟹爪 trees |
| `atmos.py` | 米点 hills, 平远 banks, mist masks, ripples, waterfall mask + threads |
| `figures.py` | 茅亭 (plinth, 4 posts, railing, thatched roof, seated scholar), walking scholar, skiff with reflection, seals |
| `scene_back.py` / `scene_front.py` | the composition |
| `paint.py` | layers, mist / waterfall reservation at compositing time, seals, output |
| `annotate.py` | label placement: picks the brightest free spot around each anchor, then draws a leader line |

## Composition (三远)
- **高远**: the broad, steep main peak in the upper middle, in the spirit of 范宽. It is built from about ten
  overlapping lobes (foothills → waterfall cliffs → inner folds → summit → side peaks), with a forest of tiny trees
  and 焦墨 dots on the summit.
- **深远**: on the left, four rows of rounded 披麻 hills step back up a valley toward the base of the peak. Each row
  is paler (淡 → 清) and partly dissolved in mist.
- **平远**: on the right, open water runs back to low flat banks and faint 米点 hills fading to the horizon.
- **Waterfall**: it drops from the cleft between the summit and the right peak. The water is reserved paper (留白),
  bounded by dark rock lips, with a few faint threads. It vanishes into the cloud band and reappears as the stream
  that zig-zags past shoals into the lake.
- **Mist**: per-layer *subtractive* masks applied at compositing. They are wavy, wispy and uneven along x, so mountain
  feet dissolve into paper rather than being cut by stripes.
- **Foreground**: angular 斧劈 boulders (浓墨). Pines, a 介字点 tree, a 个字点 tree and two bare trees are rooted on the
  crests, each with root claws and moss at its foot. The thatched pavilion sits on a flat ledge on its plinth and
  four posts, with a scholar seated inside and another walking up to it. A fishing skiff floats on the lake with a
  broken reflection and ripple lines. A bold 泼墨 mass sits at the lower left.

## Techniques: where, and how convincing
| technique | where | verdict |
| --- | --- | --- |
| 留白 | waterfall, mist bands, lake | **strong**. The waterfall framed by dark lips reads well, and the mist is soft |
| 积墨 / 重墨 | main peak face (two wash passes per lobe plus layered texture) | **strong**. Gives the dark, streaked 范宽-like face |
| 披麻皴 | left peak flank and mid hills | **good**. Long, soft, bundled strokes following the dome; reads as hemp fibre |
| 墨分五色 | 清 far 米点 hills → 淡 mid hills → 重 main peak → 浓 foreground → 焦 moss, trunks and lips | **good**. The recession is clear |
| 泼墨 | lower-left foreground mass | **good**. Organic bleeding edge with satellite drops. Somewhat blob-like up close |
| 点苔 | crests everywhere, summit forest, tree feet | **good** |
| 勾勒 + 渲染 | every lobe crest and cliff side is outlined with broken, pressure-varying strokes over 积墨 washes | **good** |
| 茅亭 / 渔舟 | ledge / lake | **good**. Posts and plinth stand on the rock; the boat sits on its waterline with a reflection |
| 斧劈皴 | foreground boulders, and mixed into the main-peak faces | **fair**. Broad side-brush cuts with dry streaks build planes, but they lean toward 大斧劈 / 雨点 "drapes" rather than crisp 李唐-style angular facets |
| 松针 | pine plates | **fair**. Half-wheel fans with an indigo under-wash; the fans are a little too regular |
| 介字点 / 个字点 | left tree / tree beside the pavilion | **fair**. Recognisable at full size, small in the preview |
| 米点皴 | distant peaks upper left and right; 平远 hills | **fair**. Layered horizontal wet dots, but they blur into a cloudy mass once mist is applied |
| 飞白 | trunks, contour strokes, 斧劈 strokes | **fair**. Visible at full resolution, subtle in the preview |
| 破墨 | small mid-ground slope right of the valley | **weak**. The blooms are real but pale and small; the effect is easy to miss |

## Iteration log (`rounds/`)
- **r1**: primitive polygons with scattered textures. The result was diagrammatic: a bullet-shaped peak,
  arrowhead-stamp 斧劈, fish-scale 米点, sea-urchin pines, a stream of two straight lines, and an empty middle band.
- **r2**: rewrote mountains as occluding lobes (`massif.py`), which gave real structure and depth. The peak was then
  too dark and conical, the far hills darker than the mid hills (an inverted recession), and the foreground rocks
  looked like floating pyramids.
- **r3**: broader, steep-sided summit with inner folds; paler far hills; varied mid-hill lobes with 矾头 heads.
  Foreground lobes still had flat grey bottoms.
- **r4**: foreground bodies flare down off the sheet (`extend`), and the shoals and shore lost their bead-like dots.
- **r5**: full-res crop review. Crisper 斧劈 (after one overcorrection to "ferns"); a ragged, tapered waterfall with
  double lips; windowed blob fields (removing rectangular wash halos); thinner, longer vertical cliff texture;
  crab-claw bare trees; a fixed abstract seal pattern.
- **r6 (final)**: bold 泼墨, 破墨 moved to an open slope, cliff sides outlined, occlusion weighted by visible ink (no
  hard notches), and the ledge meets the water.

## Known weaknesses
- The lobe silhouettes are still a little smooth and similar, and a few cliff sides drop almost vertically.
- The pine fans are too evenly spaced, and the 破墨 blooms are too faint.
- The mist is purely subtractive (paper reserve). There is no separate pale wash *in* the mist, so some mountain
  feet fade rather uniformly.

---

# v2 revision (user review, six points)

`shanshui_v1.png` / `shanshui_v1_preview.jpg` keep v1. `compare_v1_v2.jpg` shows both paintings side by side;
`detail_compare.jpg` shows four detail crop pairs (主峰, 苔点, 瀑布, 中景山). Rounds are in `rounds/v2_r1..r3.jpg`.
New modules: `textures.py` (皴法 vocabulary + clustered 点苔), `falls.py` (叠泉 waterfall), `inscription.py`
(题款), `compare.py`.

| # | complaint | what changed |
| --- | --- | --- |
| 1 | 皴法单一、重复 | Per-region stroke vocabulary in `textures.py`. Main peak: **侧锋 dry brush laid in passes**, i.e. groups of 2–7 broad, broken, 飞白 strokes sharing a facet direction, mixed with long drags, short stabs and thin dry wrinkles. They hug the crest and the shadow flank and thin out downward. Slope feet: **wet pale pooled washes** (no stroke shapes). Mid hills: **long, gently curving 披麻 bundles** that bend outward with the dome. Foreground: 斧劈 + 侧锋 + wet feet. Every stroke draws length, direction, curvature, pressure and wetness from wide ranges. |
| 2 | 苔点太均匀 | Moss is no longer spaced along ridges. `moss_cluster` makes irregular clumps (big wet dots, small dry flicks, varied size, darkness and shape), placed only at accents: a few near summits, the summit forest (now 4–6 clumps of tiny trees instead of a fringe), two rock seams, and tree roots. Most ridges have none. |
| 3 | 中景山形雷同 | The mid-ground was rebuilt around one dominant, irregular earthy mass with merged shoulders, plus a long low spur sloping toward the stream and angular, sloping back hills. Outline weights range from 1.6 to 6.5, and several contours are deliberately broken (`gaps`). |
| 4 | 主峰墨色闷 / 泼墨脏 | The peak stays strong (`crest_dark` deepens the crest and shadow flank) but breathes. Soft, noise-shaped lit faces (`LIGHT` in `paint.py`), an internal mist wisp and pale inner folds open it up. 泼墨 is now one **rock-shaped mass poured in one gesture**, built from three nested washes: a pale bleed halo, a wet body with a feathered organic contour, and a pooled dark core with tonal variation. There are no speckles. |
| 5 | 瀑布太干净 | `falls.py`: a dark V-notch water mouth at the source, an upper stage, a rock step that breaks the fall (叠泉) with a splash plume, a lower stage plus a thin side strand, and a plunge pool with pebble rims. 水汽 is a soft spray mask (留白) with a pale indigo halo; faint threads and ripple arcs are drawn after the reservation. |
| 6 | 有印无款 | Vertical right-to-left 题款 in the upper right, in AR PL UKai CN: 飞流直下三千尺 / 疑是银河落九天 / 丙午秋日 写 (smaller, lower), with a red name seal under the signature. Each glyph is turned into absorbance with its own brush load (fresh dip per column, drying down the column), ragged paper-noise edges, dry streaks on late characters, fibre absorption and a faint bleed. A crop was checked: all characters render correctly, with no tofu. |

Also fixed: blob-field washes are now negative outside their window, so wash warp noise can no longer produce faint
rectangular edges. In the annotator, labels avoid the inscription block, and 题款 / 叠泉 / 水汽 / 侧锋 were added.

## v2 rounds
- **v2_r1**: all six fixes in, but the peak became far too pale (breathing overdone, sparse 侧锋 "confetti"), the
  water mouth read as a black funnel, and 破墨 was left floating.
- **v2_r2**: 侧锋 rebuilt as staggered grouped passes at double density with crest darkening, so the peak is strong
  again. Wet feet became pooled washes instead of lozenge strokes. 泼墨 went from an ellipse to a feathered rock
  mass. The mouth notch and pool were refined, with stronger spray.
- **v2_r3**: the peak's inner fold had looked unfinished, so it got more dry texture and a softer light patch. Final.

## Remaining weaknesses (v2)
- 破墨 is still the weakest technique: it is now on the dominant mid hill but partly hidden behind the pines.
- The 侧锋 passes are varied but still a little "hairy" up close. The pine needle fans are unchanged from v1.
- The pool's rims are small; the pool reads mainly through its 留白 ellipse and spray.
- Some lobes still drop nearly vertically at their sides (the left peak and the pavilion ledge).
- The inscription uses a font's 楷书 skeleton. The ink texture helps, but stroke rhythm and pressure are not truly
  hand-written.

---

# v3 pass (two rounds: `rounds/v3_r1.jpg`, `v3_r2.jpg`; `compare_v2_v3.jpg`)
v2 is kept as `shanshui_v2.png` / `shanshui_v2_preview.jpg`.

- **Main peak: power restored.** The summit uses 4 积墨 wash passes, the right peak and inner folds 3. Crest and
  shadow side are darkened (`crest_dark` up to 1.3). The confetti-like 侧锋 fragments are replaced by
  `textures.bundles`: 4–9 long side-brush strokes laid side by side down the face, sharing a direction and a gentle
  curve, broad at the start and dragging dry (飞白) at the end. There are only two pale breathing gaps (`LIGHT`)
  plus the one internal mist wisp.
- **泼墨.** The uniform black dome became a splash inside a rock outline. Large-scale noise gives it lobes and bays.
  A feathered bleed halo of varying reach surrounds it, with small edge breaks where the wet front stopped. Large,
  lighter diluted zones sit inside, and 3–5 darker pools mark where the ink settled. The tide-line was softened.
- **Back mid-ground** is angular and sloping (`steps`, low `sharp`), with varied heights. **破墨** moved to the open
  left slope of the dominant mid hill, clear of the pines.

**Still weak:** up close the bundles can read as splayed "brooms". The flat summit crest is a bit mesa-like.
破墨 is visible but still modest. The rest is unchanged from v2.
