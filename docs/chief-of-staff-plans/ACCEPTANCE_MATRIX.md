# Acceptance matrix and release gates

This matrix is a requirements map, not a record of completed tests. All slices start **not started**. Test IDs are specified in the individual plans; implementations must map them to actual test names and evidence.

## Product capability coverage

| Requirement | First complete slice | Evidence required |
|---|---|---|
| Persistent approved goals and priorities | S01 | Owner-confirmed records survive restart; unapproved changes are excluded. |
| Knowledge access with provenance | S02 | Ask/cite/inspect/correct/revoke demonstration and valid source locators. |
| Awareness from a real external integration | S03 | Calendar adapter fixture plus separately recorded live-read validation. |
| Scheduled preparation and commitment tracking | S04 | Approved schedule, deduplicated brief, confirmed follow-up and resolution. |
| Direct user task delegation | S05 | Bounded work order, isolated worker, reviewed result and cancellation. |
| Specialised multi-agent execution | S06 | Bounded graph, independent contexts, dependency/review/failure evidence. |
| Proactive task suggestions | S07 | Evidence-backed proposal, accept/defer/dismiss and repetition suppression. |
| Autonomous background work | S08 | Approved mandate, deterministic trigger/policy/budget checks and revocation. |
| Controlled external effect | S09 | Exact approval, read-back verification and ambiguous-outcome reconciliation. |
| Long-term strategy support | S10 | Outcomes/assumptions/options review with owner-controlled direction changes. |
| Inspectability, ownership and recovery | S11 | Status, pause, export, restore and full failure replay. |

## Cross-cutting gates: implemented early, regressed thereafter

| Control | Introduce | Regress especially in |
|---|---|---|
| Host-derived identity and owner-bound approval | S01 | S04, S05, S08, S09, S11 |
| CoS feature gating and dependency-failure isolation | S01 | Every slice |
| External LAN PostgreSQL, validated host environment and TLS policy | S01 | Every slice, especially S11 |
| No database credentials/direct DB network access in agent execution | S01/S05 | Every provider/runtime path and S06/S08/S11 |
| Explicit external test profile: protected separate target or guarded disposable runtime; scoped migration roles | S01 | Every migration/integration/demo |
| Bounded shared pool, partition handling and ambiguous DB commits | S01 | S02–S11 |
| Scoped records and no secret-bearing agent mounts | S01 | S02, S03, S05, S09, S11 |
| RPC idempotency and PostgreSQL/SQLite recovery | S01 | S04–S09, S11 |
| Source revision/evidence validity and revocation | S02 | S03–S10, S11 |
| Source-to-model processing authorisation | S02 | S05, S06, S08, S10 |
| Calendar coverage, pagination and time semantics | S03 | S04, S08, S09, S10 |
| Native recurrence and delivery uncertainty | S04 | S07, S08, S11 |
| Real mission execution identity isolation | S05 | S06, S08, S10, S11 |
| Native-route/tool/network bypass resistance | S01/S05 | S06, S08, S09, S11 |
| Generation fencing and attempt accounting | S05 | S06, S08, S09, S11 |
| Root budget and bounded delegation | S05/S06 | S08, S10, S11 |
| Proposal != commitment != authorisation | S01/S04/S07 | S08–S10 |
| Exact external payload and effect receipt | S09 | S11 |
| Coordinated remote PostgreSQL/local runtime backups before real writes | S09 | S11 |
| Goal checkpoint, actual merge verification and resume without a slice prompt | Before implementation | Every slice handoff |

## Required test layers

**Unit:** validators, policy checks, selectors, state transitions, recurrence decisions and canonical hashing. Use a fake clock and deterministic random/ID sources where appropriate.

**Contract:** host ↔ container RPC, native delivery/approval integration, provider adapter inputs/outputs and schema versions. Reject unknown methods, caller-supplied identity and malformed results.

**Integration (executed on the Mac):** real external PostgreSQL using a separate `COS_TEST_PG*` target with its protected marker, or explicit `runtime-disposable` while the bound implementation lifecycle permits it. Use isolated local SQLite/files and the actual registration/dispatch path with fixture channels/models. Never silently switch profiles or replace the whole vertical flow with a mocked repository method. No separate DB provisioning is mandatory during the disposable period.

**Runtime isolation:** inspect actual mounts, identities, network restrictions and provider state in the selected container runtime. Use two distinct synthetic canaries. Keep these tests separate from nondeterministic model quality tests.

**Failure injection:** crash before/after each durable handoff; duplicate/out-of-order events; unavailable dependency; stale lease; late approval; source/owner/subscription revocation; ambiguous external success.

**User-value evaluation:** structured human assessment of recommendations, net time saved after review, false positives, missing commitments, notification noise and strategic decision usefulness. Do not present model agreement as proof or fabricate productivity improvements.

## Completion vocabulary

- `not_started`: no implementation work recorded.
- `in_progress`: active branch/work in progress.
- `blocked`: a prerequisite or necessary implementation/verification step is unresolved.
- `ready_for_review`: implemented slice, tested and documented; PR awaits human review.
- `merged`: reviewed implementation is merged; dependency gate may open.
- `activation_pending`: tracked separately for real account/model/channel/action gates. In-scope migration/deployment waits only for technical checks/access, not fresh human consent.
- `activated`: the relevant existing authority and actual activation evidence are recorded; this is distinct from a healthy fixture-only deployment.

A merged code slice may have live activation pending. That does not imply connected sources or external writes are operating. The next code slice may use the fixture adapter, but its corresponding live feature remains disabled until the required live gates are satisfied.

## Release checklist

- All S01–S11 implementation receipts exist and correspond to merged changes.
- Relevant legacy NanoClaw tests and channel protections remain intact.
- Every runtime/provider profile used for real work has an isolation receipt.
- No permission change is justified only by an agent instruction or hidden tool.
- Source revocation and output access checks work across queued, running and completed work.
- No retries of ambiguous external actions create new identities silently.
- A restore was performed in an isolated environment, not merely a backup command executed.
- Operational configuration, actual limits, coverage gaps and residual risks are documented.
- Live writer is off until S09's explicit account-specific acceptance is recorded.
- In-scope migrations and NanoClaw deployment/restart/rollback execute under the standing implementation authority, without another human review. PR merge and previously unauthorised account/action gates remain.
- No application example provisions a local PostgreSQL server or silently falls back between profiles. Explicit runtime-disposable tests are allowed only before the protected lifecycle closes.
- Remote database preflight, TLS policy, role separation, environment isolation, network interruption and commit-reconciliation evidence exist.
- External-database and local-state backups have a matched, tested recovery manifest and separate restore target.
- The same goal selects/resumes the next eligible slice from verified state, preserves review gates and marks blocked/pending states honestly.

## Implementation-authority coverage

| Requirement | Introduce | Required evidence |
|---|---|---|
| No per-operation human migration/deployment gate | S01; all slices | S01-OPS01/02, per-slice actual migration/release/health receipts. |
| Optional second DB while runtime is disposable | S01 | S01-OPS03; explicit profile, target binding, quiescence, scoped fixtures. |
| Existing NanoClaw and foreign stores preserved | S01; all slices | S01-OPS04, protected-state backups and regression checks. |
| Data protection overrides old disposable assumptions | S01/S11 | S01-OPS05 and S11-OPS02/03/04; closure receipt outside the disposable DB. |
| Final target release and automatic lifecycle closure | S11 | S11-OPS01–05, deployed source identity, healthy service and protected data state. |

A real failure in tests, credentials, host access, target identity or rollback remains a blocker. `awaiting_migration_approval` and `awaiting_deployment_approval` are invalid blockers for in-scope implementation operations. Do not conflate this administrative grant with permission for CoS workers to perform owner actions.

## Mac-to-Pi and interaction gates added in revision 4

Every slice inherits [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) and [INTERACTION_MODEL.md](INTERACTION_MODEL.md). S01-REL01–12 and S01-UI01–08 are required S01 tests; S11-REL01–04 and S11-UI01 are required final tests, not optional roadmap notes.

| Gate | Required evidence |
|---|---|
| Local before delivery | Actual source/runner/slice and final Linux/ARM64 image tests on the Mac; failed gates prevent transfer/activation. |
| Complete immutable release | Matching host-carrier payload and baked-code worker images, no source overrides, exact source and image IDs, artifact checksums. |
| Pi as runtime only | No target builds/installs/source edits; safe image load, payload extraction, current data roots and matching runtime profiles. |
| Cross-host data safety | External DB test profile or Pi-verified shared-disposable lease/quiescence; isolated Mac SQLite; credentials supplied independently. |
| Verified target deployment | Exact Pi release/schema/platform identity, native smoke/isolation, one active live bot, compatible rollback and separate receipts. |
| Mattermost experience | Private owner-scoped chat, exact host-confirmed proposals/controls, reliable IDs and honest readiness; no automatic Telegram context sharing. |
| Completion | Healthy final merged release, Pi-owned protected lifecycle, Mac-independent operation, truthful account/channel activation state. |

Technical test evidence, deployment authority, human code merge and runtime business-action approval remain four separate concepts. Changing where development occurs must not collapse them.

## GitHub source-synchronisation gates added in revision 5

All releases follow [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md). S01 introduces S01-REL13–S01-REL18: fetch is not deployment; exact fork/commit/tree verification; preserved dirty checkout and detached release source; source/image identity agreement; interrupted sync recovery; read-only Git access and offline runtime independence. S11 exercises retained-release recovery. Acceptance receipts must distinguish source pushed, source verified on Pi, final image tested and release activated. None of these is implied by the others.
