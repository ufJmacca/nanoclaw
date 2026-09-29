# S01 subscription runtime: capability evidence

2026-09-30. Partial implementation decision. This is an offline protocol proof, not live subscription acceptance or a completed production runtime.

## Native conversation and tool execution

Use the existing NanoClaw Codex app-server transport for the persistent CoS AgentGroup. The pinned Codex 0.158.0 binary supports `environments: []` on thread creation and turns, and persists that selection on resume. This allows a durable model conversation without granting an execution environment. Fixed CoS dynamic tools return through the trusted NanoClaw client, which must still validate actual scope, ingress and current authority.

The proof uses the native `openai` provider and native cached `chatgpt` authentication with synthetic tokens. A loopback TLS/WebSocket server supplies account-routing, native OAuth refresh and model responses; Docker has no external network. Fixture endpoint overrides and its generated CA are confined to the test. Production policy selects native ChatGPT authentication and accepts no endpoint or provider override.

The effective Astra tool catalogue is carried in structured `additional_tools` context. It exposes the isolated JavaScript wrapper, its wait helper and user-input helpers. The wrapper's callable tools in this fixture are the admitted `cos_context_get` and Codex's clock. The wrapper must remain functional: disabling `code_mode_host` leaves advertised tools unusable. Its V8 environment has no `process`, `require` or `fetch`. Do not confuse this pure computation wrapper with a shell or Node execution environment. Production must reject unsupported client requests and bound tool execution; helper prompts never authorize CoS changes.

Verified with the actual pinned binary:

- Native cached-account inspection reports `chatgpt`; fixture requests carry the synthetic subscription credential, with no API key.
- Native `account/read` with proactive refresh rotates the synthetic refresh/access credentials exactly once. Subsequent query processes use an access-only native cache with an empty refresh token. They complete tool calls and conversation resume without another refresh.
- The advertised tool wrapper successfully invokes `cos_context_get` through app-server's client dispatch.
- Forged `exec_command` and `apply_patch` calls receive unsupported-call results. They do not reach the client dispatcher or create the escape sentinel.
- A wrapper attempt to call `tools.exec_command` fails. Runtime inspection reports `process`, `fetch` and `require` as undefined.
- Access/refresh credential canaries are absent from captured model context.
- After terminating and starting a new app-server process, resuming the same thread retains the owner's earlier synthetic detail and tool results. It does not allocate a new conversation.
- Non-generating WebSocket warmups are separate from generating requests. Six generating requests implement the adversarial first turn and resumed follow-up; this is not a guarantee that one turn equals one provider request.

The tested worker image is `sha256:4b799b1d6c4cb086c9431a37c2eb79f84892bc2045efa277e0861e33bd360672`. The new fixture and policy were mounted read-only for this development proof. This is not final-image acceptance; the final release must bake and rerun them against its own exact identities.

## Reproduce the offline proof

Run from the repository root using host Docker. The fixture refuses an existing auth file or a non-loopback network interface. It creates only synthetic authentication and temporary certificates inside the disposable container.

```sh
docker run --rm --network none --read-only \
  --tmpfs /tmp:rw,nosuid,nodev \
  --tmpfs /home/node:rw,nosuid,nodev \
  --tmpfs /workspace:rw,nosuid,nodev \
  -e HOME=/home/node -e NANOCLAW_COS_OFFLINE_FIXTURE=1 \
  --mount "type=bind,src=$PWD/container/agent-runner/fixtures/cos-subscription-capability.ts,dst=/app/fixtures/cos-subscription-capability.ts,readonly" \
  --mount "type=bind,src=$PWD/container/agent-runner/src/providers/codex-subscription-policy.ts,dst=/app/src/providers/codex-subscription-policy.ts,readonly" \
  --entrypoint bun \
  sha256:4b799b1d6c4cb086c9431a37c2eb79f84892bc2045efa277e0861e33bd360672 \
  /app/fixtures/cos-subscription-capability.ts
```

Expected final receipt: `probe=passed`, six generating requests, retained context, only the admitted CoS dispatch, no escape file, no credential canaries, one native refresh and an access-only query cache. The fixture intentionally does not supply a live model catalogue; catalogue warnings do not establish live model availability. Failed assertions or a timeout fail the process.

## Credential ownership implementation

The new host-side `src/providers/codex-subscription-auth.ts` stages native checks in a private directory, outside the primary login. It does not implement OAuth requests, decode JWTs to refresh them, or change native cache timestamps. Native Codex owns refresh; the store validates the resulting account and publishes completed updates atomically. Query snapshots retain only access/id credentials, account binding and the native timestamp, with no refresh token or API key.

Its durable journal distinguishes a check with an uncertain outcome from an already checked candidate ready for publication. A later legitimate host owner can finish publication without rotating again. Incomplete native writes preserve the primary file and block automatic refresh retries. A forced refresh with unchanged access/refresh credentials is not reported as success: pinned `account/read` can return account information after an attempted refresh, so account type alone is insufficient evidence. Changed primary credentials are not overwritten. The store requires the native host execution lease and serializes operations for the same source within the process.

Eight credential-store regressions cover access-only export, competing refreshes, stale generations, partial writes, recovery by a new store instance, changed login/account, host-authority loss, unsafe permissions and symlinks, and unconfirmed refresh. The native protocol fixture separately verifies actual Codex rotation and subsequent access-only execution. These are component proofs; the host store and native runner still need to be connected and tested together.

Both ordinary and CoS launch paths must use this single refresh owner before enabling CoS subscription access. Existing ordinary runtimes still receive full per-session copies and have not yet been changed. Deployment must drain those older processes through the normal service path. Preserve ordinary session histories while replacing only credential preparation; test concurrent ordinary/CoS queries and bounded renewal after access expiry. No master refresh credential should enter an ordinary query runtime or a CoS tool runtime under the coordinated profile.

## Work still required before integration is accepted

The production runtime must retain a CoS-only provider state directory, reapply the no-environment policy on resume/turns and remove unconditional startup continuation clearing. Preserve the single native coordinator context across Mattermost reply threads; only specialist attempts receive separate contexts. Test restart, compaction, recovery, explicit invalidation and revoked-context exclusion.

Pinned native file storage truncates and writes `auth.json`; production must use the tested staging/publication path, not let native checks write the primary file directly. Do not mount the whole host `.codex` directory, enable simultaneous uncoordinated refresh writers, or overwrite refreshed credentials with old copies. An uncertain refresh requires explicit reconciliation or reauthentication; retaining the primary file does not prove an older refresh credential is still valid at the provider.

Controlled model/authentication egress, durable activation limits, cancellation, production CoS RPC integration, explicit readiness, credential refresh/recovery, complete regression tests, baked ARM64 release checks, Pi deployment and bounded live acceptance remain unfinished. SUB01–SUB14 are not collectively satisfied by this proof. No real account call, Mattermost message or Pi change was made for it.

## Pinned source references

- [Thread/environment protocol](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/tests/suite/v2/thread_environments.rs).
- [Synthetic native authentication and account-routing fixtures](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/tests/common/auth_fixtures.rs).
- [Dynamic tool dispatch tests](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/app-server/tests/suite/v2/dynamic_tools.rs).
- [Tool registration and environment selection](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/core/src/tools/spec_plan.rs).
- [Native credential persistence](https://github.com/openai/codex/blob/rust-v0.158.0/codex-rs/login/src/auth/storage.rs).

Generated schemas from the actual image were also inspected; source references complement executable evidence rather than replace it.
