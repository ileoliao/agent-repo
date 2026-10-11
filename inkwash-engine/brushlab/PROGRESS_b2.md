# PROGRESS_b2 — bristle model v2

- [x] 0. classic baseline saved (/tmp/classic_ref.npz via check_classic.py save on HEAD b6735ea)
- [x] 1. references (brushlab/ref/, LICENSES.md, REF_NOTES.md)
- [x] 2. rework pipeline (wet/pigment maps, diffusion, dry gate, tonal structure)
- [x] 3. rounds b2_r1..r4+
- [x] 4. constraints check (classic cmp, tests sheet, shanshui)
- [x] 5. deliverables

PR3 bench (before): zhong 13.4 ms, ce dry 11.4, wet 14.2, 皴 5.4, 松针 2.3

## r1 (b2_r1.jpg)
New pipeline in place (brush2.py rewrite, brush2_ink.diffuse/edge_darkening). Clean tone, straight shu, no noise erosion.
Problems: dry areas speckled (pixel gate isotropic), wet halo ~invisible, edges too vector-clean.

## r2 (b2_r2.jpg)
Dry gaps now per-clump + per-strand (2 hairs) contact score sampled along each bristle path (paper height smoothed
along s) -> long striations; solid starts. Todo: teardrop dots, dun ears, visible wet halo, fibre-scale edge feather.

## r3 (b2_r3.jpg)
diffuse() -> capillary wet front (fibre-gated dilation) + pigment carried at core conc × mob (halo 3–4 px);
edge darkening on core wet mask; teardrop dots (_dot_profile, 2:1, curved); 顿笔 = gradual swell + blunt end.
Todo r4: darker dense ink, protect core bristles from contact gaps in thin strokes, 1-px absorbency edge, wider wet halo.

## r4 (b2_r4.jpg)
Core hairs protected from contact gaps; 1-px absorbency on coverage threshold; finer strands (per-hair + pair noise);
graze grey between dry streaks from a geometric footprint channel; thin strokes (w<4) lose tone instead of breaking.
Bench: zhong 15.4 ms, ce dry 16.6, wet 19.0, 皴 5.0, 松针 2.3 (classic 14/13/14/2.3/0.9).

## r5 (b2_r5.jpg) — final
Wet levelling stronger (sigma 0.5+0.45·w·lev); deposit weight × fan (no pale band on outer side of curves);
coverage threshold 0.12–0.42 so a single hair track counts. classic cmp OK; shanshui --brush bristle OK (25 s).
Deliverables generated: compare_pr3_new.jpg, ref_vs_new.jpg (brushlab/make_compare.py), shanshui_brush_v2_preview.jpg.
Bench: zhong 16.8 ms, ce dry 16.2, wet 18.3, 皴 4.7, 松针 2.0.
- [x] docs (INKWASH_NOTES 笔毛模型, brushlab/README) — DONE

# Review round 2 (PROMPT_brush2_r2.md)
- [x] 6a 淡墨 light line: caused by per-hair random `reach` (outer hair 2 px apart) -> removed.
- [x] 6b 回锋 hook: gesture side-shift 0.5W -> 0.15W over a broad bell; 藏锋 0.55 -> 0.35.
- [x] per-hair dry streaks (hn: own 25–80 px noise + own break offset, per-hair rate spread) -> 1–1.5 px hairs breaking at
      different lengths; dry hairs keep dark tone (base 0.52+0.22·dry); along-stroke striation `stk` 5–14%; graze grey only near streaks.
- full-res r5 sheet rendered from 4639c8d -> /tmp/sheet_r5.png (for compare_final3)
## ADDENDUM todo: tone variation (belly core, mottling, fibre in mid-tones, soft halo); 侧锋 heel/splits; 披麻 bundle variety
## (tests + model); dots variety + some halo; 竖画 tone + 藏锋 head texture; deliverables incl. compare_final3.jpg
- [x] tone: belly core (+16%·(1−o²)·p, zhong), pressure tone p^0.6, low-freq mottling (nz_mid 7% + nz_low 5%),
      fibre visible in mid-tones (±16%·fn, fades in dense ink), sub-2px fibre fuzz ring (dilate 5×5, fibre ridges only),
      藏锋 head: clump-wise ragged cap + stronger head striation.
- [x] 侧锋: heel jit 0.45·rough·h³ (uneven belly edge), protected core = tip side for ce, end splits (22% clumps lift off
      after u≈0.62 when dry>0.2). Saved rounds/b2_r6.jpg.
- [x] 披麻 (model, also shanshui textures.py pima): thin strokes get stronger/faster width variation, length-scaled
      waviness (~L·0.06·wobble), per-stroke load 0.55–0.8 for ~30% (lighter strands), soft dry breaks (paper height along
      path + noise + starve; outer hairs break first -> tapered break ends). tests.py bundle: irregular spacing,
      converge/diverge, varied length & pressure.
- [x] dots: random elongation/belly position/angle ±0.12 rad/arc, wet ×(0.45–0.8 | 1.0–1.5) -> some with halo.
- [x] 松针/出锋: tip tone fade 60% from u=0.45, round-shoulder tip taper (t^0.5), sig +0.2 for w<1.6.
- [x] 出锋 fade window absolute (min(0.55L, max(4w,20)), 60% for w<2 else 35%) so long 出锋 strokes keep tone. rounds/b2_r7.jpg.
  Bench: zhong 18.1, ce dry 17.9, wet 20.3, 皴 5.4, 松针 2.2 ms. classic cmp OK.
- [x] deliverables: compare_final3.jpg (make_compare.py <final> <r5>), compare_pr3_new.jpg, ref_vs_new.jpg, shanshui preview.
- [x] docs (INKWASH_NOTES r6–r7 subsection, brushlab/README perf + limits)
