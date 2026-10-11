# Feature: new strokes interact with ink already on the paper — 破墨 and 积墨 (time box ~60 min)

Same working copy /workspace/inkwash-engine. You (Claude Code) do ALL coding and design. Work in small, incremental edits
(long replies get dropped), commit after each meaningful step with `Co-Authored-By: Claude <noreply@anthropic.com>`,
keep progress in brushlab/PROGRESS_pomo.md (resume from it if it exists). Do NOT push.

## Requirements
1. Persistent paper state on the Layer/canvas: a WET map (water) and a PIGMENT/absorption map that persist between strokes,
   plus a simple drying model over time. Strokes already carry t0 in the engine; wetness decays with elapsed time. Also add an
   explicit API, e.g. `layer.dry(dt)` / `layer.set_time(t)`. Keep it local/bbox-based for performance (no full-canvas ops per stroke).
2. When a new stroke lands:
   - on WET areas: new ink and existing ink diffuse into each other — wet-on-wet bleed, feathery intermixing.
     淡破浓: water from a pale stroke pushes dark pigment outward → soft blooms / backruns with lighter centres and darker fringes.
     浓破淡: dark ink into pale wet → soft spreading dark with feathered edges. Backruns/blooms at the wet front.
   - on DRY areas: layers stack (积墨) with visible layered edges and increased depth; each layer's edge stays readable
     (edge-darkening per layer), not just multiplicative darkening.
3. Opt-in and backward compatible: classic stroke output stays byte-identical (brushlab/check_classic.py: run `save` FIRST on the
   current commit, `cmp` after changes); existing bristle output is unchanged unless the interaction flag is on
   (e.g. `Layer(interact=True)` / `cv.layer(..., interact=True)` or `stroke(..., interact=True)`) — verify this too by saving a
   bristle reference sheet before changes and comparing with np.array_equal after. Chengdu video scenes and shanshui must still render.
4. brushlab/sheet.py: add new rows — 破墨：淡破浓 (dark stroke, then pale wet stroke over it while still wet), 破墨：浓破淡,
   湿破湿晕化 (two wet strokes crossing), 积墨 (3–4 layers, each after drying), and a control row with the same strokes interaction
   off vs on. For these rows it's fine if the left column = interaction off and right = on (label clearly).
   Study brushlab/ref/ (八大山人 lotus/bamboo show 破墨 well) and brushlab/REF_NOTES.md; add notes on 破墨/积墨 observations there.
5. Iterate ≥3 rounds; each round render, LOOK at the new rows (full + 2x crops) vs the refs, critique honestly in PROGRESS_pomo.md,
   save brushlab/rounds/pomo_rN.jpg.
6. (User change) Do NOT render any shanshui — skip the shanshui preview entirely. Only make sure shanshui still imports/works with defaults (no render needed beyond a quick syntax/import check).
7. Bench a typical stroke (w=20, L=400) with interaction on vs off (extend brushlab/bench.py); keep it reasonable (< ~60 ms).
8. Update INKWASH_NOTES.md with a 破墨/积墨 section (Chinese, real function names/params); update brushlab/README.md.

## Deliverables
- brushlab/pomo_rows.jpg (only the new rows, off vs on, < 3 MB)
- brushlab/sheet_full.jpg (whole updated test sheet, < 3 MB)
- final commit; end with a short summary: what changed, bench numbers, honest remaining issues.
