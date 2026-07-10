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

Phase status: complete.

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

Phase status: complete.

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

## Phase 2 — Inbound event normalization

Phase status: complete.

### Slice 2.1: posted event produces one inbound message

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'turns one posted event into one NanoClaw inbound message'`.
- RED failure observed: the Mattermost inbound processor module did not exist.
- GREEN command: the same focused command after adding the minimal processor and sink boundary.
- GREEN result: 1 passed; one valid `posted` frame produced one chat message with sender display name and text.
- REFACTOR performed: isolated raw-event handling from the authenticated transport behind a typed `MattermostInboundSink`; formatting, lint, and typecheck remained clean.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts` — 1 passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: stable identities, threading metadata, bot filtering, deduplication, validation, and safe logging follow as separate slices.

### Slice 2.2: collision-safe channel platform identity

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'namespaces channel identity by Mattermost instance and channel id'`.
- RED failure observed: the processor emitted the raw channel ID instead of `mattermost:primary:channel-id`.
- GREEN command: the same focused command after adding the instance/channel namespace.
- GREEN result: 1 passed; identical channel IDs on two instance keys produced distinct stable platform IDs.
- REFACTOR performed: kept channel identity derived exclusively from immutable instance key and channel ID, never channel name.
- Affected-suite verification: inbound suite — 2 passed; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: malformed/ambiguous identity components will be rejected by the validation slice.

### Slice 2.3: stable sender identity

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'uses a stable Mattermost sender id independent of display name'`.
- RED failure observed: normalized content carried the display name but no `senderId`.
- GREEN command: the same focused command after namespacing the immutable Mattermost user ID.
- GREEN result: 1 passed; content carries `senderId: mattermost:user-id` independently of sender display name.
- REFACTOR performed: kept the human-readable sender and authorization identity as separate fields.
- Affected-suite verification: inbound suite — 3 passed; targeted ESLint passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: missing/invalid user IDs are handled by the validation slice.

### Slice 2.4: external post identity retention

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'retains the Mattermost post id as the external message id'`.
- RED failure observed: the normalized message still used the temporary placeholder ID.
- GREEN command: the same focused command after mapping `post.id`.
- GREEN result: 1 passed; the NanoClaw inbound message ID exactly matches the Mattermost post ID.
- REFACTOR performed: no additional identifier or content copy was introduced; the external ID remains the deduplication key.
- Affected-suite verification: inbound suite — 4 passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: duplicate suppression is added after bot filtering.

### Slice 2.5: thread reply delivery metadata

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'retains root_id as delivery metadata for thread replies'`.
- RED failure observed: normalized `threadId` was `null` instead of the Mattermost root post ID.
- GREEN command: the same focused command after mapping non-empty `root_id`.
- GREEN result: 1 passed; thread replies retain their root ID while root posts continue to map to `null`.
- REFACTOR performed: reused NanoClaw's delivery `threadId` field without creating a per-thread session decision in the processor.
- Affected-suite verification: inbound suite — 5 passed; host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: Phase 4 explicitly decouples this UI delivery metadata from context selection.

### Slice 2.6: bot-authored events are ignored

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'ignores posts authored by the authenticated bot user'`.
- RED failure observed: the sink received one normalized message authored by the configured bot user.
- GREEN command: the same focused command after filtering on the authenticated `/users/me` ID.
- GREEN result: 1 passed; the bot-authored post produced zero inbound messages.
- REFACTOR performed: filtering uses immutable user ID rather than username/display name and occurs before any sink invocation.
- Affected-suite verification: inbound suite — 6 passed; targeted ESLint passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: the authenticated identity is wired from the client after processor behavior is complete.

### Slice 2.7: duplicate posts are processed exactly once

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'processes concurrent duplicate post events exactly once'`.
- RED failure observed: two concurrent copies invoked the sink twice.
- GREEN command: the same focused command after atomically reserving the external post ID before awaiting the sink.
- GREEN result: 1 passed; concurrent duplicate frames invoked the sink once.
- REFACTOR performed: reused the immutable external post ID established in Slice 2.4 and placed dedup after bot filtering.
- Affected-suite verification: inbound suite — 7 passed; host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: bounded/durable deduplication across reconnect and restart is Phase 8 scope.

### Slice 2.8: malformed JSON is rejected safely

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'rejects malformed envelope and nested post JSON without throwing'`.
- RED failure observed: invalid outer JSON rejected the processor promise with a `SyntaxError`.
- GREEN command: the same focused command after adding guarded outer/nested parsing and structural envelope checks.
- GREEN result: 1 passed; malformed outer and nested JSON returned `false`, invoked no sink, and did not throw.
- REFACTOR performed: extracted safe JSON and record guards that rethrow only unexpected non-syntax failures; targeted lint remains clean.
- Affected-suite verification: inbound suite — 8 passed; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: required-field/type validation and size limits are separate following slices.

### Slice 2.9: unsupported events are ignored

- Characterization command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'ignores unsupported WebSocket event types'` — initially passed.
- RED mutation command: the same focused command after temporarily removing the `posted` discriminator.
- RED failure observed: a `typing` event was normalized and returned `true` instead of being ignored.
- GREEN command/result: the same command after reverting the mutation — 1 passed and zero sink calls.
- REFACTOR performed: retained a single outer-envelope discriminator before nested post parsing.
- Affected-suite verification: included in the current inbound suite.
- Files changed: `src/channels/mattermost-inbound.test.ts`; the production mutation was reverted.
- Remaining risks: none for unsupported event dispatch; reconnect/event catalog changes are Phase 8 scope.

### Slice 2.10: malformed required fields fail closed

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'rejects posted events with missing or invalid required fields'`.
- RED failure observed: a post missing its ID returned `true` and reached the sink.
- GREEN command: the same focused command after adding a pure required-field/type/timestamp guard.
- GREEN result: 1 passed across missing ID, empty channel ID, non-string user/root/message fields, and invalid timestamp fixtures; none invoked the sink.
- REFACTOR performed: consolidated nested post validation in a type predicate before bot filtering, deduplication, timestamp conversion, or routing identity construction.
- Affected-suite verification: inbound suite — 10 passed; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: ambiguous broadcast/post channel disagreement is the next fail-closed slice.

### Slice 2.11: oversized payloads are rejected before parsing

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'rejects oversized events before invoking the sink'`.
- RED failure observed: the over-limit frame returned `true` and reached the sink.
- GREEN command: the same focused command after adding an injectable UTF-8 byte limit with a 1 MiB host default.
- GREEN result: 1 passed; the over-limit frame returned `false` before parsing or sink invocation.
- REFACTOR performed: measured bytes rather than JavaScript character count and kept the limit in host-only processor configuration.
- Affected-suite verification: inbound suite — 11 passed; Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: server-specific lower post limits are an outbound Phase 3 concern.

### Slice 2.12: ambiguous channel identity fails closed

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'fails closed when broadcast and post channel identities disagree'`.
- RED failure observed: the contradictory envelope returned `true` and routed using the nested post channel.
- GREEN command: the same focused command after validating optional broadcast identity against `post.channel_id`.
- GREEN result: 1 passed; contradictory or malformed broadcast identity returns `false` with zero sink calls.
- REFACTOR performed: the processor has one authoritative channel only after all supplied immutable IDs agree.
- Affected-suite verification: inbound suite — 12 passed; host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: none for envelope channel ambiguity.

### Slice 2.13: ambiguous instance keys are rejected at configuration time

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'rejects ambiguous Mattermost instance keys before processing'`.
- RED failure observed: constructing a processor with `primary:shadow` did not throw, allowing delimiter ambiguity.
- GREEN command: the same focused command after enforcing a colon-free slug.
- GREEN result: 1 passed; ambiguous instance identity fails before any frame can be processed.
- REFACTOR performed: centralized the configuration invariant in the processor constructor.
- Affected-suite verification: inbound suite — 13 passed; targeted ESLint passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: none for platform-ID delimiter ambiguity.

### Slice 2.14: diagnostics exclude message content

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'logs diagnostic metadata without full message content'`.
- RED failure observed: the logger recorded zero diagnostic events.
- GREEN command: the same focused command after adding structured metadata-only logging.
- GREEN result: 1 passed; logs contain instance/event/post/channel/sender/root/byte metadata and exclude the private message body.
- REFACTOR performed: injected a minimal logger interface and kept the production logger as the default; raw frame, serialized post, parser error, token, and text are never logged.
- Affected-suite verification: inbound suite — 14 passed; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-inbound.ts`, `src/channels/mattermost-inbound.test.ts`.
- Remaining risks: post-auth socket wiring remains before the Phase 2 gate.

### Slice 2.15: authenticated bot identity is required

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'fails closed when users/me omits the authenticated user id'`.
- RED failure observed: setup resolved for a 200 response without a user ID and opened the socket.
- GREEN command: the same focused command after validating the identity response before WebSocket setup.
- GREEN result: 1 passed; invalid identity rejected safely and `openWebSocket` was never called.
- REFACTOR performed: extracted the authenticated ID without retaining the REST response body.
- Affected-suite verification: Mattermost client suite — 12 passed at completion of this slice; host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: the ID must accompany post-auth frames without exposing the raw socket.

### Slice 2.16: post-auth raw event subscription

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'forwards raw events only after authentication and unsubscribes on teardown'`.
- RED failure observed: the post-auth event callback remained at zero calls.
- GREEN command: the same focused command after installing a distinct listener only after the matching `OK` challenge.
- GREEN result: 1 passed; pre-auth and auth frames were not forwarded, a post-auth frame arrived once with the authenticated bot ID, and teardown prevented later delivery.
- REFACTOR performed: client owns and removes the event listener independently of the temporary authentication listener; the socket remains private.
- Affected-suite verification: Mattermost client + inbound suites — 27 passed immediately after the slice; targeted ESLint and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: no reconnect listener is introduced before Phase 8.

### Phase 2 refactor and fake-transport integration

- Pure refactor: extracted `normalizeMattermostPayload()` with discriminated accepted/ignored/rejected results and metadata separate from stateful deduplication, sink invocation, and logging.
- Refactor verification: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts` — 14 tests passed immediately after extraction; Prettier, targeted ESLint, and host typecheck passed after formatting/type cleanup.
- Fake transport characterization: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'routes an authenticated fake WebSocket post through the inbound processor'` — 1 passed.
- Integration result: authenticated fake socket → client listener → processor → NanoClaw inbound sink preserves channel and post identity with no adapter registration or outbound behavior.
- Affected verification: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts src/channels/mattermost-client.test.ts` — 2 files passed, 28 tests passed.

### Phase 2 gate

- Focused/affected command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts src/channels/mattermost-client.test.ts src/container-runner.isolation.test.ts src/channels/telegram.test.ts src/channels/telegram-pairing.test.ts src/channels/telegram-outbound.test.ts src/channels/telegram-markdown-sanitize.test.ts` — 7 files passed, 88 tests passed.
- Host fast-suite command: `pnpm test` — 40 files passed, 376 tests passed.
- Container command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` — 10 files passed, 103 tests passed.
- Formatting command: `pnpm run format:check` — passed.
- Lint command: `pnpm run lint` — passed with 0 errors and the same 100 pre-existing warnings documented in pre-flight.
- Host type-check command: `pnpm run typecheck` — passed.
- Container type-check command: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Isolation review: channel identity is namespaced by a validated instance key; sender/post/root identities remain distinct; contradictory mappings fail closed; Telegram paths are unchanged; the host-only bot token is absent from inbound events, logs, SQLite metadata, container environments, and mounts.
- Activation boundary: no `ChannelAdapter` is registered yet. Activating one before Phase 4 would either force the current per-thread session policy or discard `root_id`; both conflict with the binding channel-shared-session invariant. This phase therefore ends at the authenticated client → normalized inbound sink seam, and Phase 4 supplies the explicit thread/session policy before startup activation.
- Deferred work: bounded durable deduplication, reconnect, and replay behavior remain Phase 8 scope.
- Diff/secrets review: the Phase 2 commit contains only the authenticated-event callback, inbound normalizer/processor, focused tests, and this progress log; `git diff --check` passed; no real credentials, generated artifacts, outbound behavior, adapter activation, migrations, or unrelated changes are present.
- GitHub checks: the repository code `CI` workflow did not trigger because it is configured only for pull requests targeting `main`; the available `label` metadata check passed in 2 seconds ([run 29097109262](https://github.com/ufJmacca/nanoclaw/actions/runs/29097109262)).
- Phase status: complete; the full local gate and every available GitHub check passed; pull request ready for review.
- Pull request: [#39](https://github.com/ufJmacca/nanoclaw/pull/39), `codex/mattermost-02-inbound` → `codex/mattermost-01-auth` (depends on #38).

## Phase 3 — Outbound delivery

Phase status: in progress.

### Slice 3.1: stable outbox delivery identity reaches the delivery boundary

- RED command: `pnpm exec vitest run src/delivery.test.ts -t 'forwards the stable outbox message id as the delivery id'`.
- RED failure observed: the delivery adapter received only six arguments; the durable `messages_out.id` was missing.
- GREEN command: the same focused command after appending an optional delivery-ID argument to the host delivery boundary and forwarding `msg.id`.
- GREEN result: 1 passed; the adapter received `out-stable-delivery-id` alongside the original destination, content, and file arguments.
- REFACTOR performed: appended the optional parameter to preserve every existing adapter call signature and kept the identifier independent of message content, destination names, or credentials; no further structural change was needed for this slice.
- Affected-suite verification: `pnpm exec vitest run src/delivery.test.ts` — 4 passed; focused Prettier passed; targeted ESLint passed with 0 errors and the same 4 pre-existing warnings in `delivery.ts`; host typecheck passed.
- Bridge refactor: extracted the index delivery dispatch into `createChannelDeliveryBridge()` without changing routing, content parsing, typing, or missing-adapter behavior; `pnpm exec vitest run src/channels/delivery-bridge.test.ts src/delivery.test.ts` passed 5 tests after extraction.
- Characterization mutation: temporarily replaced parsed outbound content with an empty object; `pnpm exec vitest run src/channels/delivery-bridge.test.ts -t 'preserves existing outbound content and routing'` failed on the changed payload, then passed after the mutation was reverted.
- Files changed: `src/delivery.ts`, `src/delivery.test.ts`, `src/channels/delivery-bridge.ts`, `src/channels/delivery-bridge.test.ts`, `src/index.ts`.
- Remaining risks: the channel-adapter bridge must carry the ID into `OutboundMessage` before Mattermost can derive a stable `pending_post_id`.

### Slice 3.2: stable delivery identity reaches the channel adapter

- RED command: `pnpm exec vitest run src/channels/delivery-bridge.test.ts -t 'forwards the stable delivery id into the outbound message'`.
- RED failure observed: the bridge delivered parsed content but omitted `deliveryId` from `OutboundMessage`.
- GREEN command: the same focused command after adding the optional adapter field and carrying the host argument through the extracted bridge.
- GREEN result: 1 passed; `out-stable-delivery-id` reached the fake `ChannelAdapter` unchanged.
- REFACTOR performed: formatted the focused test and retained a single bridge conversion point for content, files, and stable identity; existing adapters remain source-compatible because the field is optional.
- Affected-suite verification: `pnpm exec vitest run src/channels/delivery-bridge.test.ts src/delivery.test.ts` — 2 files passed, 6 tests passed; focused Prettier passed; targeted ESLint passed with 0 errors and 6 existing warnings; host typecheck passed.
- Files changed: `src/channels/adapter.ts`, `src/channels/delivery-bridge.ts`, `src/channels/delivery-bridge.test.ts`.
- Remaining risks: Mattermost payload construction must require this ID before any POST.

### Slice 3.3: normal replies use the exact Mattermost channel

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'posts a normal reply to the exact Mattermost channel'`.
- RED failure observed: the Mattermost outbound delivery module did not exist, so no REST POST could occur.
- GREEN command: the same focused command after adding the minimal host-side delivery component.
- GREEN result: 1 passed; one `POST /api/v4/posts` used the configured bearer authentication, exact parsed channel ID, JSON content type, message text, and returned the server post ID.
- REFACTOR performed: separated destination parsing, text extraction, and response-ID validation into small pure helpers; errors contain status/shape metadata only and never response bodies, outgoing content, or credentials.
- Affected-suite verification: Mattermost outbound/client + host/adapter delivery suites — 4 files passed, 20 tests passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: thread placement, stable pending ID, retry policy, mass-mention policy, and full format/length validation follow as independent slices.

### Slice 3.4: thread replies preserve the original root

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'includes the original root id for a thread reply'`.
- RED failure observed: the POST body contained channel and message only; `root_id` was absent.
- GREEN command: the same focused command after conditionally mapping non-null delivery thread metadata into the Mattermost payload.
- GREEN result: 1 passed; a thread reply carried `root_id: root-post-id` while the normal root-post test remained green without a synthetic root.
- REFACTOR performed: kept root placement in payload construction only; it does not select a NanoClaw session or alter the Phase 4 policy boundary.
- Affected-suite verification: Mattermost outbound suite — 2 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: shared-session routing semantics are explicitly Phase 4; this slice only preserves delivery metadata.

### Slice 3.5: repeated delivery reuses a stable pending post ID

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'uses a stable pending post id for repeated delivery of one outbox message'`.
- RED failure observed: `pending_post_id` was `undefined` on both POST payloads.
- GREEN command: the same focused command after deriving a deterministic SHA-256-based ID from instance, immutable channel, root, and stable outbox identity.
- GREEN result: 1 passed; two deliveries of the same outbox message produced the same non-empty `nanoclaw-…` ID.
- REFACTOR performed: extracted `buildMattermostPendingPostId()` as a pure component; the input excludes message text, bot token, mutable names, and response data, and delivery fails closed if the host ID is absent.
- Affected-suite verification: Mattermost outbound + adapter/host delivery suites — 3 files passed, 9 tests passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: server acceptance with a lost response is covered by Phase 9 live contract tests; Phase 8 adds durable recovery beyond Mattermost's server-side pending-ID window.

### Slice 3.6: response headers survive the concrete host transport

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'normalizes response headers and tolerates a non-JSON rate-limit body'`.
- RED failure observed: parsing the non-JSON 429 body threw `SyntaxError`, and retry headers never reached delivery policy.
- GREEN command: the same focused command after normalizing response headers and treating only JSON syntax failure as an absent body.
- GREEN result: 1 passed; lowercase `retry-after` and `x-ratelimit-reset` values reached the transport response without reflecting the raw body.
- REFACTOR performed: isolated header normalization; unexpected parser failures still propagate instead of being swallowed.
- Affected-suite verification: Mattermost client + outbound suites — 2 files passed, 17 tests passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-client.ts`, `src/channels/mattermost-client.test.ts`.
- Remaining risks: delivery has not yet interpreted or bounded the guidance.

### Slice 3.7: HTTP 429 honors Retry-After

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'honors Retry-After guidance before retrying a rate-limited post'`.
- RED failure observed: delivery rejected immediately with `HTTP 429` instead of waiting and retrying.
- GREEN command: the same focused command after adding an injected sleeper and a three-attempt loop for valid numeric `Retry-After` guidance.
- GREEN result: 1 passed; delivery waited 2,000 ms, retried once, returned the successful post ID, and reused the byte-identical payload/pending ID.
- REFACTOR performed: parsed retry guidance in a pure helper and built the request once outside the loop so retries cannot drift.
- Affected-suite verification: Mattermost outbound + concrete client suites — 2 files passed, 18 tests passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: fallback guidance, hostile delay bounds, retryable 5xx, and exhaustion are separate slices.

### Slice 3.8: Mattermost reset guidance is the 429 fallback

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'falls back to Mattermost X-RateLimit-Reset guidance'`.
- RED failure observed: a 429 with only `X-RateLimit-Reset` failed immediately.
- GREEN command: the same focused command after preferring `Retry-After` and otherwise parsing Mattermost's reset value as delay seconds.
- GREEN result: 1 passed; the fallback waited 3,000 ms and retried once.
- REFACTOR performed: consolidated header precedence in `rateLimitDelayMs()` and retained one strict numeric parser.
- Affected-suite verification: Mattermost outbound suite — 5 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: the next slice clamps untrusted server values.

### Slice 3.9: rate-limit guidance is bounded

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'clamps untrusted rate-limit delays to a bounded maximum'`.
- RED failure observed: an untrusted `Retry-After: 999999` requested a 999,999,000 ms sleep.
- GREEN command: the same focused command after applying a configurable 30,000 ms default maximum.
- GREEN result: 1 passed; hostile guidance was clamped to 30,000 ms before reaching the sleeper.
- REFACTOR performed: kept the bound at the policy boundary and formatted the helper; no timer or server value is stored globally.
- Affected-suite verification: Mattermost outbound suite — 6 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: retry count and 5xx classification follow.

### Slice 3.10: retryable 5xx uses bounded exponential backoff

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'retries transient 5xx failures with bounded exponential backoff'`.
- RED failure observed: the first HTTP 500 rejected delivery immediately instead of retrying.
- GREEN command: the same focused command after classifying 500–599 as retryable within the existing bounded attempt loop.
- GREEN result: 1 passed; 500 → 502 → 201 waited 250 ms then 500 ms, made exactly three requests, reused one payload, and returned the post ID.
- Test-fixture correction before accepting Green: once delivery reached the final assertion, Vitest exposed unsupported `toHaveSize`; changed it to the equivalent typed `Set.size` assertion and reran the focused test.
- REFACTOR performed: extracted exponential delay calculation and shared the existing maximum delay/attempt policy.
- Affected-suite verification: Mattermost outbound suite — 7 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: permanent status handling and exhaustion must prove there is no infinite loop.

### Slice 3.11: permanent failures stop immediately and stay sanitized

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'does not retry permanent failures or expose response and credential data'` after resetting the not-yet-accepted classifier to retry 4xx–5xx.
- RED failure observed: HTTP 400 was requested 99 times instead of once.
- GREEN command/result: the same command after applying the minimal 500–599-only classifier — 1 passed; one request, zero sleeps, and a status-only error excluding token, outgoing content, and server body.
- REFACTOR performed: retained a narrow explicit 500–599 retry predicate; no response body enters errors or logs.
- Affected-suite verification: Mattermost outbound suite — 8 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.test.ts`; the production mutation was reverted.
- Remaining risks: exhaustion for retryable statuses is the next slice.

### Slice 3.12: retryable failures stop at the configured attempt bound

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'stops retryable failures at the configured attempt bound'` after resetting the not-yet-accepted final-attempt guard to allow another sleep.
- RED failure observed: the final 503 was replaced by a generic exhausted error after an extra sleep, violating the exact three-attempt boundary.
- GREEN command/result: the same focused command after applying the strict `attempt < maxAttempts` guard — 1 passed; a persistent 503 makes three requests and only two sleeps.
- REFACTOR performed: retained one attempt counter for both 429 and 5xx paths and status-preserving final failure.
- Affected-suite verification: Mattermost outbound suite — 9 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.test.ts`; the production mutation was reverted.
- Remaining risks: none for bounded HTTP-status retry count; transport-level reconnect/recovery is Phase 8.

### Slice 3.13: dangerous mass mentions are neutralized by default

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'neutralizes dangerous mass mentions by default'`.
- RED failure observed: `@channel`, `@ALL`, `@here`, and full-width `＠channel` reached the POST unchanged.
- GREEN command: the same focused command after adding the default sanitizer.
- GREEN result: 1 passed; a zero-width separator neutralized the four mass mentions while ordinary `@ada` remained unchanged.
- REFACTOR performed: extracted `sanitizeMattermostMassMentions()` as a pure, case-insensitive component and made the unsafe override an explicit host configuration flag.
- Affected-suite verification: Mattermost outbound suite — 10 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: explicit opt-in behavior needs its own proof.

### Slice 3.14: mass mentions require explicit host opt-in

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'allows mass mentions only with explicit host opt-in'` after resetting the not-yet-accepted override path to always sanitize.
- RED failure observed: the explicit `@channel` was neutralized instead of preserved.
- GREEN command/result: the same focused command after applying the explicit host-only branch — 1 passed; only explicit host opt-in permits the raw mass mention.
- REFACTOR performed: retained the unsafe choice solely in host configuration; message content cannot self-enable it.
- Affected-suite verification: Mattermost outbound suite — 11 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.test.ts`; the production mutation was reverted.
- Remaining risks: deployment configuration for this flag is deferred until adapter activation; the secure default requires no setting.

### Slice 3.15: outbound format selection is deterministic

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'prefers Markdown content and falls back to plain text predictably'`.
- RED failure observed: a payload containing both fields sent `Plain response` instead of the Markdown representation.
- GREEN command: the same focused command after applying an explicit `markdown`-then-`text` precedence.
- GREEN result: 1 passed; Markdown reached Mattermost unchanged and existing text-only tests stayed green.
- REFACTOR performed: retained format extraction in the pure content helper before mention sanitization and HTTP construction.
- Affected-suite verification: Mattermost outbound suite — 12 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: empty/invalid input and maximum Unicode length remain.

### Slice 3.16: invalid or empty content fails before HTTP

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'rejects missing, non-string, or empty content before HTTP'`.
- RED failure observed: an empty string was POSTed and returned `should-not-post` instead of rejecting.
- GREEN command: the same focused command after requiring a non-whitespace Markdown or text string.
- GREEN result: 1 passed across missing, non-string, empty text, and empty Markdown cases; zero HTTP requests were made.
- REFACTOR performed: one pure extraction path now handles precedence and validation without trimming valid output.
- Affected-suite verification: Mattermost outbound suite — 13 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: Unicode code-point limit is the final format constraint.

### Slice 3.17: Mattermost's Unicode code-point limit is enforced predictably

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'enforces the 16383 Unicode code-point limit before HTTP'`.
- RED failure observed: a 16,384-emoji message was POSTed and resolved instead of rejecting.
- GREEN command: the same focused command after validating the final sanitized message by Unicode code point.
- GREEN result: 1 passed; exactly 16,383 emoji posted once, while 16,384 rejected before a second HTTP request.
- REFACTOR performed: exported the server-aligned `MATTERMOST_MESSAGE_MAX_CODE_POINTS` constant and counted code points rather than UTF-16 code units; content is never silently truncated.
- Affected-suite verification: Mattermost outbound suite — 14 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: the live server boundary is Phase 9 contract-test scope.

### Slice 3.18: outbound destinations fail closed across instances or ambiguity

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'fails closed for cross-instance and ambiguous destinations before HTTP'` after adding whitespace, path-delimiter, and control-character cases.
- RED failure observed: a malformed channel component posted successfully as `should-not-post`.
- GREEN command/result: the same focused command after applying a safe opaque-ID grammar — 1 passed; wrong-instance, extra-delimiter, empty, whitespace, path-delimited, and control-character destinations make zero HTTP requests.
- REFACTOR performed: centralized one safe component grammar and retained exact `mattermost:<configured-instance>:<channel>` parsing as the only outbound authority.
- Affected-suite verification: Mattermost outbound suite — 18 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: none for outbound instance/channel ambiguity.

### Slice 3.19: delivery refuses an unstable idempotency identity

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'refuses delivery without the durable host outbox identity'` after resetting the not-yet-accepted stable-ID guard to missing.
- RED failure observed: the message POSTed successfully as `should-not-post` with an unstable empty-derived pending ID.
- GREEN command/result: the same focused command after applying the fail-closed guard — 1 passed; missing delivery identity makes zero HTTP requests.
- REFACTOR performed: kept the fail-closed guard immediately before pending-ID construction.
- Affected-suite verification: Mattermost outbound suite — 16 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.test.ts`; the production mutation was reverted.
- Remaining risks: none for required host idempotency input.

### Slice 3.20: ambiguous instance configuration fails closed

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'rejects an ambiguous configured instance key before HTTP'`.
- RED failure observed: `primary:shadow` was accepted as a configured instance and posted as `should-not-post`.
- GREEN command: the same focused command after applying the colon-free instance slug invariant before destination parsing.
- GREEN result: 1 passed; ambiguous configuration rejected before HTTP.
- REFACTOR performed: kept the same instance-key grammar established by inbound normalization and no mutable instance display name enters routing.
- Affected-suite verification: Mattermost outbound suite — 18 passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: none for configured-instance delimiter ambiguity.

### Slice 3.21: outbound transport failures are sanitized

- RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'redacts credential and content from transport failures'`.
- RED failure observed: the thrown error message and stack contained the bearer fixture and private outgoing content.
- GREEN command: the same focused command after replacing transport-boundary failures with a generic delivery request error and no sensitive cause.
- GREEN result: 1 passed; serialized error data excluded token, content, and authorization metadata.
- REFACTOR performed: kept sanitization at the host HTTP boundary so the existing delivery retry logger can safely record the error.
- Affected-suite verification: Mattermost outbound/client + adapter/host delivery suites — 4 files passed, 37 tests passed; focused Prettier, targeted ESLint, and host typecheck passed.
- Files changed: `src/channels/mattermost-outbound.ts`, `src/channels/mattermost-outbound.test.ts`.
- Remaining risks: transport-level retry/reconnect of thrown network failures is Phase 8 recovery scope.

### Phase 3 component refactor and TDD audit

- Payload-component RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'builds a validated post payload independently of HTTP delivery'`.
- Payload-component RED observed: `buildMattermostPostPayload` was not a function because payload validation/construction still lived inside `deliver()`.
- Payload-component GREEN: the same command after extracting the pure builder — 1 passed; the full outbound suite remained green.
- Retry-component RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'classifies retry delay independently of HTTP orchestration'`.
- Retry-component RED observed: `mattermostRetryDelayMs` was not a function because classification/delay logic still lived inside the orchestration loop.
- Retry-component GREEN: the same command after extracting the bounded pure policy — 1 passed; 429, 5xx, permanent, and final-attempt decisions are directly asserted.
- Idempotency characterization: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'derives idempotency identity independently of payload content'` — passed; temporarily removing channel identity from the hash made the test fail because channels A and B collided, then the reverted implementation passed.
- Independent components: `buildMattermostPostPayload()`, `mattermostRetryDelayMs()`, and `buildMattermostPendingPostId()` are now directly tested; `deliver()` owns only destination parsing, one request, bounded orchestration, sanitized transport errors, and response-ID validation.
- Review-driven TDD audit: the permanent-failure, retry-exhaustion, mass-mention opt-in, destination-validation, and stable-ID guards were each reset to their missing state, observed failing with their focused command, minimally restored, and rerun Green before accepting the phase.
- Refactor verification: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts` — 21 passed; focused Prettier, targeted ESLint, and host typecheck passed.

### Phase 3 gate

- Focused/affected command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts src/channels/mattermost-client.test.ts src/channels/delivery-bridge.test.ts src/delivery.test.ts src/channels/channel-registry.test.ts src/container-runner.isolation.test.ts src/channels/telegram.test.ts src/channels/telegram-pairing.test.ts src/channels/telegram-outbound.test.ts src/channels/telegram-markdown-sanitize.test.ts` — 10 files passed, 105 tests passed.
- Host fast-suite command: `pnpm test` — 42 files passed, 401 tests passed.
- Container command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` — 10 files passed, 103 tests passed.
- Formatting command: `pnpm run format:check` — passed.
- Lint command: `pnpm run lint` — passed with 0 errors and the same 100 pre-existing warnings documented in pre-flight.
- Host type-check command: `pnpm run typecheck` — passed.
- Container type-check command: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Refactor result: stable outbox identity now traverses one extracted channel-delivery bridge; pending-ID, validated payload construction, and bounded retry classification are deterministic host-side components with direct focused tests.
- Independent review: a read-only post-fix review reported no remaining actionable Phase 3 acceptance, isolation, correctness, scope, or TDD defect.
- Isolation review: outbound destinations require the configured instance and exact channel ID; root metadata never chooses a session; pending IDs include instance/channel/root/outbox identity but never content or token; errors exclude credentials/content; Telegram behavior and identities remain unchanged; no Mattermost configuration, token, workspace, mount, or container environment is introduced.
- Activation boundary: the Mattermost delivery component remains unregistered. Activating it before Phase 4 would still couple thread delivery to per-thread sessions, and before Phase 5 would permit unsafe generic wiring reuse.
- Deferred work: explicit thread/session policy is Phase 4; strict subscription identity is Phase 5; transport recovery is Phase 8; real-server post/idempotency validation is Phase 9.
