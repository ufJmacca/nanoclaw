# Mac release and Pi delivery

Run the host wrappers from the Mac checkout. They use the running repository devcontainer for project tools and the host's Docker, GitHub and SSH tools. They never install project dependencies on the Mac or build application code on the Pi.

```sh
bash scripts/cos-release.sh --slice S04 --target pi --db-profile test --local-only
bash scripts/cos-deploy.sh status --target pi
bash scripts/cos-deploy.sh --target pi --release-manifest /absolute/checkout/.cos-plan-state/releases/release-…/release.json
bash scripts/cos-deploy.sh rollback --target pi --release-id release-…
```

The equivalent package commands are `cos:release` and `cos:deploy`. The default development service is Compose project `nanoclaw-cos`, service `devcontainer`; `COS_DEVCONTAINER_ID` can identify the same running repository container. The release command requires a clean committed candidate, the existing private execution ledger and `.cos-plan-state/deployment-target.json`. It selects only the `COS_TEST_PG*` connection fields and protected test marker from the private `.env`. It copies the selected CA certificate into a private test directory, outside the build context and release archive.

Local checks precede all candidate transfers. The command builds and tests the host, standard Codex worker and document-enabled Codex worker as Linux/ARM64 images. Existing Pi provider/package profiles are checked again before activation; unsupported profiles block deployment. No live bot or paid provider credentials enter these tests. The saved archive must contain the exact tested image identities and independently hashed configuration bytes.

Delivery pushes the tested source commit, verifies its detached Pi source checkout, transfers the archive and uses the tested packaged helper to load and activate it. The existing service briefly stops for consistent protected-state backups and scoped migrations. The helper preserves data roots and requires service, database, worker RPC, provider-fixture and isolation health checks before reopening eligible work. The coordinator records separate local, source, transfer and deployment checkpoints without claiming a reviewed merge.

After an interrupted delivery, rerun `cos:deploy` with the same manifest. The Pi reconciles the durable release receipt and maintenance lease. Do not delete locks, replace target history, or create a new disposable declaration to bypass an uncertain operation. Explicit rollback uses the current release's recorded compatible predecessor, preserves database contents, and leaves CoS paused. It does not reinstall dependencies or restore an old SQLite backup over newer messages.

For a recorded activation or health failure after migration, a retry first attempts compatible rollback. If no compatible rollback succeeds, it can retry the same tested candidate: stop and verify the service/owned workers again under the original lease, then recheck artifacts and schema before activation and health. Migration and backup phases are not repeated. The receipt counts activation retries; failed health remains recorded as `health_failed`. Changed source or manifest evidence is rejected.

If a source correction is needed, build and pass the full release checks on the Mac with `--local-only`, then deliver that new manifest with the exact failed release ID:

```sh
bash scripts/cos-deploy.sh --target pi --release-manifest /absolute/checkout/.cos-plan-state/releases/release-NEW/release.json --recover-from release-FAILED
```

Repeat the same manifest and `--recover-from` on an interrupted retry. Recovery requires a recorded failure after completed migration, the same target binding and an intact deployment lease. It refuses healthy releases, uncertain migrations, runtime-test leases, foreign targets and a handoff already reserved for another successor. Read-only release preflight can inspect a stopped service only when the target already records closed maintenance authority. New source, images and normal local evidence still precede transfer.

The target verifies the failed manifest and replacement's schema compatibility, stops the service/owned workers, and retains a baseline that does not require a running process. It marks the old receipt `superseded`, reserves the replacement in Pi-owned state, closes the old lease without opening admission, and starts a new lease for the replacement. A competing current-helper operation cannot claim the interval between leases. Interrupted receipt/state writes reconcile the same successor. A failed corrective candidate can itself be replaced through this path. Old receipts, artifacts and backups remain; no native database restore or PostgreSQL reset occurs.

The replacement takes its own protected-state backup and passes the normal migration, activation and health checks. Its failed predecessor is never treated as a known-good rollback target. Once the replacement is healthy, a later ordinary release can record it as a compatible predecessor. Recovery does not replenish or resume model consent. Deployment-failure recovery has local fixture evidence. Guarded context recovery and the native transition to a fresh tool catalogue pass packaged-image and Pi fixtures; these use synthetic histories. The candidate deployment did not deliberately fail the live service after migration.

Prefer `--db-profile test`. Explicit `--db-profile runtime-disposable` requires an already installed CoS helper and a Pi-owned disposable lifecycle record; it refuses an unbound or protected target. It selects only the Mac's `COS_PG*` runtime and migration settings. An authenticated live SSH session holds the Pi operation lock while the Mac fixture driver holds the database fence. Each database admission checks the live session. Connection loss stops the owned fixture processes and leaves CoS paused; ordinary NanoClaw service processes remain running. First delivery uses the separate test database.

Private test logs and receipts remain under `.cos-plan-state`; only sanitised acceptance evidence belongs in Git. Runtime fixture retries must retain the same owner, source, image, slice and request identity. A completed Pi receipt can reconcile a lost final reply only when the matching Mac receipt proves fixtures passed. Historical requests without a slice retain their original S01 meaning and receipt identity. See the acceptance receipts for actual deployment status.

## S04 brief and commitment delivery

New release construction selects S04, PostgreSQL schema 6 and SQLite contract 22. It requires S03's reviewed merge and verified delivery of that exact merged source. The manifest pins all six migration checksums; historical S01–S03 release identities remain readable under their own schema contracts. See [S04 evidence](evidence/S04.md) and [briefs and commitments](BRIEFS_AND_COMMITMENTS.md) for implementation, testing and live prerequisites.

Migrations 4–6 add confirmed work and immutable revisions, approved schedules, stable briefing runs, notification intents and budget reservations. The schema-3 S03 release is incompatible after these migrations. Refuse incompatible rollback, preserve maintenance and pause on unresolved failure, and use tested schema-compatible recovery code. Deployment does not approve a schedule, resume CoS, connect an account or extend model consent.

## S03 calendar delivery

S03 release construction selected PostgreSQL schema 3 and SQLite contract 22 after S02's reviewed merge and verified delivery of that exact merged source. Its manifest carries the three pinned migration checksums. See [S03 evidence](evidence/S03.md) for the reviewed merged deployment and recovery observations, and [calendar operations](CALENDAR_OPERATIONS.md) for optional account setup.

Calendar access remains disabled until separately configured. Calendar credentials and denial journals, when present, require verified encrypted storage and protected backups. Deployment does not link an account or activate a model. After schema 3 is installed, S02 is not a compatible rollback; preserve closed admission on an unresolved failure and use tested compatible code.

## S02 knowledge configuration

The historical S02 host required PostgreSQL schema 2 and checked its recorded checksums at startup. The current S04 host requires schema 6. Startup never migrates the database. The knowledge controls below remain available in S04.

S02 was human-merged and its exact merged source was tested and delivered before S03 began; see [S02 evidence](evidence/S02.md). Once schema 2 was installed, the old S01 manifest became incompatible. Listing a release as an upgrade predecessor does not make it a valid rollback target. Preserve a failed deployment's receipt and maintenance lease; do not reset the database or clear the lease to force a retry.

The trusted host runtime environment accepts `COS_KNOWLEDGE_ENABLED=true` to enable selected-source ingestion and retrieval. Its default is `false`. `COS_KNOWLEDGE_RETENTION_DAYS` is an integer from 0 through 365, defaulting to 30; approved deletion records its deadline when applied. Keep both settings in the host's scoped runtime environment, and restart the host to apply changes through the normal deployment/operational checks. No agent receives these settings or database credentials.

The authenticated target state root owns `knowledge/artifacts` and `knowledge/staging`. The host creates these private directories outside Git, the installation and native data roots. It refuses symlinks, permissive paths and unowned existing content. Neither directory is mounted in a worker. Imports select an individual staged file through the owner administration path; adding a file to staging alone does not admit it.

Use the knowledge switch to disable ingestion/retrieval while keeping the CoS host enabled. Current-policy checks, revocation, quarantine and due deletion remain active. Stored replies with source dependencies cannot be redisplayed while retrieval is disabled. A context previously exposed to sources remains fenced; disabling retrieval does not erase that history or reset model consent. Approved-priority replies work in a clean context.

The guarded `context-recover` owner command rebuilds the same CoS AgentGroup's context after verified quiescence, private membership and protected backup. It quarantines stale pending input/output and gives the runner an empty provider history and a new continuation key. It does not replay the old discussion. Subsequent answers must retrieve current approved records and permitted sources again.

An S01 native conversation retains its original three-tool catalogue on resume. Before an S02 live walkthrough, use the guarded recovery path to create the current eight-tool context; ordinary restart alone does not refresh that catalogue. Candidate deployment preserved the original conversation and left CoS paused with knowledge disabled. Enabling knowledge and admitting selected notes does not itself authorize a model turn; the completed S01 test allowance cannot be reused.

Recovery can carry an already-issued, unexpired allowance into that replacement context. Only the context generation changes: activation ID, account, model, consent reference, expiry, maximum attempts and all charged usage remain unchanged. Missing, expired or exhausted consent is not transferred. A private journal reconciles interrupted updates without replenishing usage. Recovery always leaves CoS paused; the separate guarded resume operation remains necessary. This code path performs no model call or message send, and it does not reactivate the completed S01 live-test allowance.

Recovery retains old provider history until an approved source-deletion deadline and the guarded retention consumer permit removal. Protected recovery backups have a separate retention boundary; context recovery alone is not proof of byte erasure.

### Owner source management in S02 source

Use the deployed S02 administration entry with the existing target maintenance lease, stopped service/owned workers, paused CoS binding and verified private membership. The command acquires the target and host execution locks, validates the bound database/schema and derives owner/session/group identity from the binding. It does not activate a model. Package-command examples below refer to tooling in the Mac devcontainer. On the Pi, invoke the activated payload's `dist/modules/chief-of-staff/ops/admin.js` using its packaged `node/bin/node` and trusted host environment; do not install dependencies or run development tooling there.

Place only an explicitly selected UTF-8 `.md` or `.txt` file in the target's private `knowledge/staging` directory, mode `0600`. Write a separate private JSON manifest with `sourceKey`, `filename` (one flat filename), `title`, `processingProviders` (for example `["codex"]`), and `expectedVersion` (`0` for a new source; the current inventory version for a correction). An optional `projectId` must refer to an existing approved project. No scope, owner, host path or other authority override is accepted in the manifest. An empty provider list permits no model processing.

```sh
pnpm cos:admin source-import --scope SCOPE --request-id STABLE_UUID --manifest /absolute/private/import.json
pnpm cos:admin source-inventory --scope SCOPE --limit 50
pnpm cos:admin source-inventory --scope SCOPE --limit 50 --after LAST_RETURNED_NEXT_AFTER --status current
pnpm cos:admin source-reconcile --scope SCOPE
```

Keep the same request ID, manifest and staged bytes when reconciling an uncertain import. A changed intended import needs a new request ID and the expected source version. A conflict requires inspecting the current inventory before trying again. `COS_KNOWLEDGE_ENABLED=true` is required for ingestion. Inventory and cleanup remain available when ingestion/retrieval is disabled. Nothing automatically resumes CoS after these commands.

Inventory returns at most 100 records (50 by default), metadata and a `next_after` cursor, without source bodies or artifact paths. It supports the seven stored states: admitted, indexing, current, stale, revoked, failed and unsupported. Pagination checks current owner authority on each page; it is not a frozen snapshot across separate invocations. Rejected files that were never admitted do not become inventory records. Unsupported formats, malformed manifests, unsafe files and text extraction limits produce fixed error codes without raw file contents or paths. Inspect and correct the selected input; rejected corrections do not overwrite an existing source revision.

`source-reconcile` removes only recognised unreferenced bytes in this target's owned artifact root after a fixed 24-hour grace period. It takes the publication lock and refreshes the complete database reference set before removing anything. It is host-root maintenance, not a source-delete request: referenced or quarantined artifacts remain protected by their separate retention policy. No staging original, delivered chat, provider history, credential or backup is removed by this command. Source revocation/deletion still uses the exact owner proposal/approval flow.

### Due source deletion and retained context

`pnpm cos:admin source-purge --scope SCOPE` processes up to five already-approved, due source deletions under the same paused target/maintenance/host lease and private membership checks. It cannot change deadlines, approve a deletion or force removal. The normal running service can remove due source/artifact bytes, but leaves an exposed-history deletion pending with `retained_history_requires_maintenance` until this guarded consumer completes it.

The consumer checks source exposure records against private host-owned generation receipts outside the worker mounts. If an exposed generation is still current, it returns `context_recovery_required`; perform the existing guarded `context-recover`, preserving its pause and consent limits, then retry the purge. It refuses unknown or mismatched ownership, symlinks, hardlinks, unsafe trees and re-created directories after a completed purge. The entire selected tree is inspected before removal. Interrupted unlink or receipt writes can be retried without recreating history. More than 1,000 exposed generations or a tree over 100,000 entries/64 levels fails closed for operator investigation.

A completed purge removes the proved retired provider directory (including its replaceable per-generation access cache) and CoS RPC response-cache rows tagged by the host with that exact scope/session/generation. The current generation, master credential store, native messages/approval receipts, unrelated contexts and backups remain intact. Missing ownership is an error, never permission to infer ownership from a directory name. The generation ownership records must accompany any future restore of native history; losing them does not relax deletion checks.

Before acknowledging a due deletion, the host also reconciles recognized unreferenced blobs and partial publication files throughout its owned artifact root. Interrupted or denied publication can leave bytes without a source/derivation row, so this cleanup cannot rely only on the deleted source's metadata. The artifact lease excludes active publishers, and a fresh database snapshot waits for uncertain metadata commits. Every published or quarantined reference in every scope remains protected. Database unavailability or an unsafe file leaves deletion incomplete. This due-deletion sweep has no file-age grace; it does not shorten retention for admitted artifacts. The separate `source-reconcile` command keeps its 24-hour grace. Staging originals and unrecognized files remain untouched.

This is logical deletion of the managed source artifacts, retired provider history and tagged response cache. It does not retract delivered messages or provider inputs, delete owner staging originals, rewrite retained native message/tool-request archives, expire protected backups, or prove physical erasure from filesystem snapshots or SQLite/PostgreSQL pages and journals. Those boundaries remain explicit in the deletion evidence and recovery/retention policy.

### S02 development verification

Inside the repository devcontainer, supply only the selected admitted test profile and explicit fixture host-root/image configuration, then run:

```sh
pnpm cos:test --slice S02 --db-profile test
pnpm cos:demo --slice S02 --fixture --db-profile test
```

The test command includes affected S01 contracts, S02 database contracts and the routed twelve-question knowledge conversation. The demo command runs that conversation independently and emits its delivered replies and bounded quality judgements. See [the recorded development demonstration](evidence/S02_DEMO.md). `COS_FIXTURE_HOST_ROOT` identifies the Mac checkout for Docker bind mounts; `COS_FIXTURE_IMAGE` identifies the explicitly selected local runner. Development may use the existing `COS_FIXTURE_RUNNER_VOLUME` with a source mount. Final release checks must omit that override and use the exact tested immutable image identity. Neither the whole private environment nor database credentials enter the runner.

Runtime-disposable selection retains the existing live cross-host guard; there is no automatic fallback from the separate test database. Source and packaged fixture requests record their selected slice. The current S04 selector runs affected predecessor contracts plus work, schedule, brief and authenticated recurring-flow scenarios for each final worker profile. Passing development commands alone does not satisfy exact-image or Pi gates.
