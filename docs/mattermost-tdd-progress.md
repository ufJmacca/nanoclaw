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

Phase status: complete.

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
- Diff/secrets review: the Phase 3 commits contain only stable delivery-ID plumbing, the extracted bridge, concrete HTTP response metadata, outbound delivery/components/tests, and this progress log; `git diff --check` passed; no real credentials, generated artifacts, adapter activation, migrations, container configuration, or unrelated changes are present.
- GitHub checks: the repository code `CI` workflow did not trigger because it is configured only for pull requests targeting `main`; the available `label` metadata check passed in 4 seconds ([run 29099975105](https://github.com/ufJmacca/nanoclaw/actions/runs/29099975105)).
- Phase status: complete; the full local gate, independent review, and every available GitHub check passed; pull request ready for review.
- Pull request: [#40](https://github.com/ufJmacca/nanoclaw/pull/40), `codex/mattermost-03-outbound` → `codex/mattermost-02-inbound` (depends on #39).

## Phase 4 — Decouple UI threading from context selection

Phase status: complete; pull request ready for review.

### Slice 4.1: Mattermost shared wiring owns one channel session

- RED command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'routes a channel root and its thread replies into one shared session'`.
- RED failure observed: a root post and its thread reply created two sessions because `supportsThreads: true` unconditionally forced per-thread context.
- GREEN command: the same focused command after adding explicit `force-per-thread | honor-wiring` capability and honoring the Mattermost fixture's shared wiring.
- GREEN result: 1 passed; both messages resolved to one session with `session.thread_id = NULL`.
- REFACTOR performed: appended an optional adapter capability with a legacy-compatible threaded default; delivery thread preservation remains controlled by `supportsThreads`.
- Affected-suite verification: thread-policy + host-core suites — 2 files passed, 26 tests passed; focused Prettier passed; targeted ESLint passed with 0 errors and 2 existing warnings; host typecheck passed.
- Files changed: `src/channels/adapter.ts`, `src/router.ts`, `src/router.thread-policy.test.ts`.
- Remaining risks: per-message root metadata, channel separation, legacy threaded behavior, Telegram behavior, and the concrete unregistered Mattermost adapter capability follow.

### Slice 4.2: shared context retains per-message root delivery metadata

- Test-fixture correction before evidence: the first query used the raw external post ID, while router rows are namespaced per agent; changed it to read the sole routed row, then established the valid characterization.
- Characterization command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'keeps root_id as per-message delivery metadata in the shared session'` — passed.
- RED mutation command: the same focused command after temporarily nulling the default delivery thread in `deliverToAgent()`.
- RED failure observed: the stored row's `thread_id` became `NULL` instead of `root-post-id`.
- GREEN command/result: the same focused command after reverting the mutation — 1 passed; the shared session stays threadless while its message retains the root.
- REFACTOR performed: session identity and delivery address remain separate values; the router never derives one from the other.
- Affected-suite verification: included in the current thread-policy suite; host typecheck remained green after Slice 4.1.
- Files changed: `src/router.thread-policy.test.ts`; the production mutation was reverted.
- Remaining risks: actual outbound POST composition with the stored row is verified after concrete adapter assembly.

### Slice 4.3: a second Mattermost channel stays in a distinct session

- Characterization command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'keeps a second Mattermost channel in a distinct session'` — passed.
- RED mutation command: the same focused command after temporarily forcing every messaging-group lookup to channel A.
- RED failure observed: channel B created no session and its work was misrouted to A.
- GREEN command/result: `pnpm exec vitest run src/router.thread-policy.test.ts` after reverting the mutation — 3 passed; A and B own distinct messaging groups, agent groups, and session IDs.
- REFACTOR performed: parameterized the fixture by immutable channel identity without introducing channel-name routing.
- Affected-suite verification: thread-policy suite — 3 passed.
- Files changed: `src/router.thread-policy.test.ts`; the production mutation was reverted.
- Remaining risks: Phase 5 makes this topology mandatory and transactionally enforced for real subscriptions.

### Slice 4.4: legacy threaded adapters still force per-thread context

- RED command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'keeps the legacy force-per-thread default for threaded adapters without a policy'` after resetting the not-yet-accepted default to honor wiring.
- RED failure observed: the root and thread reply collapsed into one session instead of the legacy two.
- GREEN command: the same focused command after restoring `force-per-thread` as the omitted-policy default for threaded adapters.
- GREEN result: 1 passed; the adapter without a policy created root and thread-scoped sessions exactly as before.
- REFACTOR performed: compatibility remains an explicit default decision rather than a change to every existing adapter fixture/plugin.
- Affected-suite verification: included in the current thread-policy suite.
- Files changed: `src/router.ts`, `src/router.thread-policy.test.ts`.
- Remaining risks: the duplicated policy resolution is extracted after Telegram compatibility is covered.

### Slice 4.5: Telegram behavior remains channel-scoped

- Characterization command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'keeps Telegram channel-scoped session and delivery behavior unchanged'` — passed.
- RED mutation command: the same focused command after temporarily disabling the non-threaded adapter normalization.
- RED failure observed: `ignored-telegram-thread` leaked into the stored message row instead of being stripped.
- GREEN command/result: `pnpm exec vitest run src/router.thread-policy.test.ts` after reverting the mutation — 5 passed; Telegram's session and message thread IDs remain `NULL`.
- REFACTOR performed: UI thread normalization remains a separate pre-routing decision from effective session mode.
- Affected-suite verification: thread-policy suite — 5 passed.
- Files changed: `src/router.thread-policy.test.ts`; the production mutation was reverted.
- Remaining risks: none for Telegram compatibility; the next refactor removes duplicated effective-policy calculation.

### Slice 4.6: session selection is a pure policy decision

- RED command: `pnpm exec vitest run src/router.thread-policy.test.ts -t 'resolves context mode independently from UI thread support'`.
- RED failure observed: `TypeError: resolveEffectiveSessionMode is not a function`; the router still embedded policy selection inside delivery orchestration.
- GREEN command/result: the same focused command after extracting the resolver — 1 passed, 5 skipped.
- REFACTOR performed: `resolveEffectiveSessionMode()` now accepts wiring mode, group scope, and explicit adapter policy; `resolveThreadSessionPolicy()` centralizes the compatibility default and both engage/accumulate paths reuse one decision.
- Affected-suite verification: `pnpm exec vitest run src/router.thread-policy.test.ts src/host-core.test.ts` — 2 files passed, 31 tests passed.
- Files changed: `src/router.ts`, `src/router.thread-policy.test.ts`.

### Slice 4.7: active-turn tools retain the current Mattermost root

- RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'keeps the active Mattermost root on a mid-turn send_message'`.
- RED failure observed: `send_message` returned an error because the shared session's immutable route has no thread-specific destination; no rooted outbound row was written.
- GREEN command/result: the same focused command after binding per-turn routing around `processQuery()` — 1 passed; the outbox row retained channel A and `root-post-id`.
- Cleanup characterization: `... -t 'does not retain a completed turn as the default send_message route'` passed before and after the change.
- Cleanup mutation proof: temporarily omitting `releaseActiveTurnRouting()` made the post-turn tool send succeed against stale channel A instead of returning an error; the cleanup was restored and the focused test passed.
- REFACTOR performed: current-turn routing is an explicit scoped binding; immutable `session_routing` remains only the fallback outside an active turn.
- Files changed: `container/agent-runner/src/outbound-files.ts`, `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Slice 4.8: accumulated context cannot choose the reply root

- RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'uses the newest wake-triggering message instead of accumulated context for reply routing'`.
- RED failure observed: routing selected older accumulated `root-a` instead of the wake-triggering `root-b`.
- GREEN command/result: the same focused command after selecting the newest `trigger=1` row — 1 passed; `root-b` and its inbound ID own the reply.
- REFACTOR performed: `extractRouting()` now documents and implements one deterministic chronological rule with a safe newest-row fallback for non-poll callers.
- Files changed: `container/agent-runner/src/formatter.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Slice 4.9: shared-query follow-ups advance root routing FIFO

- RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'advances reply and MCP routing when a second Mattermost root joins the shared query'`.
- RED failure observed: the initial reply, second-root `send_message`, and second result all carried `root-a`; expected roots were `root-a`, `root-b`, `root-b`.
- GREEN command/result: the same focused command after adding a routing-context FIFO synchronized with pushed prompts/results — 1 passed.
- REFACTOR performed: result/progress dispatch and active MCP routing now use the current queue head; a follow-up that arrives after the prior result immediately becomes current.
- Files changed: `container/agent-runner/src/outbound-files.ts`, `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Slice 4.10: roots never cross explicit destination channels

- RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'does not copy a Mattermost root onto a different destination channel'`.
- RED failure observed: an explicit send from channel A to channel B incorrectly copied `root-a` onto B.
- GREEN command/result: the same focused command after requiring channel type and platform ID equality before inheriting a root — 1 passed; B receives a rootless cross-channel message.
- REFACTOR performed: thread inheritance is now address-scoped and agent destinations are always unthreaded.
- Files changed: `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Slice 4.11: concrete Mattermost adapter declares and preserves the policy

- Capability RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'supports thread-aware delivery while honoring the shared wiring session'`.
- Capability RED observed: the concrete adapter module/factory did not exist, so the required Mattermost capability could only be faked in router tests.
- Capability GREEN: the same command after adding an unregistered adapter assembly — 1 passed; it advertises `supportsThreads=true` and `threadSessionPolicy='honor-wiring'`.
- Inbound RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'authenticates and forwards a Mattermost thread reply through the host setup boundary'`.
- Inbound RED observed: no authentication challenge or inbound callback occurred because setup was inactive.
- Inbound GREEN: the same command after composing the authenticated client and inbound normalizer — 1 passed; the host received the namespaced channel and original root.
- Outbound RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'delivers the shared-session reply with its per-message Mattermost root id'`.
- Outbound RED observed: adapter delivery rejected as inactive.
- Outbound GREEN: the same command after composing `MattermostOutboundDelivery` — 1 passed; the HTTP body contained channel A and `root_id=root-post-id`.
- Activation characterization: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'stays unregistered until strict subscription validation is available'` passed. Temporarily self-registering the adapter failed with `['mattermost']`; the registration mutation was reverted.
- REFACTOR performed: client, inbound normalization, and outbound delivery are composed behind `ChannelAdapter`, but the module is deliberately absent from `src/channels/index.ts` until Phase 5 closes generic wiring reuse.
- Files changed: `src/channels/mattermost-adapter.ts`, `src/channels/mattermost-adapter.test.ts`, `src/channels/adapter.ts`.

### Slice 4.12: interactive and scheduled current-conversation tools retain roots

- Card RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'keeps the active Mattermost root on a mid-turn send_card'`.
- Card RED observed: the card outbox row had `channel_type=NULL`, `platform_id=NULL`, and no root because interactive tools read only static session routing.
- Card GREEN: the same focused command after using the scoped resolver — 1 passed with the exact Mattermost channel/root.
- Schedule RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'keeps the active Mattermost root on a task scheduled mid-turn'`.
- Schedule RED observed: the scheduling system row had a null channel route and root.
- Schedule GREEN: the same focused command after sharing the active resolver — 1 passed with the exact channel/root.
- REFACTOR performed: `send_message`, `send_file`, `ask_user_question`, `send_card`, and `schedule_task` now share the same active-turn-first routing boundary; missing current destinations fail closed rather than writing ambiguous rows.
- Files changed: `container/agent-runner/src/mcp-tools/interactive.ts`, `container/agent-runner/src/mcp-tools/scheduling.ts`, `container/agent-runner/src/outbound-files.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Slice 4.13: cross-process and same-poll review hardening

- Independent-review finding: the first active-route binding was module-local, while production MCP tools run in a separate Bun process; same-poll trigger rows from different roots were also being collapsed into one provider turn.
- Cross-process RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'publishes active Mattermost routing for the separate MCP process'`.
- Cross-process RED observed: a child Bun process reading the shared outbound database saw `NULL` while the poll-loop process held channel A/root routing only in module memory.
- Cross-process GREEN: the same focused command after persisting the scoped route in `outbound.db.session_state` and reading it on every resolution — 1 passed; the independent process observed the exact channel/root tuple.
- Same-poll fixture correction: the first attempt imported a not-yet-present selector and could not execute, so it was not accepted as Red. An identity selector seam was added without changing behavior and the focused command was rerun.
- Same-poll RED command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts -t 'separates two same-poll Mattermost roots into ordered turns'`.
- Same-poll RED observed: the first turn contained accumulated context, root A, and root B instead of stopping before B; B would have been completed under A/B's single newest route.
- Same-poll GREEN: the same focused command after selecting one reply-address turn at a time — 1 passed; accumulated context + A form turn one and B remains turn two with its own root.
- REFACTOR performed: consecutive triggers are still batched when channel, platform, and root are identical, preserving the existing same-conversation batch behavior; a different route stays pending and enters the existing FIFO push/result queue on the next poll. Scoped route cleanup deletes the persisted row instead of restoring potentially stale crash state.
- Affected-suite verification: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/poll-loop.test.ts src/integration.test.ts` — 2 files passed, 31 tests passed, including the existing same-route multi-message batch.
- Files changed: `container/agent-runner/src/outbound-files.ts`, `container/agent-runner/src/poll-loop.ts`, `container/agent-runner/src/poll-loop.test.ts`.

### Phase 4 gate

- Focused/affected host command: `pnpm exec vitest run src/router.thread-policy.test.ts src/host-core.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts src/channels/mattermost-outbound.test.ts src/channels/mattermost-client.test.ts src/channels/delivery-bridge.test.ts` — 7 files passed, 87 tests passed.
- Host fast-suite command: `pnpm test` — 44 files passed, 411 tests passed.
- Container command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` — 10 files passed, 112 tests passed.
- Formatting command: `pnpm run format:check` — passed; changed container sources were also formatted explicitly with the repository Prettier version.
- Lint command: `pnpm run lint` — passed with 0 errors and the same 100 pre-existing warnings documented in pre-flight.
- Host type-check command: `pnpm run typecheck` — passed.
- Container type-check command: `pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit` — passed.
- Refactor result: platform reply placement, effective context/session selection, active-turn routing, and immutable session fallback are separate decisions. Mattermost preserves roots while honoring one shared channel wiring; legacy threaded adapters retain their default; Telegram remains threadless.
- Isolation review: channel A and B resolve distinct messaging/agent/session identities; root IDs never select an agent group or workspace; cross-destination sends cannot inherit another channel's root; active routes are scoped and released; neither the adapter configuration nor bot token reaches messages, prompts, SQLite routing metadata, mounts, or container environments.
- Activation boundary: the concrete Mattermost adapter is tested but remains unregistered and absent from the channel barrel. Phase 5 must install strict one-to-one subscription validation before activation, preventing generic approval from reusing a Telegram or Mattermost agent group.
- Operational impact: no migration, configuration, dependency, live connection, or credential is introduced. Existing threaded adapters keep their prior behavior unless they explicitly opt into `honor-wiring`.
- Diff/secrets review: `git diff --check` passed; only Phase 4 router/adapter/container routing tests and progress evidence are present; no real credentials, generated artifacts, runtime data, or unrelated changes were found.
- Independent review: the first review exposed the separate-MCP-process and same-poll multi-root gaps in Slice 4.13. A read-only post-fix re-review found no remaining actionable blocker and confirmed cross-process route visibility, stale-state deletion, FIFO turn selection, cross-destination root stripping, adapter non-registration, and isolation semantics.
- GitHub checks: the repository code `CI` workflow did not trigger because it is configured only for pull requests targeting `main`; the available `label` metadata check passed in 2 seconds ([run 29102770047](https://github.com/ufJmacca/nanoclaw/actions/runs/29102770047)).
- Phase status: complete; the full local gate, review-driven fixes, independent re-review, and every available GitHub check passed; pull request ready for review.
- Pull request: [#41](https://github.com/ufJmacca/nanoclaw/pull/41), `codex/mattermost-04-thread-session-policy` → `codex/mattermost-03-outbound` (depends on #40).

## Phase 5 — Strict channel subscription transaction

Phase status: complete; pull request ready for review.

### Slice 5.0: race-safe subscription identity schema

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'installs one-to-one subscription identity constraints'`.
- RED failure observed: `PRAGMA table_info('mattermost_subscriptions')` returned no columns; the strict subscription identity and uniqueness boundary did not exist.
- GREEN command/result: the same focused command after migration 014 — 1 passed.
- REFACTOR performed: the composite instance/channel key and unique messaging-group, agent-group, and wiring identities live in one dedicated table; lifecycle status values are explicit for later phases.
- Affected-suite verification: focused migration test passed; broader DB verification follows the first transactional behavior.
- Files changed: `src/db/migrations/014-mattermost-subscriptions.ts`, `src/db/migrations/index.ts`, `src/channels/mattermost-subscription.test.ts`.
- Isolation impact: database uniqueness now reserves one canonical messaging group, agent group, and wiring per strict subscription; no credentials or mutable channel name are stored.

### Slice 5.1: fresh channel and agent identities

- Messaging-group RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'creates a namespaced messaging group for channel A'`.
- RED failure observed: the strict subscription seam threw `Strict Mattermost subscription is not implemented`; no channel mapping existed.
- Messaging-group GREEN: the same command after creating `mattermost:<instance>:<channel>` inside a transaction — 1 passed.
- Agent-isolation RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'creates a fresh agent identity for each Mattermost channel without reusing Telegram'`.
- RED failure observed: both results had no agent group.
- Agent-isolation GREEN: the same command after deriving a fresh hash-scoped agent ID/folder per immutable instance/channel — 1 passed; A, B, and Telegram IDs/folders are distinct.
- REFACTOR performed: channel names remain display metadata; IDs and folders derive only from validated immutable coordinates.
- Files changed: `src/channels/mattermost-subscription.ts`, `src/channels/mattermost-subscription.test.ts`.

### Slice 5.2: one canonical shared wiring

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'creates exactly one shared channel-to-agent wiring and canonical subscription row'`.
- RED failure observed: the messaging group had zero wirings and no subscription row.
- GREEN command/result: the same focused command after inserting one safe wiring and its canonical identity row in the same transaction — 1 passed.
- REFACTOR performed: the wiring is `shared`, `sender_scope=known`, `ignored_message_policy=drop`, and pattern `.`; creation also produces only its normal same-channel destination row.
- Isolation impact: a strict subscription now owns exactly one messaging group, fresh agent group, shared wiring, and unique workspace folder.

### Slice 5.3: workspace creation and complete rollback

- Workspace RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'initializes one unique workspace identity for each subscribed channel'`.
- RED failure observed: the filesystem initializer was called zero times.
- Workspace GREEN: the same command after initializing the fresh agent group — 1 passed; A and B received distinct hash-scoped folders.
- Database rollback RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rolls back every database row when workspace initialization fails'`.
- RED failure observed: subscription, wiring, destination, messaging-group, and agent-group rows remained committed after the synthetic failure.
- Database rollback GREEN: the same command after moving filesystem initialization inside the immediate transaction — 1 passed; every count remained zero.
- Filesystem fixture correction: the first path-cleanup run used a hoisted mock factory that referenced a non-hoisted constant and was rejected as evidence; the fixture was corrected before rerunning.
- Filesystem cleanup RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'removes only newly-created workspace paths when initialization partially fails'`.
- RED failure observed: the synthetic partial group/state directories remained on disk.
- Filesystem cleanup GREEN: the same command after exact-path cleanup guarded by invocation-local ownership — 1 passed.
- Pre-existing identity RED/GREEN: `... -t 'fails closed without deleting a pre-existing workspace identity'` first completed without error, then passed after the transaction rejected the identity while preserving its foreign marker and creating zero rows.
- REFACTOR performed: rollback removes only paths proven absent before this invocation; it never deletes or inherits pre-existing context.

### Slice 5.4: validated idempotency and safe placeholder adoption

- Idempotency RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'returns the same validated mapping when the subscription is repeated'`.
- RED failure observed: the second call hit the messaging-group uniqueness constraint.
- GREEN command/result: the same command after reloading and fully validating the winner inside `BEGIN IMMEDIATE` — 1 passed; all topology counts and filesystem initialization remained one. A returned-object normalization mismatch for `denied_at` was corrected before accepting Green.
- Placeholder RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'adopts only a clean unwired placeholder previously observed by the router'`.
- RED failure observed: the deterministic insert collided with the already-observed platform identity.
- Placeholder GREEN: the same command after adopting only a zero-wiring placeholder, tightening it to strict policy, and clearing denial state — 1 passed; no second messaging group was created.
- Identity-validation RED/GREEN: `... -t 'rejects ambiguous subscription identity before any mutation'` first accepted `primary:shadow`, then passed after delimiter-safe bounded component validation; zero rows/files were touched.

### Slice 5.5: concurrent duplicate serialization

- Cross-process command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'serializes concurrent duplicate subscriptions into one valid mapping'` (run outside the process-spawn sandbox).
- Harness corrections before evidence: the `tsx` CLI IPC socket was sandbox-blocked, then child spawning itself was sandbox-blocked; neither run was accepted. The final harness uses Node's `--import` loader and six real concurrent processes against one file database.
- Characterization result: all six calls returned the same IDs and the database contained one subscription, messaging group, agent group, and wiring.
- RED mutation: replacing validated winner reload with a duplicate error made the same cross-process command fail when later contenders observed the winner.
- GREEN result: after reverting the mutation, all six processes passed again with one valid mapping.
- REFACTOR performed: `BEGIN IMMEDIATE`, database uniqueness, deterministic identities, and full winner validation form one race-safe boundary; no application-only pre-check decides ownership.

### Slice 5.6: malformed configuration fails before invocation

- Shared-agent RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a hand-written second-channel mapping before sender or agent invocation'`.
- RED failure observed: channel B reached sender resolution and would create a session/wake channel A's agent.
- GREEN command/result: the same command after installing the reusable strict validator at the router boundary — 1 passed; sender, session, and container invocation stayed untouched.
- Canonical-agent RED/GREEN: `... -t 'rejects a hand-written subscription that assigns a non-canonical agent identity'` first returned `valid:true` for an arbitrary Telegram-like agent, then returned `non_canonical_agent_identity` after deterministic ID/folder validation.
- Wiring-policy RED/GREEN: `... -t 'fails closed when the canonical wiring is weakened after subscription'` first accepted `sender_scope=all`, then returned `unsafe_wiring_policy` after canonical policy validation.
- Messaging-policy RED/GREEN: `... -t 'fails closed when the canonical messaging-group policy is weakened'` first accepted `public`, then returned `unsafe_messaging_group_policy` after strict group validation.
- Refactor result: one reason-coded validator checks active status, platform identity, canonical agent identity/folder, exact wiring ownership, shared mode, safe sender/engagement policy, forward count, and reverse agent reuse before routing.

### Slice 5.7: generic registration paths cannot bypass strict subscription

- Setup RED command: `pnpm exec vitest run setup/register.test.ts -t 'rejects Mattermost before a caller can select or reuse an agent folder'`.
- RED failure observed: the generic setup guard did not throw.
- Setup GREEN: the same command after calling the guard immediately after argument parsing — 1 passed; Telegram remains admitted.
- Legacy approval RED command: `pnpm exec vitest run src/modules/permissions/channel-approval.test.ts -t 'refuses a legacy generic approval row for Mattermost instead of reusing an agent'`.
- RED failure observed: the legacy pending row created a Mattermost-to-existing-agent wiring.
- Legacy approval GREEN: the same command after rejecting and deleting Mattermost rows at the generic response boundary — 1 passed; zero wirings were created.
- Unknown-channel characterization: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'keeps unknown Mattermost channels out of the generic approval flow'` passed. Temporarily bypassing strict router validation made the generic approval hook fire; the mutation was reverted.
- Isolation impact: only the strict transaction may create an active Mattermost mapping; generic setup and generic chat approval cannot select Telegram or another Mattermost agent.

### Slice 5.8: independent-review race and topology hardening

- Concurrent-cleanup RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'preserves a workspace created by a concurrent winner before this invocation owns initialization'`.
- RED failure observed: the losing invocation removed the winner's runtime marker (`expected true, received false`) because cleanup relied on a path snapshot taken before the database lock.
- GREEN command/result: the same command after exclusive directory claims and per-path ownership flags — 1 passed; a contender removes only roots it created. This is the genuine missing concurrent behavior for the Phase 5 concurrency requirement; the earlier mutation proof remains supplemental.
- Worker review reproduction: the reviewer observed `Unexpected end of JSON input` when piped worker stdout was lost. The fixture now uses synchronous `fs.writeSync(1, ...)`; the real six-process command passed with one mapping and identical returned identities.

- Stale-session placeholder RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects an unwired placeholder that already owns session context'`.
- RED failure observed: subscription completed and adopted a messaging group with an existing running session.
- GREEN command/result: the same command after requiring zero pre-existing sessions — 1 passed; the legacy session remained untouched.
- Destination-reference placeholder RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects an unwired placeholder referenced by an existing agent destination'`.
- RED failure observed: subscription adopted the referenced placeholder.
- GREEN command/result: the same command after requiring zero channel-destination references — 1 passed; only a truly inert observed row may be adopted.

- Outgoing-destination validator RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'fails closed when a strict Mattermost agent gains an outgoing agent destination'`.
- RED failure observed: the reusable validator returned `valid:true` with an agent-to-agent destination.
- GREEN command/result: the same command after requiring exactly one outgoing destination to the canonical channel — 1 passed with `unsafe_destination_topology`.
- Incoming-destination validator RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'fails closed when another agent gains a destination into a strict Mattermost agent'`.
- RED failure observed: the reusable validator returned `valid:true` for the incoming agent route.
- GREEN command/result: the same command after requiring zero incoming agent destinations — 1 passed with `unsafe_destination_topology`.

- Fan-out TOCTOU RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'uses only the validated canonical wiring if topology changes before fan-out'`.
- RED failure observed: a second wiring inserted from the sender-resolution seam received its own session and invocation after validation.
- GREEN command/result: the same command after routing with the exact validated wiring snapshot — 1 passed; only the canonical agent received a session/wake. The retained fixture drops the insert guard to simulate a legacy/tampered database and prove the runtime defense independently.
- Cross-platform RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a legacy Telegram wiring into a Mattermost-owned agent before sender resolution'`.
- RED failure observed: Telegram reached sender resolution and created a session over the Mattermost-owned agent/workspace.
- GREEN command/result: the same command after applying the symmetric Mattermost ownership boundary to every inbound messaging group — 1 passed; the legacy mapping was rejected as `cross_channel_agent_reuse` before sender/session/wake.

### Slice 5.9: database-enforced ownership reservation

- Active-insert topology RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a hand-written subscription row whose agent already has a second channel'`.
- RED failure observed: the active subscription row was inserted over a two-channel agent topology.
- GREEN command/result: the same command after an active-subscription topology trigger checks group policy, exact safe shared wiring, forward/reverse exclusivity, and destination topology — 1 passed with a database abort.
- Reserved-agent INSERT RED/GREEN: `... -t 'prevents a second channel wiring to a Mattermost-owned agent at the database boundary'` first completed without error, then passed after the reserved-agent wiring trigger.
- Reserved-group INSERT RED/GREEN: `... -t 'prevents a second agent wiring into a strict Mattermost messaging group at the database boundary'` first completed without error, then passed after the mirrored reserved-group trigger.
- Reserved-agent UPDATE RED/GREEN: `... -t 'prevents an existing generic wiring from being repointed to a Mattermost-owned agent'` first completed without error, then passed after the UPDATE guard.
- Reserved-group UPDATE RED/GREEN: `... -t 'prevents an existing generic wiring from being repointed into a strict Mattermost channel'` first completed without error, then passed after the mirrored UPDATE guard.
- Active canonical wiring RED/GREEN: `... -t 'prevents mutation of an active Mattermost canonical wiring at the database boundary'` first changed its messaging group, then passed after active canonical rows became immutable.
- Inactive canonical ownership RED/GREEN: `... -t 'keeps canonical wiring ownership immutable while a Mattermost subscription is inactive'` first repointed both owners, then passed after identity columns became immutable for every lifecycle status.

- Subscription identity RED/GREEN: `... -t 'keeps a Mattermost subscription ownership identity immutable at the database boundary'` first repointed `agent_group_id`, then passed after immutable instance/channel/group/agent/wiring identity triggers.
- Active-delete RED/GREEN: `... -t 'prevents deleting an active Mattermost ownership reservation'` first deleted the row, then passed after deletion was refused.
- Archived-delete RED/GREEN: `... -t 'retains an archived Mattermost ownership reservation so its workspace is never reassigned'` first deleted the archived row, then passed after the ownership reservation became permanent for every status.
- Reactivation RED/GREEN: `... -t 'revalidates canonical topology before an inactive subscription can become active'` first activated a weakened wiring, then passed after activation reused the complete topology validation trigger.
- Agent workspace RED/GREEN: `... -t 'keeps the Mattermost-owned agent workspace identity immutable'` first changed the folder to a Telegram-like shared path, then passed after agent ID/folder immutability.
- Messaging identity RED/GREEN: `... -t 'keeps the Mattermost messaging-channel identity immutable'` first changed the platform identity, then passed after messaging-group ID/channel/platform immutability.

- Outgoing destination INSERT RED/GREEN: `... -t 'prevents an outgoing agent destination from a Mattermost-owned agent at the database boundary'` first inserted the agent route, then passed after the canonical-channel-only trigger.
- Duplicate destination RED/GREEN: `... -t 'prevents a duplicate destination to the canonical Mattermost channel'` first inserted a second local name for the same channel, then passed after exact restoration was allowed only when no destination exists.
- Incoming destination INSERT RED/GREEN: `... -t 'prevents an incoming agent destination into a Mattermost-owned agent at the database boundary'` first inserted the incoming route, then passed after the target guard.
- Canonical destination UPDATE RED/GREEN: `... -t 'prevents mutation of an active Mattermost canonical destination at the database boundary'` first repointed it to an agent, then passed after active-row immutability.
- Canonical destination DELETE RED/GREEN: `... -t 'prevents deleting an active Mattermost canonical destination'` first deleted it, then passed after the active delete guard.
- Inactive destination ownership RED/GREEN: `... -t 'keeps canonical destination ownership immutable while a Mattermost subscription is inactive'` first repointed it, then passed after owner/type/target immutability for every status.
- Incoming destination UPDATE RED/GREEN: `... -t 'prevents an existing destination from being repointed into a Mattermost-owned agent'` first repointed a channel row into the strict agent, then passed after the incoming UPDATE guard.
- Outgoing owner UPDATE RED/GREEN: `... -t 'prevents an existing generic destination from being reassigned to a Mattermost-owned agent'` first changed its owner to the strict agent, then passed after the owner UPDATE guard.
- REFACTOR performed: one permanent ownership row, reason-coded application validator, validated runtime snapshot, and synchronized database triggers now enforce the same one-channel/one-agent/one-destination topology. Lifecycle fields remain mutable for Phase 7; identities are never reassigned.

### Slice 5.10: generic management and raw-row bypass closure

- Initial-card RED command: `pnpm exec vitest run src/modules/permissions/channel-approval.test.ts -t 'excludes Mattermost-owned agents from a generic channel approval card'`.
- RED failure observed: two agents caused a generic `choose_existing` option instead of exposing only the reusable non-Mattermost agent.
- GREEN command/result: the same command after filtering permanent Mattermost ownership rows — 1 passed; only `connect:ag-1` remained.
- Forged-connect RED command: `pnpm exec vitest run src/modules/permissions/channel-approval.test.ts -t 'rejects a forged generic connect response targeting a Mattermost-owned agent'`.
- RED failure observed: the handler reached the database trigger and threw instead of safely claiming/rejecting the forged response.
- GREEN command/result: the same command after an explicit response-boundary ownership guard — 1 passed; no wiring and no stale pending row remained.
- Follow-up RED command: `pnpm exec vitest run src/modules/permissions/channel-approval.test.ts -t 'excludes Mattermost-owned agents from a legacy choose-existing follow-up'`.
- RED failure observed: the follow-up included `connect:<mattermost-agent>`.
- GREEN command/result: the same command after reusing the ownership filter — 1 passed.
- Generic setup RED command: `pnpm exec vitest run setup/register.test.ts -t 'rejects a generic channel when its selected agent is owned by Mattermost'`.
- RED failure observed: the registration seam did not throw.
- GREEN command/result: the same command after checking permanent ownership before filesystem initialization — 1 passed; generic Telegram selection remains allowed for non-Mattermost agents.
- Raw-identity RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a hand-written subscription with an ambiguous instance identity'`.
- RED failure observed: a raw `primary:shadow` row with matching derived topology returned `valid:true`.
- GREEN command/result: the same command after reusing bounded delimiter-safe component validation for database rows — 1 passed with `unsafe_subscription_identity`.
- Focused strict-subscription verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts` (outside the spawn sandbox) — 1 file passed, 44 tests passed at that checkpoint; later trigger-focused additions are included in the final affected gate below.

### Phase 5 gate

- Focused/affected host command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts setup/register.test.ts src/router.thread-policy.test.ts src/host-core.test.ts src/modules/permissions/channel-approval.test.ts src/modules/permissions/permissions.test.ts src/db/db-v2.test.ts` — 7 files passed, 139 tests passed.
- Host fast-suite command: `pnpm test` (outside the process-spawn sandbox) — 46 files passed, 463 tests passed, including the six-process subscription race.
- Reference-schema command: `node --import tsx -e "import Database from 'better-sqlite3'; import { SCHEMA } from './src/db/schema.ts'; const db = new Database(':memory:'); db.exec(SCHEMA); console.log('schema-ok'); db.close();"` — passed with `schema-ok`.
- Container type-check command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun run typecheck` — passed.
- Container default-suite observation: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test` ran 111 tests successfully but twice timed out the unchanged Phase 4 shared-query test at 5.1 seconds. Its focused command passed in 0.75 seconds. Inspection showed that `src/integration.test.ts` leaves an intentionally infinite `runPollLoop()` alive after its `Promise.race` wrapper returns; the leaked loop consumes the next test file's database and message. No Phase 5 source or test participates in this failure, so no assertion, timeout, or unrelated lifecycle code was changed.
- Complete isolated container gate, unit portion: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/db/session-state.test.ts src/mcp-tools/deep-research-workflow.test.ts src/providers/codex.factory.test.ts src/providers/factory.test.ts src/providers/codex-app-server.test.ts src/providers/codex.test.ts src/poll-loop.test.ts src/timezone.test.ts src/formatter.test.ts` — 9 files passed, 109 tests passed.
- Complete isolated container gate, integration portion: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/integration.test.ts` — 1 file passed, 3 tests passed. Together the two clean processes execute the complete 10-file/112-test inventory with original assertions and timeouts.
- Formatting command: `pnpm run format:check` — passed; all Phase 5 sources and evidence were also formatted explicitly with the repository Prettier version.
- Lint command: `pnpm run lint` — passed with 0 errors and the same 100 pre-existing warnings documented in pre-flight.
- Host type-check command: `pnpm run typecheck` — passed.
- Diff validation: `git diff --check` — passed.
- Refactor result: deterministic identity derivation, transactional creation, complete reusable validation, exact validated routing snapshots, permanent database ownership triggers, generic-path filtering, and workspace ownership cleanup are separate boundaries with one shared strict topology contract.
- Isolation review: one Mattermost channel owns one canonical messaging group, fresh agent group, shared session wiring, workspace folder, canonical channel destination, and container/session identity. Mattermost-to-Mattermost and Telegram-to-Mattermost reuse fail before sender resolution or invocation. Threads can vary only the outbound `root_id` inside their channel's shared context. Ambiguous identities and malformed topology fail closed.
- Credential review: the subscription API accepts no bot token or Mattermost credential. The token is absent from prompts, message metadata, SQLite subscription state, mounts, workspace initialization, and container environments. A scan of every Phase 5 path found only explanatory progress-log references to token isolation from earlier phases; no credential value is present.
- Operational impact: migration 014 is append-only and transactional. It creates the strict ownership table plus topology-preserving triggers, and the synchronized reference schema executes cleanly in memory. No dependency, production connection, live credential, or automatic subscription command is introduced. Rollback is code rollback plus database restore; permanent ownership reservations are intentionally not deleted in place.
- Independent review: the final read-only re-review found no remaining Phase 5 correctness, security, migration, or isolation blocker. It independently passed 67 affected tests, the 463-test host suite, type checking, formatting, linting, and diff checks, and confirmed migration/reference-trigger parity. Exact lifecycle transitions, archived-state rules, stopping, replay, unsubscribe, and resubscribe remain scoped to Phase 7.
- GitHub checks: the repository code `CI` workflow did not trigger because it is configured only for pull requests targeting `main`; the available `label` metadata check passed in 3 seconds ([run 29125527546](https://github.com/ufJmacca/nanoclaw/actions/runs/29125527546)).
- Phase status: complete; the full local gate, review-driven fixes, independent re-review, and every available GitHub check passed; pull request ready for review.
- Pull request: [#42](https://github.com/ufJmacca/nanoclaw/pull/42), `codex/mattermost-05-strict-subscriptions` → `codex/mattermost-04-thread-session-policy` (depends on #41).

## Phase 6 — Container and context isolation proof

Phase status: complete; pull request ready for review.

### Slice 6.0: immutable active-container execution identity

- RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'rejects a reused session id that changes channel or agent identity'`.
- RED failure observed: the second wake resolved `true` for the already-active session ID even though its agent group and messaging group changed; the runner treated a different channel execution as the same container.
- GREEN command/result: the same focused command after binding active and in-flight entries to the complete session/agent/messaging-group/thread tuple — 1 passed; the collision returned `false`, spawned nothing, and did not create a second OneCLI identity.
- REFACTOR performed: one `ContainerExecutionIdentity` value and equality helper now guard both active and in-flight maps; legitimate duplicate wakes still share their original promise.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.isolation.test.ts` — 1 file passed, 4 tests passed; `pnpm run typecheck` — passed.
- Files changed: `src/container-runner.ts`, `src/container-runner.isolation.test.ts`.
- Isolation impact: a running or spawning container key cannot be rebound to work for another agent, channel, session context, or thread.

### Slice 6.1: canonical execution-session boundary

- Cross-channel RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a Mattermost-owned agent session bound to another channel'`.
- Cross-channel RED failure observed: the reusable execution validator did not exist, so a canonical agent could not be checked against its owning messaging group before execution.
- Cross-channel GREEN: the same focused command after resolving ownership from both agent and messaging-group directions — 1 passed with `session_identity_mismatch` for A-agent/B-channel reuse.
- Shared-session RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a per-thread session for a shared Mattermost channel'`.
- Shared-session RED failure observed: the validator returned `valid:true` for a strict session carrying a non-null root; the channel could acquire a second context identity.
- Shared-session GREEN: the same command after requiring `thread_id = NULL` for execution — 1 passed with `threaded_session`.
- Active-session RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a closed session for an active Mattermost subscription'`.
- Active-session RED failure observed: the closed session returned `valid:true`.
- Active-session GREEN: the same command after requiring an active session — 1 passed with `inactive_session`.
- Persistence RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'rejects a canonical-looking Mattermost session without a matching database record'`.
- Persistence RED failure observed: an unpersisted caller-constructed session returned `valid:true` solely because its visible channel and agent fields looked canonical.
- Persistence GREEN: the same command after comparing the exact agent, messaging-group, thread, and status tuple to the central `sessions` row — 1 passed with `session_record_mismatch`.
- Characterization/mutation proof: canonical persisted Mattermost and generic persisted Telegram tests initially passed. Temporarily returning `{ strict:false }` for the canonical strict path made `... -t 'accepts the persisted canonical shared Mattermost session'` fail (`strict:false` versus the required strict validated value); the mutation was reverted and both characterization tests passed again.
- REFACTOR performed: `validateMattermostSessionForExecution()` is one reusable, reason-coded boundary layered on the complete Phase 5 topology validator; Telegram remains on the generic path.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'Mattermost-owned agent session|per-thread session|closed session|canonical-looking Mattermost session|persisted canonical shared Mattermost session|persisted Telegram session'` — 6 tests passed; `pnpm run typecheck` — passed.
- Files changed: `src/channels/mattermost-subscription.ts`, `src/channels/mattermost-subscription.test.ts`.
- Isolation impact: only a persisted active shared session whose channel, agent, wiring, destination, and subscription all agree can cross an execution boundary.

### Slice 6.2: pre-side-effect invocation and delivery guards

- Container RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'rejects an invalid Mattermost session before container setup starts'`.
- Container RED failure observed: the malformed strict session returned `true` and reached routing/config/filesystem/OneCLI/spawn setup because `wakeContainer()` never consulted the execution-session boundary.
- Container GREEN: the same command after validating at the first line of `spawnContainer()` — 1 passed; the wake returned `false` with zero routing writes, config reads/writes, filesystem initialization, OneCLI calls, or process spawns.
- Delivery RED command: `pnpm exec vitest run src/delivery.test.ts -t 'rejects an invalid Mattermost session before draining its outbound queue'`.
- Delivery RED failure observed: the validator was never called and the malformed session proceeded toward its queued outbound message.
- Delivery GREEN: the same command after applying the shared boundary before agent lookup or database opening — 1 passed; the adapter was untouched and the outbound row was not marked delivered.
- REFACTOR performed: container setup and outbound drain reuse the same strict/session/topology decision instead of duplicating ownership queries; the generic Telegram path continues unchanged.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.isolation.test.ts src/delivery.test.ts` — 2 files passed, 10 tests passed; `pnpm run typecheck` — passed.
- Files changed: `src/container-runner.ts`, `src/container-runner.isolation.test.ts`, `src/delivery.ts`, `src/delivery.test.ts`.
- Isolation impact: malformed strict sessions fail before writable paths, container identities, scheduled system actions, channel delivery, or agent-to-agent routing can observe them.

### Slice 6.3: strict mount, credential, and launch isolation

- Global-context RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'does not expose legacy global context to a Mattermost container'`.
- Global-context RED failure observed: the strict launch included the synthetic marker-bearing `groups/global` source at `/workspace/global`; read-only access still leaked foreign context.
- Global-context GREEN: the same command after classifying the validated session before mount assembly — 1 passed; strict Mattermost omits the legacy mount. A generic-container characterization retained the read-only mount; temporarily disabling it made that test fail and the mutation was reverted.
- Additional-mount RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'refuses even read-only additional mounts for a Mattermost container'`.
- Additional-mount RED failure observed: a strict launch returned `true` with configured foreign context because the generic allowlist path silently filtered/accepted it.
- Additional-mount GREEN: the same command after rejecting any non-empty strict `additionalMounts` configuration before validation/OneCLI/spawn — 1 passed. Generic validated mounts remain supported; temporarily applying the rejection to every platform made the Telegram/generic characterization fail and was reverted.
- Provider-mount RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'rejects a provider mount outside its Mattermost-owned roots'`.
- Provider-mount RED failure observed: a writable provider directory outside the channel state/workspace roots reached the launch.
- Provider-mount GREEN at this checkpoint: the same command after symlink-aware containment checks against the strict channel's owned roots — 1 passed; a provider directory inside the session state root remained allowed. Slice 6.6 later tightened every platform/provider to the current session root only.
- Credential-key RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'rejects a Mattermost credential environment contribution before spawn'`.
- Credential-key RED failure observed: `MATTERMOST_BOT_TOKEN=<marker>` entered the rendered container environment and the launch returned `true`.
- Credential-key GREEN: the same command after rejecting provider environment keys in the `MATTERMOST*` namespace — 1 passed before gateway/spawn.
- Credential-alias RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'rejects the host Mattermost token when a provider aliases its environment key'`.
- Credential-alias RED failure observed: the same host token entered under `CUSTOM_PROXY_TOKEN` because only its key was checked.
- Credential-alias GREEN: the same command after comparing contributed values with host-side Mattermost credential values without logging them — 1 passed.
- Three-platform characterization: `... -t 'keeps Mattermost A, Mattermost B, and Telegram on distinct launch identities'` passed with three process launches, three active keys, three OneCLI agent IDs, and distinct `/workspace`, `/workspace/agent`, and `/home/node/.claude` writable sources. Temporarily mapping both strict group workspaces to one source made the test fail (`2` unique paths versus `3`); the mutation was reverted.
- REFACTOR performed at this checkpoint: the validated strict-session classification threads into mount assembly and provider host-path/environment checks share one fail-closed boundary. Later adversarial slices intentionally tightened generic provider mounts and cross-platform overlap while retaining safe Telegram routing and the characterized read-only global mount.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.isolation.test.ts` — 1 file passed, 14 tests passed at this checkpoint.
- Files changed: `src/container-runner.ts`, `src/container-runner.isolation.test.ts`.
- Isolation impact: A, B, and T have distinct writable state, workspaces, provider state, OneCLI identities, and active execution keys; strict containers cannot see shared legacy context, user-added mounts, or the host Mattermost token.

### Slice 6.4: agent-to-agent entry-point isolation

- Creation RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t 'rejects before creating an orphan agent, workspace, or destination'`.
- Creation RED failure observed: `handleCreateAgent()` created the child agent and initialized its workspace before migration 014 rejected the destination insert with `SQLITE_CONSTRAINT_TRIGGER`; the operation rejected after leaving partial state.
- Creation GREEN: the same command after an ownership guard immediately after source lookup — 1 passed; the handler returned normally with no child row, filesystem initialization, or extra destination.
- Outbound-route RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t 'rejects a Mattermost-to-agent route before creating a target session'`.
- Outbound-route RED failure observed: with the insertion trigger temporarily removed to model legacy corruption, the route resolved and created a generic target session.
- Outbound-route GREEN: the same command after rejecting non-self routes from a Mattermost-owned source — 1 passed before target session/message/wake creation.
- Inbound-route RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t 'rejects a generic-agent route into Mattermost before creating target context'`.
- Inbound-route RED failure observed: with the incoming trigger temporarily removed, a generic source created an agent-shared session inside the strict Mattermost agent.
- Inbound-route GREEN: the same command after the mirrored target-ownership guard — 1 passed with no target session or wake.
- Self-route RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t 'keeps a Mattermost self-message inside its canonical session'`.
- Self-route RED failure observed: the first broad source guard rejected the existing same-agent system-note path as well as cross-agent routes.
- Self-route GREEN: the same command after limiting the ownership guard to non-self routes — 1 passed; the note stayed in the one canonical session and created no second context.
- Generic characterization/mutation proof: generic A-to-B routing passed. Temporarily rejecting every non-self route made `... -t 'preserves generic agent-to-agent routing outside Mattermost'` fail; the mutation was reverted and generic routing passed again.
- REFACTOR performed: strict source and target checks share one non-self predicate; database triggers remain the durable topology layer while these early guards prevent partial runtime/filesystem state.
- Affected-suite verification: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts src/modules/agent-to-agent/agent-route.test.ts` — 2 files passed, 11 tests passed; `pnpm run typecheck` — passed after correcting the controlled-launch test's mock-call type annotation.
- Files changed: `src/modules/agent-to-agent/create-agent.ts`, `src/modules/agent-to-agent/agent-route.ts`, `src/modules/agent-to-agent/create-agent.test.ts`.
- Isolation impact: Mattermost cannot create or address another agent and no generic agent can address Mattermost, even against hand-edited legacy destination data; internal self-notes remain channel-local.

### Slice 6.5: real A/B/Telegram structural and semantic proof

- Structural characterization: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t 'creates disjoint channel, session, workspace, and fake-launch identities'` passed using a migrated temporary central database, real per-session databases/filesystems, and only a fake container launcher. A, B, and T had three messaging groups, agent groups/folders, session IDs/directories, workspaces, `.claude-shared` paths, active fake-launch keys, and platform-specific inbound histories.
- Required session-resolution mutation: temporarily mapping every `sessionDir()` call to one shared directory made the structural test fail (`1` unique directory versus `3`); the mutation was reverted and the test passed again.
- Schedule RED command: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t 'rejects a forged cross-channel Mattermost schedule route'`.
- Schedule RED failure observed: channel A's handler resolved normally and inserted a task whose action payload named channel B because scheduling ignored the owning session.
- Schedule GREEN: the same command after reusing the execution-session boundary and requiring the canonical Mattermost platform ID — 1 passed; the forged task count remained zero.
- Root RED command: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t 'rejects an unobserved Mattermost root on an otherwise canonical schedule route'`.
- Root RED failure observed: a task with channel A's canonical platform ID but a root never observed in A resolved normally and was inserted.
- Root GREEN: the same command after checking non-null scheduled roots against A's own inbound history — 1 passed with zero inserted tasks. A valid task using an observed A root remains accepted.
- Schedule/destination characterization: `... -t 'keeps schedules and projected destinations in their owning session'` passed. A, B, and T each had only its own task route/root, one projected same-channel destination, and one matching central channel destination; no agent or foreign channel appeared.
- Semantic fixture correction: the first marker run omitted the required `session_state.updated_at` value and failed at fixture insertion. It was rejected as evidence and corrected before rerunning.
- Semantic characterization: `... -t 'keeps synthetic context markers and the host token out of foreign model inputs and files'` passed with runtime-generated A/B/T markers and a runtime-generated token. Actual formatter model input, inbound history, provider continuation state, group workspace, session tree, and `.claude-shared` state contained only the owning marker; all foreign markers and the token were absent. Central subscription/session/group/channel/destination rows also excluded the token.
- Active reuse RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'revalidates a Mattermost session before reusing its active container'`.
- Active reuse RED failure observed: after the subscription validator changed to `inactive_subscription`, the same session still returned `true` because the active-map shortcut ran before validation.
- Active reuse GREEN: the same command after validating before every active/in-flight lookup — 1 passed; reuse returned `false` and no second spawn occurred. Spawn setup still revalidates immediately before side effects.
- REFACTOR performed: the integration fixture exercises real subscription, router, session, scheduling, destination projection, formatter, filesystem, and SQLite boundaries with one common A/B/T topology; marker scans are deterministic and skip symlink traversal.
- Affected-suite verification: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts` — 1 file passed, 5 tests passed; `pnpm run typecheck` — passed after replacing cross-root static formatter imports with the test runner's runtime import (the real formatter still executes).
- Files changed: `src/mattermost-isolation.integration.test.ts`, `src/modules/scheduling/actions.ts`, `src/container-runner.ts`, `src/container-runner.isolation.test.ts`.
- Isolation impact: scheduled work, destination maps, prompts, histories, provider state, memory files, and repeated container wakes remain bound to one canonical channel; the host token reaches none of them.

### Slice 6.6: adversarial fail-closed boundary review

- Orphan-channel RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "fails closed for a persisted session on an unsubscribed Mattermost messaging group"`.
- Orphan-channel RED failure observed: the persisted session returned `{ strict:false }` because neither side had a subscription row, even though the referenced messaging group was `channel_type='mattermost'`.
- Orphan-channel GREEN: the same command after classifying the referenced channel before the generic fallback — 1 passed with `missing_subscription`.
- Orphan-agent RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "fails closed when an agent-shared session belongs to an agent wired to unsubscribed Mattermost"`.
- Orphan-agent RED failure observed: a persisted `messaging_group_id=NULL` session on an agent wired to an unsubscribed Mattermost group also returned `{ strict:false }`.
- Orphan-agent GREEN: the same command after deriving Mattermost affiliation from both permanent subscription ownership and any Mattermost wiring — 1 passed with `missing_subscription`; the persisted Telegram characterization remained generic.
- Cross-platform orphan RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "rejects Telegram routing into an agent also wired to an unsubscribed Mattermost channel"`.
- Cross-platform orphan RED failure observed: Telegram reached sender resolution through the same agent because the routing boundary considered only canonical subscription rows.
- Cross-platform orphan GREEN: the same command after inspecting every current agent's permanent reservation and other Mattermost wiring — 1 passed before sender resolution, session creation, or wake.
- Ownership-reservation RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "retains Mattermost ownership when a reserved subscription topology is corrupted"`.
- Ownership-reservation RED failure observed: after a controlled legacy mutation changed the canonical messaging-group type, the subscription-reserved agent was reported as non-Mattermost.
- Ownership-reservation GREEN: the same command after unioning the permanent reservation with live Mattermost wiring — 1 passed. The real ownership-enumeration test was also proven by temporarily returning an empty set; it failed with `[]` instead of the canonical agent/folder and passed after the mutation was reverted.
- Provider-identity RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "rejects a Mattermost execution identity whose provider differs from the persisted session"`.
- Provider-identity RED failure observed: a caller-supplied `agent_provider='codex'` was accepted against a persisted null provider because the stored-tuple comparison omitted the provider.
- Provider-identity GREEN: the same command after including `agent_provider` in the immutable session tuple — 1 passed with `session_record_mismatch`.
- Unsafe-ID RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "rejects a persisted Mattermost session id that can escape its channel state directory"`.
- Unsafe-ID RED failure observed: persisted ID `../foreign-agent/foreign-session` validated successfully and could escape `v2-sessions/<agent>` during path construction.
- Unsafe-ID GREEN: the same command after applying the bounded identity-component policy to strict session IDs — 1 passed with `unsafe_session_identity`.
- Duplicate-session RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "rejects duplicate active shared sessions for one Mattermost channel"`.
- Duplicate-session RED failure observed: both active null-thread rows independently validated, allowing one channel to acquire two execution streams over one workspace and shared memory.
- Duplicate-session GREEN: the same command after requiring exactly one active row across the union of canonical agent and messaging-group ownership — 1 passed with `duplicate_active_session`.
- Filesystem-symlink RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t "rejects a canonical Mattermost session whose state directory was replaced by a symlink"`.
- Filesystem-symlink RED failure observed: replacing the canonical session directory with a symlink to foreign state still returned `valid:true`.
- Filesystem-symlink GREEN: the same command after checking every component and canonical path below trusted group/session roots — 1 passed with `unsafe_session_path`. A workspace-symlink characterization was proven by temporarily removing the group-root check: it returned `valid:true`, then passed after the check was restored.
- Mounted-config credential-key RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a Mattermost credential key in mounted MCP container configuration"`.
- Mounted-config credential-key RED failure observed: an MCP `MATTERMOST_BOT_TOKEN` environment entry reached launch and returned `true` because only provider contributions were scanned.
- Mounted-config credential-key GREEN: the same command after recursively rejecting the Mattermost namespace before config mutation/composition/mounting — 1 passed with no config write, gateway call, or spawn.
- Mounted-config credential-value mutation proof: temporarily removing the host-credential value scan made `... -t "rejects an aliased host Mattermost credential in mounted MCP instructions"` fail because launch returned `true`; restoring the scan made the test pass before prompt composition or spawn.
- Generic additional-mount RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a generic additional mount that exposes a Mattermost-owned workspace"`.
- Generic additional-mount RED failure observed: a Telegram container launched with the exact Mattermost workspace as an allowed read-only extra mount.
- Generic additional-mount GREEN: the same command after comparing every assembled source against all permanently Mattermost-owned group/state roots in both ancestor directions — 1 passed before OneCLI or spawn.
- Generic provider-mount mutation proof: moving the ownership-overlap check before provider mounts made `... -t "rejects a generic provider mount that exposes Mattermost-owned state"` fail with a successful launch; restoring the final assembled-mount check made both generic additional/provider overlap tests pass.
- Provider confinement RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "confines generic provider mounts to the current session state root"`.
- Provider confinement RED failure observed: a generic custom provider could mount an arbitrary external host directory.
- Provider confinement GREEN: the same command after applying current-session real-path containment to every platform/provider — 1 passed; the built-in-compatible provider path inside the current session remained green.
- Subscription-race RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "fails closed when a Mattermost subscription is invalidated during"`.
- Subscription-race RED failures observed: both deferred `ensureAgent` and `applyContainerConfig` cases launched and returned `true` after the validator changed to `inactive_subscription` during the await.
- Subscription-race GREEN: the same two-case command after final synchronous execution-boundary validation — 2 passed with zero process spawns.
- Active-invalidation RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "terminates an active Mattermost container when its canonical subscription becomes invalid"`.
- Active-invalidation RED failure observed: reuse returned `false`, but the already-running child was not stopped and remained able to poll pending work.
- Active-invalidation GREEN: the same command after stopping only an identity-equal active entry — 1 passed; a forged session-ID collision cannot terminate the unrelated canonical child.
- Mount-race RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a provider mount replaced with a foreign symlink during asynchronous launch setup"`.
- Mount-race RED failure observed: swapping the validated provider directory for a foreign symlink while OneCLI awaited still launched and returned `true`.
- Mount-race GREEN: the same command after revalidating provider containment and complete Mattermost mount ownership after all awaits — 1 passed with zero process spawns.
- REFACTOR performed: permanent Mattermost affiliation/ownership queries now serve routing, execution, early module guards, and mount isolation; filesystem checks separate trusted roots from owned non-symlink components; provider/config credential scans share one host-secret value source; and pre-spawn validation is repeated after every asynchronous setup boundary.
- Affected-suite verification: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts src/container-runner.isolation.test.ts src/channels/mattermost-subscription.test.ts src/delivery.test.ts src/modules/agent-to-agent/create-agent.test.ts src/modules/agent-to-agent/agent-route.test.ts src/modules/scheduling/db.test.ts src/router.thread-policy.test.ts src/host-core.test.ts` — 9 files passed, 148 tests passed at this checkpoint (three later characterization tests were added after this run).
- Static verification: `pnpm run typecheck` and `pnpm run format:check` passed; `pnpm run lint` passed with 0 errors and the same 100 pre-existing warnings; `git diff --check` passed.
- Isolation impact: malformed, orphaned, duplicated, path-escaping, symlinked, cross-platform, stale-during-launch, and credential-bearing identities now fail closed before a container can observe another Mattermost channel's workspace, state, prompt material, token, or execution stream.

### Slice 6.7: hostile host-artifact and message-route hardening

- Provider-context RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "withholds host Mattermost credentials from provider callback context"`.
- Provider-context RED failure observed: a custom provider read `MATTERMOST_BOT_TOKEN` directly from its raw `process.env` context and copied it into a session-local file before post-contribution checks ran.
- Provider-context GREEN: the same command after supplying a copy with the Mattermost namespace and aliased Mattermost credential values removed — 1 passed; no file was created and a safe provider still launched.
- Derived-config RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects host-derived runtime identity fields containing the Mattermost credential"`.
- Derived-config RED failure observed: a token-valued agent name passed the pre-mutation scan, was written as `groupName`/`assistantName`, reached OneCLI, and launched.
- Derived-config GREEN: the same command after populating identity fields in memory, rescanning, and only then persisting — 1 passed with no config write, gateway call, or spawn.
- Missing-provider-source RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a nonexistent provider mount below a symlinked session child"`.
- Missing-provider-source RED failure observed: lexical fallback accepted `session/link/new-state` while `link` pointed outside the session and the leaf did not yet exist.
- Missing-provider-source GREEN: the same command after requiring every provider mount source to exist and resolve inside the current session — 1 passed before OneCLI/spawn.
- Shared-memory-symlink RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a symlinked Mattermost shared-memory directory before filesystem mutation"`.
- Shared-memory-symlink RED failure observed: `.claude-shared -> Telegram state` launched and skill synchronization created a foreign `skills` directory.
- Shared-memory-symlink GREEN: the same command after no-follow validation of group, shared-memory, session, database, config, fragment, and provider-managed child paths before any initialization/provider/composition side effect — 1 passed with the foreign directory unchanged.
- Container-config-symlink mutation proof: temporarily omitting `container.json` from the host-managed path set made `... -t "rejects a symlinked Mattermost container config before reading or rewriting foreign state"` launch successfully; restoring the check made it fail closed before read/write/OneCLI while preserving foreign bytes.
- Skill-traversal RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a traversing skill name before it can write another channel state directory"`.
- Skill-traversal RED failure observed: configured `../../../<B>/.claude-shared/foreign-link` was joined beneath A's writable skills directory and created the link in B before spawn.
- Skill-traversal GREEN: the same command after requiring every configured skill to be one bounded path component — 1 passed with no B write, OneCLI call, or spawn.
- Stale-child RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "ignores stale child callbacks after a replacement container becomes active"`.
- Stale-child RED failure observed: after child B replaced failed child A for one session, A's late `close` callback unconditionally deleted B's active-map entry, permitting a third concurrent child.
- Stale-child GREEN: the same command after process-identity comparison in both callbacks — 1 passed; B stayed active and the third wake reused it.
- Raw-config RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a host Mattermost credential hidden in an unknown raw container-config field"`.
- Raw-config RED failure observed: normalization discarded the unknown token field while Docker still mounted the original token-bearing bytes and launch returned `true`.
- Raw-config GREEN: the same command after scanning the exact mounted artifact before normalization — 1 passed before write, OneCLI, or spawn.
- Config-TOCTOU RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects container-config credential injection during asynchronous launch setup"`.
- Config-TOCTOU RED failure observed: replacing safe config bytes with an aliased MCP credential while `ensureAgent` awaited still spawned.
- Config-TOCTOU GREEN: the same command after pinning exact post-runtime config bytes and checking them after provider setup and every OneCLI await — 1 passed with zero spawns.
- Wrapped-provider RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a host Mattermost credential wrapped inside a provider environment value"`.
- Wrapped-provider RED failure observed: `CUSTOM_AUTHORIZATION=Bearer <token>` bypassed exact-value comparison and entered launch args.
- Wrapped-provider GREEN: the same command after substring comparison against every host Mattermost credential — 1 passed before gateway/spawn.
- Final-args RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a Mattermost credential injected into final launch arguments by the gateway"`.
- Final-args RED failure observed: OneCLI appended a wrapped token after provider/config checks and the final Docker argv launched.
- Final-args GREEN: the same command after scanning every final argument without logging values — 1 passed with zero spawns.
- Compatibility RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "allows a benign MCP server named mattermost when it contains no credential"`.
- Compatibility RED failure observed: the recursive namespace scan rejected the harmless server-name key and returned `false`.
- Compatibility GREEN: the same command after narrowing key rejection to credential-bearing Mattermost names while retaining exact secret-value scans — 1 passed and spawned normally.
- Cross-platform nested-root RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a Mattermost workspace that contains another platform agent workspace"`.
- Cross-platform nested-root RED failure observed: A launched with Telegram's malformed nested workspace visible inside A's writable group mount because the inventory included only Mattermost ownership.
- Cross-platform nested-root GREEN: the same command after comparing every assembled mount in both ancestor directions against every other agent group/state root — 1 passed before OneCLI/spawn.
- Stacked-session self-route RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t "rejects Mattermost self-routing when a duplicate active session makes ownership ambiguous"`.
- Stacked-session self-route RED failure observed: `routeAgentMessage()` re-resolved the newest duplicate session and wrote/woke it instead of rejecting ambiguity.
- Stacked-session self-route GREEN: the same command after validating the supplied source session at entry and using that exact canonical session for strict self-routing — 1 passed with neither session modified or woken.
- Outbound-root RED command: `pnpm exec vitest run src/delivery.test.ts -t "rejects a Mattermost outbound root that was observed only outside its canonical channel"`.
- Outbound-root RED failure observed: A's outbound row carrying B-only `root-b` reached the adapter with that `root_id`.
- Outbound-root GREEN: the same command after requiring strict channel/platform equality and same-session canonical-root observation — 1 passed with the adapter untouched; a canonical A-observed root characterization delivered with the correct `root_id`.
- Foreign-reply RED command: `pnpm exec vitest run src/router.thread-policy.test.ts -t "rejects foreign replyTo metadata before creating Mattermost channel context"`.
- Foreign-reply RED failure observed: A accepted B's `replyTo`, created A's session, and wrote the foreign route into A's model context.
- Foreign-reply GREEN: the same command after requiring strict `replyTo` channel, platform, and root to equal the canonical inbound route before session resolution — 1 passed with no A/B session or message.
- Host-DB RED command: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t "rejects a host inbound write redirected through another channel database symlink"`.
- Host-DB RED failure observed: replacing A's `inbound.db` with a symlink to B made `writeSessionMessage(A)` write directly into B without throwing.
- Host-DB GREEN: the same command after pre-open non-symlink, regular-file, single-link, real-path, ancestor, and SQLite-sidecar checks at every host database open — 1 passed with B's count/content unchanged.
- Read-only inbound mutation proof: temporarily removing the nested inbound bind made `pnpm exec vitest run src/container-runner.isolation.test.ts -t "shadows the host-owned inbound database with a read-only nested mount"` fail because `/workspace/inbound.db` was exposed only through the writable session mount; restoring it passed with an explicit read-only nested source and no writable duplicate.
- REFACTOR performed: host-derived config is now validated as a pinned artifact; all provider inputs/outputs/final argv share one secret boundary; host-managed paths reject symlink components before mutation; every other agent root participates in mount overlap; active callbacks retain process identity; strict message roots are checked at ingress and egress; and host-owned SQLite artifacts receive pre-open identity checks while the inbound database is nested read-only in the container.
- Affected-suite verification: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts src/container-runner.isolation.test.ts src/channels/mattermost-subscription.test.ts src/delivery.test.ts src/modules/agent-to-agent/create-agent.test.ts src/modules/agent-to-agent/agent-route.test.ts src/modules/scheduling/db.test.ts src/router.thread-policy.test.ts src/host-core.test.ts` — 9 files passed, 169 tests passed.
- Full host gate: `pnpm test` outside the filesystem sandbox — 48 files passed, 531 tests passed.
- Static gate: `pnpm run typecheck` and `pnpm run format:check` passed; `pnpm run lint` passed with 0 errors and the same 100 pre-existing warnings.
- Isolation impact: the host token cannot reach provider callbacks, derived config, raw config, prompts, gateway-mutated argv, or provider env; no agent can expose another platform's nested root; strict ingress/egress roots remain channel-local; and neither a container nor a symlink/hardlink can redirect host-owned database IO into another session.

### Slice 6.8: post-provider, attachment, and filesystem-race closure

- Post-provider path RED commands:
  - `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a traversing MCP server name before prompt-fragment composition"` — a `../` MCP name reached fragment-path construction instead of failing before composition.
  - `pnpm exec vitest run src/container-runner.isolation.test.ts -t "revalidates host-managed paths after provider callbacks and before skill writes"` — a provider replaced a validated host-managed directory during its callback and later skill synchronization followed it.
  - `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a symlinked provider auth child before the provider can overwrite foreign state"` — a provider-managed auth child symlink remained writable after only its parent was validated.
  - `pnpm exec vitest run src/container-runner.isolation.test.ts -t "rejects a provider mount that creates an alternate writable view of host inbound state"` — the provider could expose `inbound.db` through a second writable container path despite the canonical nested read-only bind.
- Post-provider path GREEN: the same focused commands passed after applying bounded MCP/skill names, repeating host-managed no-symlink validation after provider callbacks, checking provider-managed children before the callback, and rejecting any provider mount that overlaps the host-owned inbound artifact. Provider contributions are rechecked before skill writes and immediately before spawn.
- Wrapped host-environment RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t "withholds host variables that wrap a Mattermost credential from provider callbacks"`.
- Wrapped host-environment RED failure observed: the provider callback received `Authorization=Bearer <host-token>` because the sanitized callback environment removed only exact credential values.
- Wrapped host-environment GREEN: the same command passed after removing any callback environment value containing a host Mattermost credential; a generic provider contribution containing the host token is independently rejected.
- A2A source RED command: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t "does not follow a symlinked Mattermost self-route outbox into foreign files"`.
- A2A source RED failure observed: direct path-based forwarding copied the synthetic foreign attachment marker through a symlinked source message directory.
- A2A source GREEN: the same command passed after forwarding reused the guarded outbox reader; no marker appeared in the target inbox or inbound content.
- Inbox/outbox root RED commands:
  - `pnpm exec vitest run src/host-core.test.ts -t "reject an outbox root symlink redirected into another session"` — the reader returned the foreign session attachment.
  - `pnpm exec vitest run src/host-core.test.ts -t "not clear another session through a redirected outbox root"` — cleanup deleted the foreign message directory.
  - `pnpm exec vitest run src/host-core.test.ts -t "reject an inbox root symlink redirected outside its owned session"` — the host wrote the decoded attachment into the foreign root.
- Inbox/outbox root GREEN: all three commands passed after validating every session/root component and refusing symlinked inbox/outbox roots. A2A target writes were refactored to reuse the same owned-inbox writer.
- Main-database hardlink characterization/mutation proof: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t "database hardlink"` passed with the single-link guard. Temporarily removing `artifactStat.nlink !== 1` made it fail because the A write no longer threw and entered B's linked database; the guard was restored.
- SQLite-sidecar characterization/mutation proof:
  - `pnpm exec vitest run src/mattermost-isolation.integration.test.ts -t "SQLite sidecar"` passed for redirected and hardlinked journals.
  - Temporarily removing the sidecar loop changed the redirected-sidecar result from the application boundary error to SQLite's `unable to open database file`; restoring the loop returned Green.
  - Temporarily removing the sidecar `nlink !== 1` check made `... -t "hardlinked SQLite sidecar"` fail because the open no longer threw; restoring it returned Green with foreign bytes unchanged.
- Concurrent-root RED command: `pnpm exec vitest run src/host-core.test.ts -t "opened directory when the container swaps|opened inbox"`.
- Concurrent-root RED failures observed: immediately before the final path IO, replacing A's lexical outbox with B's made the reader return `FOREIGN_ATTACHMENT`, cleanup deleted B's `keep.txt`, and the inbound writer created B's `photo.png`.
- Concurrent-root GREEN: the focused command passed after opening the session, inbox/outbox, message directory, and file through stable directory descriptors with `O_DIRECTORY`/`O_NOFOLLOW`; reads and writes use file descriptors, and cleanup atomically quarantines within the pinned outbox before recursive removal.
- File-open/rename mutation proof:
  - `pnpm exec vitest run src/host-core.test.ts -t "pin the outbox message directory before opening"` failed with `FOREIGN_ATTACHMENT` after temporarily reopening the file through the lexical outbox path.
  - `pnpm exec vitest run src/host-core.test.ts -t "pin the inbox message directory before opening"` failed because the temporary lexical file open created foreign `photo.png`.
  - `pnpm exec vitest run src/host-core.test.ts -t "pin the outbox root before quarantining"` failed because temporary lexical rename/delete removed B's `keep.txt`.
  - Each mutation was reverted; `... -t "pin the outbox message|pin the outbox root|pin the inbox message"` passed 3 tests.
- Descriptor-capability RED command: `pnpm exec vitest run src/host-core.test.ts -t "fail explicitly when stable descriptor-relative traversal is unavailable"`.
- Descriptor-capability RED failure observed: when both descriptor roots returned `ENOTDIR`, the guarded read silently returned `undefined` instead of an explicit security failure.
- Descriptor-capability GREEN: the same command passed after probing actual child traversal through `/proc/self/fd` and `/dev/fd`; supported hosts use the pinned-descriptor path, while an unsupported host fails closed with `Secure descriptor-relative filesystem access is unavailable` rather than silently using a raceable path.
- Empty-attachment RED command: `pnpm exec vitest run src/host-core.test.ts -t "not create inbox artifacts for a message without attachment data"`.
- Empty-attachment RED failure observed: an empty attachment array created an unnecessary `inbox/<message-id>` directory during the descriptor refactor.
- Empty-attachment GREEN: the same command passed after returning before filesystem setup when there are no files.
- Positive A2A characterization/mutation proof: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t "copies generic agent-to-agent attachment bytes"` passed with exact source bytes, target `localPath`, inbound metadata, and one target wake. Temporarily returning no forwarded files made the test fail with `attachments: []`; the mutation was reverted and the focused test passed.
- REFACTOR performed: one descriptor-relative inbox/outbox boundary now serves inbound attachments, outbound delivery, cleanup, and A2A forwarding; descriptors are closed in `finally`, unexpected filesystem errors rethrow, safe path rejections fail closed, and no-data messages avoid filesystem churn. Database claims were narrowed to pre-open identity checks rather than an unsupported atomic `SQLITE_OPEN_NOFOLLOW` claim.
- Final affected-suite command: `pnpm exec vitest run src/mattermost-isolation.integration.test.ts src/container-runner.isolation.test.ts src/channels/mattermost-subscription.test.ts src/delivery.test.ts src/modules/agent-to-agent/create-agent.test.ts src/modules/agent-to-agent/agent-route.test.ts src/modules/scheduling/db.test.ts src/router.thread-policy.test.ts src/host-core.test.ts` — 9 files passed, 190 tests passed.
- Final host gate: `pnpm test` outside the filesystem sandbox — 48 files passed, 552 tests passed.
- Container typecheck: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun run typecheck` — passed.
- Complete isolated container gate: the 9-file unit command recorded in Phase 5 passed 109 tests; the separate `src/integration.test.ts` command passed 3 tests. Together they execute the complete 10-file, 112-test inventory without the documented pre-existing leaked-poll-loop process contamination.
- Static gate: `pnpm run typecheck`, `pnpm run format:check`, and `git diff --check` passed; `pnpm run lint` passed with 0 errors and 98 warnings, two fewer than the 100-warning pre-flight baseline.
- Operational note: attachment isolation requires descriptor-relative child traversal. Linux `/proc/self/fd` is exercised by this gate. Other supported hosts are capability-checked against `/proc/self/fd` and `/dev/fd`; if neither works, attachment IO fails explicitly instead of falling back to a check-then-use path.
- Residual risk: `better-sqlite3` does not expose SQLite's no-follow open flag, so database artifact validation remains a pre-open identity check. The running container sees host-owned `inbound.db` through a nested read-only bind, and all tested symlink/hardlink/sidecar states fail closed; the container-owned outbound database retains a narrow leaf-swap window for future native/openat hardening.
- Isolation impact: A/B/Telegram marker, workspace, mount, session, routing, credential, attachment, and execution boundaries remain disjoint even under malformed topology, provider mutation, root replacement, and deterministic filesystem races covered by this phase.
- Pull request: [#43 — Phase 6: prove Mattermost container and context isolation](https://github.com/ufJmacca/nanoclaw/pull/43), base `codex/mattermost-05-strict-subscriptions`, head `codex/mattermost-06-isolation`.
- GitHub checks: the available `label` check passed in 3 seconds ([run 29131018921](https://github.com/ufJmacca/nanoclaw/actions/runs/29131018921)); the code CI workflow did not trigger because it is configured only for pull requests targeting `main`, so no code-CI pass is claimed.
- Phase status: complete; the full local gate, independent release audit, and every available GitHub check passed; pull request ready for review.

## Phase 7 — Approval, subscribe, and unsubscribe lifecycle

Phase status: complete; the full local gate, independent release audits, and every available GitHub check passed.

### Slice 7.0: dedicated unknown-channel approval boundary

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'routes an unknown Mattermost mention only to the dedicated subscription approval gate'`.
- RED failure observed: the router exposed no Mattermost-specific approval hook (`undefined` instead of a function), so every missing subscription failed at the strict boundary and could not begin the authorized lifecycle without entering the forbidden generic connect-to-existing-agent flow.
- GREEN command/result: the same focused command after adding the dedicated hook and pristine-placeholder branch — 1 passed; the Mattermost gate received the exact channel/event, the generic gate was untouched, and no subscription, agent, wiring, session, or container wake was created.
- REFACTOR performed: the hook reuses the channel-request function shape but has separate state and is reachable only for an addressed, group-scoped, unwired, non-denied `request_approval` Mattermost placeholder with the reason `missing_subscription`; all other invalid Mattermost topology still fails closed.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'unknown Mattermost channels|dedicated subscription approval gate|unwired placeholder'` — 5 tests passed.
- Files changed: `src/router.ts`, `src/channels/mattermost-subscription.test.ts`.
- Isolation impact: unknown Mattermost channels can request a new dedicated identity, but they cannot invoke the generic flow, select an existing Telegram/other-channel agent, create context, or wake a container before approval.

### Slice 7.1: owner-only pending subscription request

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'delivers one dedicated subscription request'`.
- RED failure observed: the owner delivery adapter was called zero times instead of once because the dedicated router hook had no persistent owner-request implementation.
- GREEN command/result: the same focused command after adding the dedicated pending table, owner-DM request service, and permissions-module registration — 1 passed; the card contained only `approve`/`reject`, stored the exact trigger and canonical channel identity, and created no subscription, agent, wiring, session, or wake.
- REFACTOR performed: channel and requester identifiers use bounded exact parsing; the request service independently revalidates a pristine unwired placeholder and owner-only recipient list before persisting anything. Prettier normalized the touched Phase 7 tests and service.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts` — 2 files passed, 64 tests passed after refactoring.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified only the three touched files, they were formatted, and the repeated command passed.
- Files changed: `src/db/migrations/015-mattermost-lifecycle.ts`, `src/db/migrations/index.ts`, `src/modules/permissions/db/pending-mattermost-channel-approvals.ts`, `src/modules/permissions/mattermost-channel-approval.ts`, `src/modules/permissions/index.ts`, `src/modules/permissions/mattermost-channel-approval.test.ts`.
- Isolation impact: a mention can create only host-side pending authorization metadata and an owner card. It cannot select an existing agent, grant membership, create a workspace/session/container identity, or move the Mattermost token beyond its host transport boundary.

### Slice 7.2: owner-only decision authorization

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'selects an owner and claims but refuses'`.
- RED failure observed: an unauthorized global-admin approval response was unclaimed (`false` instead of `true`) because no handler recognized dedicated Mattermost approval IDs.
- GREEN command/result: the same focused command after registering a dedicated response handler — 1 passed; the reachable owner remained the designated approver, while both a global administrator's approve click and the Mattermost requester's reject click were claimed but made no state change.
- REFACTOR performed: row lookup is isolated in the dedicated CRUD module and authorization requires both exact designated-recipient identity and a current global owner role; the handler shares no generic admin or channel-registration authorization path.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts` — 2 files passed, 65 tests passed after formatting.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified the touched CRUD file, it was formatted, and the repeated command passed.
- Isolation impact: forwarded cards, requesters, Mattermost membership, scoped administrators, and global administrators cannot approve or reject a dedicated Mattermost subscription; authorization remains distinct from bot membership and no container or topology is created.

### Slice 7.3: strict subscription transaction on approval

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'approves only through a fresh canonical'`.
- RED failure observed: after the designated owner's approve click, the requested channel had no subscription row (`undefined` instead of the expected active canonical ownership) because authorized responses still made no topology change.
- GREEN command/result: the same focused command after atomically claiming `pending -> processing`, validating the stored channel/requester identity, and calling `subscribeMattermostChannelStrict` — 1 passed; the requested channel received a new canonical Mattermost agent, one shared/known-sender wiring, and one channel-only destination.
- REFACTOR performed: strict stored-event checks precede the atomic claim, and the compare-and-update claim makes duplicate/concurrent clicks unable to invoke the constructor twice. The test seeds both an unrelated Telegram agent and another canonical Mattermost agent and proves neither is selected.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts` — 2 files passed, 66 tests passed after formatting.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified the touched test, it was formatted, and the repeated command passed.
- Isolation impact: approval can create only the deterministic identity owned by the exact `(instance_key, channel_id)` request. Existing Telegram agents, existing Mattermost agents, their workspaces, and their container identities cannot be adopted or shared.

### Slice 7.4: requester membership in the new channel only

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'adds the requester only'`.
- RED failure observed: the requester had zero membership rows instead of membership in the newly subscribed agent group, so a replay would fail the strict known-sender gate.
- GREEN command/result: the same focused command after host-side requester upsert and membership grant — 1 passed; `mattermost:user-requester` belongs only to the fresh canonical channel agent and `added_by` records the designated approving owner.
- REFACTOR performed: membership uses the strict constructor's returned agent identity rather than a caller-supplied or queried alternative; user creation occurs only after the owner-authorized atomic claim and subscription succeeds.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts` — 2 files passed, 67 tests passed after formatting.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified the touched test, it was formatted, and the repeated command passed.
- Isolation impact: the approval grants no global Mattermost access and no access to Telegram or another channel. Only the triggering requester becomes a known sender for the one newly created dedicated agent group, before any replay or container wake.

### Slice 7.5: exactly-once trigger replay

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'replays the exact trigger once'`.
- RED failure observed: concurrent duplicate owner approvals produced zero sessions instead of one because the claimed trigger was never replayed after subscription and membership.
- GREEN command/result: the same focused command after replaying the stored event and marking the claimed request completed — 1 passed; two concurrent clicks produced one shared session, one inbound row, one trigger wake, and one completed replay timestamp.
- REFACTOR performed: the original event is replayed unchanged after the requester membership grant, and the affected earlier tests now assert zero wakes before approval plus exactly one after approval. The resulting inbound row preserves the original message ID namespace, Mattermost platform/channel, `root-trigger`, content, and trigger bit.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts src/router.thread-policy.test.ts` — 3 files passed, 75 tests passed.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: atomic `pending -> processing` claim prevents double subscription and double replay; channel-shared session policy collapses the root only for execution context while retaining the Mattermost root on the inbound reply address, and no other channel receives the message or wake.

### Slice 7.6: owner rejection is terminal for the placeholder

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'rejects the pending channel without'`.
- RED failure observed: the rejected placeholder still reported `denied=0` because the authorized reject response was claimed but made no lifecycle transition.
- GREEN command/result: the same focused command after adding the atomic rejection transaction — 1 passed; the request records the owner and decision time, the placeholder becomes denied, no topology/session/wake is created, and a later mention emits no second card.
- REFACTOR performed: pending-row transition and placeholder denial execute in one immediate SQLite transaction guarded by `status='pending'`; duplicate reject/approve races therefore have one winner and cannot both mutate lifecycle state.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts src/modules/permissions/channel-approval.test.ts` — 3 files passed, 82 tests passed after formatting.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified the touched test, it was formatted, and the repeated command passed.
- Isolation impact: rejection creates no agent identity or writable root, and the permanent denied placeholder prevents repeated approval spam while remaining separate from generic channel registration.

### Slice 7.7: persisted approval rendering

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'resolves persisted button values'`.
- RED failure observed: `getAskQuestionRender(approval_id)` returned `undefined`, so Chat SDK index-valued button responses could not resolve to the persisted `approve`/`reject` values.
- GREEN command/result: the same focused command after adding the guarded dedicated-table lookup — 1 passed with the exact persisted title and normalized subscription/rejection options.
- REFACTOR performed: core rendering checks table existence before querying, preserving the module-optional startup boundary and avoiding any hardcoded option-index mapping.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/chat-sdk-bridge.test.ts src/db/session-db.test.ts` — 3 files passed, 15 tests passed.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: only host-side opaque approval IDs resolve button values; no channel identity, credential, prompt content, workspace path, or container context is added to the response bridge.

### Slice 7.8: unsubscribe closes execution before kill

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'marks only channel A inactive'`.
- RED failure observed: the strict subscription module exposed no deactivation function (`undefined` instead of a function), so an active channel could not enter the required unsubscribed state.
- GREEN command/result: the same focused command after adding explicit-policy deactivation — 1 passed; A became unsubscribed and its session was closed/stopped before `killContainer(A)`, while B remained active/idle and was never killed.
- REFACTOR performed: one immediate transaction selects the permanent owner row, captures every session touching A's reserved agent or messaging-group identity, disables the subscription, and closes/stops those sessions. Container termination is dynamically loaded only after commit, avoiding a subscription/container-runner module cycle and ensuring the DB gate precedes process control.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/container-runner.isolation.test.ts` — 2 files passed, 108 tests passed.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: deactivation is keyed only by bounded canonical instance/channel identity; it never uses channel names, leaves B untouched, and disables routing/session authorization before the A execution can observe more work.

### Slice 7.9: database guard closes the stale-route race

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'prevents a stale route from creating'`.
- RED failure observed: after A was unsubscribed and its old session closed, `resolveSession` created a second active A session instead of throwing, leaving stale routing able to persist active work after deactivation.
- GREEN command/result: the same focused command after installing the active-session and one-session-cardinality guards — 1 passed; the stale resolution throws `Mattermost channel already owns a session identity` and only the reserved closed/stopped session remains.
- REFACTOR performed: the triggers classify Mattermost ownership by either permanent agent or messaging-group identity, require both identities to match one currently active subscription for active execution, and prohibit a second session identity even while inactive. The pre-existing generic threaded-adapter characterization now uses a Telegram fixture so its generic fallback remains covered without weakening Mattermost's literal 1:1 contract.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/router.thread-policy.test.ts src/container-runner.isolation.test.ts` — 3 files passed, 116 tests passed. One simultaneous focused/affected invocation reused the same fixed temporary root and made the focused process see `workspace identity already exists`; the affected run passed and an isolated repeat of the focused command passed, confirming test-process interference rather than a product failure.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: SQLite serialization now makes unsubscribe atomic against session creation: sessions inserted before the transition are closed by it, while inserts after the transition fail before any session directory, message, or container wake can be created.

### Slice 7.10: explicit retain/archive policy and permanent ownership

- Archive RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'retains or archives the owned workspace'`.
- Archive RED failure observed: an explicit archive request returned and persisted `unsubscribed` instead of `archived` because deactivation implemented retention only.
- Archive GREEN: the same focused command after the in-transaction `unsubscribed -> archived` transition — 1 passed; `archived_at` is set, A workspace/state markers remain byte-identical in place, B stays active, and strict subscribe cannot reuse the archived identity.
- Explicit-policy characterization command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'requires an explicit workspace'` — initially passed with A still active after a missing policy was rejected.
- Mutation proof: temporarily removing only the deactivation policy check made that command fail because the promise resolved `{status:'unsubscribed'}` instead of rejecting; the check was restored and `... -t 'requires an explicit workspace|retains or archives the owned workspace'` passed 2 tests.
- REFACTOR performed: active archive requests transition through unsubscribed in the same immediate transaction, retained requests keep `archived_at=NULL`, archived identity is terminal, and neither policy deletes or renames the canonical wiring, destination, workspace, state root, or message history.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/container-runner.isolation.test.ts src/mattermost-isolation.integration.test.ts` — 3 files passed, 120 tests passed after formatting.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: retention and archive are explicit host lifecycle choices over A's already reserved roots; neither makes those roots assignable to B, Telegram, a future channel, or a new container identity.

### Slice 7.11: SQLite-enforced lifecycle order

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'enforces ordered lifecycle transitions'`.
- RED failure observed: a raw `active -> archived` update succeeded instead of throwing, allowing callers to bypass the required unsubscribed stage and archive timestamp policy.
- GREEN command/result: the same focused command after adding lifecycle/archive-coherence triggers — 1 passed; only `pending -> active`, `active -> unsubscribed`, and `unsubscribed -> active|archived` transitions are legal, archived is terminal, and `archived_at` is non-null only for archived rows.
- REFACTOR performed: the earlier archived-reservation characterization now performs the required intermediate unsubscribe before archive; it still proves the permanent ownership row cannot be deleted.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/container-runner.isolation.test.ts src/mattermost-isolation.integration.test.ts` — 3 files passed, 121 tests passed.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: application bugs or direct SQLite writers cannot skip, reverse, or forge lifecycle stages to reactivate an archived identity or expose a retained workspace under inconsistent status metadata.

### Slice 7.12: retained resubscription preserves one channel-owned session

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'resubscribes the retained identity'`.
- RED failure observed: the strict subscription module exposed no resubscription function (`undefined` instead of a function), so a retained identity could not be safely reactivated.
- GREEN command/result: the same focused command after adding strict retained-only reactivation — 1 passed; the canonical messaging-group, agent, folder, wiring, and sole shared-session IDs remained identical. The retained A history remained available to A, the new A message appended to that same session, B context was absent, and B remained on its own active session.
- REFACTOR performed: resubscription runs in an immediate transaction, revalidates the sole reserved session and full canonical topology, validates existing workspace/state components without following symlinks, changes `unsubscribed -> active`, and reactivates that session without allocating or renaming an execution identity.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/router.thread-policy.test.ts src/mattermost-isolation.integration.test.ts src/container-runner.isolation.test.ts` — 4 files passed, 129 tests passed.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: resubscribe retains only A's own permanently reserved context and execution identity after validating them; it cannot allocate a second session, copy B/Telegram context, or adopt another channel's workspace, memory, mount, or container identity.

### Slice 7.13: inactive destination remains permanently reserved

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'keeps the canonical channel destination permanently'`.
- RED failure observed: deleting A's canonical channel destination while unsubscribed succeeded instead of throwing because the Phase 5 delete guard applied only while active.
- GREEN command/result: the same focused command after adding the permanent destination-delete trigger — 1 passed; the sole `channel -> A messaging group` destination remains present while unsubscribed.
- REFACTOR performed: the permanent trigger retains the established active-delete error contract so existing active-state characterization remains unchanged; topology mutation is still disabled by lifecycle status rather than by deleting canonical ownership rows.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/mattermost-isolation.integration.test.ts src/modules/agent-to-agent/create-agent.test.ts` — 3 files passed, 87 tests passed after aligning the established error text.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: unsubscribe/archive can no longer make A's outbound ACL target disappear and later be replaced or repaired toward another channel; permanent reservation survives every non-active state.

### Slice 7.14: authenticated native mention signal

- RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'trusts only authenticated WebSocket mention'`.
- RED failure observed: authenticated-bot, other-user, and malformed `data.mentions` inputs all produced `isMention=undefined`, leaving real native unknown-channel approval unreachable.
- GREEN command/result: the same focused command after parsing Mattermost's JSON-encoded mention IDs — 1 passed with `[true,false,false]` for authenticated bot, other user, and malformed metadata.
- REFACTOR performed: mention detection compares only exact platform user IDs against the `/users/me` authenticated bot identity; absent, malformed, non-array, or mixed-type metadata fails closed and no username/message regex is used.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts src/channels/mattermost-adapter.test.ts src/modules/permissions/mattermost-channel-approval.test.ts` — 3 files passed, 27 tests passed after formatting.
- Static verification: `pnpm typecheck` passed; the initial `pnpm format:check` identified the touched normalizer, it was formatted, and the repeated command passed.
- Isolation impact: only the authenticated socket's bot-ID mention can open the owner-approval path; ordinary channel chatter or forged textual `@name` content cannot create pending state, agents, sessions, or containers.

### Slice 7.15: authenticated bot removal deactivation

- Adapter RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'forwards only an authenticated removal'`.
- Adapter RED failure observed: the authenticated direct `user_removed` event produced zero lifecycle callbacks because every non-`posted` socket event was discarded.
- Adapter GREEN: the same command after adding the optional host lifecycle boundary and fail-closed removal normalization — 1 passed; only `broadcast.user_id=<authenticated bot>` with one bounded unambiguous channel emitted `{kind:'bot_removed', platformId}`. Other-user and channel-wide sibling shapes emitted neither lifecycle nor chat.
- Service RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'deactivates only the removed bot channel'`.
- Service RED failure observed: no bot-removal lifecycle service was exported (`undefined` instead of a function).
- Service GREEN: the same command after adding idempotent removal handling — 1 passed; A became retained-unsubscribed and its running session was killed after closure, B remained active/idle, and the pending request for a separately removed channel was deleted so a delayed owner click cannot activate it.
- REFACTOR performed: the host setup now dispatches only Mattermost `bot_removed` lifecycle events to the same strict deactivation service; it never synthesizes inbound chat or grants/revokes owner authorization. The test fixture resets its per-test kill implementation so full-file execution remains independent.
- Isolation impact: authenticated bot membership loss disables only the canonical channel named by the platform event, cancels only its pending approval, and cannot deactivate by display name, affect B, or be confused with owner/admin authorization.

### Slice 7.16: production registration and host-only configuration

- Registration RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'is reachable from the production'`.
- Registration RED failure observed: the production barrel registered only `cli` and `telegram`, not `mattermost`.
- Registration GREEN: the same command after adding the self-registration module and barrel import — 1 passed; `mattermost` is registered with no `containerConfig`.
- Configuration RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'creates an adapter only from a complete'`.
- Configuration RED failure observed: the registration module exposed no host-config factory (`undefined` instead of a function).
- Configuration GREEN: the same command after implementing the host factory — 1 passed; all-absent config disables the adapter, partial config throws a sanitized error without the fixture token, and complete URL/token/instance config creates the native shared-session adapter. The token remains only in the host transport/client object and no mounts or container environment are registered.
- REFACTOR performed: the delivery bridge is installed before network adapter setup so an immediate authenticated mention cannot strand an undeliverable pending approval; host lifecycle dispatch is installed in the same setup object. Mattermost registration reads only the four named `.env` keys, validates a credential-free HTTP(S) URL and bounded instance key, and opts into mass mentions only on exact `true`.
- Final affected verification for Slices 7.15–7.16: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts src/channels/mattermost-subscription.test.ts src/modules/permissions/mattermost-channel-approval.test.ts src/channels/channel-registry.test.ts` — 5 files passed, 104 tests passed after resetting the leaked test mock implementation and formatting.
- Static verification: `pnpm typecheck` and `pnpm format:check` passed.
- Isolation impact: the production adapter is now reachable without exposing credentials to prompts, SQLite message metadata, channel container config, mounts, or container environments; partial/ambiguous configuration fails closed before network setup.

### Slice 7.17: one immutable session identity per Mattermost channel

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'resubscribes the retained identity into its one|prevents a second session identity'`.
- RED failure observed: the initial lifecycle design created a second session on retained resubscription, so A had two session rows and a direct second `createSession` did not fail. This contradicted the binding one-channel/one-shared-session invariant.
- GREEN command/result: the same combined focused command after adding sole-session reactivation and the cardinality trigger — 2 passed; retained A resumes its original session ID and any second identity fails with `Mattermost channel already owns a session identity`.
- Identity RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'prevents renaming or deleting the one reserved'`.
- Identity RED failure observed: with the identity guards temporarily omitted, a raw session-ID rename succeeded instead of throwing.
- Identity GREEN command/result: the same focused command after restoring the ID-update and delete guards — 1 passed; the reserved session can be neither renamed nor deleted.
- Ownership RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'keeps Mattermost session ownership identity immutable'`.
- Ownership RED failure observed: before the ownership-update guard, a retained A session could be reassigned to a generic agent, messaging group, and thread.
- Ownership GREEN command/result: the same focused command after guarding `agent_group_id`, `messaging_group_id`, and `thread_id` — 1 passed.
- REFACTOR performed: migration and reference-schema triggers now enforce cardinality, immutable session ID/ownership/thread identity, and permanent row reservation for any session touching a Mattermost-owned agent or messaging group. The lifecycle service reactivates only the exact stopped/closed row it previously deactivated.
- Isolation impact: one Mattermost channel has one permanent shared session and execution identity across retention cycles; the row cannot be duplicated, renamed, deleted, reassigned, threaded, or mixed with B/Telegram identity.

### Slice 7.18: approval delivery and retry readiness

- Availability RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'leaves no pending request when the owner delivery'`.
- Availability RED failure observed: an unavailable owner adapter was still called once and a pending request was persisted, allowing startup ordering to strand approval.
- Availability GREEN command/result: the same focused command after adding the adapter `isAvailable` capability and bridge readiness check — 1 passed; no row or delivery is created until the action-capable owner transport is ready.
- Startup-order RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'is reachable from the production'`.
- Startup-order RED failure observed: production import ordering registered Mattermost before Telegram, so an immediate native mention could arrive before its owner action transport.
- Startup-order GREEN command/result: the same focused command after ordering registration `cli -> telegram -> mattermost` and installing the delivery bridge before Mattermost setup — 1 passed.
- Destination RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'skips non-interactive Mattermost and CLI owner destinations'`.
- Destination RED observed/result: the first run selected the unusable Mattermost owner instead of Telegram; after that path was excluded, the next Red selected the unusable CLI owner. Approval selection now requires an explicitly available action-capable destination, and the same focused command passes with the exact Telegram owner receiving the request while Mattermost/CLI owners are skipped.
- Delivery-failure RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'removes an undelivered approval row'`.
- Delivery-failure RED observed/result: the first run left one pending row after delivery rejection; after cleanup was added, the same command passed and a later mention could create and deliver one fresh request.
- Processing-retry RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'releases a failed approval claim'`.
- Processing-retry RED observed/result: an injected strict-subscription filesystem failure left the request `processing`; after release-on-failure was added, the same command passed and an exact retry completed once with one replay and wake.
- REFACTOR performed: delivery capability is an optional adapter contract, owner selection is authorization-plus-interactivity rather than membership, pending insertion remains host-side, delivery failures remove only their undelivered row, and in-process approval failures release only their own atomic claim.
- Isolation impact: credentials and owner transport remain host-side; unavailable or noninteractive destinations grant nothing, and retry paths cannot allocate duplicate topology, sessions, replay, or container execution.

### Slice 7.19: approval/removal concurrency fails closed

- Removal-race RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'does not create an approval when bot removal wins'`.
- Removal-race RED failure observed: a delayed owner-resolution path delivered one approval after authenticated bot removal completed.
- Removal-race GREEN command/result: the same focused command after durable placeholder denial and atomic post-resolution revalidation — 1 passed; no pending row or card survived the removal winner.
- Concurrent-mention RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'lets only one concurrent mention'`.
- Concurrent-mention RED failure observed: two mentions passed the pre-check and one promise rejected with a unique-constraint error.
- Concurrent-mention GREEN command/result: the same focused command after an `INSERT OR IGNORE ... SELECT` winner operation — 1 passed; both calls settled successfully while exactly one row/card was created.
- REFACTOR performed: the insert statement revalidates the exact pristine placeholder inside the write, bot removal durably denies unknown placeholders, and only the insertion winner may deliver. The pending row is still removed if that winner's delivery fails.
- Isolation impact: removal and duplicate mentions cannot resurrect or multiply a channel identity, and no losing race can create an agent, membership, session, message replay, workspace, or container wake.

### Slice 7.20: raw lifecycle and outbound execution boundaries

- Raw-transition RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'requires the owned session to be closed'`.
- Raw-transition RED failure observed: a direct `active -> unsubscribed` update succeeded while A's session remained active/running.
- Raw-transition GREEN command/result: the same focused command after adding the session-state precondition trigger — 1 passed; raw unsubscribe now fails until every owned session is closed/stopped.
- Router characterization command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'drops new A traffic after unsubscribe'` initially passed with no A message/wake and continued B routing. Temporarily removing the inactive-status check made it reject at the reserved session-cardinality guard instead of dropping traffic; restoring the check returned the test to Green.
- Outbound-drain RED command: `pnpm exec vitest run src/delivery.test.ts -t 'stops a queued Mattermost drain'`.
- Outbound-drain RED failure observed: deactivation after the first awaited delivery still allowed a second queued Mattermost item to post (`2` adapter calls instead of `1`).
- Outbound-drain GREEN command/result: the same focused command after per-item execution-boundary revalidation — 1 passed; draining stops after A becomes inactive and persists the remaining queue.
- REFACTOR performed: the lifecycle transaction closes/stops sessions before container kill, direct SQL must satisfy that same ordering, inbound routes fail closed at subscription status, and each awaited Mattermost outbound send obtains a fresh active-boundary decision.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts src/delivery.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts src/channels/channel-registry.test.ts src/router.thread-policy.test.ts src/container-runner.isolation.test.ts src/mattermost-isolation.integration.test.ts src/modules/permissions/channel-approval.test.ts src/modules/permissions/sender-approval.test.ts` — 11 files passed, 202 tests passed.
- Static verification: `pnpm typecheck`, `pnpm format:check`, `pnpm lint`, and `git diff --check` passed; lint reported zero errors and the same 98 warnings as the Phase 6 baseline.
- Isolation impact: once unsubscribe wins, A cannot accept inbound, activate a session, continue a queued outbound drain, or keep a running container; B and Telegram remain independently routable and untouched.

### Slice 7.21: deactivation commits before its first asynchronous yield

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'commits unsubscribe before yielding'`.
- RED failure observed: immediately after invoking deactivation, A was still `active` with an `active/running` session instead of already being `unsubscribed` and `closed/stopped`; awaiting the dynamic container-runner import occurred before the fail-closed database transaction.
- GREEN command/result: the same focused command after starting the module import without awaiting it until after the transaction — 1 passed; database routing and execution gates close synchronously before container cleanup can yield.
- REFACTOR performed: module loading begins eagerly to preserve the existing cycle boundary, the immediate transaction remains synchronous, and only the post-commit container-kill step awaits the loader. The focused regression resets its kill mock so the full affected file cannot inherit an earlier assertion implementation.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts src/router.thread-policy.test.ts src/delivery.test.ts` — 3 files passed, 92 tests passed.
- Isolation impact: bot removal and explicit deactivation cannot leave a microtask window in which another A inbound message creates work or wakes A's container before the database boundary closes; B and Telegram remain unaffected.

### Slice 7.22: partial approval cannot become rejectable active topology

- RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'keeps a partial approval non-rejectable'`.
- RED failure observed: an injected requester-membership failure after strict subscription released the claim to `pending`; a subsequent owner rejection changed it to `rejected` and could deny the now-active canonical messaging group (`rejected` instead of the required recovery-safe `processing`).
- GREEN command/result: the same focused command after topology-aware release/reject guards — 1 passed; once the strict subscription exists, the request remains `processing`, rejection becomes a no-op, and the active messaging group remains non-denied.
- REFACTOR performed: release and rejection share one correlated pristine-placeholder SQL boundary requiring no subscription, wiring, session, or destination. Pre-topology filesystem failures still return to `pending`; post-topology failures remain durable for Phase 8 recovery.
- Affected-suite verification: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts` — 1 file passed, 14 tests passed.
- Isolation impact: failure after the ownership transaction cannot turn an active channel into a denied-but-routable contradiction, authorize a second subscription attempt, or make a partially established A topology assignable to another channel.

### Slice 7.23: lifecycle migration audits legacy session cardinality

- RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'fails the lifecycle migration closed'`.
- RED failure observed: a simulated Phase 5/6 database with two closed session identities for one canonical Mattermost channel accepted migration 015; newly created triggers did not retroactively detect the existing 1:many violation.
- GREEN command/result: the same focused command after adding the preflight audit — 1 passed; migration aborts with `Cannot migrate Mattermost lifecycle: a channel owns multiple session identities`, and its schema-version row is not committed.
- REFACTOR performed: the audit groups persisted sessions by the immutable Mattermost subscription owner and counts distinct session IDs before any lifecycle table or trigger is created, relying on the migration runner's existing transaction for all-or-nothing rollback.
- Isolation impact: an upgraded database cannot silently carry multiple historical execution identities into a phase that promises one permanent channel-owned session; operator reconciliation is required before migration can proceed.

### Slice 7.24: production delivery readiness characterization

- Characterization command/result: `pnpm exec vitest run src/channels/delivery-bridge.test.ts -t 'reports whether'` — 1 passed with a registered adapter available and a missing adapter unavailable.
- Mutation proof: temporarily removing the bridge's `isAvailable` implementation made the same command fail (`undefined` instead of `true`); the implementation was restored and the command passed again.
- REFACTOR performed: no production refactor was needed; the direct bridge contract now protects the readiness capability independently of approval-service mocks.
- Isolation impact: approval startup readiness is verified at the real host adapter lookup boundary without introducing credentials, container configuration, filesystem state, or cross-channel routing.

### Slice 7.25: Phase 7 complete local gate and independent audit

- Complete affected-suite command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts src/channels/mattermost-subscription.test.ts src/delivery.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts src/channels/channel-registry.test.ts src/channels/delivery-bridge.test.ts src/router.thread-policy.test.ts src/container-runner.isolation.test.ts src/mattermost-isolation.integration.test.ts src/modules/permissions/channel-approval.test.ts src/modules/permissions/sender-approval.test.ts` — 12 files passed, 208 tests passed.
- First full host command: `pnpm test` — 48 files and 586 tests passed; one existing create-agent runtime-corruption test failed because migration 015's new cardinality trigger correctly rejected its intentional duplicate before the runtime validator was reached. The fixture now explicitly drops only that trigger while simulating a pre-Phase-7 corrupt database, matching the equivalent subscription-validator fixture.
- Fixture verification: `pnpm exec vitest run src/modules/agent-to-agent/create-agent.test.ts -t 'duplicate active session'` — 1 passed.
- Repeated full host command: `pnpm test` — 49 files passed, 587 tests passed.
- Container type-check command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun run typecheck` — passed.
- Complete isolated container unit command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/db/session-state.test.ts src/mcp-tools/deep-research-workflow.test.ts src/providers/codex.factory.test.ts src/providers/factory.test.ts src/providers/codex-app-server.test.ts src/providers/codex.test.ts src/poll-loop.test.ts src/timezone.test.ts src/formatter.test.ts` — 9 files passed, 109 tests passed.
- Complete isolated container integration command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/integration.test.ts` — 1 file passed, 3 tests passed. Together the two clean processes cover the complete 10-file/112-test inventory without the known leaked-loop cross-file interference.
- Static commands/results: `pnpm typecheck` passed; `pnpm format:check` passed; `pnpm lint` passed with zero errors and the same 98 warnings as the Phase 6 baseline; `git diff --check` passed.
- Independent audit: three read-only review tracks found and verified fixes for startup readiness, unusable owner destinations, delivery/processing retries, removal and concurrent-mention races, literal session cardinality/immutability, raw lifecycle ordering, outbound drain invalidation, deactivation's pre-yield transaction, partial-approval recovery, migration preflight, schema parity, and public router coverage. Their final re-audits found no remaining Phase 7 correctness, acceptance, credential, or isolation blocker.
- Operational note: approval currently requires a reachable Telegram owner because the built-in native Mattermost and CLI adapters do not implement an authenticated action response round-trip. Explicit retain/archive/resubscribe are exported strict host service boundaries; bot removal is the only automatic production deactivation caller in this phase, and no operator-facing command is added speculatively.
- Isolation impact: the final gate covers A/B/Telegram routing, session, workspace, mount, context, container, lifecycle, authorization, outbound, migration, and credential boundaries under normal, malformed, concurrent, failure, removal, and retained-resubscription paths.
- Pull request: [#44 — Phase 7: add Mattermost subscription lifecycle](https://github.com/ufJmacca/nanoclaw/pull/44), base `codex/mattermost-06-isolation`, head `codex/mattermost-07-lifecycle`.
- GitHub checks: the available `label` check passed in 3 seconds ([run 29134118426](https://github.com/ufJmacca/nanoclaw/actions/runs/29134118426)); the code CI workflow did not trigger because it is configured only for pull requests targeting `main`, so no code-CI pass is claimed.
- Phase status: complete; the full local gate, all three independent final audits, and every available GitHub check passed; pull request ready for review.

## Phase 8 — Recovery, ordering, and bounded concurrency

Phase status: complete; pull request #45 is ready for review.

### Slice 8.1: bounded runtime WebSocket reconnect

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'bounded exponential backoff'`.
- RED failure observed: an authenticated socket close scheduled no reconnect timer (`undefined` instead of the required 1,000 ms first delay) because the transport/client exposed no post-open close lifecycle.
- GREEN command/result: the same focused command after adding the optional socket termination seam and client reconnect state — 1 passed; consecutive open failures scheduled 1s, 2s, 4s, 8s, 16s, 30s, and remained capped at 30s, while teardown cancelled the pending attempt.
- REFACTOR performed: initial and reconnect authentication share one connection method; reconnect state retains only the credential-free URL, authenticated bot ID, event callback, and bounded attempt counter. As finalized in Slice 8.28, the counter resets only after a sequenced event completes durably, and no token enters timer or error state.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 16 tests passed after the following transport termination slice.
- Isolation impact: reconnect reuses only this adapter instance's host-side authentication and event callback; it cannot change subscription, channel, agent, session, workspace, mount, or container identity.

### Slice 8.2: post-open socket errors enter recovery safely

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'post-open error and close'`.
- RED failure observed: emitting a post-open socket `error` threw `connection lost` from the EventEmitter because the transport had removed its one-shot opening error listener and installed no runtime termination listener.
- GREEN command/result: the same focused behavior passed as part of the 16-test client file; a runtime `error` followed by `close` emits exactly one termination notification and enters the reconnect path.
- REFACTOR performed: the Node transport's termination subscription owns both error and close listeners behind a one-shot guard and removes both together. The client removes the guard before closing the failed socket, preventing recursive/double scheduling.
- Isolation impact: a transport error cannot crash the host and leave unrelated channels unmanaged; recovery remains scoped to the failed Mattermost connection and preserves all database isolation gates.

### Slice 8.3: authentication-window termination is observed

- RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'subscribes socket termination before'`.
- RED failure observed: the socket's termination seam had been subscribed zero times while WebSocket authentication was pending, leaving an error/close window between open and challenge acknowledgement.
- GREEN command/result: the same focused command passed after installing the one-shot termination listener before sending the authentication challenge; an interrupted setup rejects cleanly and closes once.
- REFACTOR performed: authentication timer, message listener, rejection callback, and termination listener are cleared through one ownership path, including challenge-send failure and teardown.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 22 tests passed after the subsequent sequence/reconnect slices.
- Isolation impact: a half-authenticated socket never accepts channel traffic, and the host-side credential is neither logged nor propagated beyond the challenge transport.

### Slice 8.4: connection sequence, resume, and recovery barriers

- Sequence RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'exact missed window'`.
- Sequence RED failure observed: a jump from expected sequence 2 to received sequence 3 invoked the recovery hook zero times because server `seq` values were ignored.
- Barrier RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'holds live frames'`.
- Barrier RED failure observed: both the gap-triggering and subsequent live frames reached the event listener before the deferred recovery promise resolved.
- Resume RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'resumes the server connection id'`.
- Resume RED failure observed: reconnect opened the bare WebSocket URL instead of supplying the server `connection_id` and next sequence number.
- Replacement-connection RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'replacement connection behind catch-up'`.
- Replacement-connection RED failure observed: a resumed socket whose `hello` supplied a different connection ID invoked the reset hook zero times and released its frames without catch-up.
- GREEN command/result: each focused command passed after tracking every valid server sequence, awaiting the exact gap hook, retaining the server connection ID for resume, and treating a changed ID as a sequence reset behind the same asynchronous barrier.
- REFACTOR performed: one per-generation promise tail serializes connection metadata observations while post routing remains independently awaitable by the channel processor; stale socket/generation callbacks are ignored and teardown clears all resume state.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 22 tests passed.
- Isolation impact: missed windows cannot release newer channel traffic first; recovery changes no channel identity and buffers only within the same authenticated adapter lifecycle.

### Slice 8.5: per-channel ingress ordering and teardown drain

- Ordering RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'preserves per-channel order'`.
- Ordering RED failure observed: A2 began before deferred A1 completed, while the required independent B1 path also had no explicit serialization boundary.
- Receipt-release RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'releases a post receipt'`.
- Receipt-release RED failure observed: retrying a post after its sink failed returned `false` because the process-local receipt had been marked before routing and never released.
- Failed-head RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'failed channel blocked'`.
- Failed-head RED failure observed: A2 fulfilled after A1 rejected, allowing a newer same-channel post to leapfrog the missing head.
- Adapter-drain RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'waits for accepted inbound routing'`.
- Adapter-drain RED failure observed: teardown completed while an accepted host routing promise was still pending.
- Lifecycle-order RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'orders bot removal behind'`.
- Lifecycle-order RED failure observed: authenticated removal overtook an earlier deferred post in the same channel.
- GREEN command/result: all focused commands passed after adding channel-ID keyed promise queues, retryable failed heads, receipt release, a processor drain, and one shared queue for posts, lifecycle, and metadata. Channel B continues independently while A is blocked.
- REFACTOR performed: `src/index.ts` now returns routing and lifecycle promises so the adapter can observe durable host completion; failures are logged and rethrown instead of becoming fire-and-forget receipts.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts` — 30 tests passed after rename handling; the wider recovery set passed 62 tests before later additions.
- Isolation impact: ordering keys use the canonical namespaced channel ID, never channel name or thread; A, B, and Telegram cannot share a queue, session, workspace, or execution identity.

### Slice 8.6: durable recovery cursors and content-free receipts

- Migration RED command: `pnpm exec vitest run src/db/db-v2.test.ts -t 'durable Mattermost recovery'`.
- Migration RED failure observed: neither recovery-cursor nor post-receipt table existed.
- Receipt RED commands: focused `src/channels/mattermost-recovery.test.ts` runs for `claims one content-free receipt`, `completes only the exact`, `releases only the exact`, and `resets only crash-left`; each first failed because its store function was undefined.
- Cursor RED commands: focused runs for `lists only active strict subscriptions` and `advances an active channel watermark`; each first failed because durable enumeration/advancement was undefined.
- GREEN command/result: the focused behaviors and complete `pnpm exec vitest run src/channels/mattermost-recovery.test.ts` passed after adding exact receipt claim/complete/release/reset and monotonic active-channel cursors.
- REFACTOR performed: receipt identity is `(instance_key, post_id, channel_id, create_at, SHA-256 payload digest)` with only processing/completed status and timestamps; cursor identity is the immutable subscription tuple. Neither table stores raw messages, tokens, headers, prompts, mounts, or container data.
- Static verification: `pnpm exec tsc --noEmit --pretty false` passed after narrowing parsed response records outside callback closures.
- Isolation impact: replayed post IDs cannot move between channels or mutate content; inactive or foreign-instance channels cannot advance a cursor.

### Slice 8.7: durable cross-source deduplication and exact session replay

- Processor RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'deduplicates the same post across'`.
- Processor RED failure observed: a restarted processor accepted and routed the same WebSocket/REST post a second time because deduplication existed only in process memory.
- Session replay RED command: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'exact crash-replayed'`.
- Session replay RED failure observed: exact crash replay hit the `messages_in.id` uniqueness constraint instead of recognizing the already-durable identical row.
- Collision characterization: `pnpm exec vitest run src/channels/mattermost-subscription.test.ts -t 'exact crash-replayed|mismatched.*collision'` passed; temporarily changing the collision branch to return an idempotent result made the mismatch test fail because the promise resolved, and restoring the throw returned both tests to Green.
- GREEN command/result: durable receipts suppress completed posts across process/source boundaries, while Mattermost session insertion is idempotent only when every stable row field matches exactly. Exact replay does not issue an ordinary second wake; any mismatched message ID fails closed.
- REFACTOR performed: the canonical receipt digest is source-independent and excludes envelope-only WebSocket metadata; non-Mattermost session writes retain their existing insertion behavior.
- Isolation impact: a duplicate cannot create two turns, while reuse of one external post/message ID for another channel, thread, content, or routing identity is rejected.

### Slice 8.8: fail-closed REST catch-up and bounded retry

- Parser RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'parses one REST catch-up page'`.
- Parser RED failure observed: the catch-up page parser was undefined.
- Coordinator RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'recovers each active channel'`.
- Coordinator RED failure observed: no recovery coordinator existed to request active channels from their durable watermark, route oldest-first, and advance only after completion.
- Saturation RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'catch-up window is saturated'`.
- Saturation RED failure observed: an oversized 1,000-post response resolved and advanced instead of rejecting an unprovable window.
- Validation RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'malformed catch-up post'`.
- Validation RED failure observed: a post with a numeric user identity was routed and advanced rather than rejected before the sink.
- Watermark-proof RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'cannot prove the durable watermark'`.
- Watermark-proof RED failure observed: a sparse response that omitted the prior durable post resolved, routed, and advanced instead of proving a consecutive recovery boundary.
- WebSocket-cursor RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'WebSocket receipt completes'`.
- WebSocket-cursor RED failure observed: completing an active-channel WebSocket receipt left its durable cursor at `{createdAt:0, postId:null}`, forcing later recovery to begin without a trustworthy watermark.
- Response-retry RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'retries rate limits'`.
- Response-retry RED failure observed: the first HTTP 429 failed immediately rather than honoring `Retry-After` and retrying the following 503.
- Transport-retry RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'transient catch-up transport'`.
- Transport-retry RED failure observed: the first network rejection immediately became the sanitized terminal catch-up error.
- Headerless-429 RED command: `pnpm exec vitest run src/channels/mattermost-outbound.test.ts -t 'headerless rate limit'`.
- Headerless-429 RED failure observed: retry classification returned `null` instead of the bounded 250 ms fallback.
- GREEN command/result: the recovery file passed 15 tests at this checkpoint and now passes 34 after the later boundary, state, approval, and retention proofs. REST uses one authenticated channel-ID request ending in `?per_page=200&skipFetchThreads=true`, oldest-first routing of the proven subset, bounded 429/5xx/network delays, sanitized transport errors, and no cursor advance on malformed, failed, saturated, filtered, or unproven windows.
- REFACTOR performed: catch-up shares the pure Mattermost retry classifier with outbound delivery and requests exactly one ordinary newest-first page of at most 200 posts. It does not use `since`, `page`, `before`, or a multi-page walk. An active channel must already have an exact trusted `(post ID, create_at)` watermark inside that page; otherwise recovery fails closed. Response parsing rejects duplicate/invalid ordered IDs, cross-channel rows, malformed stable identities, unsafe timestamps, nonincreasing-order violations, server filtering, an incomplete equal-timestamp boundary cohort, and unvalidated extra rows before routing. Validated unreferenced parent rows may be present but are never routed. Receipt completion and cursor advancement share one SQLite transaction for active channels.
- Isolation impact: catch-up never derives identity from a channel name and never stores or renders the bearer token; ambiguous or incomplete windows stay durably pending rather than skipping messages.

### Slice 8.9: startup/reconnect integration and recovery-aware teardown

- Auth-context RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'returns the authenticated host context'`.
- Auth-context RED failure observed: successful setup resolved `undefined`, so the adapter could not build its host-side processor before recovery without waiting for user traffic.
- Startup-barrier RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'recovers durable channel posts'`.
- Startup-barrier RED failure observed: setup made only the users/me request; no active-channel REST recovery ran and newer live traffic was not gated.
- Runtime-drain RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'drains earlier channel routing'`.
- Runtime-drain RED failure observed: the gap catch-up request began while an earlier same-channel host route was still pending (`3` REST calls instead of `2`).
- Connection-state RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'reports the adapter unavailable'`.
- Connection-state RED failure observed: `isConnected()` remained `true` after authenticated socket termination entered reconnect backoff.
- Teardown RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'in-flight catch-up work during teardown'`.
- Teardown RED failure observed: teardown cleared the processor before the pending REST response could route its durable post, producing zero host calls.
- Crash-receipt characterization: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'crash-left processing receipts'` passed; temporarily removing startup receipt reset made it fail with zero recovered host calls, and restoring reset returned it to Green.
- GREEN command/result: the adapter now gates live callbacks behind startup catch-up, drains prior ingress before a gap window, exposes reconnect availability accurately, coalesces/awaits active recovery, and drains it before clearing inbound state on teardown.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts src/channels/mattermost-recovery.test.ts` — 27 tests passed before later additions.
- Isolation impact: restart/reconnect reuse the existing strict subscription and processor; no recovered item can be dispatched after its channel processor is cleared or into another channel's identity.

### Slice 8.10: channel rename preserves immutable identity

- Normalizer RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'normalizes a channel rename'`.
- Normalizer RED failure observed: the channel-update normalizer was undefined.
- Adapter RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'forwards a channel rename'`.
- Adapter RED failure observed: a valid `channel_updated` frame produced zero metadata callbacks because unsupported socket events were discarded.
- Database RED command: `pnpm exec vitest run src/db/db-v2.test.ts -t 'updates discovered metadata'`.
- Database RED failure observed: no platform-keyed metadata-only update function existed.
- GREEN command/result: all three focused commands passed; only exact agreement between parsed channel ID and broadcast channel ID emits metadata, and the host updates only display name/group metadata for the existing exact platform row.
- REFACTOR performed: rename runs through the same per-channel queue as posts and removal. The database update cannot alter subscription tuple, messaging-group ID/platform ID, agent ID/folder, wiring, session, workspace, mounts, or execution identity.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts src/channels/mattermost-inbound.test.ts` — 30 tests passed; `pnpm exec vitest run src/db/db-v2.test.ts` — 34 tests passed at that point.
- Isolation impact: names remain presentation metadata; every routing and recovery key remains the immutable namespaced channel ID.

### Slice 8.11: bounded execution admission and fail-closed host availability

- Capacity RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'reserves capacity across active and spawning identities'`.
- Capacity RED failure observed: with limit 1, B returned `true` and entered spawn while A was still in asynchronous launch preparation; the expected fail-closed result was `false`.
- Capacity GREEN command/result: the same focused command passed after reserving capacity across the union of active and spawning session IDs. At saturation, B's durable inbox remains untouched; after A exits, retry launches B only with B's agent, session, workspace, and mounts.
- Delivery availability REDs: focused delivery/bridge tests first showed an unavailable Mattermost adapter was still called, a registry race resolved `undefined`, retry budget was consumed, and a disconnected registered adapter reported available.
- Delivery availability GREEN: unavailable/disconnected adapters now leave outbound rows due, and adapter disappearance throws a typed transient error that consumes no permanent retry budget.
- Orphan REDs: focused container-runtime tests showed enumeration failure, a surviving labeled orphan, and a failed stop request did not abort startup.
- Orphan GREEN: enumeration or stop uncertainty now throws; cleanup re-enumerates the install-labeled set and startup cannot continue with a known survivor.
- Affected verification: `pnpm exec vitest run src/container-runner.test.ts src/container-runner.isolation.test.ts src/host-sweep.test.ts` — 3 files/69 tests passed; relevant delivery/bridge/registry/runtime command — 4 files/30 tests passed; full isolation file — 45 tests passed.
- Static verification: type checking and relevant formatting passed; lint reported zero errors and only established warnings.
- Isolation impact: global capacity is shared only as a numeric host resource; queued/deferred work remains in its own session database and can never borrow another channel or Telegram container identity. Runtime cleanup fails closed before a second process can knowingly attach to a surviving execution identity.

### Slice 8.12: file-backed restart retains one exact channel context

- Characterization command: `pnpm exec vitest run src/mattermost-restart.integration.test.ts` — 1 passed using a real file-backed central SQLite database closed and reopened between the accepted and recovered posts.
- Mutation proof: temporarily changing an exact existing receipt from `return existing.status` to `return 'claimed'` made the focused restart test fail (`expected 'claimed' to be 'completed'`); restoring the exact branch returned the test to Green.
- GREEN behavior: the active subscription, messaging-group/agent/wiring IDs, one shared session ID with `thread_id=null`, workspace/session directories and marker, cursor, and completed receipt survive restart. The durable watermark post is skipped, a missed post enters the same inbox/session with its own root, and only the initial and genuinely new work wake that exact session.
- Affected verification: `pnpm exec vitest run src/mattermost-restart.integration.test.ts src/channels/mattermost-recovery.test.ts src/mattermost-isolation.integration.test.ts` passed before pagination hardening; after hardening, the restart test and 15-test recovery file passed together.
- Static verification: focused type checking, ESLint, Prettier, and diff checks passed.
- Isolation impact: restart preserves inode/path and database identity for A without creating a second session, workspace, memory store, mount set, agent identity, or container identity; the recovered thread root remains delivery metadata only.

### Slice 8.13: processing approval crash recovery

- API RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts -t 'resumes a claimed pre-topology approval'`.
- API RED failure observed: the processing-approval recovery function was undefined, so an owner-authorized crash state could not resume.
- Subsequent focused REDs observed zero recovery wake for an exact pending replay; malformed JSON propagated a syntax error; event-identity mismatches completed; orphan/invalid topology and unsafe artifacts threw or were accepted; message collisions propagated; a lost completion transition reported success; and quarantined rows could return to pending.
- Characterization mutations: waking every persisted exact row made the completed-replay test fail; removing the non-pristine-placeholder classification made corrupt state complete. Both mutations were reverted and the focused suite returned to Green.
- GREEN command/result: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts` — 15 tests passed at this checkpoint and 26 pass after the later authenticated-membership recovery slices. Valid pre-topology, membership, session, and persisted-message crash points converge to one topology/replay; only an exact pending replay is re-woken. Deterministic corruption is quarantined, while operational failures propagate and remain retryable.
- REFACTOR performed: migration 016 adds a content-free quarantine row containing only approval ID, bounded reason, and timestamp. Quarantined approvals stay non-rejectable `processing`; live exact replay semantics remain unchanged. Startup invokes recovery after verified orphan cleanup and before adapter ingress.
- Affected verification: the approval checkpoint passed 4 files/143 tests. Later audit-driven coverage superseded that count; the current focused Phase 8 recovery/startup set is recorded after Slice 8.30 rather than claiming this checkpoint as the phase gate.
- Isolation impact: recovery validates canonical subscription/session/filesystem ownership before replay, never repairs ambiguous topology, and cannot wake a mismatched/corrupt channel or reuse another workspace/container identity.

### Slice 8.14: conservative capacity default

- RED command: `pnpm exec vitest run src/config.test.ts`.
- RED failure observed: the Pi-sized default was 5 concurrent containers instead of the required conservative value 2.
- GREEN command/result: the same command passed after changing only the default; an explicit positive `MAX_CONCURRENT_CONTAINERS` environment override remains available for measured deployments.
- REFACTOR performed: `.env.example` documents the host-global capacity and advises measurement before increasing it; `docs/SPEC.md` matches runtime configuration.
- Isolation impact: the limit controls only admission count. It never authorizes container reuse, cross-session mounts, shared writable state, or cross-channel execution.

### Slice 8.15: shutdown drains or durably preserves accepted work

- Delivery RED commands: focused `src/delivery.test.ts` runs for `awaits an already-started delivery drain`, the combined stop/drain API, and `does not admit a new delivery drain` first found the drain APIs undefined and one post-stop adapter call.
- Container RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'closes admissions, awaits spawn reservations'`.
- Container RED failure observed: the shutdown API was undefined, so new wakes could race reservations and active-container enumeration.
- Host-order RED command: `pnpm exec vitest run src/host-shutdown.test.ts`.
- Host-order RED failure observed: the ordered host shutdown function was undefined.
- Failure-continuation RED command: `pnpm exec vitest run src/host-shutdown.test.ts -t 'continues durable drains'`.
- Failure-continuation RED failure observed: the first external-ingress error aborted shutdown immediately instead of draining delivery/spawns and attempting every exact container stop.
- Registry RED command: `pnpm exec vitest run src/channels/channel-registry.test.ts -t 'reports teardown failures'`.
- Registry RED failure observed: a failed adapter drain was logged but converted into a resolved teardown promise.
- GREEN behavior: shutdown synchronously closes host sweep, delivery intake, and container admission; stops external/adapter ingress; awaits accepted recovery/inbound and delivery work; settles spawn reservations; then stops exact active entries. It attempts all later safety steps and aggregates any failures. Failed container stops remain tracked and yield a non-successful host exit; pending SQLite work remains durable.
- Affected verification: shutdown primitives passed 6 files/91 tests; `pnpm exec vitest run src/host-shutdown.test.ts src/delivery.test.ts src/container-runner.isolation.test.ts src/channels/channel-registry.test.ts` passed 4 files/65 tests after final wiring.
- Isolation impact: closing admission before drains prevents a late A/B/Telegram wake from crossing the shutdown boundary, and active entries are stopped by immutable session-bound identity only.

### Slice 8.16: FIFO capacity liveness without identity reuse

- RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'automatically admits capacity-queued channels in FIFO order without racing spawn bookkeeping'`.
- RED failure observed: 1 failed/47 skipped; after A released the only slot, the expected `ensureAgent({name:'Agent agent-mattermost-fifo-b', identifier:'agent-mattermost-fifo-b'})` call never occurred and the sole call remained A, proving B was not automatically reconsidered.
- GREEN command/result: the same focused command passed (1 passed/47 skipped) after adding the insertion-ordered capacity queue.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.isolation.test.ts` — 48/48 passed; `pnpm exec vitest run src/container-runner.test.ts src/container-runner.isolation.test.ts src/host-shutdown.test.ts` — 3 files/62 tests passed.
- REFACTOR performed: queued work retains only immutable execution identity, reloads the canonical session before admission, revalidates active status and exact identity, joins any racing wake through existing spawn bookkeeping, and clears the process-local queue when admissions close. Focused tests remained Green; `tsc --noEmit`, scoped Prettier, ESLint (zero errors/four unrelated warnings), and diff checks passed.
- Isolation impact: capacity is shared only as a numeric host limit. FIFO release never lends A's container, agent, session, workspace, mounts, or memory to B/C/Telegram, and each durable inbox remains the source of truth while queued.

### Slice 8.17: startup/shutdown race hardening and bounded best-effort stop

- Deadline RED command: `pnpm exec vitest run src/host-shutdown.test.ts -t 'bounds a hung shutdown stage'`; the test timed out at 5 seconds because one unresolved stage blocked every later stop.
- Startup REDs: the focused `does not run later startup stages` test found `runHostStartupStages` undefined; `tracks an initializing adapter` observed registry teardown complete early (`true` instead of `false`); `does not retry adapter setup after startup cancellation` observed two setup calls instead of one; and `cannot report connected when teardown interrupts startup catch-up` saw setup resolve `undefined` instead of rejecting cancellation.
- Stop-fallback REDs: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'continues stopping later identities'` surfaced the raw `fallback kill failed` error before the next identity was attempted, while `pnpm exec vitest run src/container-runtime.test.ts -t 'calls docker stop for valid container names'` showed the runtime stop lacked `timeout: 10000`.
- GREEN/affected verification: `pnpm exec vitest run src/host-shutdown.test.ts src/channels/channel-registry.test.ts src/channels/mattermost-adapter.test.ts src/container-runner.isolation.test.ts src/container-runtime.test.ts` — 5 files/88 tests passed.
- REFACTOR performed: an abort-aware staged startup prevents later admission/poll stages from reopening after termination; the registry tracks initializing adapters and cancels retry sleeps; the Mattermost adapter uses a lifecycle generation and rejects its startup barrier; each asynchronous shutdown stage has a referenced 30-second deadline; Docker stop has its own 10-second bound; and nested runtime/fallback failures are aggregated while later identities are still attempted and failed identities remain tracked.
- Static verification: `pnpm typecheck` and targeted Prettier passed; targeted ESLint reported zero errors/seven established warnings; `git diff --check` passed.
- Isolation impact: shutdown cannot briefly resurrect Mattermost ingress or a container after its gates close, and a failed A stop cannot prevent exact B/Telegram stop attempts or authorize execution-identity reuse.

### Slice 8.18: exclusive host lease and default-closed execution admission

- Schema RED command: `pnpm exec vitest run src/db/db-v2.test.ts -t 'installs one central host execution lease before container admission'`; the observed column list was `[]` instead of the singleton owner/PID/acquisition columns.
- Lease API RED commands: focused `rejects a second live host`, `atomically reclaims a lease`, and `allows only the exact current owner to release` runs first found the acquire/reclaim/release exports undefined. The release proof also established that a stale generation cannot delete the current owner's row.
- Startup-order RED command: `pnpm exec vitest run src/host-shutdown.test.ts -t 'acquires exclusive host execution ownership'`; the ordered ownership helper was undefined, so filesystem/runtime mutation and admission were not proven to follow lease acquisition.
- Default-closed REDs: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'keeps a fresh host runner closed'` resolved `true` instead of `false`; `pnpm exec vitest run src/delivery-admission.test.ts` made one downstream agent-group call instead of zero. Both modules therefore admitted work before exclusive startup opened them.
- Conditional-release RED command: `pnpm exec vitest run src/host-shutdown.test.ts -t 'releases the host execution lease only after'`; the successful shutdown path never called lease release, rather than calling it only after the final container stop, while a failed stop had to retain the lease.
- GREEN contract result: `pnpm exec vitest run src/host-execution-lease.integration.test.ts` — 1 passed using real child processes; the second live host was rejected before writing its admission marker, and the exact database was reclaimable only after the first owner received `SIGKILL` and exited.
- Affected-suite verification: `pnpm exec vitest run src/container-runner.test.ts src/container-runner.isolation.test.ts src/host-shutdown.test.ts src/host-execution-lease.integration.test.ts src/db/db-v2.test.ts` — 5 files/105 tests passed; `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts src/modules/permissions/mattermost-channel-approval.test.ts src/host-shutdown.test.ts src/host-execution-lease.integration.test.ts src/container-runner.isolation.test.ts src/db/db-v2.test.ts` — 6 files/126 tests passed; `pnpm exec vitest run src/delivery-admission.test.ts src/delivery.test.ts` — 2 files/13 tests passed. Type checking passed.
- REFACTOR performed: startup now initializes/migrates the central database, atomically acquires one SQLite lease, and only then mutates shared filesystem/runtime state, cleans labeled orphans, and opens default-closed container/delivery intake. Shutdown releases only the exact owner generation and only after every ingress drain, spawn settlement, and container stop succeeds; any prior failure keeps the lease for fail-closed process exit and later stale-owner recovery.
- Operational assumption: liveness uses `process.kill(pid, 0)`, so this lease coordinates processes on the same host and PID namespace. Deployments that share the SQLite database across hosts or isolated PID namespaces still require an external single-writer/leader boundary.
- Isolation impact: two live local hosts cannot concurrently admit channel or Telegram execution against the same central database; crash recovery can replace only a provably dead owner, and no lease decision exposes Mattermost credentials or changes channel/session/workspace identity.

### Slice 8.19: missed supported non-post state is reconciled before gap recovery completes

- Rename RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'reconciles a missed channel rename'`.
- Rename RED failure observed: the gap recovery completed with zero metadata callbacks because REST catch-up recovered posts only and never reconciled current channel metadata.
- Removal RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'reconciles a missed bot removal'`.
- Removal RED failure observed: the gap recovery completed with zero lifecycle callbacks, leaving the active subscription intact when the authenticated bot was absent from the current membership set.
- Identity-validation RED commands: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'rejects an ambiguous current-state identity'` and `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'rejects a malformed identity anywhere'`.
- Identity-validation RED failures observed: both malformed/ambiguous authenticated current-state responses resolved instead of failing closed before metadata, lifecycle, or post routing.
- Retry RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'retries rate limits and transient failures while reconciling current channel state'`.
- Retry RED failure observed: the first HTTP 429 escaped immediately rather than honoring the bounded retry policy and continuing through the following transient 503 to the valid snapshot.
- Teardown mutation proof: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'waits for an in-flight current-state callback'`; temporarily bypassing the inbound processor made teardown finish early (`expected true to be false`). Restoring the exact processor path returned the test to Green.
- GREEN command/result: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts src/channels/mattermost-recovery.test.ts src/channels/mattermost-outbound.test.ts` — 3 files passed, 62 tests passed.
- REFACTOR performed: recovery now obtains one authenticated host-side snapshot from `/api/v4/users/me/channels?include_deleted=false`, strictly validates every returned stable identity, applies exact-ID rename/removal state through the existing per-channel processor, reloads the active subscription set, and only then performs post catch-up. Current-state and post requests share the same bounded 429/transient retry helper and credential-sanitized transport errors.
- Isolation impact: absence can deactivate only the exact namespaced active channel; ambiguous or deleted/non-channel identities stop recovery before routing. Renames change presentation metadata only, and removal cannot redirect a subscription, session, workspace, mount, memory store, or container identity. The bot token remains solely in the host-side Authorization header and is never written to prompts, logs, SQLite metadata, mounts, container environments, or the progress evidence; reconciliation stores no message content.

### Slice 8.20: approval activation and live ingress share one failed-head-aware channel sequencer

- Live-race RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'holds a newer live post'`.
- Live-race RED failure observed: while the approved trigger's first container wake remained deferred, the newer same-channel WebSocket post reached routing and called `wakeContainer` a second time instead of waiting behind the trigger replay.
- Failed-head RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'blocks newer channel work after approval replay fails'`.
- Failed-head RED failure observed: after activation succeeded and trigger replay failed, newer channel-A work resolved `true` and entered the partially activated session; the expected failed-head rejection was absent.
- Lifecycle/claim RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'does not activate an approval behind an earlier queued bot removal'`.
- Lifecycle/claim RED failure observed: an already-queued authenticated bot removal deleted/denied the pending row, but the approval had claimed outside the channel queue and subsequently recreated one active subscription (`count: 1` instead of `0`).
- Mutation proof: temporarily removing the approval task's stable head ID made `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval.test.ts -t 'blocks newer channel work after approval replay fails'` fail again because newer A resolved `true`; restoring the head ID returned the same command to 1 passed/16 skipped.
- GREEN focused result: the combined live-race, failed-head, and lifecycle/claim behaviors passed 3 tests/14 skipped after the final implementation.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-recovery.test.ts src/modules/permissions/mattermost-channel-approval.test.ts src/modules/permissions/mattermost-channel-approval-recovery.test.ts` — 5 files passed, 96 tests passed.
- REFACTOR performed: one host-scoped sequencer now owns canonical channel-ID tails and stable failed post heads for approval activation/replay, live and recovered posts, metadata, and lifecycle. A failed head rejects later identified work without replacing the original head; only the exact post-ID retry can clear it, while unkeyed lifecycle control remains able to fail closed. Approval claim, activation, requester membership, trigger replay, and completion transition now execute inside that same boundary, and completion failure is asserted rather than ignored.
- Static verification: `pnpm typecheck` passed; `pnpm lint` exited zero with 97 established warnings and no errors; scoped Prettier and `git diff --check` passed.
- Isolation impact: queue keys are exact namespaced Mattermost channel IDs, so channel B remains independent while failed channel A is blocked, and Telegram never shares this sequencer, agent group, session, workspace, mounts, memory, or container identity. The sequencer retains only process-local promise tails and stable post IDs; it stores no bot token, authorization header, raw message content, prompt, SQLite message metadata, mount data, or container environment.

### Slice 8.21: only contiguous durable WebSocket sequences are committed

- RED commands: focused `src/channels/mattermost-client.test.ts` runs for `replays a failed lifecycle sequence instead of resuming past it`, `does not commit a later sequence while an earlier handler is pending`, `commits out-of-order successes once the contiguous predecessor settles`, and `prevents an old generation recovery from overwriting replacement resume state`.
- RED failures observed: the client advanced its resume sequence when a handler merely started, skipped a failed predecessor, and allowed an obsolete connection generation to overwrite the replacement connection's recovery state.
- GREEN command/result: `pnpm exec vitest run src/channels/mattermost-client.test.ts` — 26 tests passed. A connection records separately observed and contiguously committed sequence numbers; it advances the resume point only when every preceding host handler has completed durably, and resumes at the failed/pending predecessor.
- REFACTOR performed: handler completion is an explicit outcome, connection generations own their recovery state, and late work from an old generation is ignored without mutating the authenticated replacement. The same connection-wide sequence barrier covers posts, rename metadata, and lifecycle events.
- Affected-suite verification: `pnpm exec vitest run src/channels/mattermost-client.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-recovery.test.ts src/channels/mattermost-inbound.test.ts` — 4 files/80 tests passed.
- Isolation impact: no event is acknowledged before its exact host-side durable effect, and a replaced connection cannot route or acknowledge work into a newer channel/session generation. Connection IDs and sequence counters contain no credentials or message content.

### Slice 8.22: bounded ordinary-page catch-up and trustworthy restart baselines

- Window-design RED failures: multi-request `since`/pagination designs could omit nonconsecutive posts and equal-timestamp peers, while an unbounded response made completeness impossible to prove. The final focused proofs are recorded in Slice 8.25.
- Bootstrap RED failures: recovery began from an untrusted empty cursor instead of failing closed; the legacy-completed-approval bootstrap API was undefined; an unsafe trigger post was seeded as one accepted baseline instead of being rejected; and an equal-timestamp lower post ID regressed the durable cursor.
- GREEN behavior: REST makes exactly one ordinary `per_page=200&skipFetchThreads=true` channel-post request, rejects a missing or ambiguous exact prior watermark, preserves Mattermost's server order for equal timestamps, and fails closed when a full-page boundary cannot prove the complete timestamp cohort. No `since`, `page`, `before`, keyset walk, or 50-page budget remains. Approval activation atomically seeds its trusted trigger baseline; startup derives a baseline only for exact, completed Phase 7 approvals whose topology and trigger identity still validate. Direct/manual active rows without a trusted baseline fail closed.
- REFACTOR performed: the cursor remains monotonic over `(create_at, lexical post ID)` while catch-up retains server order and treats the cursor only as a durable identity proof, not as a server pagination token. Legacy bootstrap and approval crash recovery share strict identity/topology validation and never infer a baseline from a channel display name or mutable metadata.
- GREEN/affected verification: the current recovery suite passes 34 tests; `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts src/modules/permissions/mattermost-channel-approval.test.ts` now covers 43 approval tests. The combined current recovery/startup verification is recorded after Slice 8.30.
- Isolation impact: a recovery baseline belongs to one exact platform/channel/subscription/session tuple. Ambiguous legacy state remains inactive for recovery and cannot inherit another channel's history, workspace, memory, mounts, or container identity.

### Slice 8.23: source-independent identity and host-only credential aliases

- Sender-label RED command: `pnpm exec vitest run src/mattermost-restart.integration.test.ts -t 'reconciles a WS sender label'`.
- Sender-label RED failure observed: the same post received by WebSocket with `sender_name` and later by REST without that presentation field was rejected as an identity collision instead of recognized as one durable post.
- Credential RED command: `pnpm exec vitest run src/container-runner.isolation.test.ts -t 'loaded from the host .env file'`.
- Credential RED failure observed: a Mattermost token alias loaded from the host `.env` was not included in the launch-time value scan and could enter provider/container contributions (`true` instead of the required fail-closed `false`).
- GREEN behavior: the durable receipt digest uses only stable source-independent post identity/content fields; optional sender presentation is preserved for the first routed message but cannot change replay identity. Launch admission scans configured host `.env` Mattermost credential values as well as process-environment aliases and rejects any occurrence in provider environment, arguments, mounts, or rendered configuration.
- GREEN/affected verification: the sender restart focus passed 1 test/1 skipped; the credential focus and the 48-test `src/container-runner.isolation.test.ts` suite passed at the current checkpoint.
- REFACTOR performed: one credential-value collector feeds the existing exact-value and derived-output guards without logging values; test fixtures use synthetic markers only.
- Isolation impact: delivery-source presentation cannot fork one Mattermost post into two turns, and the bot token remains host-side rather than entering prompts, logs, SQLite message metadata, writable workspaces, mounts, container environments, or launch arguments.

### Slice 8.24: bounded durable receipt retention without replay ambiguity

- Schema RED command/result: the focused migration test found no retention-floor table (`[]` instead of four constrained columns).
- Classification REDs: exact receipt lookup and below-floor classification initially had no behavior; removing floor classification later made the file-backed pruned-replay test accept a changed replay (`false` expected, `true` observed).
- Pruning REDs: an initial stub threw; a processing receipt incorrectly allowed the floor to advance to `100` and delete two rows instead of clamping at timestamp `50` and deleting only one. Injected deletion failure initially left floor `100`, proving cursor/floor/prune were not one rollback boundary.
- Claim RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'checks exact receipts before retiring absent posts below the floor'`; an exact completed receipt returned `claimed` because the floor was consulted before exact identity.
- Nested-transaction RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'atomically completes, advances its cursor, and prunes through a nested transaction'`; the expected injected deletion failure did not propagate, so completion and pruning could diverge.
- GREEN behavior: each channel retains the newest 10,000 completed receipts plus the complete boundary-timestamp cohort and every processing receipt. The subscription-independent per-channel floor rejects absent unknown/changed posts below it, while exact retained identity is always checked first and equal-boundary collisions remain provable. Receipt completion, cursor advancement, floor movement, and deletion share one SQLite transaction and roll back together.
- Restart GREEN command: `pnpm exec vitest run src/mattermost-restart.integration.test.ts -t 'rejects pruned WS and changed REST replays after restart before session or wake'` — 1 passed. The retention checkpoint passed 9 files/225 tests; the recovery suite now passes 34/34 after the later audit-driven cases, and static checks remained green.
- REFACTOR performed: migration 018 adds content-free per-channel retention floors with integrity constraints; pruning is deterministic and uses the same transaction helper as durable completion. No retained row or floor contains message content, sender labels, prompts, tokens, workspace paths, mounts, or container environment.
- Isolation impact: retention keys include the immutable platform/channel identity, so a floor cannot suppress another Mattermost channel or Telegram. Conservative boundary retention and processing clamps fail closed rather than treating an ambiguous replay as completed.

### Slice 8.25: one-page recovery completeness proofs

- Same-millisecond RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'unprocessed post in the same millisecond'`; the durable watermark was listed before its same-millisecond peer, so routing produced `[]` instead of `['post-missed-a']`.
- Ordinary-boundary RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'same-millisecond cohort split at the ordinary page boundary'`; the attempted recovery omitted `post-boundary-missed`. The final proof rejects because the exact watermark is outside the sole 200-row page; the companion full-page test also rejects when a present watermark's timestamp cohort reaches the response boundary.
- Nonconsecutive-window RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'fills a nonconsecutive since hole'`; the prior `since` strategy routed only `['post-newest']` instead of `['post-since-hole', 'post-newest']`. The retained test name records that regression, but Green obtains the hole from the single ordinary page and sends no `since` request.
- Parent-row RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'validates but does not route an unreferenced parent'`; the response was rejected as invalid merely because Mattermost included a parent outside `order`. Green validates every extra row's stable identity/channel but routes only rows referenced by `order`.
- Boundary/order/filter mutation RED commands: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'full page whose watermark timestamp cohort'`, `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'not in nonincreasing creation order'`, and `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'server-filtered page'`. Temporarily bypassing the respective checks made the boundary and order cases resolve instead of reject; the filtered response likewise resolved instead of rejecting.
- GREEN command/result: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts` — 34/34 passed. Each channel issues one request to `/api/v4/channels/{id}/posts?per_page=200&skipFetchThreads=true`; the exact watermark must be present, timestamps must be nonincreasing in server order, `first_inaccessible_post_time` must not report filtering, and a full equal-timestamp boundary must be provably complete or recovery stops without routing or cursor movement.
- REFACTOR performed: removed the unsafe `since`, offset, keyset, and multi-page assumptions. One bounded parser validates the complete returned object, reverses only the proven route subset, preserves equal-timestamp server order, prioritizes an exact failed head separately, and treats every proof failure as terminal for that recovery attempt.
- Isolation impact: completeness is proven independently for each immutable instance/channel cursor. An ambiguous page can neither acknowledge skipped work nor borrow another channel's receipt, session, workspace, memory, mount, or container identity.

### Slice 8.26: recovered-post priority and terminal channel control

- Present-channel ordering RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'replays recoverable posts before applying current metadata'`; callbacks ran as `['metadata', 'post']` instead of `['post', 'metadata']`, so a rename could be blocked ahead of the post whose failed head had to be retried.
- Exact-head RED command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'prioritizes the exact failed head'`; the recovery promise rejected with `Mattermost channel ingress is blocked by an earlier failed post` because a later same-millisecond candidate ran before the exact failed head.
- Terminal-removal RED command: `pnpm exec vitest run src/channels/mattermost-inbound.test.ts -t 'lets terminal bot removal clear a failed head'`; the removal promise was rejected as blocked and the failed-head ID remained set, so an absent bot could not terminally close the channel.
- GREEN behavior: current authenticated membership is validated first, but for a present channel its recoverable posts run before rename metadata. Recovery promotes only the sequencer's exact failed post ID ahead of otherwise preserved server order. Metadata remains blocked behind a failed post, while authenticated bot removal is terminal control that may execute, clear the exact failed head, and prevent later work.
- REFACTOR performed: the recovery coordinator receives a read-only failed-head lookup from the shared channel sequencer; terminal lifecycle clearing remains inside that sequencer rather than adding a second ordering mechanism.
- Verification: the recovery and inbound suites pass 34/34 and 21/21 respectively.
- Isolation impact: priority is scoped by exact namespaced channel ID and stable post ID. Terminal removal affects only its canonical channel; it cannot release another Mattermost channel or any Telegram execution.

### Slice 8.27: authenticated approval membership recovery

- Offline-membership RED commands: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts -t 'reports unfinished approval work'` and `pnpm exec vitest run src/channels/mattermost-recovery.test.ts -t 'unfinished approvals from authenticated membership'`. The membership-work APIs were undefined, so startup with no active subscription skipped the authenticated current-channel request and could strand an owner-authorized pending/processing approval.
- Pending/processing RED commands: focused runs for `terminal-cancels a pending approval`, `quarantines an absent processing approval`, `recovers a processing approval only after authenticated startup membership`, and `deactivates partial processing topology`. Before Green, absent processing reported `membershipQuarantined: 0` instead of `1`, present processing reported `completed: 0` instead of `1`, and absent partial topology remained active. Pending work also lacked an authenticated terminal-cancellation path.
- Live-owner RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts -t 'live owner replay that completes ahead'`; stale startup recovery threw `Mattermost approval recovery completion transition failed` after the live owner path had already completed the exact row.
- Scoped-bootstrap RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts -t 'bootstraps legacy cursors only for the authenticated Mattermost instance'`; primary startup seeded one secondary-instance cursor instead of zero.
- Terminal-head RED command: `pnpm exec vitest run src/modules/permissions/mattermost-channel-approval-recovery.test.ts -t 'terminal-cancels an absent approval through the shared failed-head sequencer'`; cancellation left the failed-head string in place.
- GREEN behavior: unfinished approvals force one authenticated membership snapshot even when there is no active subscription. An absent `pending` row is terminally cancelled and denied; an absent `processing` row is content-free quarantined and any partial subscription is deactivated; a present O/P-channel processing row resumes exact topology/replay and completes. A concurrent live owner completion is accepted as already resolved, and legacy cursor bootstrap is restricted to the authenticated instance.
- REFACTOR performed: membership reconciliation precedes legacy bootstrap and active-channel post recovery, uses the shared terminal sequencer for cancellation, and keeps deterministic absence quarantine distinct from retryable operational failures. Direct-message, group-message, and deleted memberships cannot authorize channel recovery; public and private channels remain the only accepted types.
- Verification: `src/modules/permissions/mattermost-channel-approval-recovery.test.ts` passes 26/26, `src/modules/permissions/mattermost-channel-approval.test.ts` passes 17/17, and the recovery suite passes 34/34.
- Isolation impact: authenticated bot membership is checked for the exact instance/channel before activation or replay. A pending/processing row cannot construct or wake topology for an absent, foreign-instance, direct-message, group-message, deleted, or ambiguous channel, and quarantine contains no message content or credential.

### Slice 8.28: recovery readiness, socket truth, and persistent reconnect backoff

- Pre-initialization RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'settles a pre-initialization sequence-gap hook'`; after teardown, `teardownSettled` was still `false` because a gap hook remained blocked on an unresolved recovery-ready promise.
- Post-auth cleanup RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'tears down authenticated transport when post-auth initialization fails'`; the database failure escaped with zero socket-close calls instead of one.
- Socket-state RED command: `pnpm exec vitest run src/channels/mattermost-adapter.test.ts -t 'remains unavailable when the authenticated socket closes during startup recovery'`; `isConnected()` returned `true` instead of `false` after the socket terminated while REST startup recovery was pending.
- Persistent-backoff RED command: `pnpm exec vitest run src/channels/mattermost-client.test.ts -t 'continues exponential backoff across authenticated connections whose recovery fails'`; after a second authenticated `hello` and another unprovable recovery gap, the active delay reset to 1,000 ms instead of continuing to 2,000 ms.
- GREEN behavior: setup creates an explicitly rejectable `recoveryReady` boundary before client callbacks can observe a gap; teardown and setup failure settle it, drain hooks, and close authenticated transport exactly once. Adapter availability requires both completed recovery setup and a currently connected socket. Reconnect attempts reset only after a sequenced event completes durably, not merely after authentication or `hello` while recovery still fails.
- REFACTOR performed: socket connectivity and recovery readiness are separate state variables joined only at the adapter availability boundary; lifecycle generations own all deferred setup state and stale callbacks cannot reopen it.
- Verification: the adapter suite passes 23/23 and the client suite passes 27/27.
- Isolation impact: no pre-initialization or stale-generation hook can outlive teardown and route into replacement state. Backoff state carries only counters/connection sequence metadata, never token, content, channel workspace, or container identity.

### Slice 8.29: restart-generation lease and project-file capacity configuration

- Same-PID RED command: `pnpm exec vitest run src/db/db-v2.test.ts -t 'reclaims a stale generation when a restarted host reuses the same process id'`; acquisition threw the live-lease error when a restarted host reused PID 101 instead of replacing the prior owner generation.
- `.env` capacity RED command: `pnpm exec vitest run src/config.test.ts -t 'honors the global container limit from the project env file'`; configuration remained at the default `2` instead of the project-file value `3`.
- GREEN behavior: the lease's random owner generation distinguishes a restarted same-PID host and exact-generation release still cannot delete a replacement row. `MAX_CONCURRENT_CONTAINERS` now follows normal project configuration precedence—process environment, project `.env`, then conservative default 2—with a minimum of 1.
- REFACTOR performed: same-PID generation replacement stays inside the existing immediate SQLite acquisition transaction; capacity uses the shared bounded env-file reader rather than a second parser.
- Verification: `src/db/db-v2.test.ts` passes 40/40 and `src/config.test.ts` passes 2/2.
- Isolation impact: PID reuse cannot strand all execution admission, stale owner IDs cannot release current admission, and a configured capacity changes only the number of distinct identities admitted—not their channel/session/workspace/mount/container binding.

### Slice 8.30: strict required-adapter startup gates

- Strict-recovery RED command: `pnpm exec vitest run src/channels/channel-registry.test.ts -t 'propagates a strict adapter recovery failure'`; initialization resolved instead of rejecting the adapter's recovery failure.
- Required-credentials RED command: `pnpm exec vitest run src/channels/channel-registry.test.ts -t 'durable state requires an adapter whose credentials are missing'`; initialization resolved instead of rejecting missing credentials for persisted Mattermost state.
- Instance-preflight RED command: `pnpm exec vitest run src/channels/channel-registry.test.ts -t 'persisted instance mismatch before adapter setup'`; the mismatched adapter's `setup` ran instead of failing before any adapter mutation. The companion `requires the active adapter to match every persisted platform instance` focus initially lacked the required instance-check API.
- GREEN behavior: a strict Mattermost setup/recovery error propagates before host work starts; persisted Mattermost state makes the adapter and its host credentials required; and every persisted instance key must exactly match the configured adapter instance both before setup and at the post-initialization guard.
- REFACTOR performed: optional adapters retain best-effort startup, while strict, required, and required-instance policies are explicit registry options supplied by host startup. Required-instance preflight occurs immediately after factory construction and before `adapter.setup()`.
- Verification: `pnpm exec vitest run src/channels/channel-registry.test.ts` — 11/11 passed.
- Isolation impact: durable `mattermost:{instance}:{channel}` state cannot be served by a missing, partially initialized, or differently configured instance, so startup fails before ingress, recovery, workspace mutation, or container admission can cross an instance boundary.

### Current Phase 8 regression checkpoint

- Focused command/result: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts src/channels/mattermost-inbound.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-client.test.ts src/modules/permissions/mattermost-channel-approval-recovery.test.ts src/modules/permissions/mattermost-channel-approval.test.ts src/db/db-v2.test.ts src/config.test.ts src/channels/channel-registry.test.ts` — 9 files/201 tests passed.
- Latest full host regression command/result: `pnpm test` — 57 files/733 tests passed.
- Phase status remains in progress. These are current local verification results, not a completed phase gate, pull-request result, or CI claim.

### Phase 8 local gate

- Focused recovery/startup command: `pnpm exec vitest run src/channels/mattermost-recovery.test.ts src/channels/mattermost-inbound.test.ts src/channels/mattermost-adapter.test.ts src/channels/mattermost-client.test.ts src/modules/permissions/mattermost-channel-approval-recovery.test.ts src/modules/permissions/mattermost-channel-approval.test.ts src/db/db-v2.test.ts src/config.test.ts src/channels/channel-registry.test.ts` — 9 files/201 tests passed.
- Full host fast-suite command: `pnpm test` — 57 files/733 tests passed.
- Host static commands: `pnpm typecheck` and `pnpm format:check` passed; `pnpm lint` passed with zero errors and 96 warnings; `git diff --check` passed.
- Container type-check command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun run typecheck` — passed.
- Complete isolated container unit command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/db/session-state.test.ts src/mcp-tools/deep-research-workflow.test.ts src/providers/codex.factory.test.ts src/providers/factory.test.ts src/providers/codex-app-server.test.ts src/providers/codex.test.ts src/poll-loop.test.ts src/timezone.test.ts src/formatter.test.ts` — 9 files/109 tests passed.
- Complete isolated container integration command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/integration.test.ts` — 1 file/3 tests passed. The two clean processes cover the full 10-file/112-test container inventory without the pre-existing leaked-loop cross-file interference documented in Phase 5.
- Scope/security audit: no focused-test markers, whitespace errors, new generated artifacts, or large untracked source files were found. The diff contains synthetic credential markers only; no production Mattermost URL, token, credential, or message content was used.
- Independent audit: concurrent review tracks found and verified fixes for one-page completeness, durable sequence commits, authenticated approval recovery, terminal failed-head control, startup readiness, reconnect escalation, strict instance preflight, same-PID lease recovery, retention boundaries, FIFO capacity, and shutdown races. Their final reviews found no remaining Phase 8 correctness, acceptance, credential, or mandatory-isolation blocker.
- Pull request: [#45](https://github.com/ufJmacca/nanoclaw/pull/45), `codex/mattermost-08-recovery` targeting `codex/mattermost-07-lifecycle` (dependent on Phase 7 PR #44).
- GitHub verification: the available `label` check passed ([run 29140090841](https://github.com/ufJmacca/nanoclaw/actions/runs/29140090841)). The repository's code CI workflow is restricted to pull requests targeting the default branch, so GitHub did not provide a code test/type/lint check for this stacked base; the complete local host/container gate above is the phase gate, and no unavailable check is represented as passing.
- Phase status: complete; the local gate, independent audits, scope/security review, and every available required GitHub check passed. Pull request #45 is ready for review.

## Phase 9 — Live Mattermost contract tests

- Phase status: in progress. The disposable harness and its host-side safety boundaries are under local verification; no live contract result, pull-request result, or CI result is claimed here.

### Slice 9.1: disposable environment fails closed before Docker

- Initial RED command: `pnpm exec vitest run src/contracts/mattermost/safety.test.ts`.
- Initial RED failure observed: the safety validator was absent, so the focused assertion received `undefined` instead of a function.
- Focused RED commands included `pnpm exec vitest run src/contracts/mattermost/safety.test.ts -t 'bot token'`, `-t 'Mattermost instance'`, `-t 'non-loopback'`, `-t 'Docker context'`, `-t 'remote Docker host'`, `-t 'unpinned Mattermost'`, `-t 'unpinned Postgres'`, `-t 'host bind mounts'`, `-t 'Docker socket mounts'`, `-t 'privileged services'`, `-t 'external Compose networks'`, and `-t 'non-amd64 host'`. Each initially resolved without the required rejection. The malformed-endpoint focus returned raw `Invalid URL` instead of the content-free contract error.
- GREEN command/result: `pnpm exec vitest run src/contracts/mattermost/safety.test.ts` — 24/24 passed. The validator rejects caller-provided Mattermost URL/token/instance values, non-loopback or credential-bearing endpoints, remote Docker selection, non-approved image pins, bind/socket mounts, privileged services, external networks, and direct execution on a non-amd64/x64 host.
- Mutation proof: relaxing the official Mattermost repository expression made `pnpm exec vitest run src/contracts/mattermost/safety.test.ts -t 'unofficial Mattermost'` fail because the unsafe image stopped throwing. Removing `x64` from the accepted architecture set made `pnpm exec vitest run src/contracts/mattermost/safety.test.ts -t 'isolated disposable baseline'` fail. Both mutations were reverted and their focused tests returned to Green.
- REFACTOR performed: safety input, service, mount, and network types are readonly; Docker host/context and socket checks are pure helpers; the approved Mattermost 11.7.6 and Postgres 18-alpine digests are exported immutable constants for the harness and Compose validation boundary.
- Affected verification at slice completion: `pnpm exec vitest run src/contracts/mattermost` — 5 files/48 tests passed; `pnpm typecheck`, targeted ESLint, targeted Prettier, and `git diff --check` passed.
- Remaining risk: the runner must faithfully normalize `docker compose config --format json` into the validated image, service, mount, and network fields. Custom rootless Docker sockets intentionally fail closed.

### Slice 9.2: host REST contract client cannot target production

- Additional RED command: `pnpm exec vitest run src/contracts/mattermost/api.test.ts -t 'cannot be constructed for a non-loopback Mattermost server'`.
- RED failure observed: constructing the client for `https://mattermost.production.example` resolved instead of throwing, so the provisioning client could be pointed outside the disposable loopback environment.
- GREEN command/result: the same focused command passed after constructor validation rejected the production host with `Mattermost contract base URL must be loopback-only`; `pnpm exec vitest run src/contracts/mattermost/api.test.ts` — 18/18 passed.
- REFACTOR/coverage result: the host-only client uses bounded readiness polling, timeouts and retry backoff, encoded resource paths, exact response-identity validation, and sanitized transport errors while covering disposable users, team, channels, bot, membership, root/thread posts, reads, removal, and deactivation.
- Isolation impact: provisioning credentials remain in the host contract process, and the constructor rejects non-loopback destinations before any HTTP request can carry them.

### Slice 9.3: bounded restart-worker protocol and credential-free observations

- Command RED: `pnpm exec vitest run src/contracts/mattermost/worker-protocol.test.ts` failed because the executable seam rejected even the valid instance-scoped delivery command. The focused control-command RED likewise rejected valid snapshot, deactivation, and shutdown requests.
- Event REDs: the focused `emits bounded prefixed events` run failed because the encoder rejected every safe event; after its first Green, a forbidden token embedded in an error message did not throw. The `ignores ordinary logs` focus initially rejected a safe prefixed event, and later an unprefixed stdout line containing the synthetic bot token returned `null` instead of failing.
- Configuration RED: `pnpm exec vitest run src/contracts/mattermost/worker-config.test.ts` failed because the parser rejected the valid fixed-loopback/two-channel configuration.
- GREEN result: `src/contracts/mattermost/worker-protocol.test.ts` passes 4/4 and `src/contracts/mattermost/worker-config.test.ts` passes 1/1. Commands accept only exact bounded fields in the fixed `contract` instance; the worker root must be a dedicated `nanoclaw-mm-contract-*` directory under the system temporary root; event encoding/parsing rejects credential keys, forbidden credential values in prefixed events or ordinary logs, malformed payloads, cycles, and oversized output.
- REFACTOR performed: command, config, and event validation are pure seams. The live worker registers the real Mattermost adapter directly, so its disposable token stays in host memory instead of a project `.env`, prompt, SQLite message metadata, mount, launch argument, or agent-container environment.
- Isolation impact: the worker creates two strict canonical subscriptions, uses the real router while execution admission remains closed, emits only content-free topology/session counts, and restarts against the same test-owned SQLite/filesystem root without sharing A/B identities.

### Slice 9.4: safe Compose orchestration, cleanup, and trustworthy mutation proof

- Cleanup REDs: `pnpm exec vitest run src/contracts/mattermost/run.test.ts` first returned the unimplemented-harness error instead of the injected live failure; the partial-start focus observed zero cleanup calls; and the dual-failure focus received only the cleanup error instead of both failures.
- Compose REDs: the normalized-safety focus hit the unimplemented parser; a host-PID field resolved instead of being rejected; host networking, a `0.0.0.0` published port, and a non-internal network each resolved without the required fail-closed error before their focused Greens.
- Execution RED: `pnpm exec vitest run src/contracts/mattermost/run.test.ts -t 'executes argv'` received the unimplemented executor instead of the bounded child result. An initial `process.exit()` fixture discarded pipe output and was not accepted as Red; the fixture was corrected to synchronous descriptor writes before Green.
- Mutation-proof mutation: `pnpm exec vitest run src/contracts/mattermost/run.test.ts -t 'unrelated live-test failure'` passed with the marker check present. Temporarily accepting any nonzero live exit made the focus fail because the harness resolved after an unrelated infrastructure error. Restoring the required `CONTRACT_ROOT_ID_ASSERTION` marker returned the focus to Green.
- GREEN result: `src/contracts/mattermost/run.test.ts` passes 8/8 and `src/contracts/mattermost/safety.test.ts` passes 27/27. The runner validates the actual normalized Compose model, uses argv without a shell, accepts only the local default Docker socket and exact image pins, expects the unique root mutation failure, runs the unmutated suite, and always removes containers/named volumes. Simultaneous test and cleanup failures are preserved in one aggregate.
- Actual Compose verification: the pinned Compose file passed `docker compose ... config --quiet`; its `--format json` output also passed `parseMattermostContractComposeConfig` followed by `assertSafeMattermostContractEnvironment`, including exact images, two-service topology, volume-only mounts, loopback port, and internal non-external network.
- REFACTOR performed: subprocess environment propagation is an explicit small allowlist; no caller `NODE_OPTIONS` or unrelated secret-bearing environment reaches Docker/Vitest children; command errors do not reflect response bodies or credentials.

### Slice 9.5: disposable live scenario prepared for the x86 gate

- The separate `vitest.mattermost.config.ts` includes only `*.contract.ts`; the repository's normal fast suite cannot discover the destructive provisioning scenario.
- The live scenario creates its administrator/actor/team/channels/bot/token only on `http://127.0.0.1:8065`, verifies bot membership, receives normal/threaded posts through the real WebSocket adapter, inspects distinct A/B topology/workspace/session/execution identities, sends real adapter replies, restarts the adapter in a second process, unsubscribes A while B continues, and waits for authenticated bot-removal deactivation on B.
- The runner first sets a test-only mutation that drops the outbound root. The focused live test must fail specifically with `CONTRACT_ROOT_ID_ASSERTION`; it then runs without the mutation for Green. Any authentication, provisioning, Docker, or other assertion failure cannot satisfy the mutation proof.
- Local live status: the entrypoint was run but the live scenario was not executed. It failed closed before Docker on this arm64 host; the dedicated secret-free `ubuntu-24.04` workflow is the authorized disposable x86 execution environment. No live Red, Green, or contract pass is claimed until that workflow executes.
- Operational documentation: `docs/mattermost-contract-tests.md` records commands, immutable image pins, PostgreSQL 18's `/var/lib/postgresql` volume target, scenario coverage, cleanup, architecture limitations, and the prohibition on production credentials/instances.

### Slice 9.6: audit-driven restart proof and complete disposable-resource isolation

- Cleanup API RED command: `pnpm exec vitest run src/contracts/mattermost/api.test.ts -t 'removes and deactivates'`; it failed with `TypeError: api.disableBot is not a function` before the v11 bot-disable and personal-token-revoke contracts existed. GREEN uses `POST /api/v4/bots/{id}/disable` and `POST /api/v4/users/tokens/revoke` with the exact token identity; the API suite passes 18/18.
- Restart-proof RED command: `pnpm exec vitest run src/contracts/mattermost/worker-config.test.ts`; the valid `bootstrapSubscriptions: true` configuration was rejected. GREEN validates the exact boolean and provisions subscriptions only for the first worker; the restarted worker sets it false and must recover the same active subscription/session identities from disk without recreating them.
- Credential-output RED command: `pnpm exec vitest run src/contracts/mattermost/worker-protocol.test.ts`; an ordinary unprefixed stdout line containing the synthetic forbidden token returned `null` instead of throwing. GREEN scans all worker stdout before ignoring ordinary logs, while still emitting only bounded credential-free prefixed observations.
- Network-namespace RED command: `pnpm exec vitest run src/contracts/mattermost/safety.test.ts -t 'join another container network namespace'`; the `container:shared-service` mode resolved without rejection. GREEN permits only the normalized default/bridge mode and rejects cross-container namespace attachment.
- Top-level storage RED commands: focused `src/contracts/mattermost/run.test.ts` runs for `external top-level Compose volumes`, `volume driver options`, `fixed top-level volume names`, `custom top-level volume drivers`, and `incomplete disposable named-volume topology`. Each initially resolved without throwing. GREEN rejects external/shared volumes, host/NFS-capable driver configuration, globally fixed names, and any named-volume set other than the seven exact project-scoped disposable volumes.
- Network-name RED command: `pnpm exec vitest run src/contracts/mattermost/run.test.ts -t 'fixed top-level network names'`; a shared global network name resolved. GREEN requires the normalized internal network name to carry the exact current Compose project prefix.
- GREEN/affected result: `pnpm exec vitest run src/contracts/mattermost/run.test.ts` — 14/14 passed; `pnpm test:mattermost:safety` — 5 files/65 tests passed.
- REFACTOR performed: Compose normalization now retains the current project identity only for validation and returns the minimal safety model; dual run/cleanup failures preserve both errors and the cleanup cause; live cleanup follows stop worker → revoke token → disable bot → delete channels/team → deactivate actor before the outer authoritative `down --volumes`.
- Live assertions strengthened: A and B must have distinct real group and session-state paths, distinct agent/messaging/wiring/session/composite execution identities, stopped container state throughout, active status after restart, and closed/stopped B state after authenticated bot removal. These assertions await the disposable x86 execution and are not represented as locally passed.
- Independent audit: two read-only reviews checked the Mattermost 11.7.6 REST/WebSocket contracts, restart semantics, topology/session assertions, cleanup ordering, Compose isolation, and credential surfaces. Every identified correctness or isolation gap was fixed; their final local review found no remaining semantic blocker.

### Slice 9.7: first CI startup hypothesis is tested and rejected

- Failed check: Phase 9 PR #46 `live-contract`, [run 29141890199](https://github.com/ufJmacca/nanoclaw/actions/runs/29141890199), failed after 2m33s with `Mattermost contract root_id mutation was not detected`. Safety and normalized Compose steps had passed; the focused mutation child consumed approximately the complete 120-second readiness budget and never reached the root assertion, so the harness correctly refused to count an infrastructure failure as Red.
- Hypothesis evidence: the approved pinned image manifest declares runtime user `mattermost` and image-owned volumes at `/mattermost/config`, `/mattermost/data`, `/mattermost/logs`, `/mattermost/plugins`, and `/mattermost/client/plugins`, but not the configured standalone Bleve path.
- Hypothesis RED command: `pnpm exec vitest run src/contracts/mattermost/run.test.ts -t 'image-owned Mattermost data volume'` — failed because the parser required the standalone `mattermost-bleve` volume (`Mattermost contract Compose volumes must match the disposable topology`). The focus and affected local gate passed after temporarily nesting Bleve under `/mattermost/data` and removing that volume.
- Falsification: the corrected [run 29142232510](https://github.com/ufJmacca/nanoclaw/actions/runs/29142232510) failed with the same error after 2m32s. The ownership inference therefore was not accepted as root cause; its code, test, documentation, and six-volume topology were reverted without weakening readiness or mutation detection.

### Slice 9.8: bounded redacted CI diagnostics survive cleanup

- RED command: `pnpm exec vitest run src/contracts/mattermost/run.test.ts -t 'unrelated live-test failure'` — the new reporter was called zero times, so child failure, Compose status, and server logs were discarded before `down --volumes`.
- GREEN command/result: the same focus passes after a missing mutation marker gathers `docker compose ps --all --format json` and the final 200 Compose log lines before cleanup. One bounded 12,000-character report strips control characters and redacts authorization bearer values, password/token fields, and every known disposable password; the focused fixture proves three synthetic credential values are absent while `permission denied` remains useful.
- REFACTOR performed: diagnostics are an injectable reporter for tests and stderr-only by default. Diagnostic command startup failures collapse to a content-free marker and never mask the authoritative `Mattermost contract root_id mutation was not detected` failure; cleanup still always removes containers and volumes.
- Affected verification: `src/contracts/mattermost/run.test.ts` passes 14/14; `pnpm typecheck`, targeted Prettier, targeted ESLint with zero errors/one established warning, and `git diff --check` pass.

### Phase 9 local gate

- Focused contract command: `pnpm test:mattermost:safety` — 5 files/65 tests passed.
- Full host fast-suite command: `pnpm test` — 62 files/798 tests passed. The separate `*.contract.ts` live suite remained excluded.
- Host static commands: `pnpm typecheck` and `pnpm format:check` passed; `pnpm lint` passed with zero errors and 100 warnings; `git diff --check` passed.
- Compose commands: `docker compose -f test/contracts/mattermost/docker-compose.yml -p nanoclaw-mm-contract-ci config --quiet` passed; the real `--format json` output passed `parseMattermostContractComposeConfig` and `assertSafeMattermostContractEnvironment`, including exact service/image/mount/port/network/project-volume topology.
- Container type-check command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun run typecheck` — passed.
- Complete isolated container unit command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/db/session-state.test.ts src/mcp-tools/deep-research-workflow.test.ts src/providers/codex.factory.test.ts src/providers/factory.test.ts src/providers/codex-app-server.test.ts src/providers/codex.test.ts src/poll-loop.test.ts src/timezone.test.ts src/formatter.test.ts` — 9 files/109 tests passed.
- Complete isolated container integration command: `docker run --rm --network none -v /home/pi/nanoclaw-v2:/workspace -w /workspace/container/agent-runner oven/bun:1.3.12 bun test src/integration.test.ts` — 1 file/3 tests passed.
- Local live command outside the sandbox: `pnpm test:mattermost` failed closed before Docker with `Mattermost contract tests require an amd64 host`. The official pinned Mattermost image is not emulated on this arm64 host, so no local live pass is claimed.
- Phase status remains in progress pending the stacked draft PR's disposable `ubuntu-24.04` live-contract check. These local results are not a pull-request, CI, or live Mattermost pass claim.
