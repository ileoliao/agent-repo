# Spec v3 implementation validation

Validated locally on 2026-11-13 in the harbor-team-kb-v2 worktree. Phase 1 and Phase 2 tool capabilities are implemented; Phase 3 is excluded. No production Jira workflow, private remote repository, or administrator settings were changed.

## Pre-push regression — 2026-11-14

- Re-ran `node tests/verify_pluggable.js`: exit 0, all 73 assertions passed, including all 15 v3 scenario groups and all 13 Jira mock end-to-end groups.
- The run includes real skill linting, copied/symlink installation, approval and publishing checks, two-clone synchronization, source fingerprints and isolated local Git origins. It does not exercise a live Jira server or live model judgment.
- The latest prompt-budget measurement is a 1,200-token static increment; at 500 entries the fifth-turn peak is 4,470 tokens (3.49% of 128k). These are fixture measurements, not business-effectiveness results; older measurements below describe the previous validation run.
- Documentation checks passed for local file links, code-block pairing and the new Spec chapter 8 references. `git diff --check` passed.
- Cold-start orchestration, task-end knowledge extraction, semantic conflict checks and automated relationship maintenance in Spec chapter 8 remain planned capabilities; this regression does not certify them as implemented.

## Results

- `node tests/verify_pluggable.js`: all 73 assertions passed, including Suite 12's 15 v3 scenario groups.
- `node tests/verify_v3.js`: all 15 scenario groups passed independently.
- `node tests/verify_jira_mock_e2e.js`: all 13 Jira mock end-to-end scenario groups passed independently and inside the full suite.
- Adjacent `loop-runner`: TypeScript compilation and all 12 suites in `npm test` passed (e2e, console DOM, memory, Harbor team, housekeeping, doctor, triggers, console wording, attention, allow commands, policy profiles, folding). Local listener tests required execution outside the filesystem/network sandbox. Existing development dependencies were reused with a temporary symlink, which was removed afterwards.
- Real Harbor Mate `lintSkill`: team-kb, team-kb-publish, and story-guard each produced zero errors and zero warnings.
- All four skill scripts remain below 57,344 bytes; all three SKILL.md files remain below 4,096 characters. Only Node standard library imports and the same-directory kb_index.js module are used.
- All 16 public demo entries pass schema validation with zero warnings. No actual private team data was introduced.
- Existing 32 core engineering queries retain Recall@1/5 of 100% at both 16 and 500 entries. Existing eight difficult negatives retain zero false positives. Eight separate holdout queries achieve Recall@3 of 100%. These are dataset measurements, not a guarantee for every natural-language query; lexical retrieval can still confuse adjacent concepts in shorter or vague queries.
- The existing 128k-context benchmark with both read skills mounted measures a 1,337-token static KB increment and a 4,686-token fifth-turn peak (3.66%); the v3 budget assertions reflect the added story-guard capability.
- `git diff --check` passes.

## Covered contracts

Suite 12 exercises private repository initialization, strict CODEOWNERS placeholders, non-destructive upgrades, three identical resolvers and secret patterns, configured-root failure, demo refusal, independent copied skills, persistent drafts, private publishing, classified Story examples, cross-domain references, automatic QA routing, invalid identifier sanitization, a fixed hash vector, metadata invariance, latest approval selection, 64 KB rejection, Nonce isolation, official snapshot context, online/TTL/offline/local modes, strict-online rejection, nested repository layouts, absent remote baselines, worktree repository identity, all seven anchor states, LF/CRLF equivalence, explicit clean-file re-verification, hard-drift-only wake behavior, and retrieval budgets.

The main regression suite retains policy denial for unattended publishers, SHA-256-bound human approval, temporary worktree publication, two-clone synchronization, concurrent index construction, byte-exact uninstall, prototype safety, YAML indentation, default-policy handling, and remote-default-branch isolation. Historical publication fixtures explicitly opt into the demo override; normal commands continue to refuse public-engine publishing.

## Integration boundary

Per the requested acceptance scope, the Jira Editor and Jira workflow boundary is now exercised through a file-backed mock. The adapter models original-text export, QA-only approvals, Story Approved edit locks, development-state edits, re-approval and closing impact fields. These are the project's assumed contract, not evidence about a live Jira server configuration. Real Jira/API/plugin connectivity, live model sessions, and GitHub PR API/branch-protection settings are outside this mock acceptance. The approval hash detects content changes; Jira permissions authenticate the reviewer in a real deployment.

## Post-implementation conformity review

A second review of the uncommitted implementation against SPEC_V3 found four independent deviations (four Spec findings, two overlapping engineering-contract findings). They have been corrected:

1. Copied audit/publish scripts relied on a disposable cache to recognize the public engine. Targets are now checked by their engine layout as well as known real paths; CLI, environment, persistent-user, and workspace pointers cannot bypass the demo guard after cache deletion. Valid legacy engine pointers can still supply the explicitly labelled demo fallback without superseding a configured private data repository.
2. Nested working directories skipped origin detection. Origin is now queried directly from the current directory, always prioritized, and tracked independently of directory-name duplication. Tests include nested worktrees and a child directory named exactly like origin.
3. Positional re-verification of the same persistent draft incorrectly required --force. Explicitly naming the input draft now permits an in-place update. Validation occurs on temporary bytes before replacement; failure preserves the original draft.
4. story-guard expanded home-relative paths differently from the other entry points. All three now share identical handling of standalone ~, slash-relative, and Windows-style home paths.

After correction, the full KB suite passed all 73 assertions with 15 v3 scenario groups; the final origin-name collision case is additionally covered by the standalone suite. The mock-versus-live integration boundary above still applies. Passing automated checks is evidence for the exercised contracts, rather than proof that every deployment or input combination has been validated.

## Jira mock end-to-end acceptance

Command: `node tests/verify_jira_mock_e2e.js --report tests/evidence/jira-mock-e2e.json`.

All 13 scenario groups pass. The suite is also part of `verify_pluggable.js`. Jira Editor/workflow state and reviewer decisions use fixture actors; copied skill installation, standards/maps, check/audit/verify, raw export-byte comparisons, business code tests, dirty-source rejection, clean re-verification, reviewed-draft hash comparison, publishing to a real bare Git origin, validation/review/merge, and synchronization by a second independent member all execute real code. A low-risk control verifies that QA routing does not simply classify every Story as REQUIRED. Failure paths cover role escalation, approval-state edits, title/body tampering, closing without required fields, configured-data loss and cache deletion.

The [machine-readable evidence](tests/evidence/jira-mock-e2e.json) records the mock issue's final Closed status, approval/story/standard hashes, source and data commits, published topic branch, second-member commit and mock transition history. Each run isolates HOME, cache, Git identity and all repositories in a temporary directory and cleans them afterwards; only an explicitly requested report persists. Local topic-branch review/merge is used instead of a GitHub PR service.
