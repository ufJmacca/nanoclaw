# S11 — Inspect, pause and recover the whole assistant

**Status:** in progress; inspection, readiness and owner-denial development checks passed; full recovery and release acceptance pending.

**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `codex/s11-operations-and-recovery`

**Depends on:** S10 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** You can see what the assistant is doing and why, stop it safely, restore it after failure and export your own records.

Development evidence is recorded in [S11](../chief-of-staff/evidence/S11.md). These milestones do not satisfy the full slice, Pi deployment or human merge gates below.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

While a delegated mission and a scheduled brief exist, ask for status. Receive current state, authority, budget consumption/uncertainty, source freshness and pending decisions. Pause automation and confirm no new work is admitted. Restart the host, recover queued work and inspect an uncertain external action without duplicating it. Restore a test backup into an isolated environment with egress disabled, reconcile action receipts, and only then deliberately resume.

## In scope

A consolidated chat/CLI operator view, health and evidence inspection, coordinated backup/restore, export, retention operations and a full system acceptance replay. This is not the first security/reliability work; those controls are mandatory in every preceding slice. No new web dashboard, public endpoint or observability SaaS is required.

## Execution sequence

1. Add `cos_status` and owner-run CLI inspection for goals, commitments, proposals, missions/attempts, mandates, approvals, action receipts, blocked operations, source coverage and limits. Every status item links to its originating purpose/authority and a safe evidence reference.
2. Implement authenticated pause admission, pause automation, cancel mission, revoke source, disable connector and inspect uncertain action controls. Scope them precisely. A request to stop CoS must not kill unrelated NanoClaw containers or erase state. Keep control operations available during partial dependency failure through a trusted host path.
3. Define health/readiness separately: host alive; external PostgreSQL configuration, DNS/TCP/TLS/auth/schema/reconciliation state; bounded pool utilisation and waiting count; queue backlog; failed outbox commands; stale connector coverage; worker capacity; orphan resources; and unknown effects. Logging is structured and redacted. Do not store private chain-of-thought; retain concise action reasons, policy decisions, identifiers and result evidence.
4. Coordinate an administrator-managed remote PostgreSQL backup/checkpoint with relevant local NanoClaw central/session SQLite, host-owned artifacts, scope/config references and schema versions. The external DBA owns server backups/PITR; the application must not assume a local PostgreSQL volume or copy the remote server data directory. Use a maintenance/quiesce barrier or documented coordinated snapshot procedure; respect SQLite journals/WAL. Record the matching generation and checksums. Credentials are re-injected separately into the host service environment, never embedded in a portable data export.
5. Implement a restore manifest containing backup generation, software/schema versions, checksums, included state, revocation markers and the external reconciliation checkpoint. Restore PostgreSQL into a separate admitted external restore/test database when available, or use the bound disposable runtime under the quiesced, effects-safe implementation restore procedure. Restore local files only into an isolated host data root, with admissions and external egress disabled. The implementation restore has no extra review gate; protected runtime data may not be overwritten. Verify integrity before considering any resume.
6. Reconcile stale leases, partial allocations, orphan containers, outbox commands, native schedules and external actions created after the backup. Never infer an external action did not happen merely because an older database lacks its receipt. Require provider read-back or owner disposition of uncertainty before reopening writer admission.
7. Add source/artifact retention and export. Apply scope checks and revocation rules to exports, use short-lived/private delivery or owner-local files, and audit the export itself. Clearly state where already-delivered messages, providers and backup retention limit deletion guarantees.
8. Run the full synthetic acceptance replay across S01–S10, then inject test-path network partitions/latency, refused connections, idle-pool errors, credential/TLS failures, ambiguous database commits, container crash, host restart, duplicate events, delayed approvals, revoked access, missing connector credentials and timeout-after-remote-success. Do not stop the shared PostgreSQL server or modify its firewall for these tests. Confirm every operation reaches a known terminal or explicitly uncertain state.
9. Write operator runbooks: external-database prerequisites and role boundaries; host-service environment injection; read-only connection preflight; explicit scoped migrations; install/upgrade; safe shutdown/startup; credential rotation with automatically authorised service restart; source revocation; mission cancellation; effect reconciliation; coordinated backup/restore; feature rollback; and known limitations. Do not modify global coding-agent permissions to make deployment convenient.
10. Produce the release assessment with separate code readiness and live activation states. External writes remain disabled when their account-specific validation is pending. Missing account/model credentials do not erase implemented fixture work or block an otherwise healthy fixture-only target deployment; they prevent claiming that those integrations are active. Verify final deployment and automatically close the disposable data period when all implementation/merge gates pass.

## Required red tests

| ID      | Behaviour that must first fail                                                                        |
| ------- | ----------------------------------------------------------------------------------------------------- |
| S11-T01 | Status remains accurate across queued/running/blocked/review/uncertain/cancelled states.              |
| S11-T02 | Pause closes admission immediately while preserving safe inspection and unrelated NanoClaw operation. |
| S11-T03 | Restore with mismatched schema/checksum or missing required artifacts cannot enable execution.        |
| S11-T04 | Restored old state cannot re-execute an already-created external action without reconciliation.       |
| S11-T05 | Revocation tombstones survive backup/restore and prevent resurrection of restricted content.          |
| S11-T06 | Export obeys scope, excludes secrets and does not publish to a public/default channel.                |
| S11-T07 | Orphan/lease/schedule recovery preserves stable identities and does not spawn duplicate workers.      |
| S11-T08 | Host/PostgreSQL/connector outages do not silently turn missing knowledge into confident conclusions.  |
| S11-T09 | Global CoS stop affects only CoS-owned execution identities and resources.                            |
| S11-T10 | Upgrade/rollback preserves historical approvals, immutable intents and adapter receipt semantics.     |

## External PostgreSQL requirements for this slice

Separate the external DBA’s server responsibilities from the NanoClaw operator’s client configuration and local runtime backups. Test network failures through a controlled test path, never by stopping the shared database. Reinject credentials through the real service environment during the pre-authorised restart. Restore into a separate external target or the guarded quiesced disposable-runtime target; always isolate local restore roots. Never require a new migration/deployment reviewer.

| ID       | Additional required red → green behaviour                                                                                                                                                                            |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S11-PG01 | Redacted preflight distinguishes network, authentication, TLS, schema and reconciling states without leaking environment values.                                                                                     |
| S11-PG02 | A coordinated remote/local manifest restores to an admitted test target or eligible quiesced disposable runtime; protected runtime content and actual local NanoClaw state are never overwritten by fixture restore. |
| S11-PG03 | Credential rotation uses the standing-authorised service restart, closes old pool connections, validates new access and never forwards either password to an agent.                                                  |
| S11-PG04 | Outage simulation affects only the test route; normal operations never create/stop a PostgreSQL server or manipulate a local database volume.                                                                        |

## Automatic deployment and protected-data closure tests

| ID        | Required red → green behaviour                                                                                                                                             |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S11-OPS01 | The final eligible release migrates/deploys/restarts/verifies on the bound target without another approval; failed health is recovered or reported as a technical blocker. |
| S11-OPS02 | Completion of all implementation/merge gates automatically latches data to protected before valuable data can be admitted.                                                 |
| S11-OPS03 | Reopening a goal, a stale ledger, lost local progress or a restored blank template cannot reactivate runtime-disposable cleanup after closure.                             |
| S11-OPS04 | Disposable-mode cleanup/restore cannot erase identities needed to reconcile real external effects or reset ordinary NanoClaw data.                                         |
| S11-OPS05 | Code review/merge and account/action approvals remain enforced; migration/deployment receipts are evidence, not new approval gates.                                        |

## Final Mac/Pi release and recovery tests

| ID        | Required behaviour                                                                                                                                                      |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S11-REL01 | Final merged source/image identities match the healthy Pi release; the Pi runs when the Mac is offline.                                                                 |
| S11-REL02 | Interrupted staging, load, extraction, migration or restart reconciles the same target release, without builds on the Pi.                                               |
| S11-REL03 | Rollback preserves current NanoClaw messages/sessions and uses only schema-compatible recorded artifacts.                                                               |
| S11-REL04 | Pi-owned lifecycle protection survives a stale/lost Mac ledger, code-directory changes and target restart.                                                              |
| S11-UI01  | Mattermost owner can inspect/cancel/pause via deterministic host controls when model execution is unavailable; private content still fails closed on lost DB authority. |

Restore drills keep local Mac fixtures distinct from protected Pi runtime data. Release archives, Pi data backups and database backups are different artifacts; none substitutes for the other. Record where each was actually created and verified. Retain last-known-good payload/images and target receipts outside disposable CoS records. Do not copy Pi account secrets or real conversation history to the Mac as test data.

## Final acceptance gates

**Code gate:** all slice contracts, relevant legacy regressions, migration tests and selected-runtime isolation tests pass. Every limitation has a recorded owner and operational consequence. No security-critical test is waived because a model's answer looks correct.

**Target deployment gate:** the completed release is installed and healthy on the bound NanoClaw machine using the standing operational authority. Record actual migration/build/service/health receipts. No extra human sign-off is required. Close the disposable lifecycle automatically once all implementation/merge criteria pass, even if an operational repair remains blocked; do not let a deployment delay justify retaining destructive data permissions.

**Pilot gate:** on a small set of explicitly approved real sources, the owner completes a briefing, one delegated mission, one read-only mandate, one strategic review and a backup/restore drill. Evaluate net time saved after supervision, missed commitments, incorrect recommendations, notification noise and cost visibility. These are observed outcomes, not promised targets.

**Write gate:** the separate S09 live action/reconciliation checks pass on a non-sensitive test calendar. Until then, the writer remains disabled. Deployment/restart is already authorised separately from code merge; it is not approval to connect every account or perform an external effect.

## Rollback

Close all CoS admissions, revoke in-flight authority, retain inspection/reconciliation access and preserve state. Restore only through the tested isolated procedure. Never repair the system by clearing the queue, deleting approval/effect receipts or resetting NanoClaw's databases.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S11 --db-profile <selected-profile>` and `pnpm cos:demo --slice S11 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S11.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.

## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.
