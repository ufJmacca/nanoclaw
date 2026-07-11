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
- GitHub CI: `ci` passed in 39 seconds ([run 29093912894](https://github.com/ufJmacca/nanoclaw/actions/runs/29093912894)).
- Phase status: complete; local and GitHub gates passed; pull request ready for review.
- Pull request: [#37](https://github.com/ufJmacca/nanoclaw/pull/37), `codex/mattermost-00-characterization` → `main`.

## Phase 1 — Host-side Mattermost client authentication

Phase status: in progress.

### Slice 1.1: bearer-authenticated identity validation

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'validates the configured bot with a bearer-authenticated users/me request'`.
- RED failure observed: the host-side Mattermost client module did not exist, so the required authentication behavior could not be loaded.
- GREEN command: the same focused command after adding the minimal injectable client and transport contract.
- GREEN result: 1 passed; setup issued `GET /api/v4/users/me` with the configured bearer credential and normalized base URL.
- REFACTOR performed: kept HTTP and WebSocket operations behind a host-only `MattermostTransport` boundary; no adapter routing was introduced.
- Affected-suite verification: focused suite passed; Prettier, ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: status validation, WebSocket authentication, lifecycle, and redaction are the following Phase 1 slices.

### Slice 1.2: invalid REST credentials fail closed

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'fails setup on invalid credentials without opening a WebSocket'`.
- RED failure observed: setup resolved successfully for an HTTP 401 response instead of rejecting.
- GREEN command: the same focused command after rejecting non-2xx identity responses.
- GREEN result: 1 passed; setup rejected with a sanitized authentication error and never called `openWebSocket`.
- REFACTOR performed: kept the failure based on status only, avoiding reflection of server bodies or credentials.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 2 passed; Prettier, ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: transport-thrown failures and WebSocket failures receive explicit redaction coverage later in this phase.

### Slice 1.3: WebSocket authentication challenge

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'authenticates the WebSocket with a challenge before setup completes'`.
- RED failure observed: no WebSocket frame was sent, so the challenge spy remained at zero calls.
- GREEN command: the same focused command after opening `/api/v4/websocket`, sending the sequence-1 authentication challenge, and awaiting its response.
- GREEN result: 1 passed; setup remained pending until `{status: 'OK', seq_reply: 1}` arrived.
- REFACTOR performed: extracted response-shape validation, removed the temporary auth listener after the matching response, and rethrew non-JSON-parse errors so the slice adds no lint warnings.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 3 passed; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: authentication timeouts, teardown, and transport error redaction follow in the next slices.

### Slice 1.4: bounded authentication timer ownership

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'owns and clears a bounded WebSocket authentication timer'`.
- RED failure observed: the injected timer scheduler recorded zero timers, so a missing challenge response could wait forever.
- GREEN command: the same focused command after adding a 10-second host-owned authentication timer.
- GREEN result: 1 passed; the matching authentication response cleared the exact timer handle.
- REFACTOR performed: centralized timer cleanup and provided an injectable scheduler with a system default.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 4 passed; Prettier, ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: teardown must cancel a still-pending authentication promise and close its socket.

### Slice 1.5: idempotent teardown closes host resources

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'teardown closes the socket and cancels pending authentication'`.
- RED failure observed: the client exposed no teardown function.
- GREEN command: the same focused command after adding client-owned cancellation and socket cleanup.
- GREEN result: 1 passed; teardown rejected pending setup, removed authentication state, cleared the exact timer, closed the socket once, and remained idempotent.
- REFACTOR performed: consolidated authentication listener/timer/reject cleanup in one private boundary used by success, timeout, failure, and teardown paths.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 5 passed; Prettier, ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: socket close/error callbacks and credential-bearing transport failures need sanitized fail-closed handling.

### Slice 1.6: credential redaction across authentication failures

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'redacts the bot credential from REST transport failures'`.
- RED failure observed: the raw transport error exposed both the fixture credential and bearer header in its message and stack.
- GREEN command: the same focused command after replacing raw REST failures with a fresh safe error that carries no raw cause.
- GREEN result: 1 passed; string, stack, and serialized error forms excluded the credential and bearer header.
- Additional RED/GREEN cycle: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'redacts the bot credential from WebSocket transport failures'` first exposed the fixture credential from `openWebSocket`, then passed after sanitizing that boundary.
- Additional RED/GREEN cycle: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'redacts the bot credential when sending the WebSocket challenge fails'` first exposed the fixture credential from a thrown `send`, then passed after promise-boundary sanitization and cleanup.
- REFACTOR performed: authentication failures are newly constructed without `cause`, request headers, server bodies, socket URLs, or challenge payloads; the client emits no authentication logs.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 8 passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: host/container credential exclusion is the final Phase 1 security slice.

### Slice 1.7: concrete Node 20 host transport

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'adapts host fetch responses to the Mattermost transport contract'`.
- RED failure observed: `NodeMattermostTransport` was not a constructor.
- GREEN command: the same focused command after adding the minimal fetch adapter.
- GREEN result: 1 passed; method, URL, headers, optional body, status, and JSON response crossed the seam unchanged.
- Additional RED/GREEN cycle: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'adapts a ws connection and text messages to the transport socket contract'` failed because no WebSocket instance was created, then passed after adding the `ws`-backed adapter and listener unsubscription.
- REFACTOR performed: pinned `ws@8.21.0` and `@types/ws@8.18.1` because the supported Node 20 runtime cannot rely on an unflagged native WebSocket; kept both fetch and constructor injectable for deterministic tests.
- Affected-suite verification: client suite and host typecheck passed after both transport cycles.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`, `package.json`, `pnpm-lock.yaml`.
- Remaining risks: reconnection and live-server compatibility remain Phase 8 and Phase 9 scope.

### Slice 1.8: failed WebSocket authentication fails closed

- Characterization command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'rejects a failed WebSocket authentication response and closes the socket'` — initially passed.
- RED mutation command: the same focused command after temporarily treating every matching response as `OK`.
- RED failure observed: the setup promise resolved instead of rejecting the server's `FAIL` response.
- GREEN command/result: the same focused command after reverting the mutation — 1 passed; setup rejected with a safe error and closed the socket.
- REFACTOR performed: reused the central authentication cleanup path; no server error body is retained.
- Affected-suite verification: included in the Phase 1 affected gate below.
- Files changed: `src/channels/mattermost-client.test.ts` only; the production mutation was reverted.
- Remaining risks: none within the Phase 1 authentication response contract.

### Slice 1.9: Mattermost credentials stay out of container launches

- Characterization command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'keeps Mattermost credentials host-side during container launch'` — initially passed.
- RED mutation command: the same command after temporarily adding Docker inheritance for `MATTERMOST_BOT_TOKEN`.
- RED failure observed: the launch environment contained the forbidden variable name.
- Additional RED mutation: temporarily mounting the repository root read-only caused the same focused test to fail because that source contains the host `.env` path.
- GREEN command/result: the focused command after reverting each mutation — 1 passed; launch args excluded the variable/value and every mount source excluded the host `.env`.
- REFACTOR performed: parsed final controlled-launch arguments, covering provider and OneCLI contributions rather than private helper output; the test never reads a credential file.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.isolation.test.ts src/channels/mattermost-client.test.ts` — 13 passed before the later WebSocket-failure characterization was added.
- Files changed: `src/container-runner.isolation.test.ts`; all production mutations were reverted.
- Remaining risks: prompt, message, and SQLite metadata exclusion becomes testable with the Phase 2 normalization path and receives full proof in Phase 6.

### Phase 1 gate

- Affected and Telegram suites: `pnpm exec vitest run src/channels/mattermost-client.test.ts src/container-runner.isolation.test.ts src/channels/telegram.test.ts src/channels/telegram-pairing.test.ts src/channels/telegram-outbound.test.ts src/channels/telegram-markdown-sanitize.test.ts` — 6 files passed, 71 tests passed.
- Full host fast suite: the first `pnpm test` run had one pre-existing random Telegram pairing-code collision (`does not collide with active codes`) while its affected-suite run was green; the exact unmodified rerun passed 39 files and 359 tests. No test was weakened or changed.
- Container suite: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` — 103 passed.
- Frozen dependency verification: `pnpm install --frozen-lockfile --offline` — lockfile current and install passed.
- Formatting: `pnpm run format:check` — passed.
- Lint: `pnpm run lint` — passed with the same 100 pre-existing warnings and 0 errors; Phase 1 adds no warnings.
- Host typecheck: `pnpm run typecheck` — passed.
- Container typecheck: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Diff/secrets review: only the host client/tests, pinned `ws` dependency metadata, container credential characterization, and this progress evidence differ from Phase 0; no real credentials, generated artifacts, inbound mapping, or outbound delivery behavior are present.
- Isolation result: the bot credential exists only in the host client closure and its authentication request/challenge; safe errors, container args, inherited environment, and mounts exclude it.
- GitHub checks: the repository `CI` workflow did not trigger because it is configured only for pull requests targeting `main`; the available `label` metadata check passed in 2 seconds ([run 29095477461](https://github.com/ufJmacca/nanoclaw/actions/runs/29095477461)).
- Phase status: complete; the full local gate and every available GitHub check passed; pull request ready for review.
- Pull request: [#38](https://github.com/ufJmacca/nanoclaw/pull/38), `codex/mattermost-01-auth` → `codex/mattermost-00-characterization` (depends on #37).
