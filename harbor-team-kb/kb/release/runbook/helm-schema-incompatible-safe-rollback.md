---
title: "Safe two-phase Helm rollback runbook for releases with database schema migrations"
summary: "Before rolling back a release that ran database schema changes, run verify_backward_compat and keep Expand-Contract columns intact; never run destructive DROP COLUMN DDL during an incident."
sources:
  - "harbor-deploy:scripts/rollback_tier0.sh#verify_backward_compat"
triggers:
  - "verify_backward_compat"
  - "rollback_tier0.sh"
  - "rollback"
  - "回滚"
  - "schema migration"
  - "Expand-Contract"
---

## When to Use

Use this runbook whenever an emergency application rollback is needed after a release that applied database schema migrations.

## Safe Rollback Procedure

1. **Roll back stateless pods only — never run `DROP COLUMN` during outage**: Under Expand-Contract rules, newly added columns remain nullable or defaulted; running destructive down-migrations drops rows written during canary traffic.
2. **Run compatibility pre-check**: Execute `harbor-deploy:scripts/rollback_tier0.sh#verify_backward_compat` to verify:
   - No newly added column has `NOT NULL` without a `DEFAULT` (otherwise older pod `INSERT` queries fail immediately; run `ALTER COLUMN ... DROP NOT NULL` before rolling pods back).
   - Queue/cache payloads do not contain unknown enum variants that crash older consumers.
3. **Roll back Deployment & verify**: Revert the Helm revision / image tag and watch `error_rate` plus DB constraint logs for 10 minutes.
