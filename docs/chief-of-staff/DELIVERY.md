# Mac release and Pi delivery

Run the host wrappers from the Mac checkout. They use the running repository devcontainer for project tools and the host's Docker, GitHub and SSH tools. They never install project dependencies on the Mac or build application code on the Pi.

```sh
bash scripts/cos-release.sh --slice S01 --target pi --db-profile test
bash scripts/cos-deploy.sh status --target pi
bash scripts/cos-deploy.sh --target pi --release-manifest /absolute/checkout/.cos-plan-state/releases/release-…/release.json
bash scripts/cos-deploy.sh rollback --target pi --release-id release-…
```

The equivalent package commands are `cos:release` and `cos:deploy`. The default development service is Compose project `nanoclaw-cos`, service `devcontainer`; `COS_DEVCONTAINER_ID` can identify the same running repository container. The release command requires a clean committed candidate, the existing private execution ledger and `.cos-plan-state/deployment-target.json`. It selects only the `COS_TEST_PG*` connection fields and protected test marker from the private `.env`. It copies the selected CA certificate into a private test directory, outside the build context and release archive.

Local checks precede all candidate transfers. The command builds and tests the host, standard Codex worker and document-enabled Codex worker as Linux/ARM64 images. Existing Pi provider/package profiles are checked again before activation; unsupported profiles block deployment. No live bot or paid provider credentials enter these tests. The saved archive must contain the exact tested image identities and independently hashed configuration bytes.

Delivery pushes the tested source commit, verifies its detached Pi source checkout, transfers the archive and uses the tested packaged helper to load and activate it. The existing service briefly stops for consistent protected-state backups and scoped migrations. The helper preserves data roots and requires service, database, worker RPC, provider-fixture and isolation health checks before reopening eligible work. The coordinator records separate local, source, transfer and deployment checkpoints without claiming a reviewed merge.

After an interrupted delivery, rerun `cos:deploy` with the same manifest. The Pi reconciles the durable release receipt and maintenance lease. Do not delete locks, replace target history, or create a new disposable declaration to bypass an uncertain operation. Explicit rollback uses the current release's recorded compatible predecessor, preserves database contents, and leaves CoS paused. It does not reinstall dependencies or restore an old SQLite backup over newer messages.

Prefer `--db-profile test`. Explicit `--db-profile runtime-disposable` requires an already installed CoS helper and a Pi-owned disposable lifecycle record; it refuses an unbound or protected target. It selects only the Mac's `COS_PG*` runtime and migration settings. An authenticated live SSH session holds the Pi operation lock while the Mac fixture driver holds the database fence. Each database admission checks the live session. Connection loss stops the owned fixture processes and leaves CoS paused; ordinary NanoClaw service processes remain running. First delivery uses the separate test database.

Private test logs and receipts remain under `.cos-plan-state`; only sanitised acceptance evidence belongs in Git. Runtime fixture retries must retain the same owner, source, image and request identity. A completed Pi receipt can reconcile a lost final reply only when the matching Mac receipt proves fixtures passed. S01 acceptance and Pi deployment are not yet claimed by this runbook.

## S02 knowledge configuration — implementation in progress

The S02 host source requires PostgreSQL schema 2 and checks its recorded checksums at startup. Startup never migrates the database. S02 release registration, final-image testing and Pi delivery remain pending; these settings do not make the existing S01 deployment an S02 deployment.

The trusted host runtime environment accepts `COS_KNOWLEDGE_ENABLED=true` to enable selected-source ingestion and retrieval. Its default is `false`. `COS_KNOWLEDGE_RETENTION_DAYS` is an integer from 0 through 365, defaulting to 30; approved deletion records its deadline when applied. Keep both settings in the host's scoped runtime environment, and restart the host to apply changes through the normal deployment/operational checks. No agent receives these settings or database credentials.

The authenticated target state root owns `knowledge/artifacts` and `knowledge/staging`. The host creates these private directories outside Git, the installation and native data roots. It refuses symlinks, permissive paths and unowned existing content. Neither directory is mounted in a worker. Imports select an individual staged file through the owner administration path; adding a file to staging alone does not admit it.

Use the knowledge switch to disable ingestion/retrieval while keeping the CoS host enabled. Current-policy checks, revocation, quarantine and due deletion remain active. Stored replies with source dependencies cannot be redisplayed while retrieval is disabled. A context previously exposed to sources remains fenced; disabling retrieval does not erase that history or reset model consent. Approved-priority replies work in a clean context.

The guarded `context-recover` owner command rebuilds the same CoS AgentGroup's context after verified quiescence, private membership and protected backup. It quarantines stale pending input/output and gives the runner an empty provider history and a new continuation key. It does not replay the old discussion. Subsequent answers must retrieve current approved records and permitted sources again.

Recovery can carry an already-issued, unexpired allowance into that replacement context. Only the context generation changes: activation ID, account, model, consent reference, expiry, maximum attempts and all charged usage remain unchanged. Missing, expired or exhausted consent is not transferred. A private journal reconciles interrupted updates without replenishing usage. Recovery always leaves CoS paused; the separate guarded resume operation remains necessary. This code path performs no model call or message send, and it does not reactivate the completed S01 live-test allowance.

Recovery retains old provider history until an approved source-deletion deadline and the guarded retention consumer permit removal. Protected recovery backups have a separate retention boundary; context recovery alone is not proof of byte erasure.

### Owner source management in S02 source

After S02 deployment, use `pnpm cos:admin` on the trusted host with the existing target maintenance lease, stopped service/owned workers, paused CoS binding and verified private membership. The command acquires the target and host execution locks, validates the bound database/schema and derives owner/session/group identity from the binding. It does not activate a model. These commands are not available in the existing S01 Pi release yet.

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

This is logical deletion of the managed source artifacts, retired provider history and tagged response cache. It does not retract delivered messages or provider inputs, delete owner staging originals, rewrite retained native message/tool-request archives, expire protected backups, or prove physical erasure from filesystem snapshots or SQLite/PostgreSQL pages and journals. Those boundaries remain explicit in the deletion evidence and recovery/retention policy.

### S02 development verification

Inside the repository devcontainer, supply only the selected admitted test profile and explicit fixture host-root/image configuration, then run:

```sh
pnpm cos:test --slice S02 --db-profile test
pnpm cos:demo --slice S02 --fixture --db-profile test
```

The test command includes affected S01 contracts, S02 database contracts and the routed twelve-question knowledge conversation. The demo command runs that conversation independently and emits its delivered replies and bounded quality judgements. See [the recorded development demonstration](evidence/S02_DEMO.md). `COS_FIXTURE_HOST_ROOT` identifies the Mac checkout for Docker bind mounts; `COS_FIXTURE_IMAGE` identifies the explicitly selected local runner. Development may use the existing `COS_FIXTURE_RUNNER_VOLUME` with a source mount. Final release checks must omit that override and use the exact tested immutable image identity. Neither the whole private environment nor database credentials enter the runner.

Runtime-disposable selection retains the existing live cross-host guard; there is no automatic fallback from the separate test database. S02 release/manifest registration and exact-image/Pi gates remain pending even when these development commands pass.
