# Goal: implement on the Mac and deliver the CoS to the Pi

**Goal ID:** `nanoclaw-chief-of-staff`  
**Plan revision:** 5 — GitHub-pinned source, Mac-built Pi artifacts, external PostgreSQL and Mattermost-first interaction.  
**Repository:** `ufJmacca/nanoclaw`, checked out on the Mac.  
**Status:** goal specification, not evidence of implementation or deployment.

## Objective and completion

Implement S01–S11 as complete vertical slices, using NanoClaw for runtime/messaging and the existing separate LAN PostgreSQL server for CoS records. Develop, test and build on the Mac. Deliver the exact locally tested Linux/ARM64 images to the bound Raspberry Pi, which remains the always-on runtime. Use one dedicated private Mattermost channel as the initial CoS interface.

Maintain one independently reviewable PR per slice and preserve human merge gates. Migrations, image transfer, in-scope Pi deployment/restart/health and compatible rollback are already authorised; do not introduce new operational approval gates. Tested candidates may be deployed before review, with that status explicit.

Completion requires all S01–S11 code and required alignment corrections to have verified reviewed merges; mandatory local unit/integration/runner, final Linux/ARM64 image and actual Pi-native smoke/isolation gates to pass; acceptance and deployment receipts to match the final source/image identities; the final target release to be healthy; and the Pi-owned data lifecycle to be protected. Preserve separate account/model/channel activation status. Missing live account consent does not block a fixture-only deployment, but failed mandatory local tests or Pi deployment are not optional activation.

## Required reading

Read repository-local instructions, then [START HERE](00_START_HERE.md), [baseline](REPOSITORY_BASELINE.md), [architecture](ARCHITECTURE_AND_CONTRACTS.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [GitHub source sync](GITHUB_SOURCE_SYNC.md), [interaction model](INTERACTION_MODEL.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [acceptance matrix](ACCEPTANCE_MATRIX.md), this goal and the current slice/predecessor receipts. Environment examples are placeholders, not installed configuration. No other prior project is assumed available.

## Persistent state and authority

The active coding ledger is `.cos-plan-state/execution.json` in an ignored directory on the Mac. Create it from the template only when absent. Upgrade earlier versions additively to v5, preserving unknown fields, branches, completed work and evidence. Verify claims against Git/PRs and actual receipts. A clean template is never a reason to redo a completed slice.

The Pi owns the deployment lock, installation binding, last-known-good release, deployment receipts, maintenance latch and monotonic disposable/protected lifecycle record, outside resettable PostgreSQL and worker mounts. The Mac ledger stores references and redacted copies, not competing authority. Missing/contradictory target history means no destructive runtime-disposable work. Do not recreate a disposable declaration from a stale Mac ledger.

Use an exclusive Mac goal lock and a distinct Pi deployment/maintenance lock. Shared-database tests require cross-host quiescence/lease checks, not just a Mac filesystem lock. Never steal a live lock or overwrite another process's work. Save atomic checkpoints before pauses, transfers and remote changes. Store private SSH/endpoint configuration separately, not in public receipts.

## Repeating execution loop

1. **Reconcile actual state on the Mac.** Inspect Git, current worktree, HEAD, existing slice PRs/reviews, ledger and plan revision. Verify dependencies are merged. Read-only SSH preflight may identify the bound Pi/service/platform without moving development there. Never reset to the historical reference SHA.
2. **Select one eligible slice.** Resume the earliest unfinished slice or necessary alignment correction, including actual review feedback. No new per-slice instruction is needed. Never start a dependent slice before a legitimate predecessor merge.
3. **Preflight local tooling and data.** Verify the Mac-local Docker builder, Linux/ARM64 capability, test environment and target identity. Use external test DB credentials supplied to Mac processes. If explicitly using the same disposable runtime DB, coordinate Pi CoS quiescence/current lifecycle and an exclusive lease before local tests. Do not export Pi secrets or silently substitute another DB.
4. **Implement on the Mac.** Follow red → green → refactor for the user-visible flow. Add only current-slice state/tools. Preserve native SQLite ownership, ordinary channels and Mattermost restrictions. New host/admin commands are code to build and test, not presumed existing utilities. Do not edit source or install dependencies on the Pi.
5. **Pass local gates.** Run actual slice fixtures, root/runner checks and affected regressions. Build the complete target-native host/agent images and test the final identities locally without checkout overrides. Bind receipts to source/tree/image identities. Missing/failed mandatory checks prohibit transferring candidate images or deploying; do not bypass this to repair a shared-DB schema mismatch.
6. **Release from the Mac.** Push the exact candidate source commit to this fork; preserve its source/tree identity in the manifest. Export the tested images and checksums. Validate SSH target/key, have the Pi fetch and verify that exact commit in a separate detached release-source worktree, and copy the tested bundle to the Pi's staging area. Do not integrate a moving branch into the active checkout. Source sync alone must not activate or restart anything. Use the pre-authorised target helper to verify/load/extract, back up protected local state, invoke the Pi-env migration tool, activate matching host/agent artifacts and restart. The target never builds, pulls mutable application tags or installs dependencies. Record any tested-but-unreviewed candidate accurately.
7. **Verify on the Pi.** Run no-send fixture smoke checks and, where applicable, native isolation checks. Ensure one live runtime, correct data roots, exact release IDs and current remote schema. Reconcile uncertain remote operations by stable release ID. On failure, select a compatible prior release or leave unsafe CoS work closed; do not blindly restore old messages/queues or reset protected stores. No extra consent is needed for these in-scope operations.
8. **Publish and checkpoint.** Include source-push/source-sync status and the exact verified commit/tree. Write sanitised acceptance receipts and update the Mac ledger with separate local-test, image-test, transfer, migration, Pi-smoke and deployment status. Create/update the slice PR. Preserve actual technical failures rather than marking them green.
9. **Observe the human merge gate.** While review is pending, checkpoint `awaiting_review`; respond to actual feedback within the active session. Do not auto-merge, busy-poll indefinitely or claim monitoring after exit. Once a reviewed merge is verified, compare source trees. Build/test a release identified with the actual merged commit on the Mac whenever the source identity changes, verify matching Pi source, and redeploy; advance to the next eligible slice.
10. **Close disposal and complete.** When all implementation/merge gates pass, monotonically protect the database using the Pi's lifecycle record before admitting valuable data. If target contact is unavailable, do not authorise valuable-data admission; retain any already-established maintenance latch and leave goal completion blocked until target protection is confirmed. Do not claim to have remotely stopped or protected a machine that could not be reached. Verify the final release, run programme-wide recovery checks and report remaining separately gated account/model features.

Goal mode supplies continuity, not a promise that a runner keeps executing after it exits. Resume this same objective when the actual coding environment is invoked again.

## Boundaries that must survive the topology change

Only the trusted Mac implementation processes and Pi admin/host processes receive their expressly configured database/deploy credentials. Agent containers receive neither. Ordinary CoS coordination never holds an SSH deployment capability. Runtime Pi secrets remain on the Pi; Mac tests need an intentionally supplied profile, not automatic secret copying.

Do not run the Pi's live Mattermost/Telegram bot identity on the Mac. Use fixture channel/model/connector transports for local tests, with real external PostgreSQL and isolated local SQLite. A separately authorised live development bot must be distinct. Mattermost is the first interface; Telegram is not silently linked or used as a fallback for private approvals.

Keep PostgreSQL on the separate machine. The Pi and Mac do not get a database server. Scope migrations and disposable cleanup to admitted CoS data; preserve actual NanoClaw messages, sessions, credentials, unrelated groups and foreign DB schemas. Dispose only under the current Pi lifecycle/lease checks. Local source tests passing does not excuse missing ARM64 image tests or real Pi isolation evidence.

Keep runtime operator approvals for goals, mandates and concrete external effects. The standing implementation authority does not authorise unrequested account linking, real messages, paid model calls, firewall changes, remote database administration, OS upgrades or new machine-wide privileges. Reuse already satisfied authorisations; do not ask repeatedly for permissions already granted.

## Blocking conditions

| Condition | Correct treatment |
|---|---|
| Local tests or final-image tests fail | Continue fixes on the Mac; no transfer/deploy. |
| Local Docker unavailable or builder points at Pi | Fix existing local configuration within authority or record a tooling blocker; no remote build fallback. |
| Mac test DB credentials absent | Continue safe unit work; database gates remain blocked. Do not pull secrets from the Pi. |
| Shared disposable target cannot be quiesced | No shared-target tests; use a separately admitted test DB when configured. |
| Pi unreachable, wrong host key/target, incompatible ARM64 runtime | Preserve built artifacts and checkpoint; do not guess or rebuild remotely. |
| In-scope migration/deployment is ready | Execute automatically, with local/target checks and receipts; no human operational gate. |
| PR awaiting review | Checkpoint `awaiting_review`; do not advance to its dependent slice. |
| Mattermost/live account not configured | Keep fixture implementation/deployment usable, mark live interface/account pending; do not invent a working connection. |
| Protected lifecycle or unexplained target history | Refuse destructive runtime tests/resets, preserve read-only inspection. |

## Final report

Report merged PRs, local and target test evidence, source/tree and deployed image IDs, actual migration/deployment/recovery receipts, Pi lifecycle state, Mattermost configuration/readiness and outstanding account/model gates. State precisely what works with the Mac offline. No private endpoint, secret, raw environment or real source content belongs in this report.
