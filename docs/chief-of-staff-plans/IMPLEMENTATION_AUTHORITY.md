# Implementation authority: disposable CoS database and automatic deployment

**Contract:** `cos-implementation-authority/v2`  
**Applies to:** the S01–S11 coding goal on the Mac, delivering to the designated Raspberry Pi NanoClaw installation.  
**Authority source:** the owner's standing migration/deployment grant and disposable-data declaration, refined by the requirement to develop/test/build on the Mac and transfer built images to the Pi only after successful local tests.  
**Status:** standing authorisation for the implementing coding agent; no operation is claimed to have run.

## 1. Do the authorised work without another approval

The implementing coding agent is pre-authorised to execute the in-scope operations below. Do not ask for per-operation consent, create an approval card, wait for `migration_approved` or `deployment_approved`, or require the owner to type a confirmation. Automated target, test and health checks still apply. This standing authority is independent of whether a slice PR has been reviewed; it does not authorise merging that PR.

| Operation | Treatment during S01–S11 |
|---|---|
| Inspect the configured CoS database, preflight connectivity and inspect schema state | Run automatically with redacted output. |
| Apply this programme's checked-in, tested `cos` schema migrations on the configured external runtime database | Run automatically using host-provided migration credentials and a bounded migration lock. |
| Run synthetic integration tests and fixture demonstrations | Run automatically against a separate admitted test DB when supplied, or the explicitly selected disposable runtime target under section 4. |
| Deploy a tested slice/release to the designated NanoClaw machine | Run automatically; record the exact source/build identity and service target. |
| Build/test images and pinned dependencies on the Mac; transfer verified artifacts; load/extract/restart on the Pi | Authorised after mandatory local gates. No builds, dependency installs or source fixes on the Pi; no unrelated upgrades or machine reboot. |
| Take host-local protected-state backups, enable the installed CoS module for fixture validation, inspect health, and roll back to the last compatible release | Run as part of the deployment transaction. External account/model/channel activation is not implied. |
| Clean up disposable CoS fixtures or rebuild disposable `cos` objects when a test or failed migration requires it | Only after the target, quiescence and effect-ledger checks below. Never use a reset to hide a failing recovery test. |

A live endpoint is not automatically a production-data endpoint. During this goal, the configured CoS database is a disposable implementation environment even though it is running on the actual remote server.

## 2. Exact scope; other approvals remain

This authority applies only to the CoS database selected by the existing trusted `COS_PG*` configuration and the identified NanoClaw installation/service. Bind the actual service, deployment root, runtime data roots and database target once during S01 preflight; the coding agent records that binding itself using existing configuration. A new manual “approve this binding” step is not required. Validate that subsequent operations still target the same installation and database. An ambiguous or changed target is a real blocker, not a reason to guess.

Existing NanoClaw SQLite databases, messages, provider sessions, credentials, unrelated agent workspaces and other applications are **not** disposable. Take consistent local backups before their schema or deployment compatibility is affected. Necessary additive NanoClaw migrations and normal service restarts are authorised, but must preserve these stores. Drain in-flight work using the installed shutdown path, report the expected service interruption, and verify ordinary chat/service health afterwards. An informational update is not an approval request.

PR review and human merge requirements stay unchanged. Do not merge your own PR or start a dependent slice before its predecessor is verified merged. You may deploy a tested current-slice candidate before review, labelling it unreviewed in the deployment receipt; after merge verify that the deployed content matches the merged release and redeploy when it differs.

This is authority for the **trusted implementation process**, not for the deployed CoS coordinator or specialist containers. Preserve all application-level owner approvals, mission/mandate rules and secret boundaries. No database credential enters an agent container or model context. The Mac implementation process uses its explicitly supplied development/test credentials. The Pi helper invokes narrowly scoped runtime migration/administrative tools with the Pi environment. Do not export Pi secrets to the Mac or delegate either administrative capability to a CoS worker.

No new authority is granted to connect accounts, send real messages, incur model charges not already authorised, create real calendar effects, widen runtime permissions, change TLS policy, open firewalls, administer the remote PostgreSQL server, drop a database or modify other schemas. Existing authorisations for those actions may be reused within their scope; otherwise their existing gates remain. Do not reopen a satisfied authorisation merely because this bundle was revised.

## 3. Automatic Mac-to-Pi delivery cycle

[MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) defines the mandatory cycle. The implementing goal remains on the Mac: edit → local tests → target-platform image build/tests → immutable release → SSH transfer → Pi verification/load/extract → explicit Pi-env migration → service activation/restart → Pi-native smoke checks → compatible rollback or receipt. No candidate-image transfer or deployment before passed mandatory local tests. Read-only target preflight and authorised maintenance coordination for shared-DB local tests can happen earlier.

The host release is an image-carried prebuilt payload extracted for the existing service; workers use matching baked-code images. Package the host/worker code together, remove checkout-source overrides in release mode and disable on-Pi per-group builds. Preserve existing runtime data roots and service identity. The target is not a build worker and does not execute the coding goal.

S01 adds a small checked-in Mac release coordinator and narrowly scoped Pi deployment helper, not a general remote-execution platform. The helper runs under existing verified access, keeps its own deployment lock/receipt and uses the real installed service manager. Stage and verify artifacts before quiescing; drain before affected protected-state backups; run explicit scoped migrations; restart and verify one active runtime. Existing live bot connections remain Pi-only.

On an interrupted SSH session, reconcile by stable release ID from the Pi receipt. On failed health, select only a compatible previous code/image pair; never blindly restore old SQLite over messages accepted after a backup. Data roots, target bindings, lifecycle and credentials are not replaced by artifact extraction. No additional human migration/deployment reviewer is required.

Missing local tools, database/test prerequisites, SSH access, existing privilege, compatible target runtime, a safe drain, or passing tests are genuine blockers. Missing a new operational consent is not. Never change global sandbox rules, grant new machine-wide privilege, ignore host-key failures or move work onto the Pi to get around them.

## 4. Disposable runtime database as a test target

A separate external test database remains useful but is **not mandatory during implementation**. When one is fully configured and reachable, use `--db-profile test` with the protected test-target marker. When it is not configured, the goal may explicitly select `--db-profile runtime-disposable`; this uses the already configured runtime endpoint and logs the selection. There is no silent credential fallback. A partially configured or failing explicit test profile reports its actual error; it must not quietly switch databases.

The Mac test coordinator and Pi helper verify the private target binding, active goal and the Pi-owned `implementation_disposable` lifecycle before allowing this profile. The Mac ledger is not authoritative for target disposal. This owner's instruction is the standing disposal declaration; do not add another environment approval flag or require DBA marker provisioning for the runtime-disposable option. The separate test profile's marker checks remain unchanged. Use server/database identity checks and current TLS validation as well as the configured endpoint; never accept a target supplied by agent-generated content.

Before a Mac-hosted runtime-disposable test, quiesce/fence the Pi CoS through its trusted helper, verify the shared target lease, and use isolated SQLite/artifact roots on the Mac. The tests run locally and connect to remote PostgreSQL. Separate fixture scopes alone do not isolate schema migrations. If a test changes schema incompatibly, do not reopen Pi CoS until compatibility is restored or a locally tested matching release is deployed. Ordinary tests create namespaced fixture scopes and clean only their own rows. Leave the runtime's `cos` schema at the tested release version and reconcile CoS projections before reopening it. Unrelated NanoClaw state is never the fixture database.

A deliberate disposable reset is exceptional, scoped to owned `cos` objects/fixtures and requires no additional human confirmation once these mechanical checks pass. Refuse it while real or uncertain external effects could be replayed, while workers are active, or while protected-state markers exist. Preserve/reconcile any real-effect identities and corresponding native schedule/approval projections before cleanup. Never drop the whole database, alter the protected `cos_admin` marker, touch foreign schemas, or erase the implementation ledger and acceptance receipts. Fault injection affects only the harness connection/proxy, not the database server or LAN firewall.

## 5. End the disposable period automatically

Use a Pi-owned lifecycle record outside PostgreSQL, immutable release payloads and agent mounts; the Mac goal ledger references it. A missing/stale Mac copy cannot initialise or reopen disposal against an already bound Pi. During S01–S11 the state is `implementation_disposable`. It applies to this bound database, not to everything reachable by its login. The agent may initialise this state once from this explicit owner instruction and the active incomplete programme.

After all eleven implementation slices and required alignment changes are verified merged and their mandatory tests pass, switch the Pi lifecycle to `protected` **before** admitting non-disposable data. Confirm the remote latch; loss of target contact leaves completion blocked and must not be recorded as success. Do this automatically; no human sign-off is required to tighten protection. In S11 test the transition and its enforcement. An earlier explicit statement that valuable data has been introduced also closes the disposable period immediately.

The protected state is monotonic for this goal: restarting, losing a ledger, changing a local slice status or installing the blank template cannot reopen disposal. Preserve the closure receipt with the protected local state. If closure/target history cannot be reconciled, treat data as protected, not disposable. Runtime-disposable tests, fixture resets on the runtime DB and in-place runtime restore tests are then refused. Use a separately admitted disposable external test target for further destructive testing.

Routine data-preserving migrations and deployments needed to finish this bound implementation goal do not gain a new human-approval gate merely because protection has switched on. Require protected-data backup/recovery and compatibility checks instead. The grant does not authorise destruction of later valuable data or future unrelated deployments. Goal completion reports the final deployed release, data lifecycle and remaining account/model activation gates without claiming the whole service is fully live.

## GitHub source synchronisation — revision 5

[GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) adds a pinned-source gate to the existing Mac-to-Pi release contract. The Mac authors/tests/builds/pushes; the Pi may fetch and prepare a separate detached checkout of the exact manifest commit without another operational approval. Preserve dirty work and active runtime paths. No automatic pull/merge, source execution, dependency installation, worker code override, runtime-state sync or expanded GitHub privilege is authorised. Source and artifact identities must agree before activation. Human PR merge gates and the existing disposal/secret boundaries remain unchanged.
