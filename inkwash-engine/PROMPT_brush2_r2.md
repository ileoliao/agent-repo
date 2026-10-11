# Review round 2 (from the art director's side) — continue improving brush2 (time box ~25 min)

Big step forward: chalky noise is gone, dots and 竖画 are much better, wet stroke tone is right. But it OVERCORRECTED to "vector clean":
1. 侧锋阔笔 now looks like a flat vector blade/knife shape: no bristle texture at all inside, hard straight edges, uniform grey.
   Real 侧锋 (see Zhu Da bamboo leaf ref + Huang Tingjian): the ragged heel side shows a few long parallel hair-streaks and broken
   edge where ink runs low; the tip side is crisp. Inside, faint along-stroke bristle striation (tone variation of ~5–15%, not noise).
   Bring back dry breakup in 侧锋 at least as strong as your round 4 but as long streaks.
2. Strong ink edges lack fibre fuzz: add a very fine (sub-2px) fibre-driven edge feathering on wet/strong strokes (your capillary along fibres) —
   visible at 2x zoom, not at 1x. Not noise erosion.
3. Dry strands too thick (2–3 px) and fade out instead of trailing into hairs: make dry-brush streaks thinner (1–1.5 px hair lines)
   with gaps between, ending as individual hairs that break off at different lengths.
4. 披麻皴 bundle is now too clean/uniform lines (looks like pen). It should be dry-ish: lines with slight thickness variation,
   intermittent dry breaks where paper is high, a couple of strands lighter than others.
5. 松针 still a bit hard/spiky: slightly softer, lighter tips, base darker.
6. Fix the faint light line along the 淡墨 stroke's upper curve, and the small hook at 回锋.
Keep everything else (dots, 竖画, wet stroke tone, perf <40 ms, classic byte-identical, API).
Do 2–3 rounds, save brushlab/rounds/b2_r6.jpg, b2_r7.jpg..., LOOK at 2x crops each round vs refs.
Then regenerate deliverables (brushlab/make_compare.py → compare_pr3_new.jpg, ref_vs_new.jpg; shanshui_brush_v2_preview.jpg),
update docs if behaviour changed, rerun bench + check_classic cmp, commit (add `Co-Authored-By: Claude <noreply@anthropic.com>` to new commits),
no push. End with a short summary: changes, bench, remaining issues.

---
## ADDENDUM (user's own feedback, takes priority; merged with the list above). Note: you were interrupted mid-edit;
## inkwash/brush2.py has an uncommitted change from you — check `git diff` and keep or revert it.
The user wants ONE more round (r6, maybe r7) to raise realism. Based on compare_pr3_new.jpg and ref_vs_new.jpg vs the 八大山人/米芾 refs:
1. Too clean/digital overall; tone too uniform. Add natural ink-density variation inside strokes: darker wet core where the belly presses,
   lighter where bristles thin out, saturated start, gradual fade; subtle mottling/granulation from paper absorption (LOW-frequency,
   not salt noise); "soaked into paper" feel — slight soft halo + fibre texture visible through mid-tones.
2. 侧锋阔笔 reads as a solid flat shape: add bristle streak structure inside (lighter/darker lanes along the stroke), uneven belly edge vs
   crisp tip edge, small dry splits near the end, like the 八大 bamboo leaf.
3. 披麻皴 bundle too parallel/regular: vary spacing, slight convergence/divergence, varied length and pressure per line, a few lines broken
   by dry brush, slight waviness. (If that needs changes in brushlab/tests.py's bundle generator, that's OK, but also make sure
   shanshui's pima/bundles callers benefit.)
4. Dots: vary size/shape/orientation more, wet halo on some.
5. 中锋竖画: keep the shape, add tonal variation and 藏锋 head texture.
Keep what's good: wet stroke water line, 飞白 tail, clean turns, perf, classic byte-identical.
Extra deliverables:
- Save the current r5 sheet for comparison: it is at brushlab/rounds/b2_r5.jpg (downscaled 2/3); for a full-res r5 you can
  `git stash`/`git worktree add /tmp/r5 4639c8d` and render brushlab/sheet.py there.
- brushlab/compare_final3.jpg (<3 MB): 3 columns PR3 bristle | v2 r5 bristle | final (r6/r7) bristle, rows aligned, labelled.
- Refresh brushlab/ref_vs_new.jpg and shanshui/shanshui_brush_v2_preview.jpg with the final code (also keep compare_pr3_new.jpg refreshed).
