# Bootstrap as a persistent Mac-hosted goal

Open the coding agent at the root of the NanoClaw checkout **on the Mac**. Set its goal to the following text using the installed tool's goal interface. This is one S01–S11 objective, not a series of single-slice prompts.

```text
Complete the Chief-of-Staff implementation programme in this NanoClaw fork as defined by docs/chief-of-staff-plans/GOAL.md.

Read GOAL.md, IMPLEMENTATION_AUTHORITY.md, MAC_TO_PI_DELIVERY.md, GITHUB_SOURCE_SYNC.md, INTERACTION_MODEL.md, the shared architecture, external-PostgreSQL contract and acceptance matrix. Reconcile Git, PRs, receipts and .cos-plan-state/execution.json. Resume existing progress and implement S01–S11 in dependency order with test-first vertical demonstrations and one reviewable PR per slice.

Do all source development, dependency installation, builds and local tests on my Mac. Build and test the exact Linux/ARM64 host-release and agent images locally, without source-mount overrides in release-mode tests. Only after mandatory local checks pass, transfer the tested image bundle over authenticated SSH to the bound Raspberry Pi. Push the exact candidate source commit to this fork. On the Pi, fetch it from GitHub into a clean detached release-source worktree and verify its commit/tree against the tested manifest; do not run git pull or overwrite the live checkout. Fetching alone must never deploy. Load/verify the matching artifacts, extract the prebuilt host payload, run scoped migrations, activate/restart the existing NanoClaw service and perform native smoke checks. Never use the Pi as a build worker or fix code there. Do not ship Mac node_modules, runtime data or secrets. The Pi must keep working when my Mac is off.

The external CoS PostgreSQL database is on a third machine on the same private network and contains only disposable data until all slices are implemented. In-scope migrations, Pi deployments, restarts, health checks and compatible rollbacks are pre-authorised: no new human confirmation or approval card. Preserve protected NanoClaw SQLite, sessions, credentials, other applications and the human PR review/merge gate. Do not auto-merge.

Mac database tests use separately supplied process-env credentials for an external test database, or explicitly select the guarded runtime-disposable target while the Pi CoS is quiesced under a cross-host maintenance lease. Do not copy/dump Pi secrets, start a local PostgreSQL server or run competing live bots on the Mac. Pi runtime/admin secrets remain in the corresponding trusted Pi environment; CoS workers never receive DB or deployment credentials.

Use one dedicated private Mattermost channel as the first CoS interface, with host-validated owner controls and exact-action approvals. Treat Mattermost threads as presentation, not mission isolation. Keep Telegram separate unless later explicitly bound; no cross-channel CoS sharing or new web UI is required. Local messaging tests use fixtures, not the Pi's live bot identity.

Continue through all authorised unblocked work. Select the next eligible slice after its predecessor's legitimate human merge; do not ask for a new TARGET_SLICE. Checkpoint local test, image, transfer, Pi migration/health and review status separately. Real account/model/channel action gates remain unless already satisfied. At real blockers or review gates checkpoint without claiming completion. Close disposal monotonically on the Pi when all implementation/merge gates pass, verify the final deployed release, and report remaining live activation honestly.
```

## Adopting revision 5

Preserve existing code, branches, receipts and progress. Move the implementation checkout/goal to the Mac without copying live secrets or Pi runtime data. Reconcile any private ledger transferred through an authorised secure channel and upgrade it additively to v5; do not overwrite it with the blank template. The Pi keeps its authoritative deployment/target/lifecycle records; the Mac ledger references and reconciles them. A stale Mac copy never reopens a protected database.

Replace the old single-machine build/deploy assumption, not the standing deployment authority. Review/merge and genuinely missing tools/access/tests still gate progress. A stopped coding session does not monitor or resume itself unless its runner actually provides that behaviour.
