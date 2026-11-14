---
title: "Demo gateway map: repository topology and infrastructure ownership"
summary: "Demo navigation and cross-service contract for gateway; verify against the checked out code."
triggers: ["demo-gateway", "gateway repository navigation"]
sources: ["demo-gateway:src/main.js#main@00000000", "JIRA:GW-104"]
---

## Repository map

The demo service owns requests; demo-infra owns deployment configuration. See gateway/spec/service-topology
