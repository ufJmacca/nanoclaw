# NanoClaw Mattermost Integration — TDD Implementation Plan

## Purpose

Implement a native Mattermost channel adapter for NanoClaw using strict test-driven development (TDD): **Red → Green → Refactor**.

The completed integration must let NanoClaw subscribe to selected Mattermost channels while guaranteeing that:

- every Mattermost channel has its own NanoClaw agent group;
- every Mattermost channel has its own session/context stream;
- no container execution is shared by two Mattermost channels;
- Mattermost and Telegram contexts never overlap;
- Mattermost threads remain threads in the UI but share only their channel's context;
- credentials remain in the NanoClaw host process and never enter agent containers.

This document is an implementation contract for a Codex CLI session. Inspect the current repository before relying on any path, type, command, or dependency named below; the fork may have changed since this plan was written.

## Target repository

- User fork: <https://github.com/ufJmacca/nanoclaw>
- Upstream: <https://github.com/nanocoai/nanoclaw>

Previously relevant areas, to be verified during repository discovery:

- `src/channels/adapter.ts`
- `src/channels/index.ts`
- `src/router.ts`
- `src/session-manager.ts`
- `src/container-runner.ts`
- `src/db/schema.ts`
- channel-management and registration skills under `.claude/skills/`

## Non-negotiable isolation model

Use NanoClaw's strongest isolation level: a distinct agent group for every Mattermost channel. Do not place multiple Mattermost channels in one agent group, even if they belong to the same Mattermost team.

The required mapping is:

```text
Mattermost instance + channel ID
              1:1
NanoClaw messaging group
              1:1
NanoClaw agent group
              1:1
NanoClaw shared session for that channel
              1:1
Dedicated container execution stream and writable workspace
```

A container may be stopped and recreated over time, but its session identity, writable mounts, workspace, memory, and agent identity must remain exclusive to one Mattermost channel. A running container must never process messages from two channel IDs.

Telegram must remain in its existing, separate agent group/session/container boundary.

### Enforced invariants

1. A Mattermost `(instance_key, channel_id)` maps to exactly one agent group.
2. A Mattermost agent group maps back to exactly one Mattermost channel.
3. A Mattermost agent group cannot contain Telegram or another adapter's wiring.
4. Mattermost channel wiring uses `session_mode = 'shared'`.
5. Mattermost thread metadata does not create a per-thread NanoClaw session.
6. One session ID can have at most one active container execution at a time.
7. Two channel IDs cannot resolve to the same session ID, workspace, writable mount, container key, memory directory, or OneCLI agent ID.
8. Mattermost agent groups have no cross-agent destinations unless a future feature explicitly adds an audited opt-in.
9. Mattermost credentials are available only to the host-side adapter.
10. Invalid or ambiguous wiring fails closed before any agent is invoked.

Prefer enforcing these invariants in both the database and application layer. If the existing many-to-many wiring schema cannot safely express Mattermost's one-to-one constraint, consider a dedicated subscription table with unique constraints, for example:

```text
mattermost_subscriptions
  instance_key
  channel_id
  messaging_group_id UNIQUE
  agent_group_id UNIQUE
  status
  created_at
  archived_at

UNIQUE(instance_key, channel_id)
```

Do not adopt this example blindly; first inspect migrations, compatibility requirements, and existing registration flows.

## TDD execution contract

Every net-new behavior must be completed as a small vertical slice.

### Red

1. Add one focused test expressing externally observable behavior.
2. Run the narrowest relevant test command.
3. Confirm it fails for the intended missing behavior, not because of a syntax, fixture, or environment error.
4. Record the command and concise expected failure in the implementation progress log.
5. Do not edit production code until the failure has been observed.

### Green

1. Implement only enough production code to satisfy the new test.
2. Run the focused test until it passes.
3. Run the affected package/suite to detect regressions.
4. Do not combine unrelated cleanup or speculative features with this step.

### Refactor

1. Improve structure, naming, duplication, and dependency boundaries without changing behavior.
2. Keep the focused test and affected suite green throughout.
3. Run formatting, linting, type checking, and the full fast test suite.
4. Record the green commands and refactoring summary in the progress log.
5. Complete this cycle before starting the next test.

Existing behavior may require characterization tests that are green immediately. These are not a substitute for a Red step on new behavior. Prove that a characterization test detects regression using a temporary local mutation or the repository's mutation-testing mechanism, then revert that mutation before continuing.

### TDD guardrails

- Never write a batch of tests followed by a batch of implementation.
- Never weaken, skip, delete, or over-mock a failing test merely to obtain green.
- Prefer behavior assertions over private implementation assertions.
- Keep network, time, randomness, retry, database, and container boundaries injectable and deterministic.
- Use the repository's existing package manager and test framework unless a new tool is clearly necessary.
- Run live Mattermost contract tests separately from the fast test suite.
- Do not claim a Red step without showing the failing command/result in the session.
- Do not begin the next phase while current acceptance tests are red.
- Stop and report any architecture conflict that would weaken the isolation invariants.

## Implementation progress log

At the start of implementation, create an untracked or branch-local file such as `docs/mattermost-tdd-progress.md`. For every slice record:

```markdown
## Slice <number>: <behavior>

- RED command:
- RED failure observed:
- GREEN command:
- GREEN result:
- REFACTOR performed:
- Full verification:
- Files changed:
- Remaining risks:
```

This is evidence of the development loop, not a replacement for tests. Do not include tokens, message bodies, synthetic secrets, or other sensitive values in the log.

## Phase 0 — Repository discovery and safety net

### Discovery

Before editing:

1. Read root and nested `AGENTS.md` files and follow their instructions.
2. Inspect `git status`, current branch, recent commits, and the diff from upstream if an upstream remote exists.
3. Identify the package manager, test framework, lint/typecheck commands, migrations, adapter registration mechanism, and CI workflows.
4. Run the existing fast tests and record the baseline. Do not attribute pre-existing failures to this work.
5. Inspect current Telegram routing, session selection, group wiring, container mounts, agent identity, concurrency controls, and channel-management flow.
6. Verify whether an upstream Mattermost adapter or overlapping change now exists. If it does, compare it with this isolation contract before deciding whether to reuse it.
7. Create the progress log.

Do not upgrade the fork and implement Mattermost in the same change set. If upstream compatibility work is required, isolate it and restore a green baseline first.

### Characterization coverage

Add safety tests for existing behavior where coverage is missing:

- Telegram resolves to its current agent group.
- `session_mode = 'shared'` returns one session for a messaging group.
- `session_mode = 'per-thread'` creates separate sessions.
- distinct agent groups receive distinct writable workspaces.
- active container executions are keyed by session identity.
- unknown channels follow the current approval behavior.
- Telegram input cannot resolve to a Mattermost agent group.

Use mutation proof for characterization tests. Refactor only enough to introduce deterministic seams such as:

- `MattermostTransport`;
- `ContainerLauncher`;
- clock/sleeper;
- retry policy;
- ID generator;
- temporary database factory.

### Phase 0 gate

- Baseline failures are documented.
- New characterization coverage is verified.
- No Mattermost feature behavior has been implemented.
- Existing Telegram tests remain green.

## Phase 1 — Host-side Mattermost client authentication

Implement one test at a time.

### Red/Green/Refactor slices

1. `GET /api/v4/users/me` sends the configured bearer token.
2. Invalid credentials fail setup without starting message consumption.
3. WebSocket authentication sends the required authentication challenge.
4. Adapter teardown closes sockets and timers.
5. Token redaction prevents credentials appearing in logs/errors.
6. Container launch environment and mounts exclude the Mattermost token.

Suggested host configuration:

```dotenv
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_BOT_TOKEN=<host-only-secret>
MATTERMOST_BOT_USERNAME=nanoclaw
MATTERMOST_INSTANCE=primary
```

Never put the token in group configuration, inbound message metadata, prompts, SQLite message content, or container environment variables.

### Phase 1 gate

- REST and WebSocket authentication are covered by deterministic tests.
- Invalid auth fails closed.
- Secret-leakage tests pass.
- No inbound/outbound message behavior is added yet.

## Phase 2 — Inbound event normalization

Build a fake Mattermost WebSocket/transport fixture. Test one behavior per cycle:

1. A `posted` event produces one NanoClaw inbound message.
2. Platform ID is stable and collision-safe: `mattermost:<instance-key>:<channel-id>`.
3. Sender ID is stable: `mattermost:<user-id>`.
4. Mattermost post ID is retained as the external message ID.
5. `root_id` is retained as delivery metadata for thread replies.
6. Bot-authored events are ignored.
7. Duplicate events are processed exactly once.
8. Malformed, unsupported, and oversized events are rejected safely.
9. Logs contain metadata needed for diagnosis but not full message content by default.

Extract pure event-mapping and validation functions during Refactor. Keep transport reconnection out of this phase.

## Phase 3 — Outbound delivery

Add one failing test and minimal implementation for each behavior:

1. Normal replies call `POST /api/v4/posts` for the correct channel ID.
2. Thread replies include the original Mattermost `root_id`.
3. An idempotency key such as `pending_post_id` prevents duplicate posts.
4. HTTP 429 honors server retry guidance.
5. Retryable 5xx failures use bounded backoff.
6. Permanent failures do not loop forever.
7. Dangerous mass mentions are escaped/sanitized unless explicitly enabled.
8. Message length/format constraints are handled predictably.

Refactor retry, idempotency, and payload construction into independently tested components.

## Phase 4 — Decouple UI threading from context selection

NanoClaw may currently infer `per-thread` sessions whenever an adapter reports thread support. Mattermost needs thread-aware delivery without thread-scoped context.

### Required Red tests

1. A root post and its thread replies in channel A resolve to the same NanoClaw session.
2. The reply still carries Mattermost `root_id` on outbound delivery.
3. A post in channel B resolves to a different session.
4. `supportsThreads = true` does not force Mattermost into `per-thread` mode.
5. Existing Telegram thread/session behavior is unchanged.

### Minimal Green design

Introduce an explicit capability similar to:

```ts
threadSessionPolicy: 'force-per-thread' | 'honor-wiring'
```

Mattermost should use:

```ts
threadSessionPolicy: 'honor-wiring'
session_mode: 'shared'
```

Names may change to fit the existing code. During Refactor, make reply placement and session selection separate concepts throughout the router.

## Phase 5 — Strict channel subscription transaction

This phase establishes the primary security boundary.

### Required Red tests

1. Subscribing channel A creates a new messaging group.
2. It creates a new agent group rather than reusing one.
3. It creates exactly one channel-to-agent wiring.
4. It sets `session_mode = 'shared'`.
5. It creates a unique folder/workspace identity.
6. It cannot reuse the Telegram agent group.
7. It cannot reuse another Mattermost channel's agent group.
8. Repeating the same subscription is idempotent.
9. Concurrent duplicate subscriptions result in one valid mapping.
10. Any partial failure rolls the transaction back.
11. Hand-written or malformed configuration that maps two Mattermost channels to one agent group is rejected before invocation.

### Minimal Green behavior

Create a transactional operation similar to:

```ts
subscribeMattermostChannelStrict(channel): AgentGroup
```

The first useful workflow may be an explicit management command. Automatic chat-based subscription can follow only after the core transaction is proven.

### Refactor target

Put one-to-one validation in a single reusable boundary and back it with database uniqueness wherever possible. Do not rely only on folder names, slugs, or application-level pre-checks that can race.

## Phase 6 — Container and context isolation proof

Build integration tests with a temporary database, fake or controlled container launcher, and temporary filesystem.

### Structural isolation tests

For Mattermost channels A and B plus Telegram T, assert distinct:

- agent-group IDs;
- messaging-group IDs;
- session IDs;
- session folders;
- writable workspace paths;
- writable mount sources;
- `.claude-shared` directories;
- OneCLI agent IDs, if enabled;
- active-container map keys;
- schedule ownership and destinations.

Also assert:

- no shared writable global directory;
- no cross-agent destinations;
- no Mattermost token in container environment, mounts, prompt, or message payload;
- one running container never receives work for two channel IDs.

If the repository always mounts `groups/global` read-only, first test and document its contents. Remove or minimize that mount if it can expose conversational memory, secrets, or channel-specific instructions. A read-only mount still permits information leakage.

### Semantic leakage tests

Use synthetic markers rather than real secrets:

1. Channel A stores `MARKER_A` in its context/workspace.
2. Channel B stores `MARKER_B`.
3. Telegram stores `MARKER_T`.
4. Query each session for the other markers.

Assert that no foreign marker is present in prompts, history queries, mounted files, retrieved memory, or model input construction. Avoid relying solely on nondeterministic model responses; inspect deterministic context assembly and filesystem boundaries.

### Mutation proof

Temporarily alter session resolution or mount mapping to reuse channel A's identity for channel B. Confirm an isolation test fails, then revert the mutation.

## Phase 7 — Approval, subscribe, and unsubscribe lifecycle

Implement each transition test-first:

```text
unknown → pending approval → active → unsubscribed → archived
```

### Required tests

1. An unknown Mattermost channel creates an approval request for the existing authorized owner destination.
2. No agent/container is invoked before approval.
3. Only an authorized owner can approve or reject.
4. Approval calls the strict subscription transaction.
5. The triggering message is replayed exactly once after approval.
6. Unsubscribe stops active execution for that channel.
7. Unsubscribe disables wiring and the session without affecting other channels.
8. The workspace is archived or retained according to an explicit policy, never silently reassigned.
9. Resubscribe cannot inherit a different channel's context.
10. Bot removal from a channel deactivates consumption safely.

Keep authorization separate from the Mattermost bot's membership. A user who can mention the bot is not automatically allowed to change subscription state.

## Phase 8 — Recovery, ordering, and bounded concurrency

Implement test-first slices for:

1. WebSocket disconnect/reconnect with bounded exponential backoff.
2. Connection sequence tracking.
3. REST catch-up after a missed-event window.
4. Deduplication across WebSocket and REST catch-up.
5. Per-channel ordering.
6. Channel rename without identity change; use channel ID, never channel name, as identity.
7. NanoClaw restart with durable subscriptions.
8. HTTP 429 and transient server failures.
9. Global container concurrency limits and queued work.
10. A busy channel cannot cause its messages to execute in another channel's container.
11. Shutdown drains or safely persists in-flight state.

Start with a conservative concurrency limit suitable for the target machine, then measure. Queue by channel/session while preserving the invariant that a session has at most one active execution.

## Phase 9 — Live Mattermost contract tests

Keep these tests outside the fast suite. Use a disposable Mattermost test environment or a dedicated non-production server; never run destructive provisioning tests against the user's production instance.

The live suite should:

1. create or select a test team;
2. create channels A and B;
3. invite the bot;
4. subscribe both channels;
5. send normal posts and threaded replies;
6. verify replies land in the correct channel/thread;
7. verify A and B have different NanoClaw isolation identities;
8. restart NanoClaw and verify subscriptions survive;
9. unsubscribe A and verify B remains active;
10. remove the bot and verify clean deactivation.

Discover and use actual repository commands. If scripts do not exist, add clear equivalents such as:

```bash
pnpm test
pnpm test:mattermost
pnpm test:isolation
```

Do not hard-code these example commands without checking `package.json` and CI.

## Adapter responsibilities

The native Mattermost adapter should ultimately provide the capabilities expected by NanoClaw's adapter contract, where applicable:

- setup and authentication;
- inbound subscription via WebSocket;
- outbound message delivery via REST;
- typing indicator;
- conversation/channel discovery;
- channel-name resolution;
- direct-message opening if intentionally supported;
- catch-up synchronization;
- clean teardown.

Likely implementation files, adjusted to current conventions:

```text
src/channels/mattermost.ts
src/channels/mattermost-client.ts
src/channels/mattermost*.test.ts
.claude/skills/add-mattermost/SKILL.md
```

Use a maintained, pinned WebSocket dependency only if the current runtime does not already provide a suitable client. Keep the network library behind the transport boundary so behavior tests do not depend on it.

## Test taxonomy

### Fast unit tests

- event mapping and validation;
- post payload construction;
- thread/session policy;
- redaction;
- retry decisions;
- state transitions.

### Local integration tests

- temporary SQLite schema and transactions;
- strict subscription race/idempotency behavior;
- router → session manager → fake container launcher;
- filesystem/mount construction;
- restart/recovery state.

### Live contract tests

- official Mattermost REST and WebSocket behavior;
- authentication handshake;
- posts, replies, reconnect, and membership changes.

### Isolation/security tests

- cross-channel identity collision;
- Telegram/Mattermost separation;
- deterministic prompt/history/filesystem leakage;
- credential exclusion;
- malformed configuration fails closed.

## Suggested change-set sequence

Keep changes reviewable. Suggested branches or PRs:

1. `test/messaging-isolation-characterization`
2. `feat/mattermost-client-auth`
3. `feat/mattermost-inbound-outbound`
4. `feat/mattermost-channel-session-policy`
5. `feat/strict-channel-subscriptions`
6. `test/mattermost-cross-channel-isolation`
7. `feat/mattermost-lifecycle-recovery`
8. `docs/add-mattermost-skill`

Each change set must contain complete Red → Green → Refactor cycles. Do not split all tests into one change and all implementation into another.

## Global definition of done

The integration is complete only when:

- all existing tests pass or pre-existing failures are explicitly documented;
- every net-new behavior has test-first evidence in the progress log;
- Telegram behavior remains unchanged;
- two Mattermost channels cannot resolve to the same agent group, even under malformed configuration or a registration race;
- root posts and threads within one Mattermost channel share that channel's context;
- replies still render in the correct Mattermost thread;
- channel A, channel B, and Telegram have distinct session/container/workspace identities;
- deterministic leakage tests pass;
- credentials never enter agent containers or logs;
- retries, catch-up, deduplication, shutdown, and restart are covered;
- lint, formatting, type checking, fast tests, isolation tests, and live contract tests are green;
- operational setup and rollback instructions are documented;
- no real tokens, production message content, or synthetic test markers are committed.

## Codex working instructions

When Codex is asked to execute this document:

1. Work from the NanoClaw repository root.
2. Read all applicable `AGENTS.md` instructions first.
3. Inspect the current repository and validate this document's assumptions.
4. Do not modify unrelated user changes in a dirty working tree.
5. Do not push, open a pull request, change production Mattermost, or use production credentials unless separately authorized.
6. Begin with **Phase 0 only**.
7. Report discovery results, baseline tests, proposed first Red test, and any architecture conflicts.
8. If the worktree and baseline are safe, execute the first complete Red → Green → Refactor slice.
9. Show the Red failure before modifying production code.
10. Pause at the Phase 0 gate and summarize changed files and test evidence before beginning Phase 1.
11. For later phases, repeat one small vertical slice at a time and stop when blocked rather than weakening an invariant.

## Bootstrap prompt for Codex CLI

Use this as the first instruction in the Codex session:

```text
Read ./NANOCLAW_MATTERMOST_TDD_IMPLEMENTATION_PLAN.md in full and treat it as the implementation contract for this task.

Start with Phase 0 only. First read all applicable AGENTS.md files, inspect the repository and git status, discover the real test/lint/typecheck commands, and run the existing fast-test baseline. Do not edit production code until you have added or selected the first focused test and shown me the expected Red failure. Existing behavior may use characterization tests with mutation proof, but every new behavior must follow Red → Green → Refactor.

Preserve all unrelated user changes. Do not push, create a PR, use production credentials, or contact the production Mattermost instance. Enforce the non-negotiable rule that every Mattermost channel has a distinct agent group, shared channel session, writable workspace, and container execution identity, with Telegram remaining separate.

After repository discovery, explain any assumptions that no longer match the code. Then complete one small Phase 0 Red/Green/Refactor or characterization/mutation-proof cycle, run the appropriate verification, update the progress log, and stop at the Phase 0 checkpoint with a concise summary.
```

## References

- Mattermost bot accounts: <https://developers.mattermost.com/integrate/reference/bot-accounts/>
- Mattermost API v4 introduction and WebSocket authentication: <https://github.com/mattermost/mattermost/blob/master/api/v4/source/introduction.yaml>
- NanoClaw isolation model: inspect `docs/isolation-model.md` in the checked-out repository.
- Codex CLI: <https://developers.openai.com/codex/cli>
- Codex CLI command reference: <https://developers.openai.com/codex/cli/reference>
