# Shared execution, verification and handover rules

**Plan revision:** 5. These requirements apply to every S01–S11 plan. This file consolidates repeated delivery and receipt text; it does not defer a slice's security or recovery work until S11.

## Read before each slice

Read applicable repository instructions, [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [GitHub source sync](GITHUB_SOURCE_SYNC.md), [interaction model](INTERACTION_MODEL.md), [goal](GOAL.md), [acceptance matrix](ACCEPTANCE_MATRIX.md), the current slice and predecessor receipts. Revalidate the historical [repository baseline](REPOSITORY_BASELINE.md) against the actual checkout. Preserve existing research, providers and ordinary channel behaviour.

Implement one complete user-visible slice per branch/PR, in dependency order. Resume existing work and address actual review feedback; do not overwrite dirty work or redo merged slices. The human-reviewed merge of the predecessor opens the next implementation gate. The goal remains incomplete at an open PR or technical blocker.

## Test-first delivery

Use red → green → refactor for each behaviour. Record the real failing behaviour test before implementing it, then the passing evidence. An import/setup failure is not meaningful red evidence. Map every specified test ID to real test names. Never waive privacy, authority, isolation, integrity or recovery checks because model output looks plausible.

S01 introduces these command contracts; they do not exist merely because the plans name them:

```text
pnpm cos:test --slice Sxx --db-profile <selected-profile>
pnpm cos:demo --slice Sxx --fixture --db-profile <selected-profile>
pnpm cos:admin status
pnpm cos:release --slice Sxx --target pi --db-profile <selected-profile>
pnpm cos:deploy --target pi --release-manifest <tested-manifest>
```

Reject unknown slice IDs and unsupported profiles. Run the slice contract/demo, affected predecessor regressions, root `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, and runner checks when touched: `pnpm --dir container/agent-runner typecheck` and `(cd container/agent-runner && bun test)`. Revalidate actual package-manager and lockfile conventions. Record genuine baseline failures separately instead of masking them or changing unrelated dependencies.

Tests run on the Mac with deterministic fixture adapters/models, real external PostgreSQL, local isolated SQLite/artifact roots, fake clocks and controlled container launchers. Release tests run the final Linux/ARM64 artifacts without checkout-source mounts. Runtime isolation also requires a Pi-native check when introduced in S05; Mac containers cannot prove Pi kernel/network behaviour. Semantic quality assessment is separate from deterministic security/integrity gates.

## External database and local safety

Use a separately supplied `COS_TEST_PG*` profile with its protected test marker, or explicitly select `runtime-disposable` while the Pi-owned lifecycle, quiescence and cross-host lease checks hold. A separate test database is optional during implementation; a failing or partially configured explicit profile must not silently switch targets. Tests still run on the Mac. Separate fixture scopes do not isolate schema migrations.

No local PostgreSQL server is installed on Mac or Pi. Pi runtime credentials remain in the Pi service environment; migration credentials enter only the selected trusted admin process. Mac tests need their own explicitly supplied profile. No environment dumps, copying Pi secret files, secrets in build arguments/images, or credential inheritance by workers. Preserve existing NanoClaw SQLite, sessions and unrelated workspaces.

Missing all eligible DB targets blocks mandatory integration acceptance. Missing a live calendar account/model/channel test is tracked separately as activation pending. Never call a fixture a live test or a blocked check a pass. Shared-target schema incompatibility leaves Pi CoS paused until safely resolved; a failing local candidate cannot be deployed to repair it.

## Source and artifact release

Mac authoring → exact commit pushed to this fork → local tests/build/final-image tests → Pi fetch/verify exact commit in a detached release-source checkout → SSH transfer of tested artifacts → Pi verification/load/extraction → protected-state backup → explicit Pi-env migrations → activation/restart → native smoke and compatible rollback or receipt.

No candidate image transfer/deployment before mandatory local gates. The Pi does not edit source, install application dependencies, build images or pull mutable application tags. Fetching Git source does not activate anything and cannot override baked worker code. Source commit/tree and tested artifact manifest must agree. Introduce S01-REL13–S01-REL18 from GITHUB_SOURCE_SYNC.md in S01 and regress them where affected thereafter.

In-scope migrations and Pi operations retain the owner's standing approval under IMPLEMENTATION_AUTHORITY.md. A new operational review is not required, but failed tests, unsafe quiescence, wrong target, missing access or invalid host key remain real blockers. A tested candidate may be deployed before PR review, labelled accordingly. Human merge still gates the next slice. After merge, publish a tested release matching the actual merged source identity.

The live user interface is one private Mattermost channel. Local messaging is fixture-only; do not start a second bot using the Pi token. Telegram remains separate. Preserve exact owner-bound approvals for application-level goals, mandates and external effects; implementation authority is not inherited by CoS agents.

## Required receipt and ledger updates

Write `docs/chief-of-staff/evidence/Sxx.md` with base/head SHA, plan/contract versions, actual red/green commands, test IDs/results, fixture demo, policy/schema changes, migration checksums, selected test profile, rollback evidence, local and final-image tests, source push/sync status, verified commit/tree, image IDs, archive digest, Pi migration/smoke/release receipt, lifecycle state, live activation state, residual limits and next handover. Keep endpoints, secrets, raw logs and private artifacts out of Git. A sanitised receipt can reference private evidence without publishing it.

Update `.cos-plan-state/execution.json` atomically and preserve unknown fields. Record the real branch, PR, commits, `next_action`, blocker and resume condition. Create/update one reviewable PR. At pending review, checkpoint `awaiting_review`; after a verified human merge the same goal selects the next eligible slice without a new slice prompt. GitHub access failure leaves publication pending, not invented. A stopped coding process does not monitor or resume itself unless a separately configured runner provides that capability.

## Rollback invariant

Disable or pause only the new/affected CoS capability; retain restrictive identity markers, current authority, receipts, revocations and uncertainty. Prefer compatible code rollback or a tested roll-forward. No blanket Docker prune, volume removal, full-database reset, restore of old live conversations, or cleanup that hides a failed recovery test. Disposable CoS cleanup requires the exact authority/lifecycle/effect checks; protected NanoClaw state is never a fixture store.
