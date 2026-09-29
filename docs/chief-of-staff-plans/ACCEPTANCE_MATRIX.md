# Acceptance matrix and release gates

**Plan revision:** 5. Requirements map, not completed test evidence. All slices begin not_started. Map every specified ID to actual tests and receipts; preserve detailed contracts through [shared execution rules](SLICE_EXECUTION_RULES.md).

## Capability coverage

| Slice | User-visible capability | Required demonstration |
|---|---|---|
| S01 | Approved direction/priorities | Exact owner confirmation, persistence, legacy compatibility, first Mac-to-Pi release and private control path. |
| S02 | Grounded knowledge | Import/ask/cite/inspect/correct/revoke with real locators. |
| S03 | Calendar awareness | Bounded paginated read-only snapshots, recurrence/time/coverage and disconnect. |
| S04 | Briefs/commitments | Approved schedule, deduplicated brief, confirm/resolve follow-up. |
| S05 | Research delegation | Bounded approved mission, fresh worker identity, verified result, cancel/recover. |
| S06 | Specialist teams | Bounded graph, dependencies, joins, root budgets and honest partial failure. |
| S07 | Proactive proposals | Evidence-backed accept/defer/dismiss and repetition suppression. |
| S08 | Standing autonomy | Approved typed mandate, deterministic trigger/policy/budget and in-flight revocation. |
| S09 | External action | Exact calendar preview/approval, stable effect ID, read-back and ambiguity handling. |
| S10 | Strategy | Outcome versus activity, alternatives/assumptions, explicit direction decisions/history. |
| S11 | Operations/recovery | Inspect/pause/export/coordinated restore, final release and protected lifecycle. |

## Cross-cutting gates

| Control | Introduce | Regress |
|---|---|---|
| Host identity, exact owner/private destination and durable approval | S01 | Every authority-bearing slice |
| Feature gating and normal-chat failure isolation | S01 | All |
| External env parsing, roles, TLS, pool deadlines and no worker secrets | S01 | All |
| Remote commit/RPC/outbox/SQLite recovery | S01 | S02–S11 |
| Scoped evidence/model-processing and revocation | S02 | S03–S11 |
| Calendar pagination/coverage/time semantics | S03 | S04/S08/S09/S10 |
| Stable native occurrence and uncertain notification | S04 | S07/S08/S11 |
| Fresh execution identity, effective filesystem/network isolation | S05 | S06/S08/S10/S11 |
| Generation fencing, cancellation and root budgets | S05/S06 | S08/S09/S11 |
| Suggestion != commitment != authority | S01/S04/S07 | All later slices |
| Exact effect payload, lease, receipt and provider reconciliation | S09 | S11 |
| Coordinated restore before real effects | S09 | S11 |
| Pinned GitHub source, tested images, no Pi builds/source overrides | S01 | Every release |
| Private Mattermost deterministic controls, no Mac live bot | S01 | S04/S05/S08/S09/S11 |
| Guarded disposable target and monotonic protected transition | S01 | S11/final completion |

## Test inventory

Each slice document carries its own complete T and PG IDs. S01 additionally owns OPS01–OPS05, REL01–REL12 from MAC_TO_PI_DELIVERY.md, REL13–REL18 from GITHUB_SOURCE_SYNC.md and UI01–UI08 from INTERACTION_MODEL.md. S11 additionally owns OPS01–OPS05 and REL01–REL04. Required IDs must not disappear during implementation or become implicitly passed through another suite. An implementation receipt maps inherited gates to the actual tests run.

## Test layers

Unit: validators, selectors, policy, transitions, canonical hashes and clocks. Contract: real host/container RPC, native delivery/approvals, schemas and provider requests. Integration: real eligible external PostgreSQL plus isolated local SQLite/files and actual registered transport; not a completely mocked repository. Isolation: concrete mounts, identities, egress and provider state with canaries, including real Pi profile checks. Faults: every durable handoff, duplicate/out-of-order events, partitions, stale leases, late decisions, revocation and uncertain provider success. User value: explicitly separate human assessment of net time saved, usefulness/errors/noise from deterministic blocking safety checks.

Mac source tests are insufficient without final ARM64 artifact tests; artifact tests do not prove Pi-native behaviour. Git source fetch does not deploy. Images named after a commit do not prove source identity. No live-model/account test is claimed from fixtures. Tests of the plan bundle itself only validate documentation/metadata, not application behaviour.

## State vocabulary

Implementation: not_started, in_progress, blocked, ready_for_review, merged. Goal may checkpoint awaiting_review without becoming completed. Activation separately: not_started/activation_pending/activated. Source publication, Pi source verification, image verification, transfer, migration, target smoke and deployment have independent actual evidence/status. Do not collapse them into a green code flag.

A merged slice may retain unconfigured accounts and continue fixture-based dependent development. Missing all eligible databases or mandatory isolation tests blocks code acceptance. A missing second test DB alone does not block the eligible guarded runtime-disposable path. A ready in-scope migration/deployment runs under standing authority, not a new review gate. Real technical failure remains a blocker.

## Final checklist

- All eleven slices and required corrections have reviewed merges and actual mandatory evidence.
- Existing NanoClaw research/providers/channel restrictions remain intact.
- Each real runtime/provider profile has isolation evidence; workers never gain DB/deploy secrets.
- Exact fork/source commit/tree, final tested image IDs and healthy Pi deployment agree.
- Pi runs independently when Mac/GitHub are unavailable; retained rollback provenance remains intact.
- Remote/local backup restore actually ran with egress closed and later effects reconciled.
- Source revocation covers queued/running/completed artifacts without resurrecting deleted data.
- Uncertain effects retain identity and are never recovered by a new-ID duplicate.
- Pi lifecycle closes disposal after all implementation/merge gates and cannot be reopened by a stale template.
- Existing SQLite/messages/sessions, credentials and foreign schemas remain protected throughout.
- Account/model/channel/pilot readiness and S09 writer activation remain honestly separate.
- Report limits and errors without fabricating productivity, signed releases or exactly-once guarantees.
