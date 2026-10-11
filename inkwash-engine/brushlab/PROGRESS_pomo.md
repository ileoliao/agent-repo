# PROGRESS_pomo — 破墨 / 积墨 (paper-state interaction)

- [x] 0. refs saved on f033133: /tmp/classic_ref.npz (check_classic.py save), /tmp/bristle_ref.npz (check_bristle.py save)
- [ ] 1. persistent paper state (Wet/Pig maps, drying, layer.dry/set_time), opt-in interact flag
- [ ] 2. wet-on-wet interaction (淡破浓 backrun, 浓破淡 feather), dry 积墨 layered edges
- [ ] 3. sheet rows + REF_NOTES 破墨/积墨 notes
- [ ] 4. ≥3 rounds (rounds/pomo_rN.jpg)
- [ ] 5. bench on/off, regression checks, scenes/shanshui import check (NO shanshui render — user change)
- [ ] 6. docs + deliverables (pomo_rows.jpg, sheet_full.jpg)

## r1 (rounds/pomo_r1.jpg)
Pipeline in place: pomo.PaperState + prepare/apply/recolor hooked into brush2._deposit (guarded by `ia`); 5 new sheet rows.
classic + bristle(off) regression: equal. Critique:
- 淡破浓: bloom works (lighter centre, darker fringe) but edges are hard OCTAGONS: wet cond≈1 -> 3×3 dilation front; removal uniform.
- 浓破淡: dark ink spreads into pale wet, but the feather ends in a hard outline (carried conc cut at fixed dilate radius).
- 湿破湿: crossing gets a light diamond with outline — push too strong for similar tones; should be soft mixing.
- 积墨: on ≈ off; layered edges not stronger. Control row identical (correct: dry -> no 破墨).
- perf: 湿破湿 strokes 78 ms (left 47) — check bench.

## r2 (rounds/pomo_r2.jpg)
Fixes: wet-zone conductance keeps fibre + nz_edge modulation (cauliflower fronts, no octagons); "paleness" compares the
new stroke's own density per coverage with old ink density, smoothstep(0.3, 0.85) (similar tones barely push; dark-into-pale
never pushes); a stroke landing on wet paper forms no own tide line (edge_boost × (1 − 0.85·wo)); 积墨: layer_edge() adds
an explicit per-layer edge over dried ink.
Critique: 淡破浓 bloom reads right (pale interior, dark cauliflower fringe). 浓破淡 feathers softly. 湿破湿 crossing bleeds,
but the front is a bit crisp/patchy. 积墨 on: layer edges crisper/darker than off. Perf: wet strokes with interaction ~60–80 ms.

## r3 (rounds/pomo_r3.jpg)
- REF_NOTES: 破墨/积墨 section (lotus wet-on-wet soft transitions, backrun pools with dark rim, droplet rings, stem bleed,
  layered leaf edges).
- soften(): inside old wet zones the new stroke's edge (σ 0.9+0.02w) and its halo (σ 1.8+0.06w) are blurred ∝ wetness.
- Backrun removal blurred (σ 1.2) and capped by mobile pigment.
- Bug fixed: the 淡破浓 push fired outside the new footprint (spread water had dnew = 0 -> "pale"). New-stroke density now
  estimated in the core and dilated 16 px along with the spreading water. 湿破湿 crossing: dOld ±0.04 (was ±0.6) -> soft bleed.
Critique: 淡破浓 bloom good; 浓破淡 = soft feathered dark line like the lotus stem; 湿破湿 soft darker mix at crossing
(could feather more irregularly); 积墨 on shows layer edges. Missing: droplet ring blooms only via dots; blooms appear at
the end of the stroke time (no animated growth).
