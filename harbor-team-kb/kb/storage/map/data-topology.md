---
title: "Demo storage map: database backup jobs and terraform modules"
summary: "Demo navigation and cross-service contract for storage; verify against the checked out code."
triggers: ["demo-storage", "storage database backup locations"]
sources: ["demo-storage:src/main.js#main@00000000", "JIRA:GW-104"]
---

## Repository map

The demo service owns requests; demo-infra owns deployment configuration. See storage/spec/data-topology
