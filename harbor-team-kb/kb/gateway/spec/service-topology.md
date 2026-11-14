---
title: "Demo gateway spec: rejected requests preserve persisted state"
summary: "Demo navigation and cross-service contract for gateway; verify against the checked out code."
triggers: ["demo-gateway", "gateway rejected request invariant"]
sources: ["demo-gateway:src/main.js#main@00000000", "JIRA:GW-104"]
---

## Business invariant

A rejected request must not mutate persisted state. Use source and test anchors for implementation details.
