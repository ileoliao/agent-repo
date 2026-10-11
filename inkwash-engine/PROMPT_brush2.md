# Task: make the bristle brush model (inkwash/brush2.py + inkwash/brush2_ink.py) substantially more realistic

You are working in /workspace/inkwash-engine (git repo, baseline commit = PR3 version). The user (a demanding art director) looked at
brushlab/pr3_sheet_final.jpg (left = classic, right = current bristle model; render it yourself with `python3 brushlab/sheet.py`)
and says the bristle strokes still don't look good. YOU do all code changes, research and design decisions.

IMPORTANT working style: work in small, incremental edits (long replies get dropped). Commit to git after each meaningful step
(`git add -A && git commit -m ...`). Keep notes of progress in brushlab/PROGRESS_b2.md so work can resume if interrupted
(if that file exists when you start, read it and resume from there).

## Review of the current result (what is wrong)
- Edges are uniformly crumbly/noisy, like chalk or burnt paper, everywhere. Real ink edges are mostly smooth-but-irregular, with a soft halo bleed only where wet; dry raggedness only at the dry tail.
- 淡墨湿笔 (wet pale stroke) looks like sponge/salt texture. Real wet stroke: smooth even tone, slightly darker rim (water line), soft feathered halo outward, very little internal speckle.
- No tonal structure inside strokes: real strokes have a darker, wetter core/belly where the brush belly presses, lighter near the edges of 侧锋; the start is darkest and saturated; ink density varies smoothly along the stroke.
- 中锋竖画 wobble looks like worms. Should be straight-ish with subtle pressure swelling, a round 藏锋 head and a clean 回锋 end.
- 点 (dots) look like scribbled blobs. A real dot = one press-and-lift: compact teardrop/seed shape, dark wet center, slight bleed.
- 披麻皴 bundle broke into dashes; should be long, slightly wavy, dry-ish lines with variation, not dotted.
- 松针 are OK-ish but too spiky/noisy.
- Overall: noise is used as a substitute for physics. Prefer structure: bristle ink-load, pressure, wetness field, paper absorption.

## Steps
1. Reference first. Download 2–4 public-domain / CC-licensed images of real Chinese brush strokes (e.g. Wikimedia Commons: 永字八法,
   calligraphy stroke scans, ink-wash brushstroke photos; use curl with a normal User-Agent; the Commons API
   https://commons.wikimedia.org/w/api.php works) into brushlab/ref/ with a LICENSES.md (source URL, author, license).
   Look at them closely (crop/zoom with python and view the crops) and write concrete visual characteristics
   (edge, tone, dry-brush, bleed, stroke start/end) into brushlab/REF_NOTES.md.
2. Rework the bristle model around a physically-motivated pipeline:
   a. per-bristle ink load + water load deposit into a WET map and a PIGMENT map in the stroke's local bbox (not straight to final absorbance);
   b. a short diffusion/capillary step on the wet map, anisotropic along paper fibres, with pigment carried and edge darkening as water
      evaporates (simplified Chu&Tai MoXi 2005 / Curtis et al. 1997 watercolor ideas: pigment migrates to the wet front -> darker rim);
   c. dry-brush gaps only where bristle ink load is low AND paper height (fibre texture) is high;
   d. remove generic noise-based edge erosion;
   e. smooth tonal structure: belly/core darker, start saturated, density decaying smoothly along the stroke.
   Keep it vectorized numpy/OpenCV with local bbox processing per stroke; perf target < ~40 ms for a typical w=20, L=400 stroke
   (brushlab/bench.py — report numbers).
3. Iterate with brushlab/sheet.py. After each render, LOOK at it (view zoomed crops too) side-by-side with the refs and critique it
   honestly against the review above. At least 4 rounds; save each as brushlab/rounds/b2_rN.jpg (JPEG, downscale ok).
4. Constraints: classic stroke stays the default and byte-identical (brushlab/check_classic.py: run `save` on the baseline FIRST,
   then `cmp` after changes); keep the API of Layer.stroke(model='bristle', ...) / dot() compatible (tip, entry, exit, dry, wet, load,
   pressure, pauses, splay...). brushlab/tests.py-driven sheet must still render. `python3 shanshui/paint.py --brush bristle` must still run.
5. Deliverables at the end:
   - brushlab/compare_pr3_new.jpg (<3 MB): left = brushlab/pr3_sheet_final.jpg's bristle column (or the whole PR3 sheet), right = new sheet, same rows aligned.
   - brushlab/ref_vs_new.jpg: reference crops next to the closest new strokes.
   - shanshui/shanshui_brush_v2_preview.jpg (render with `python3 shanshui/paint.py --scale 1 --brush bristle --out /tmp/ssb2 --name shanshui_brush_v2`, then make a JPEG preview ~1200px tall).
   - Update the 笔毛模型 section of INKWASH_NOTES.md and brushlab/README.md (Chinese, describe real functions/params).
   - Final git commit. Do NOT push anywhere.
   - End with a short summary: what changed, bench numbers, honest remaining issues.
Time box: about 60 minutes total.
