# S09 — Execute one precisely approved external action

**Status:** in progress; fixture implementation only, live writer admission disabled

**Repository:** `ufJmacca/nanoclaw`

**Branch:** `codex/s09-approved-calendar-actions`

**Depends on:** S08 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** The assistant proposes a specific focus-work block, obtains your approval and creates and verifies the exact event without inviting anyone.

S08's actual reviewed merge is accepted; see [its merged-release receipt](../chief-of-staff/evidence/S08_MERGED.md).
S09 began from `462daabef958b9ba1874168719737ad7b39ef8e8`. The fixture implementation
now includes the narrow tools, immutable intent and owner approval, a separate
calendar writer adapter, leased execution, readback and recovery by the original
event ID. A coordinated backup and isolated restore drill passes against the
separate PostgreSQL test database, local SQLite and artifacts. The independent
target journal preserves effects created after that backup without restoring
write permission. The existing host pump now schedules approved actions and
delivers private result notices in the retained main conversation, without a model
wake-up. A separate writer consent flow and credential owner pass fixture tests;
writer IDs and selected calendars are exposed through the existing context tool.
The target deployment path now captures a paired action backup after migration;
restore verification compares actual remote rows and isolated local bytes. Its
same-database fixture proof cannot enable a production writer. The existing
bootstrap now opens checked action configuration after database identity/schema
validation and preserves readback while new writes are disabled. Operator setup
and proof recording now pass guarded local tests: fresh backup retains the paused
native owner lease, and restore imports only a fresh scope into the protected
separate test database before recording proof. The complete native fixture
demonstration now passes through routing, isolated MCP, approval, host execution,
private result and recovery. Release/deployment gates remain. No real account or writer is activated.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## First external action

Implement **create one ordinary, private calendar event on an explicitly selected calendar owned by the operator, with no attendees**. Call it a focus-work block in the UI, but use a normal event type rather than assuming special provider focus-time features are available.

No email sending, guest invitations, recurring events, modifications/deletions of existing events, spending, sharing or general-purpose API execution. Initial external writes always require exact owner approval, even when the proposal originated under a mandate. Expand this only in a later separately reviewed action profile.

## Demonstration

Ask “Find an hour tomorrow for Pilot Alpha.” The assistant reads fresh availability, proposes exact start/end, timezone, calendar and minimal title, and shows an approval card. Approve it. The host checks availability and authority again, creates the event, reads it back and reports its verified ID/link. Change the proposed time after approval: the original approval must not authorise the new time.

## Execution sequence

1. Verify the current provider insert/get/authorisation contract. Add a separately enabled writer binding with the minimum appropriate write scope. Keep the S03 reader read-only. An operator must explicitly grant the new credentials/scope and choose a test calendar; code execution is not consent to account activation.
2. Define an immutable `ActionIntent`: scope, originating mission/proposal, exact calendar, start/end with timezone, approved minimal title/description, `attendees=[]`, no attachments/conference data, resource observations, payload hash, owner and expiry. Do not leak sensitive project text into the calendar by default.
3. Use `cos_action_propose` to create the preview. Retrieve availability freshly and show conflicts/coverage gaps. An ambiguous local time or incomplete calendar access blocks a claim that the slot is free. Approval means this exact action, not permission to pick another slot later.
4. Reuse the hardened approval adapter and bind its exact intent revision, approver, destination and payload hash. Persist the decision before acknowledging the UI projection. Reject replayed, expired, changed-payload and wrong-owner approvals. Do not send the provider request inside an unrecorded UI callback.
5. Add the leased action executor and reconciliation states: proposed, waiting_approval, authorised, queued, executing, verified, blocked, failed, outcome_uncertain, cancelled. Check current owner, subscription, source/model policy, credentials, calendar selection and fresh conflicts immediately before effect execution. A new conflict requires a new proposal rather than automatic movement.
6. Generate a stable high-entropy provider-compatible event ID from the action identity. Keep it unchanged across recovery. Google's documented caller-supplied ID constraints and distributed collision caveat must be respected; an ID is not a universal exactly-once proof. Add an opaque private correlation property when supported.
7. Mark request-start intent durably, call the provider and persist its receipt. Read back the event and compare approved semantic fields before declaring verified completion. Normalise server defaults without overlooking changed dates, destination or attendees.
8. Handle timeout/crash after request start as uncertain until reconciled. Query the same event ID with bounded backoff. A matching event completes the original action; a mismatched event blocks it; an unresolved absence stays uncertain. Do not automatically create a fresh-ID event to “recover”. Any operator-authorised retry uses the same identity and a visible risk/approval policy.
9. Publish the result through the private channel with exact times and verification status. Cancellation before effect execution prevents it. Cancellation after a verified creation does not delete the event; deletion would be a separate future approved action.

## Security and privacy details

A provider token's broad scopes do not widen the host action schema. Reject attendee lists, arbitrary JSON fields, calendar substitution and generic URL overrides at validation and immediately before execution. Do not describe an event as invisible to all administrators or every connected application merely because its visibility is private. Provider/account sharing and notifications remain part of the user's environment.

Before live writes, take a CoS/NanoClaw backup and demonstrate a restore of the relevant receipts in a sandbox. S11 broadens operational testing; it is not a reason to postpone the first recoverable backup until after writes.

## Required red tests

| ID      | Behaviour that must first fail                                                                          |
| ------- | ------------------------------------------------------------------------------------------------------- |
| S09-T01 | No provider write occurs before exact, current owner approval.                                          |
| S09-T02 | Payload, time, calendar or resource-version changes invalidate approval.                                |
| S09-T03 | Guests, attachments, conferencing, recurring changes and arbitrary API calls are rejected.              |
| S09-T04 | Simultaneous duplicate approvals/claims produce one action identity and one active executor lease.      |
| S09-T05 | Timeout after remote creation reconciles the original event without a new-ID create.                    |
| S09-T06 | Remote mismatch or unresolved outcome stays blocked/uncertain, not successfully retried.                |
| S09-T07 | Fresh conflict, revoked credentials or removed subscription blocks an approved-but-not-executed action. |
| S09-T08 | Lost UI/DB acknowledgement can be repaired without losing the decision or rerunning a verified effect.  |
| S09-T09 | Cancel before send prevents execution; cancel after send does not silently delete.                      |
| S09-T10 | Restore preserves effect identity and reconciles external events created after the backup.              |
| S09-T11 | Ordinary existing NanoClaw approval handlers retain their established behaviour.                        |

## External PostgreSQL requirements for this slice

Before live calendar writes, validate the coordinated backup/restore gate for remote CoS state plus local NanoClaw/artifacts. Commit intent/request-start before calling Google, release the database client during HTTP, and record/read back afterwards. A database loss after calendar creation leaves the original action uncertain; never issue another event ID or repeat a send because the receipt could not be saved.

| ID       | Additional required red → green behaviour                                                                                                                   |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S09-PG01 | Calendar creation succeeds while PostgreSQL becomes unreachable before receipt persistence: reconnect reconciles the original event ID without a duplicate. |
| S09-PG02 | Unknown authority/request-start commit, expired lease or active local pause prevents a provider request; no transaction remains open across that request.   |

## Acceptance gate

Pass the fixture provider's success, conflict, timeout-after-success and crash matrix. Run a separately approved test on one non-sensitive operator-owned calendar, inspect the created event, and record sanitised verification evidence. Without credentials/consent, mark live activation pending and keep writer admission disabled. No claim of universal exactly-once behaviour is permitted.

## Rollback

Disable writer admission and pause unexecuted actions. Keep uncertain actions in reconciliation, preserving IDs/receipts. Do not revoke read-only calendar functionality unnecessarily, delete events, or erase the ledger to make the queue appear clean.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S09 --db-profile <selected-profile>` and `pnpm cos:demo --slice S09 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S09.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.

## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.
