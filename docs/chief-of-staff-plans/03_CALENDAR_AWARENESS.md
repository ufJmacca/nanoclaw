# S03 — Understand upcoming commitments from one real connector

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s03-calendar-awareness`  
**Depends on:** S02 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** You ask about your upcoming day and receive calendar-aware advice with visible freshness and coverage.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Deliberate provider choice

Implement **Google Calendar read-only** as the first concrete external adapter. This is a replaceable reference choice, not an assumption that an account is connected or a requirement to grant access now. No Gmail, Drive, broad integration marketplace or generic API proxy is needed. An operator can select another provider through a documented contract change before coding this slice; do not implement several providers speculatively.

The code and fixture flow must work without live credentials. Live calendar validation is a separate opt-in gate and remains pending until actually performed.

## Demonstration

A fixture calendar contains an approaching meeting, an all-day event, a moved recurring instance and a cancelled event. Ask “What do I need to prepare for tomorrow?” The assistant uses only selected calendars, shows relevant events with times in the configured timezone, and marks project links as proposed when uncertain. Disconnect the connector: the assistant reports incomplete coverage, not an empty day.

## Execution sequence

1. Define a narrow `CalendarReader` interface: list an allowlisted calendar's bounded events, get an event, and report coverage/auth state. Implement an in-memory fixture adapter and an actual Google adapter. Never expose arbitrary request URLs/methods to agents.
2. Verify current official API and OAuth documentation during implementation. Choose read-only scopes, a standard supported authorisation flow, exact callback validation and host-only token storage. Account linking is an operator action; no credentials in chat, repository, runner environment or logs. Revalidate and rotate tokens through the host credential boundary.
3. Implement **bounded paginated snapshot synchronisation**, initially 30 days back and 90 days forward, configurable by the owner. Persist a snapshot generation; do not publish the generation as complete until every page succeeds. Use a stable query window throughout pagination. Re-read the provider's current recurrence/pagination semantics; do not mix a moving window with an assumed sync-token contract.
4. Normalise timed/all-day events, recurring instances, cancellations, source IDs, versions and optional project links. Keep all-day dates as dates. Use the configured IANA zone and avoid assigning an arbitrary midnight UTC meaning to all-day events.
5. Upsert revisions idempotently and retire observations missing from a successfully completed snapshot within its defined coverage. Do not delete unseen events after a failed/partial sync. Detect revoked/removed calendar access and quarantine associated cached content immediately.
6. Add `cos_calendar_read` and on-demand host sync, both constrained by the current source binding. Link observations into S02 evidence without making the CoS database authoritative for external calendar state.
7. Add calendar coverage to `cos_context_get` and the coordinator's preparation advice. A calendar event is not a commitment to perform an inferred task. Suggestions to prepare are proposals, not automatic new goals.

## Data and integration boundaries

Add connector bindings, selected calendar IDs, observed scope/provider permissions, snapshot generations, event observations and explicit last-success/last-attempt timestamps. Do not store raw tokens in these tables; store a credential reference.

No background synchronisation mechanism independent of NanoClaw is required yet. S04 adds a native scheduled review that can request a bounded refresh. No external calendar mutation is implemented in S03; code must reject write methods, even if the operator accidentally supplies a broadly scoped token.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S03-T01 | All pagination pages are read; partial failure cannot advertise complete coverage or delete missing events. |
| S03-T02 | All-day, timed, recurrence exception and cancelled-event fixtures normalise correctly. |
| S03-T03 | Duplicate sync writes do not duplicate events or evidence revisions. |
| S03-T04 | Selected calendars/scopes are enforced independently of the token's broader permissions. |
| S03-T05 | Expired/revoked auth stops reads and invalidates accessible cached evidence. |
| S03-T06 | Connector requests cannot invoke writes or target an arbitrary HTTP endpoint. |
| S03-T07 | Retry/backoff for rate limits is bounded and honours a provider retry hint when supplied. |
| S03-T08 | Source text cannot authorise actions; secrets and sensitive response bodies are redacted from operational logs. |
| S03-T09 | DST and ambiguous/nonexistent local-time cases are handled by an explicit tested policy. |
| S03-T10 | An unavailable connector produces a coverage warning, not “nothing scheduled”. |

## External PostgreSQL requirements for this slice

Read bounded calendar pages outside database transactions, then commit the snapshot generation on the external server. A database failure must not promote or retire observations from a partial generation. Reuse the host pool; account OAuth credentials and PostgreSQL credentials stay separate and host-only.

| ID | Additional required red → green behaviour |
|---|---|
| S03-PG01 | Database disconnect during snapshot persistence leaves coverage incomplete, preserves the last complete generation and does not retire unseen events. |
| S03-PG02 | Recovery retries a stable snapshot identity and exposes no database credential in calendar adapter context. |

## Acceptance gate

The demonstration works through a real host adapter interface, PostgreSQL and the fixture provider. Provide a separate operator runbook for connecting one test calendar with minimum permissions, checking read-only network requests, revoking it, and observing the resulting access loss. Do not automatically connect an account while executing this plan.

## Rollback

Disable the binding and stop refresh work. Retain access tombstones and hide its evidence. Other knowledge and work-record functionality continue. No calendar events are modified by this slice.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S03 --db-profile <selected-profile>` and `pnpm cos:demo --slice S03 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S03.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

