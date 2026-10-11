---
name: pipeline
description: Three ordered steps. Step 2 needs step 1's output; step 3 needs step 2's output.
---
Run these exact commands with run_command, in this order, one per turn. Each reads the previous step's output file. Do not change the paths.

1. `bash .github/skills/pipeline/scripts/step1.sh`
2. `bash .github/skills/pipeline/scripts/step2.sh`
3. `bash .github/skills/pipeline/scripts/step3.sh`

After step 3, call finish with status done.
