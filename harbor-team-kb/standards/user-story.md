---
id: user-story
version: "2.0"
title: "Official User Story Standard (Jira Data Center)"
required_sections:
  - "Story Statement"
  - "Scope & Architecture Mapping"
  - "Spec Delta"
  - "Acceptance Criteria & Concrete Examples"
  - "Out of Scope"
min_examples_rows: 2
required_case_prefixes:
  - "Normal"
  - "Boundary|Rejection"
advisory_vague_phrases:
  - "尽快"
  - "界面友好"
  - "合理处理"
  - "适当处理"
  - "性能良好"
  - "as soon as possible"
  - "user-friendly"
  - "handle gracefully"
---
# User Story standard

State the actor, need, and measurable outcome. Map affected repositories and a Domain.
Declare Spec Delta as NONE with rationale, existing spec IDs with changes, or NEW: domain/spec/slug.
Include a concrete input/output table with Normal: and Boundary: or Rejection: cases.
Record business invariants and cross-service contracts, linking implementation and tests rather than duplicating algorithms.
QA asks at most five implementation ambiguities. Re-export and audit after clarification.
Only an authorized human approves; the approval line is a change detector, not an identity signature.
