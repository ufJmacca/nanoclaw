# Mattermost TDD Progress

This log records test-first evidence for the stacked Mattermost integration. It intentionally excludes credentials, message bodies, and synthetic isolation markers.

## Pre-flight baseline

- Plan source: `feat/mattermost:NANOCLAW_MATTERMOST_TDD_IMPLEMENTATION_PLAN.md` (read in full before implementation).
- Applicable `AGENTS.md` files: none.
- Default branch: `main` at `e297247`.
- Fork: `ufJmacca/nanoclaw`; authenticated viewer permission: `ADMIN`; dry-run push succeeded.
- Upstream divergence: fork `main` is 147 commits ahead and 738 behind `nanocoai/nanoclaw:main`; upstream reconciliation is deliberately out of scope.
- Existing Mattermost overlap: none in the current upstream tree or locally available refs.
- First baseline command: `pnpm test`.
- Pre-existing failure observed: 115 tests failed because ignored `node_modules` contained `better-sqlite3` built for Node ABI 137 while Node 22 requires ABI 127.
- Safe environment repair: `pnpm rebuild better-sqlite3` (the sandboxed download failed; the authorized network-enabled retry succeeded).
- Verified fast baseline: `pnpm test` — 37 files passed, 342 tests passed.
- Baseline format: `pnpm run format:check` — passed.
- Baseline lint: `pnpm run lint` — passed with 100 pre-existing warnings and 0 errors.
- Baseline host typecheck: `pnpm run typecheck` — passed.
- Baseline container typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Local container-test prerequisite: Bun is not installed on the host; CI pins Bun 1.3.12 and Docker 29.5.2 is available for an equivalent local gate.
- Production credentials: Phases 0–8 require no production Mattermost access or credentials; tests use fakes and temporary state.

## Phase 0 — Repository discovery and safety net

Phase status: in progress.

### Slice 0.1: shared and per-thread session characterization

- RED command: after temporarily mutating shared-session lookup to retain `threadId`, `pnpm exec vitest run src/host-core.test.ts -t 'should resolve distinct thread ids to one existing session in shared mode'`.
- RED failure observed: the second shared lookup reported `created: true` instead of reusing the first session.
- GREEN command: the same focused command after reverting the mutation.
- GREEN result: 1 passed; shared mode ignores distinct non-null thread IDs and stores `thread_id = NULL`.
- Additional mutation proof: after temporarily collapsing both per-thread lookup and creation to `thread_id = NULL`, `pnpm exec vitest run src/host-core.test.ts -t 'should create separate sessions per thread'` failed because both threads returned the same session ID; the reverted command passed.
- REFACTOR performed: strengthened the existing shared-mode test with distinct non-null thread IDs and an explicit stored-thread assertion; no production behavior changed.
- Affected-suite verification: included in the Phase 0 affected gate below.
- Files changed: `src/host-core.test.ts`.
- Remaining risks: adapter-specific thread/session decoupling remains Phase 4 scope.

### Slice 0.2: Telegram resolves to its existing agent group

- RED command: after temporarily forcing router lookup through the `mattermost` channel type, `pnpm exec vitest run src/host-core.test.ts -t 'routes seeded Telegram input|does not cross-resolve identical platform ids'`.
- RED failure observed: the seeded Telegram route created zero Telegram sessions instead of one.
- GREEN command: the same focused command after restoring `(event.channelType, event.platformId)` lookup.
- GREEN result: 2 passed; the Telegram event woke only its seeded Telegram agent group.
- REFACTOR performed: kept the fixture explicit about the existing messaging group, wiring, and selected agent group.
- Affected-suite verification: included in the Phase 0 affected gate below.
- Files changed: `src/host-core.test.ts`.
- Remaining risks: exclusive Mattermost subscription ownership is deliberately deferred to Phase 5.

### Slice 0.3: Telegram cannot cross-resolve a Mattermost row

- RED command: after temporarily forcing router lookup through the `mattermost` channel type, `pnpm exec vitest run src/host-core.test.ts -t 'routes seeded Telegram input|does not cross-resolve identical platform ids'`.
- RED failure observed: the collision test found zero Telegram sessions because the event selected the adversarial Mattermost row.
- GREEN command: the same focused command after reverting the mutation.
- GREEN result: 2 passed; `(channel_type, platform_id)` separates otherwise identical platform IDs.
- REFACTOR performed: inserted the Mattermost fixture first so a regression that drops `channel_type` cannot pass through row-order luck.
- Affected-suite verification: included in the Phase 0 affected gate below.
- Files changed: `src/host-core.test.ts`.
- Remaining risks: this characterizes lookup separation, not the Phase 5 one-to-one schema boundary.

### Slice 0.4: unknown addressed channels fail closed pending approval

- RED command: after temporarily suppressing the Telegram channel-request gate, `pnpm exec vitest run src/host-core.test.ts -t 'leaves an addressed unknown channel unwired and does not invoke an agent before approval'`.
- RED failure observed: the approval callback was called zero times instead of once.
- GREEN command: the same focused command after restoring the gate.
- GREEN result: 1 passed; the messaging group remained unwired, no session/container was created, and one approval request was emitted.
- REFACTOR performed: combined approval-callback, wiring, session, and wake assertions into one externally observable characterization.
- Affected-suite verification: `src/modules/permissions/channel-approval.test.ts` is also included in the Phase 0 affected gate.
- Files changed: `src/host-core.test.ts`.
- Remaining risks: Mattermost-specific authorized-owner lifecycle behavior remains Phase 7 scope.

### Slice 0.5: distinct agent groups have disjoint writable mounts

- RED command: after temporarily mapping every group workspace to a constant `groups/shared` path, `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'uses disjoint writable mount sources for distinct agent groups'`.
- RED failure observed: `/workspace/agent` resolved to `groups/shared` rather than the first agent's dedicated folder.
- GREEN command: the same focused command after restoring `agentGroup.folder`.
- GREEN result: 1 passed; `/workspace`, `/workspace/agent`, and `/home/node/.claude` had exact, pairwise-disjoint host sources for two agent groups.
- REFACTOR performed: exercised actual generated container arguments through a controlled launcher instead of asserting path helpers alone.
- Affected-suite verification: included in the Phase 0 affected gate below.
- Files changed: `src/container-runner.isolation.test.ts`.
- Remaining risks: semantic marker leakage and shared/global mount policy remain Phase 6 scope.

### Slice 0.6: active and in-flight executions are keyed by session ID

- RED command: after temporarily keying in-flight wake promises by agent-group ID, `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'keys active and in-flight executions by session id'`.
- RED failure observed: two distinct sessions in one agent group returned the same in-flight promise.
- GREEN command: the same focused command after restoring session-ID keys.
- GREEN result: 1 passed; same-session wakes deduplicated while distinct sessions remained independent.
- Additional mutation proof: after temporarily keying active containers by agent-group ID, the focused test failed because the active map size was one instead of two; the reverted command passed.
- REFACTOR performed: fake child processes emit `close` during cleanup so module-global execution state cannot leak between tests.
- Affected-suite verification: `pnpm exec vitest run src/host-core.test.ts src/modules/permissions/channel-approval.test.ts src/container-runner.isolation.test.ts src/container-runner.test.ts` — 4 files passed, 46 tests passed.
- Files changed: `src/container-runner.isolation.test.ts`.
- Remaining risks: the global concurrency limit is not implemented until Phase 8.

### Phase 0 gate

- Focused/affected tests: `pnpm exec vitest run src/host-core.test.ts src/modules/permissions/channel-approval.test.ts src/container-runner.isolation.test.ts src/container-runner.test.ts` — 4 files passed, 46 tests passed.
- Telegram regression suite: `pnpm exec vitest run src/channels/telegram.test.ts src/channels/telegram-pairing.test.ts src/channels/telegram-outbound.test.ts src/channels/telegram-markdown-sanitize.test.ts` — 4 files passed, 57 tests passed.
- Full host fast suite: `pnpm test` — 38 files passed, 347 tests passed.
- Container suite: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` — 103 tests passed on the warm ARM64 image. The first cold image-pull run had one unchanged formatter test exceed Bun's 5-second timeout while neighboring trivial tests were also abnormally slow; the exact warm rerun completed in 11.18 seconds with no failures.
- Formatting: `pnpm run format:check` — passed.
- Lint: `pnpm run lint` — passed with the same 100 pre-existing warnings and 0 errors.
- Host typecheck: `pnpm run typecheck` — passed.
- Container typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Diff/secrets review: `git diff --check` passed; only Phase 0 tests and this log are present; no credential patterns or generated artifacts were found.
- Isolation result: existing Telegram routing, channel/session separation, disjoint writable mounts, and session-keyed execution are characterized without adding Mattermost feature behavior.
- Phase status: local gate passed; awaiting pull-request CI.
