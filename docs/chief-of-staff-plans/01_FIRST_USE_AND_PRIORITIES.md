# S01 — Capture direction and answer “what matters?”

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s01-first-use-and-priorities`  
**Depends on:** None; start here after reading the shared documents.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** You approve a small charter, goal and project in your private NanoClaw conversation, then get a persistent, explainable priority brief.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

In a fixture conversation, say: “My goal is to launch a pilot. The active project is Pilot Alpha. Reliability is more important than adding features.” The assistant proposes the exact charter/goal/project changes. The owner approves them through NanoClaw. Ask “What should I focus on?” and receive a grounded response linked to the approved records. Restart the host and ask again: the records survive on the separate database machine and unapproved suggestions have not become priorities. Interrupt only the test database network path, verify an unavailable CoS response alongside working unrelated chat, restore the path and confirm reconciliation without duplicate approved records.

## In scope

A feature-gated CoS host module, private scope binding, minimal PostgreSQL store, safe RPC bridge, owner-confirmed internal record changes and an on-demand context/priority response. Use one persistent coordinator, not workers yet. No source scanning, calendar account, autonomous runs or external writes.

## Execution sequence

1. **Revalidate the checkout on the Mac and read-only target preflight.** Read local repository instructions. Record actual Mac base SHA, existing test results, local builder identity, native module/MCP registration, provider configuration and approval identity path. Through existing verified SSH access discover the Pi service/platform/data roots without editing source there. Do not overwrite uncommitted changes. The bound live CoS database is disposable during this programme and may be used through the guarded `runtime-disposable` profile; existing NanoClaw local state is protected. Preserve the existing deep-research integration.
2. **Connect the smallest operational store to the external server.** Implement the validated `COS_PG*` host-environment adapter and bounded shared `pg` pool from [EXTERNAL_POSTGRES.md](EXTERNAL_POSTGRES.md). Add redacted read-only preflight and explicit `cos:db` migration commands. The operator provides the separately hosted database and runtime/migration roles; do not install a PostgreSQL server, add a database Compose service or create a data volume on NanoClaw. Check the actual server version and scoped privileges. Add only scoped charter revisions, goals, projects, proposals, events, RPC receipts and outbox tables in `cos`. Use checksummed transactional migrations and a bounded lock with an explicit migration login. Startup is a compatibility check, not automatic DDL. The trusted implementation/deployment runner invokes migrations automatically under the standing authority, with no new human review. Handle idle pool errors, queue/connection/query deadlines and uncertain commit acknowledgements without blocking unrelated chat.
3. **Bind the private entry point.** Add an owner-run local setup command that binds one suitable private Mattermost channel and its dedicated CoS coordinator identity. Fixture transport is used on the Mac; real runtime binding is on the Pi. Verify single-operator access and Mattermost rules where applicable. Do not silently repurpose a multi-user or cross-channel shared group. Record a host-only binding and the approved provider profile. Start with approved CoS context only; do not implicitly import existing group/global personal memory or previous conversation histories. Allow shared system boilerplate only after confirming it contains no private cross-scope context.
4. **Build the transport.** Implement `cos-rpc/v1`, `cos_context_get`, `cos_change_propose` and status lookup via existing delivery registration. Add bounded read-only polling of host-owned RPC responses. Enforce schema validation and correlation at both ends. Keep ordinary chat and RPC responses separate.
5. **Implement restricted identity enforcement immediately.** CoS sessions receive no self-mod, arbitrary A2A, generic external credentials or broad host mounts. Reject forged outbound actions at the host even when tools are hidden. Do not permit the CoS profile to fall back to unrestricted execution if PostgreSQL or the module is unavailable. Confirm configuration changes cannot widen the profile from inside the container.
6. **Reuse approvals safely.** Add a backward-compatible, CoS-specific correlated request API to the approvals module. Persist the exact proposal revision before displaying its card. Bind owner identity, scope, expiry and resource version. The callback durably accepts/rejects a proposal before acknowledging the UI row, then a separate transaction applies the approved internal change once. Preserve existing callers and reject forged/expired clicks. Implement recovery for a database commit followed by a lost UI acknowledgement.
7. **Produce useful output.** `cos_context_get` returns approved goals/projects/constraints with provenance and an explicit empty state. Let the model explain suggested attention, but return source IDs and mark the ranking as advice. Add deterministic rendering as a fixture fallback, not fabricated model output.
8. **Add test/demo commands.** Implement the shared `cos:test`, `cos:demo` and `cos:admin` command contracts. Fixture/test commands accept explicit `--db-profile test` or `--db-profile runtime-disposable`; the latter uses the declared-disposable runtime target with lifecycle/target/lock/quiescence checks. Runtime diagnostics and scoped migrations are pre-authorised administrative operations, not new human gates. Missing every eligible target blocks integration acceptance; a missing second database does not. Add `cos:release` and `cos:deploy` with a Mac coordinator and narrow Pi helper per [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md): local tests, immutable Linux/ARM64 host-carrier and agent images, final-image tests without source overrides, SSH archive transfer, verification/extraction, protected-state backup, Pi-env migration, existing-service restart, native smoke and compatible rollback. Implement release-mode asset packaging and disable on-Pi per-group image builds. Keep development bind mounts separate from the release path. The goal records its target binding from existing configuration without another consent prompt.

## First release and interaction acceptance

The first complete S01 outcome includes a **Mac-built, locally tested, Pi-deployed** priority flow, not just a working Mac checkout. Implement and pass S01-REL01–S01-REL12 in [the delivery contract](MAC_TO_PI_DELIVERY.md) and S01-UI01–S01-UI08 in [the interaction contract](INTERACTION_MODEL.md). Map each ID to actual test names and receipts. Code moves through image artifacts; Pi data and credentials do not.

Implement deterministic host-side confirmation/control parsing for the Mattermost baseline when a tested rich callback is unavailable. The preview remains exact owner/private-scope bound and replay-protected. A generic administrator DM, guessed “Approve” button or visual thread is not an approval implementation. Reuse the same durable NanoClaw/CoS approval abstraction for both supported renderings.

## Initial data and tool contracts

`cos_change_propose` accepts one of `charter_revision`, `goal_create`, `project_create` or a versioned edit, a reason and expected resource versions. It cannot directly approve or apply a change. Titles and descriptions are size-limited. Each proposed priority has an origin and an explicit active/inactive state.

`cos_context_get(view='today')` returns the approved charter revision, active goals/projects, source record IDs and coverage warnings. It does not infer commitments from chat in this slice.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S01-T01 | Disabled module starts without PostgreSQL and does not register CoS tools. |
| S01-T02 | A proposed goal is absent from authoritative priorities until the correct owner approves. |
| S01-T03 | Duplicate request/click applies one revision; changed payload with reused ID is rejected. |
| S01-T04 | Spoofed user/scope/session, wrong approver and replayed old ingress cannot authorise a change. |
| S01-T05 | Crash after domain commit and before SQLite response/UI acknowledgement returns the original result. |
| S01-T06 | Stale expected version requires a new proposal and cannot overwrite a later decision. |
| S01-T07 | PostgreSQL outage blocks CoS effects without preventing unrelated NanoClaw conversations. |
| S01-T08 | Forged queue rows invoking native self-mod, create-agent, schedule or another destination are denied for CoS identities. |
| S01-T09 | Protocol mismatch/timeout produces a bounded error or pending receipt, never a false success. |
| S01-T10 | Secrets and real user content are absent from generated config, logs and committed fixtures. |

## External PostgreSQL requirements for this slice

Connection configuration, migration and isolation are part of this first complete flow—not deferred operations work. Package only client-side examples and prerequisites for the external DBA. Strip database variables from existing host-to-provider/helper/container launch paths, including non-CoS agents. No local PostgreSQL or silent profile fallback is allowed. Explicit `runtime-disposable` selection is an authorised profile, not a fallback.

| ID | Additional required red → green behaviour |
|---|---|
| S01-PG01 | Missing/invalid `COS_PG*` values fail closed when enabled; disabled CoS starts without them and no localhost/ambient PG* fallback occurs. |
| S01-PG02 | A separate test target requires its protected marker; runtime-disposable requires its host-bound disposable lifecycle, target lock and quiescence. Protected/unknown/foreign targets are refused for destructive fixtures. |
| S01-PG03 | Valid TLS succeeds; unknown CA, expired certificate, hostname mismatch and unapproved plaintext fail without automatic downgrade. |
| S01-PG04 | Partition, connection refusal, exhausted pool and idle-client errors are bounded and cannot crash or indefinitely block unrelated NanoClaw work. |
| S01-PG05 | Lost commit acknowledgement resolves the original operation once, including a retry racing the original still-completing transaction. |
| S01-PG06 | Synthetic runtime/test/migration passwords and all database configuration are absent from every agent/provider/helper environment, mount, tool result and log. |
| S01-PG07 | The daemon cannot apply DDL; an explicit migration uses a separate role, checksums and bounded lock and leaves unrelated schemas unchanged. |

## Additional implementation-authority tests

| ID | Required red → green behaviour |
|---|---|
| S01-OPS01 | A bound, tested live CoS migration executes without an approval prompt/card and records its checksum/result. |
| S01-OPS02 | A tested candidate deploys/restarts the selected NanoClaw service without another human review; failed health triggers compatible rollback or safely blocked admission. |
| S01-OPS03 | Absent separate test config can use an explicitly selected eligible runtime-disposable profile; partial/invalid config cannot silently switch targets. |
| S01-OPS04 | Deployment preserves protected NanoClaw SQLite/sessions/credentials and rejects foreign targets or agent-originated administrative calls. |
| S01-OPS05 | A protected lifecycle or unresolved real external effect blocks disposable cleanup, even when an old ledger says implementation is incomplete. |

## Acceptance gate

Complete the demonstration through a fixture adapter, real SQLite, a real eligible external PostgreSQL target and the container MCP bridge, with the selected profile recorded. Confirm one unchanged legacy approval flow and one unrelated chat flow still work. A selected-provider live conversation is optional at this stage, but its status must be visible in the receipt. Do not claim the entire running installation was tested from source inspection alone.

## Rollback

Disable new CoS admissions and the feature, retaining all records and restrictive identity markers. Verify ordinary NanoClaw remains operational. No volume removal, full-database reset or protected-state deletion. A scoped disposable CoS reset is allowed only under the implementation-authority checks, not as a substitute for passing recovery tests.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S01 --db-profile <selected-profile>` and `pnpm cos:demo --slice S01 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S01.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

