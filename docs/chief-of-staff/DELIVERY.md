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

Private test logs and receipts remain under `.cos-plan-state`; only sanitised acceptance evidence belongs in Git. The separate `runtime-disposable` release path is still under implementation and currently refuses execution. S01 acceptance and Pi deployment are not yet claimed by this runbook.
