# Goal: deliver Google mail, Calendar and encrypted storage

- **Goal ID:** `nanoclaw-google-mail-storage`
- **Contract:** `cos-google-mail-storage-goal/v1`
- **Plan revision:** 1
- **Repository:** `ufJmacca/nanoclaw`, implemented from the Mac
- **Status:** execution specification; no G01–G07 slice is claimed implemented by this document.

## Objective and completion

Complete G01–G07 in [the agreed plan](GOOGLE_MAIL_AND_STORAGE.md) as reviewed vertical slices, with exact Mac-tested Linux/ARM64 delivery to the existing Pi installation. Preserve the completed S01–S11 programme, protected data, ordinary NanoClaw messaging and shared sign-ins.

Completion requires each slice's legitimate human-reviewed merge, passing required local and final-image tests, verified pinned source/artifact deployment, actual Pi health/isolation evidence and its acceptance receipt. Verify the live Gmail reader, Calendar reader, saved reply drafts, both Sydney-time schedules, encrypted remote backups and isolated recovery checks. Deployment or fixtures alone do not establish live account functionality.

## Required reading and precedence

Read repository-local instructions and the following contracts before selecting work:

- [Google mail and storage plan](GOOGLE_MAIL_AND_STORAGE.md), this goal and the current slice/predecessor receipts.
- [Original programme goal](GOAL.md) and [implementation authority](IMPLEMENTATION_AUTHORITY.md), as historical/standing contracts without reopening the completed programme or its former disposal authority.
- [Architecture and contracts](ARCHITECTURE_AND_CONTRACTS.md), [interaction model](INTERACTION_MODEL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [GitHub source sync](GITHUB_SOURCE_SYNC.md), [external PostgreSQL](EXTERNAL_POSTGRES.md) and [acceptance matrix](ACCEPTANCE_MATRIX.md).
- [Subscription runtime](SUBSCRIPTION_CODEX_RUNTIME.md) and [runtime decision](SUBSCRIPTION_RUNTIME_DECISION.md).
- [Calendar implementation](../chief-of-staff/CALENDAR.md), [Calendar operations](../chief-of-staff/CALENDAR_OPERATIONS.md), [Calendar action operations](../chief-of-staff/CALENDAR_ACTION_OPERATIONS.md), and [operations and recovery](../chief-of-staff/OPERATIONS_AND_RECOVERY.md).

Owner instructions and this extension's explicit decisions control conflicts. In particular, the runtime database is protected, new Google/backup credentials use the vault, and saved Gmail drafts have standing owner authority rather than individual action approval. These exceptions do not remove other approval, secret, context, deployment or recovery boundaries.

Treat old runbook descriptions of a paused/unlinked CoS or expired earlier test allowance as historical. Revalidate current state using private ledgers, host tools and installed authoritative receipts. Do not infer active account access from a document header or working chat connectivity.

## Scoped implementation authority

This grant belongs to the trusted implementing process and installed administration helpers. It does not give the deployed coordinator or specialist workers SSH, OS administration, NAS administration or database migration capability.

The owner starts the implementation programme by invoking this goal. Publishing these documents does not itself start G01 or provision any resource.

After required tests, target checks and locks pass, execute these operations without routine confirmation:

| Operation                           | Bounded authority                                                                                                                                                                                                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Readiness and source reconciliation | Inspect the existing Pi, configured NAS, fork, PRs, selected databases, service identities and private receipts with redacted output.                                                                                                                                                     |
| Local vault setup                   | Allocate the programme's new 1 GiB LUKS2/ext4 volume; configure its protected keys, fixed mounts/bind mounts and scoped service/process memory protections. Never format existing partitions, change global swap or expand machine-wide privilege.                                        |
| OS storage prerequisites            | Install only compatible pinned `cryptsetup-bin` and `cifs-utils` utilities when needed, and verify their recorded versions. No OS upgrade, reboot, project dependency install or source build on the Pi.                                                                                  |
| Dedicated NAS resources             | Create the named non-admin CoS account, private share and scoped access rules using the existing trusted administrative access. Preserve all other users, shares, global SMB/NFS/home settings, Omi backups and unrelated workloads. Credentials use trusted private entry/storage paths. |
| Backups and recovery checks         | Configure the plan's encrypted repository, bounded queues, checkpoint/credential schedules, retention and integrity checks. Perform consistent captures and isolated restore checks. Restic is a pinned Mac-tested artifact; no application compilation occurs on the NAS or Pi.          |
| Database and deployment             | Apply checked-in scoped additive migrations with selected trusted migration credentials; transfer, verify/load/extract matching tested artifacts; restart the bound service; run health/isolation checks; select a compatible rollback if needed.                                         |
| Cleanup                             | Retire only this programme's verified completed temporary staging/test artifacts under its retention rules and locks. Do not clear original evidence, private ledgers, shared credentials, valuable records or unrelated storage.                                                         |

The grant does not authorise global NAS protocol upgrades, enabling NFS, firewall changes, certificate-verification bypasses, remote database-server administration, dropping a database, destructive runtime tests or general remote command execution.

Human PR review/merge remains a gate. Candidates may be deployed before review when all required tests pass, with their unreviewed status explicit. Reconcile the actual reviewed merge and produce its matching tested release before beginning dependent work. Do not auto-merge or manufacture review evidence.

## Account, model and message authority

The selected owner behaviour is read access to Inbox/Sent, read-only selected Calendar access, reply drafts saved without individual approval, and daily reviews at 08:00/15:00 Australia/Sydney with at most five new drafts per day. Persist that standing policy through the existing owner-bound setup path. Calendar writes and email sending are not authorised.

Google account use requires the real owner's OAuth consent and Workspace app permissions. The owner selects the intended mailbox/account and Calendar IDs. Provide the disclosure of source use by CoS, its Codex runtime, the private Mattermost briefing surface and encrypted backups. Verify the applicable model data controls before sending live Google content to inference. These are actual account prerequisites, not new per-draft gates.

Use the existing Codex subscription runtime and whatever owner-issued allowance is currently valid. Verify its account binding, model, remaining attempts and expiry privately. Do not renew, extend or reset it, change billing method, or substitute an API key. Every live attempt and retry consumes the existing allowance; a reviewed slice or restart does not create more budget.

The live demonstrations and ongoing reviews are limited to the verified existing private CoS channel, selected accounts, plan's read/draft capabilities and valid model allowance. Use owner-designated test mail/Calendar content for live acceptance. The implementation agent does not send email, invite attendees, post to another channel or exercise unrelated account permissions. Local transports and models remain fixtures; do not run a competing live bot on the Mac.

Keep the main CoS AgentGroup/context across ordinary channel messages and visual reply threads. Only specialists have their own contexts, with explicitly authorised source manifests; they cannot save drafts or directly publish to Mattermost. Existing source withdrawal and tool-catalogue recovery procedures may renew the main context safely but must preserve consumed allowance and original authority boundaries.

## Persistent state and reconciliation

Use `.cos-plan-state/google-mail-storage-execution.json` for this goal. Create it only when absent; otherwise upgrade it additively, preserving unknown fields and actual progress. Never replace `.cos-plan-state/execution.json`, erase S01–S11 evidence, reopen a protected lifecycle or reset the Pi from a planning template.

The extension ledger records plan revision/published specification commit, current worktree/branch, each slice's source/tree and PR/review/merge identities, test/build evidence, target release/artifact/schema identities, account and live-test prerequisites, acceptance references and precise blockers. Store private endpoint/credential references separately, not secret values in the ledger.

Track each slice's states separately: local tests, final-image tests, source push, target source verification, transfer, migration, deployment, Pi checks, fixture demonstration, live demonstration, review and merged-release reconciliation. A failed or pending gate stays failed or pending. Use `awaiting_review` for a review gate and record its PR and dependency; do not infer a merge from an owner comment without checking GitHub.

Write sanitized public receipts at `docs/chief-of-staff/evidence/G01.md` through `G07.md`. They contain checks, source/artifact identities, results and limitations, not live email/event bodies, private endpoints/paths, account identifiers or credential material.

Acquire an exclusive Mac programme lock and reuse the existing Pi deployment/maintenance and host-execution lease contracts. NAS repository writers and retention operations also need the repository's lock. Never steal a live lock or let a restored lease become authority. Checkpoint atomically before review waits, transfers and remote mutations. The Pi remains authoritative for installed bindings, lifecycle, deployment receipts, maintenance and independent effect/revocation journals.

## Repeating execution loop

Apply the [iteration procedure](#iteration-procedure) during each correction. It separates debugging from release acceptance; all existing deployment, recovery and review gates still apply.

1. Reconcile the current checkout, published specification, fork, PRs, reviews, merges, original/extension ledgers and actual Pi receipts. Preserve uncommitted work and select the earliest eligible unfinished slice or necessary correction.
2. Verify the Mac devcontainer and local Docker builder, Linux/ARM64 support, test profile and bound targets. Use host tools for GitHub, Docker, SSH and credentials. Resolve certificates correctly inside containers; never dump or forward the whole `.env`.
3. Implement on the Mac using red → green → refactor and small commits. Source development, project dependencies, tooling and builds stay in the devcontainer. New helpers, schemas and commands are implementation work, not assumed installed facilities.
4. Run the slice's real fixtures, integration/contract tests and affected regressions. Use the admitted separate `COS_TEST_PG*` database and isolated SQLite/artifact roots. Runtime is permanently protected for this programme; there is no runtime-disposable fallback. Supply each trusted test/admin process only its selected profile.
5. Build and test the final immutable Linux/ARM64 host/worker/helper artifacts locally without checkout-source overrides. Bind receipts to exact source/tree/tool/image identities. Missing or failed mandatory tests prohibit candidate transfer/deployment.
6. Push the exact candidate source to the fork. Follow the existing pinned-source contract: Pi fetch into a clean detached release-source worktree and verify commit/tree against the tested manifest. Fetching alone cannot activate a release. Transfer and verify only the tested bundle; do not build/fix source on the Pi or pull mutable application tags.
7. Stage before quiescing. Drain the bound service, capture affected protected state, apply scoped migrations and activate/restart the matching artifacts with the existing helper and trusted Pi credentials. Report the expected interruption. Preserve messages, sessions, shared sign-ins and unrelated workloads. Google credential and backup staging must satisfy the new encryption checks.
8. Verify one healthy runtime, correct data roots/schema/images/source and ordinary chat health. Run installed no-send/native isolation checks. Live demonstrations require current account/channel/model authority. Reconcile interrupted operations by stable IDs; uncertain drafts must not be replayed.
9. Update the private ledger, sanitized receipt and slice PR. Stop dependent work at a legitimate review gate. After an actual reviewed merge, compare source/tree identity, build/test the merged-source release on the Mac, verify/redeploy it as required by the release contract, and advance to the next eligible slice.
10. After all slices are reviewed and reconciled, run G07's combined operating/recovery checks. Verify current data remains protected and the final release is healthy. Report live capabilities and outstanding prerequisites accurately; only then mark the goal complete.

## Iteration procedure

### Debug before building a release

For each failed attempt, record the failing stage, its actual error, the current installed release and whether recovery is complete. Identify one testable cause and the smallest experiment that distinguishes it from competing explanations. Reconcile uncertain target state before any further target mutation.

Reproduce the failure in the Mac devcontainer with isolated fixtures. Show the regression failing before the fix, then passing with the fix. During editing, run that regression and affected tests; start the full release cycle only after those pass. If a failure cannot be reproduced locally, record the missing target condition and use a bounded, authorised diagnostic to establish it. A diagnostic pass does not erase a failed deployment receipt.

For startup and worker-lifecycle failures, exercise the interacting components together: startup cleanup, health-probe ownership, worker communication and teardown. A probe passing alone does not establish that it survives concurrent startup cleanup. Use deterministic coordination where possible rather than longer sleeps or repeated deployment attempts.

### Validate once per exact candidate

Before a full release, record the regression evidence, affected-test results and any unresolved deployment assumptions. Verify Docker readiness and read-only Mac/Pi capacity early enough to avoid discovering predictable capacity failures after a long build. Preserve the existing staging capacity checks and cleanup authority.

Run every required source and immutable-image gate for the committed candidate. Once a complete bundle passes, continue source verification, staging and deployment with that exact tested bundle. Do not start a fresh release merely because a tool session ended, a local protection lease expired or an external service recovered. Revalidate the existing identities and reconcile the operation through supported paths. Fresh leases never revive expired remote authority.

Reuse evidence only for its recorded source, inputs and image identities. Source or build-input changes require a new candidate and all mandatory acceptance checks. Never copy successful receipts onto another release, relabel images, bypass a gate, or retry a terminal deployment operation. Resume only when the existing helper supports it; otherwise preserve the failure and use the normal new-operation path.

### Measure and simplify orchestration

Record UTC start/end times, elapsed time, outcome and evidence references for focused tests, full source tests, image builds, immutable-image tests, export, transfer, activation, health checks and recovery. Summarise each attempt in one row in the private extension ledger, referencing existing logs instead of duplicating them. Keep source commits, release attempts and live model attempts as separate counts.

After a failed release, report what was learned, which next test will resolve the cause and the measured slowest stage. If the same failure recurs without new evidence, stop deployment retries and improve the reproduction. A focused loop exceeding 15 minutes should trigger a check for setup overhead, an unnecessarily broad test selection or an unbounded operation; this is a diagnostic target, not a timeout that weakens a required check.

Prefer the checked-in release/deployment runners and their stable operation records. Add repeated orchestration to those runners through tested changes rather than creating another copied controller for each attempt. Preserve required atomic checkpoints, original failure records, locks and authority checks. Do not run competing release writers or change an in-flight controller.

### Tooling improvements still require implementation

This procedure does not claim that a deployment rehearsal, automatic per-stage timing or a general resumable runner already exists. Implement these as small tested changes, using the existing slice PR where appropriate:

1. Add the deterministic regression for the current startup-cleanup/health-probe interaction and fix its cause.
2. Extend the local lifecycle fixture to rehearse startup, cleanup, health failure and rollback with synthetic state. Verify both worker profiles where affected. Actual Pi acceptance remains mandatory.
3. Add stage timing to the existing runner, then use measurements to select the next optimisation. Consolidate repeated continuation logic only after tests prove identity validation, failure preservation, lease handling and rejection of terminal-operation replay.

Adopt this procedure in the active implementation chat at its next safe checkpoint. Repository edits alone do not establish that an already-running chat has read them. Preserve its in-progress regression and current recovery work; do not interrupt an activation or recovery to change process.

## Acceptance and blocking conditions

The per-slice acceptance cases in [the plan](GOOGLE_MAIL_AND_STORAGE.md) are mandatory. Regress the relevant existing source revocation, native routing, main-context isolation, Calendar approval, subscription-budget, protected-state recovery and ordinary NanoClaw contracts when they are affected. Do not substitute mocked-only evidence for final-image or actual Pi checks.

| Condition                                                          | Required treatment                                                                                                                                                  |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Local or final-artifact check fails                                | Fix and retest on the Mac; no candidate transfer/deployment.                                                                                                        |
| Vault, staging or repository capacity/proof fails                  | Deny unsafe credential/backup operations; report the exact failure. No plaintext or unrelated-data cleanup fallback.                                                |
| NAS unavailable                                                    | Keep Google operations independent of the NAS, retain bounded encrypted pending work and expose backup age/backlog. Do not claim a successful remote checkpoint.    |
| NAS scope/signing/restic compatibility fails                       | Continue eligible local work; no global NAS reconfiguration or admin-account runtime fallback.                                                                      |
| Google consent, account selection or data-control evidence missing | Continue fixture implementation/deployment where eligible; leave live source/model use closed and record the specific prerequisite.                                 |
| Current model allowance expired/exhausted                          | No live inference or automated draft preparation. Preserve spent counters; continue eligible fixture/operational work and request a new allowance only when needed. |
| Test profile missing/failing or target marker/TLS invalid          | No integration/restore admission and no runtime fallback. Preserve the actual error.                                                                                |
| Pi identity, host trust, maintenance or health uncertain           | Reconcile read-only evidence and stable operation IDs; do not guess, overwrite data or repair source remotely.                                                      |
| Slice PR awaiting review                                           | Checkpoint `awaiting_review`; do not start its dependent slice, auto-merge or claim unattended monitoring.                                                          |

Goal continuity does not promise execution after the runner exits. Resume from actual stored state when invoked again; create future monitoring only if the owner explicitly requests it.

## Bootstrap prompt

Open this checkout on the Mac and use the installed goal interface with the following prompt. It starts the implementation programme, not a new publication task.

```text
/goal Complete the NanoClaw Google mail, Calendar and encrypted-storage programme, G01–G07, as defined in /Users/jonmcmillin/nanoclaw/docs/chief-of-staff-plans/GOOGLE_MAIL_AND_STORAGE.md and GOOGLE_MAIL_AND_STORAGE_GOAL.md.

Begin implementation now. Read repository instructions, both programme documents, and the existing architecture, implementation-authority, Mac-to-Pi delivery, GitHub source-sync, interaction, external-PostgreSQL, Calendar, subscription-runtime and recovery contracts.

Reconcile the checkout, GitHub PRs, reviewed merges, acceptance receipts, private ledgers and installed Pi release. Preserve completed S01–S11 progress. Maintain a separate private G01–G07 execution ledger and resume the earliest eligible unfinished slice.

Implement every slice as a complete vertical outcome using red → green → refactor, small reviewable commits and one PR per slice. Complete its tests, demonstration, deployment evidence and sanitized receipt. Do not auto-merge or start a dependent slice before its predecessor has a legitimate human-reviewed merge. Reconcile and verify the actual merged-source release before advancing.

Use the Mac devcontainer for project dependencies and tooling. Use host tools for GitHub, Docker, SSH and credentials. Develop, build and test on the Mac. Deploy only exact tested Linux/ARM64 artifacts to the verified Pi. Never build or fix source there.

The programme's bounded vault provisioning, required OS storage utilities, dedicated NAS account/share, scoped migrations, compatible deployments, service restarts, backups, health checks and rollbacks are authorised after their required checks. Preserve ordinary NanoClaw messages, sessions, shared sign-ins and unrelated workloads. Do not introduce routine confirmation gates.

Encrypt new Google and backup credentials in the automatically unlocked local vault. Use the same NAS identified through Omi's private SSH configuration, with a separate non-admin CoS account and share. Keep all secrets and recovery material out of Git, logs, model context and agent containers. Never forward the whole repository .env.

Use the separate admitted COS_TEST_PG database for integration and restore tests. Treat the runtime database as protected. Never reset it or restore old state over current messages, revocations, independent effect journals or model counters.

Deliver Inbox/Sent reading, reply drafts saved directly in Gmail, read-only selected Calendar access, and reviews at 08:00 and 15:00 daily in Australia/Sydney, capped at five new drafts per day. Individual draft saves need no approval. The human reviews and sends in Gmail; sending email remains prohibited.

Use the existing NanoClaw Codex subscription runtime, CoS Mattermost channel and persistent main context. Only specialists have separate contexts. Preserve the currently valid model allowance and verify its remaining attempts and expiry; never replenish or extend it implicitly.

Use fixtures locally. Obtain required Google owner consent through the trusted setup workflow, verify applicable model data controls, and perform the plan's bounded live demonstrations only within valid account, channel and model authority.

Continue through authorised, unblocked work. At a genuine blocker or review gate, record exact progress, evidence and what is needed next. Mark the programme complete only after all G01–G07 reviewed merges, required tests, live demonstrations, deployment checks, encrypted backups and isolated recovery checks have passed.
```
