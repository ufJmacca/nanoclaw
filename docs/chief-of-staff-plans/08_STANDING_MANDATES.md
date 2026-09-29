# S08 — Perform useful background work under a standing mandate

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s08-standing-mandates`  
**Depends on:** S07 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** After you approve a narrow responsibility once, the assistant prepares work autonomously within its scope, budget and notification rules.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

Approve: “For selected important meetings, prepare a private briefing using the approved calendar and Pilot Alpha notes. Do not contact attendees or modify the calendar.” When a matching event appears, the host admits one preparation mission without another approval. Pause the mandate while a later mission is running: remaining permissions are revoked and no new result is published without a current authorisation check.

## In scope

Versioned mandates, typed trigger rules, deterministic policy checks, budget reservations, autonomous read-only/preparation missions and renewal/pause/expiry. External calendar/email writes are not implicitly allowed. S09 introduces a separate exact-action approval flow.

## Execution sequence

1. Add `MandateRevision` with owner, scope, purpose, allowed source selectors, allowed mission templates/operations, trigger rules, output destination, quiet hours, structural budget, start/end/review times and failure behaviour. Compile natural-language suggestions into a typed proposal, not executable scripts.
2. Support a deliberately small trigger language: selected event approaching, selected project changed, recorded commitment due, or native scheduled review. Bound look-ahead windows and matching cardinality. No arbitrary code, SQL, shell expressions or model-generated webhook URLs.
3. Reuse the S01 approval adapter for initial approval, renewal and material expansion. Show the complete authority being delegated and its limits. A mandate revision is immutable. Replacing it revokes the old revision; model edits to its readable description have no authority.
4. Implement `evaluateMandate(trigger, currentState)` as deterministic host logic. Revalidate source bindings, origin scope, current owner/subscription, expiry, allowed template and operation. In one PostgreSQL transaction, deduplicate the occurrence and reserve root budget before creating a mission/outbox record.
5. Link all child attempts/actions to the mandate revision. Check it again at source retrieval, worker wake, output publication and any privileged operation. A policy change or pause takes effect on existing work; it is not only a gate on future scheduling.
6. Integrate native NanoClaw schedules and source events using S04/S07 bindings. On startup reconcile unapplied outbox records and missed occurrences with a bounded coalescing policy. A duplicated provider event or clock tick cannot create multiple missions.
7. Implement pause, resume, revoke, expiry, failure threshold and automatic suspension after repeated failures or unknown usage. Resume does not replay an unlimited backlog or revive cancelled generations. Unknown monetary usage is visible and cannot be treated as free execution.
8. Add an activity digest: mandate, trigger, work performed, result, sources accessed, limits consumed and decisions needed. Notify immediately only under the approved escalation rule. A no-op evaluation is recorded without unnecessary model work or user interruption.

## Suggested initial templates

**Meeting preparation:** read approved calendar events and selected project notes; produce a private artifact; notify the originating owner context.

**Project health review:** inspect current approved project/commitment records and recent source changes; create proposals and private summaries; do not change project status.

**Weekly operating review:** reconcile commitments and pending decisions; propose next steps; do not create new commitments without confirmation.

Enable one template first. A template being shipped does not mean it is active. No mandate may self-expand sources, change its own expiry or approve an external effect.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S08-T01 | Unapproved, expired, revoked and out-of-scope mandate revisions cannot admit a mission. |
| S08-T02 | Duplicate/concurrent triggers reserve budget and create work once. |
| S08-T03 | Pause/revoke fences running descendants and blocks retrieval/publication at the next boundary. |
| S08-T04 | A model cannot widen actions/sources/templates or prolong a mandate. |
| S08-T05 | Budget reservations account for all children/retries; unknown usage is not zero. |
| S08-T06 | Missed occurrences coalesce; failure storms cause suspension, not runaway spawning. |
| S08-T07 | Source changes and untrusted event text cannot become executable trigger code. |
| S08-T08 | Native schedule repair cannot bypass mandate approval or replay cancelled generations. |
| S08-T09 | No-op triggers avoid model execution and do not spam the owner. |
| S08-T10 | External calendar/email writes are rejected even when a model claims the mandate implies permission. |

## External PostgreSQL requirements for this slice

Mandate evaluation, trigger deduplication and budget reservation use one remote transaction. No cached mandate or native scheduled row can authorise work while PostgreSQL is unavailable. A trusted host pause remains effective during the partition and is reconciled before reopening admission.

| ID | Additional required red → green behaviour |
|---|---|
| S08-PG01 | Database failure at trigger admission or lease renewal causes no new worker, spend reservation reset or stale-authority publication. |
| S08-PG02 | A host-local emergency pause during a partition remains in force after reconnect until the owner explicitly resumes eligible work. |

## Acceptance gate

Exercise approve → trigger → autonomous preparation → digest, followed by pause, expiry, budget exhaustion, duplicate triggers, host restart and source revocation. Prove one live read-only mandate only after its provider/runtime isolation profile has passed S05. Record concrete configured limits and the distinction between hard structural limits and estimated cost.

## Rollback

Disable mandate admission, revoke in-flight authorisations and pause associated native schedule bindings. Preserve evidence and final receipts. Explicitly record cancelled versus already-completed work; do not claim an already-delivered briefing was retracted.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S08 --db-profile <selected-profile>` and `pnpm cos:demo --slice S08 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S08.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

