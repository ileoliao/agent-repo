---
name: harbor-release-health
description: PLACEHOLDER. Will check the Harbor Release API and Airflow health, and failed or stuck DAG runs. Not implemented yet.
---
This skill is a placeholder and is not wired into any agent. Later it should check the Harbor Release API / Airflow health and report failed or stuck DAG runs.

`scripts/check.sh` exits 2 and prints "not implemented yet" on purpose: used as a `wakeIf` probe it is reported as broken and never as "all clear" (exit 1).
