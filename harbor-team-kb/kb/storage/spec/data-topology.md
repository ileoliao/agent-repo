---
title: "Demo storage spec: restoring backups preserves tenant isolation"
summary: "Demo navigation and cross-service contract for storage; verify against the checked out code."
triggers: ["demo-storage", "storage backup tenant isolation"]
sources: ["demo-storage:src/main.js#main@00000000", "JIRA:GW-104"]
---

## Business invariant

Restoring a backup must preserve isolation between tenants. Use source and test anchors for implementation details.
