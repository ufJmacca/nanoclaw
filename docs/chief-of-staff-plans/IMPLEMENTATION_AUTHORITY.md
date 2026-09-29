# Implementation authority and deployment boundaries

**Contract:** `cos-implementation-authority/v2`  
**Plan revision:** 5.  
**Scope:** S01–S11 development on the Mac and delivery to the owner's designated Raspberry Pi NanoClaw installation.  
**Status:** planning documentation for review. Publishing this file does not execute a migration, deployment or implementation task.

## Recorded owner decisions

The owner declared the configured external CoS database disposable until all slices are implemented, and authorised in-scope migrations and deployments on the NanoClaw machine without a separate review for each operation. Development, dependency installation, tests and image builds belong on the Mac. The Pi receives only locally tested release artifacts and performs target verification, scoped migrations, activation, restart and smoke checks.

This approval applies to the identified installation and its owned CoS schema. It is not permission to bypass tool safeguards, operating-system access controls, failing tests, ambiguous targets or unavailable credentials. Those remain real blockers. Human review and merge of each slice PR remain required before dependent implementation begins. The runtime CoS agents do not receive the implementation process's authority.

## Permitted operational scope

| Operation | Conditions |
|---|---|
| Read-only target, connection and schema preflight | Existing access, verified installation/database identity and redacted output. |
| Apply checked-in CoS migrations | Passed mandatory tests, scoped migration role, bounded migration lock and verified target. |
| Build images and package dependencies | Mac-local builder; recorded source commit, lockfiles and Linux/ARM64 verification. |
| Transfer, activate, restart and smoke-test | Exact tested release manifest; protected-state backup and existing service identity preserved. |
| Compatible rollback | Recorded previous release remains compatible with current schema; no blind restoration of old messages. |
| Test and clean synthetic CoS fixtures | Separate admitted test DB, or the guarded disposable-runtime procedure below. |
| Fetch pinned source on the Pi | Existing read access to this fork; separate detached worktree; no activation triggered by fetch. |

The standing operational approval removes an extra migration/deployment approval checkpoint. It does not remove target validation, health tests, compatibility checks, source verification, audit receipts or the human PR merge gate. A tested but unreviewed candidate may be deployed during implementation; its receipt must identify that status.

## Protected resources and credentials

Existing NanoClaw SQLite databases, conversations, sessions, credentials, unrelated workspaces, other applications and foreign database schemas are not disposable. Preserve their paths and identity. Take consistent backups before changes that affect local schema or deployment compatibility; drain affected workloads through the existing shutdown mechanism and check ordinary NanoClaw readiness afterwards.

Mac tooling receives only its explicitly supplied development/test profile. Pi runtime and migration credentials remain in the corresponding trusted Pi process environment. Migration credentials are not retained by the daemon. Neither database nor deployment credentials enter worker containers, models, images, shared provider state, Git or public receipts.

Account linking, real messages, paid model calls, real calendar effects, wider source/model permissions, TLS changes, firewall changes, remote database administration, OS upgrades, new machine-wide privileges and unrelated deployments are outside this operational grant unless separately authorised. Reuse an existing valid approval within its scope, without treating it as general authority.

## Automatic release procedure

Follow [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) and [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md): identify the clean source commit; test locally; build and test final Linux/ARM64 host/worker artifacts; push the exact source; verify the Pi's pinned source checkout; transfer the tested bundle; verify/load/extract; back up protected local state; run packaged migrations with the Pi environment; activate the matching host/worker release; restart; run native smoke checks; record health or select a compatible prior release.

Source fetch, staging and image loading do not themselves activate a release. The target helper is a narrow, versioned deployment utility, not arbitrary remote execution. Its first installation must come from a tested, hashed artifact using existing target access. The Pi has its own deployment lock and receipt, independent of the Mac goal lock. Shared-database tests also require cross-host maintenance coordination.

On SSH loss, query the same release receipt instead of repeating uncertain operations. On failure, keep unsafe CoS admissions closed. Prefer compatible code rollback or a tested roll-forward repair; do not restore old SQLite over newer conversations, reset queues, rebuild on the Pi or broaden permissions. Save a redacted receipt outside disposable storage containing target fingerprint, source/tree/image identity, migration checksums, schema versions, health and rollback outcome.

## Disposable runtime database tests

A separate external test database is preferred but optional during implementation. A fully configured test profile uses its protected target marker. Otherwise the goal may explicitly select `runtime-disposable`; a partially configured or failing selected profile reports its error instead of silently switching targets.

Verify the bound installation/database, current Pi-owned lifecycle record, active programme, target lease and quiescence. The owner decision above supplies the disposal declaration; it does not require another DBA marker for this runtime-disposable option. Existing separate-test marker checks remain mandatory.

Before shared-target tests run on the Mac, close Pi CoS admission, fence/drain its workers, obtain exclusive target access, and use isolated Mac SQLite/artifact roots. Fixture scopes do not isolate schema changes. If a test leaves a schema incompatible with the current Pi release, keep Pi CoS paused until compatibility is restored or a locally tested matching release is deployed. A failed local suite never justifies deploying a failing candidate.

Routine cleanup removes only that test's owned rows/artifacts. A scoped rebuild of disposable CoS objects is exceptional: it requires verified disposal, no active worker, no protected marker and no real or uncertain effect that could be replayed. Preserve effect identities, native approval/schedule projections and implementation receipts. Never drop the database, change foreign schemas, erase the goal ledger or use a reset to hide a failed recovery test. Fault injection targets only the harness connection/proxy, not the server or LAN firewall.

## End of the disposable period

The Pi owns a lifecycle record outside PostgreSQL, release payloads and agent mounts. The Mac ledger references it. A missing/stale Mac copy cannot recreate disposal for a previously bound target. Initial binding may record `implementation_disposable` from the owner's explicit decision while the programme is incomplete.

When all eleven slices and necessary alignment changes have passed mandatory implementation tests and verified human merges, set the Pi lifecycle to `protected` before admitting valuable data. This tightening happens automatically. An earlier owner statement that valuable data has been introduced closes disposal immediately. If the target cannot be reached, record the blocker rather than claiming protection was applied.

Protection is monotonic for this programme: restart, code rollback, lost ledger or an empty template cannot reopen disposal. Uncertain target history is treated as protected. After closure, runtime-disposable tests and resets are refused; further destructive tests require a separate admitted external target.

Data-preserving migrations and deployments needed to finish the bound programme remain operationally authorised after protection closes, subject to protected-data backups and compatibility checks. This does not authorise destruction of later valuable data or future unrelated deployments.

## Review and adoption

One independently reviewable PR per slice remains the delivery unit. Preserve existing work, current main and prior receipts. Record implementation, tested candidate, merged release, deployed release and account activation separately. These plans are documentation; their acceptance does not imply that the proposed `cos:*` commands, target helper or CoS runtime features already exist.
