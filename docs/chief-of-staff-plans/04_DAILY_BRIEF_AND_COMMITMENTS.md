# S04 — Deliver a daily brief and track confirmed commitments

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s04-daily-brief-and-commitments`  
**Depends on:** S03 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** You receive a useful scheduled brief, confirm or dismiss its suggested follow-ups, and stop reminders when commitments are resolved.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

Approve a weekday morning briefing in the private CoS channel. At the fixture clock's next occurrence, receive at most three substantive attention items with evidence, upcoming calendar events, open decisions and source-coverage warnings. Confirm a proposed follow-up as a commitment. Mark it complete through an authenticated owner interaction and verify subsequent briefs no longer treat it as open. Restart the host during a briefing and verify one internal run is reconciled rather than created again.

## In scope

Native NanoClaw scheduling, a briefing run lifecycle, confirmed commitments/decisions, quiet hours and deduplicated notification intent. Not yet project-monitoring mandates, specialist delegation or external account writes. An approved recurring brief is a narrow scheduled responsibility, not unlimited autonomy.

## Execution sequence

1. Add commitment and decision records with explicit statuses, supporting sources, project relationship, owner and due-date semantics. Extraction from conversation/calendar material creates a proposal. Only an owner-confirmed revision becomes a commitment or decision.
2. Add `cos_brief_request` and commitment/decision proposal operations. Deterministic candidate selection filters active projects, unresolved commitments, approaching events and stale evidence. Model synthesis may explain trade-offs, but cannot invent events or change priority records.
3. Implement the native schedule adapter after inspecting current scheduling module and recurrence encoding. Reuse those functions; do not hand-write raw recurring message rows from the conversational examples. Store the CoS schedule revision and its native task binding. Only the host may schedule a CoS action under the corresponding approved definition.
4. Give every occurrence a stable key: scope + schedule revision + intended occurrence time. The host creates one `BriefRun`, reserves its structural limits and dispatches through the native queue. Transport retry reuses that run. A failed model turn is not a new schedule occurrence.
5. Refresh selected source snapshots within bounded time before generating a brief. Continue with prominently marked stale/not-connected sections when refresh fails; do not silently omit missing data. A late brief uses current data and a visible generated-at time.
6. Add a host-controlled private notification path with stable notification ID. Revalidate channel ownership/subscription immediately before delivery. Store queued, delivered, failed or uncertain status and platform receipt where available. Do not claim provider-level exactly-once delivery where the channel adapter cannot guarantee it.
7. Implement pause/resume, quiet hours, snooze and missed-run coalescing. After downtime, prepare at most one current briefing rather than replaying every missed morning. Use IANA timezones with an explicit once-per-local-date policy and tested DST behaviour.
8. Add owner interactions to confirm, edit, complete, defer or dismiss a commitment/proposed item. These must map to exact versioned records; ambiguous free text asks for clarification rather than mutating the wrong item.

## Brief output contract

A brief contains generated_at, effective timezone, source coverage, up to three priority recommendations, due commitments, decisions needed, suggested delegated work (still proposals) and evidence references. Empty state is useful: “No confirmed commitments; calendar not connected” is valid. Do not fill the brief with speculative tasks to reach a quota.

Persist the source/record versions used for the brief. Editing the live state does not rewrite the historical brief. Revocation controls still prevent redisplaying restricted historical content.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S04-T01 | Repeated native deliveries for one occurrence create one brief run and one notification intent. |
| S04-T02 | Host restart after dispatch/before receipt reconciles existing state without inventing another run. |
| S04-T03 | Confirmed, completed, deferred and dismissed commitments appear in the correct views. |
| S04-T04 | An extracted suggestion never becomes a commitment merely because the model labels it urgent. |
| S04-T05 | Quiet hours, snooze, DST and missed-run coalescing follow the approved schedule policy. |
| S04-T06 | Subscription/owner revocation between preparation and delivery prevents disclosure. |
| S04-T07 | Stale/missing calendar data remains visible and cannot yield a false “free day” claim. |
| S04-T08 | A native retry does not bypass the brief's turn/tool/deadline limits. |
| S04-T09 | Queued, confirmed delivery and uncertain delivery are distinguished accurately. |
| S04-T10 | Generic scheduling tools/forged outbound messages cannot create unapproved CoS schedules. |

## External PostgreSQL requirements for this slice

The native task remains a wake signal, not an offline authority record. If the database link is down, do not generate/publish a private brief, accept a commitment change or mark a run delivered. On reconnect reconcile the stable occurrence and current permissions before coalescing missed work.

| ID | Additional required red → green behaviour |
|---|---|
| S04-PG01 | A due native task during database outage performs no unauthorised model/notification work and recovers to at most one current brief intent. |
| S04-PG02 | A lost commitment-change commit acknowledgement returns the original confirmed revision; it cannot duplicate or forget the owner disposition. |

## Acceptance gate

Complete schedule approval → recurring brief → commitment confirmation → resolution → next brief using a fake clock and fixture connector. Exercise one real configured channel only with explicit operator opt-in. Record notification guarantees for that adapter; a platform ambiguity must be reported rather than hidden with retries.

## Rollback

Pause CoS schedules and reconcile pending notifications as cancelled or uncertain. Keep commitments and prior approved decisions available on demand. Do not delete native schedules owned by unrelated NanoClaw groups.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S04 --db-profile <selected-profile>` and `pnpm cos:demo --slice S04 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S04.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

