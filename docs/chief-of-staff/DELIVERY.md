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

The authenticated target state root owns `knowledge/artifacts` and `knowledge/staging`. The host creates these private directories outside Git, the installation and native data roots. It refuses symlinks, permissive paths and unowned existing content. Neither directory is mounted in a worker. Imports must later select an individual staged file through the owner administration path; adding a file to staging alone does not admit it.

Use the knowledge switch to disable ingestion/retrieval while keeping the CoS host enabled. Current-policy checks, revocation, quarantine and due deletion remain active. Stored replies with source dependencies cannot be redisplayed while retrieval is disabled. A context previously exposed to sources remains fenced; disabling retrieval does not erase that history or reset model consent. Approved-priority replies work in a clean context.

The guarded `context-recover` owner command rebuilds the same CoS AgentGroup's context after verified quiescence, private membership and protected backup. It quarantines stale pending input/output and gives the runner an empty provider history and a new continuation key. It does not replay the old discussion. Subsequent answers must retrieve current approved records and permitted sources again.

Recovery can carry an already-issued, unexpired allowance into that replacement context. Only the context generation changes: activation ID, account, model, consent reference, expiry, maximum attempts and all charged usage remain unchanged. Missing, expired or exhausted consent is not transferred. A private journal reconciles interrupted updates without replenishing usage. Recovery always leaves CoS paused; the separate guarded resume operation remains necessary. This code path performs no model call or message send, and it does not reactivate the completed S01 live-test allowance.

Old provider history and protected recovery backups still remain for their separate retention boundary. Deletion of eligible retained native history is under implementation; a successful context recovery is not proof of byte erasure.
