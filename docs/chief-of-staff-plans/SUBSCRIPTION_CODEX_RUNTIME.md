# S01 correction: NanoClaw's subscription-backed Codex runtime

Status: implementation plan, 2026-09-30. No subscription-backed CoS live test is claimed. This is an alignment correction within S01 and its existing PR #54, before S02. It does not replace the S01–S11 programme or its review gates.

## Outcome

The owner uses the dedicated private Mattermost channel to propose and approve a charter, goal and project, then receives a grounded priority response. NanoClaw on the Pi runs the conversation through its Codex provider and the owner's existing ChatGPT subscription authentication. A separate OpenAI API key is not required, and authentication failure never silently switches to API billing. The Mac can be offline.

Preserve the existing permanent CoS identity restrictions, exact owner approvals, external PostgreSQL ownership, scoped context, emergency pause, ordinary NanoClaw sessions and Pi release controls. Subscription access changes the model transport, not the authority of the model or its tools.

## CoS is a NanoClaw agent group with its own conversation

Owner clarification, 2026-09-30: CoS is a persistent AgentGroup inside NanoClaw, with its own private Mattermost conversation and Codex context. NanoClaw owns its channel routing, session lifecycle, provider execution and delivery. The subscription adapter is part of that runtime; it must not create a separate user interface or independent agent platform.

The dedicated Mattermost channel maps to one persistent coordinator session. Its Codex thread retains multi-turn conversation context and resumes after ordinary container/service restarts, subject to the model's context limit and supported compaction. The owner explicitly confirmed that Mattermost reply threads group messages visually within this same model context. Only CoS specialist agents get separate execution contexts outside the main conversation, introduced in S05; neither a reply thread nor the subscription adapter creates another coordinator context.

“Fresh CoS context” means a clean boundary at initial binding: no implicit import of earlier ordinary chats, another group's history or global personal memory. It does not mean discarding subsequent CoS conversation at every launch. Keep CoS-only provider state and continuation durable and scoped to the bound AgentGroup/session. Subscription credentials remain outside model-controlled tools; retaining conversation does not require exposing credentials or unrelated files.

Conversation is working context, not approval or canonical truth. Unapproved ideas remain usable in discussion but cannot become approved goals without the existing owner confirmation. Read current approved records when answering priorities. On scope/access changes or later source revocation, fence the old continuation and reconstruct an allowed context; do not resume stale sensitive content. Ordinary restarts alone must not trigger that reset. Missing/corrupt provider state needs an explicit, tested recovery path rather than silently claiming full recall.

The original S01 runner called `clearContinuation('codex')` at startup and used ephemeral provider HOME. That did not satisfy the continuity requirement. The native correction now uses durable provider state and a host-scoped continuation; complete release acceptance remains pending. Persisting PostgreSQL records alone is not evidence of conversational continuity.

## Verified starting point

- S01 branch: `cos/s01-first-use-and-priorities`; inspected head `882280b0bd71a3b6b2d25066b339ab3d5cbce584`. PR #54 is open and unmerged. Reconcile these identities again before implementation.
- Pi candidate: `release-9efabcf42402-20260929214159`, source `9efabcf424029525462a00165853055ff3d842f8`. Deployment, fixture model checks, preservation and compatible rollback passed. Those checks do not establish live subscription compatibility.
- The dedicated CoS channel is bound and paused. Read-only inspection found cached Pi authentication with mode `chatgpt`, access and refresh credentials present, and no API key. Presence does not prove current entitlement, token validity or successful inference. No credential values belong in this plan or public receipts.
- Ordinary NanoClaw uses `src/providers/codex.ts` to prepare per-session Codex authentication and `container/agent-runner/src/providers/codex.ts` to drive `codex app-server`. The application images pin Codex `0.158.0`.
- CoS bypasses that authentication path: `bootstrap.ts` reads `COS_MODEL_API_KEY`; `coordinator-launcher.ts` requires it; `model-gateway.ts` calls the OpenAI Responses API directly. The restricted runner selects `cos_gateway` with OpenAI authentication disabled. Removing the key check alone cannot make subscription access work.
- Automated review also reported unsupported Claude bindings and active-charter uniqueness collisions. Resolve both as S01 corrections; automated review is not the required human review.

The official [authentication documentation](https://learn.chatgpt.com/docs/auth) distinguishes ChatGPT subscription login from API-key billing and describes cached authentication and refresh. Runtime protocol capabilities must be verified against the pinned executable; current documentation alone does not prove support in version 0.158.0.

## Runtime design and decision gate

Reuse NanoClaw's Codex app-server lifecycle, streaming, cancellation and configured model/reasoning profile. Replace the API-only CoS transport with an explicitly selected subscription execution profile. Preserve the ordinary provider's current behaviour.

The design to prove first separates the trusted Codex runtime from model-controlled execution:

1. A trusted Codex runtime managed by NanoClaw owns the minimum required subscription authentication and calls the supported native OpenAI provider. It receives the bound CoS conversation and admitted CoS context, including its own durable continuation. Its execution boundary must prevent model-generated commands on the Pi host and access to other groups' histories, host configuration, database credentials or deployment capabilities. This process boundary does not create a separate CoS interface or discard its session memory.
2. NanoClaw mediates the fixed CoS tool set and validates scope, ingress, owner, pause and maintenance on every operation. Existing proposal/approval semantics stay in the host. A model output is never an approval.
3. Any tool-execution worker retains its restricted filesystem and network profile and receives no subscription credentials. Unrestricted shell/file tools, arbitrary MCP servers, plugins, accounts, A2A, scheduling and arbitrary message destinations remain unavailable to CoS.
4. Model/authentication egress is enforced outside model-writable configuration. Neither a prompt nor hiding tools in the UI counts as enforcement. The runtime must not become a general-purpose authenticated HTTP proxy.

**First deliverable:** a fixture-only capability proof using the exact pinned Codex binary and a short decision record. Inspect its generated app-server schema, effective tool catalogue, sandbox/execution controls and supported authentication/transport configuration. Prove that native subscription authentication can coexist with an enforced CoS-only tool boundary and controlled egress. In particular, the current ordinary-provider combination of `danger-full-access` and automatic approval must not be inherited by a credential-bearing CoS runtime.

The [initial capability evidence](SUBSCRIPTION_RUNTIME_DECISION.md) now verifies native synthetic subscription transport, admitted tool dispatch, denied shell/file calls and persisted conversation across an app-server restart. Credential refresh, production egress and end-to-end runtime integration remain pending; the decision gate is not yet fully satisfied.

The exact transport split is not yet proven. If the pin cannot enforce this design, evaluate a supported credential-broker or isolated execution mechanism, or an explicit pinned CLI upgrade with full regressions. Document the selected mechanism and its evidence before integration. Do not invent protocol fields, scrape undocumented endpoints, hand-roll refresh from guessed token formats, or copy the entire `.codex` directory into a model-controlled worker. Do not weaken isolation or substitute an API key to pass the milestone. A capability failure is a concrete implementation blocker, not completed subscription support.

## Implementation sequence

### 1. Reconcile and prove the execution boundary

Read current PR feedback, target receipts and the private ledger. Preserve the existing goal lock and target authority. Revalidate Codex version, provider profile and sanitized login status using trusted host/container tools; never print tokens or export Pi credentials to the Mac. No model request is needed for this inspection.

Use the Mac devcontainer and synthetic authentication for the capability proof above. Define the supported invocation, credential owner, refresh writer, tool policy, network policy, cancellation path and test harness in the decision record. Pin any new executable/configuration assets in the release manifest.

### 2. Add subscription authentication and explicit readiness

Introduce a typed runtime selection such as `codex_subscription`, and a narrow authentication adapter with injected fixture dependencies. Codex should handle its own supported authentication/refresh flow. Authentication stays in private Pi-owned storage outside the source checkout, images, worker mounts and resettable PostgreSQL.

Reuse the existing login; do not run login/logout, rotate credentials or overwrite ordinary NanoClaw sessions merely to configure CoS. Establish one coordinated refresh writer, or prove the pinned Codex client's supported concurrent-store semantics. Test interruption during persistence and ensure ordinary sessions continue to authenticate. Never replace a newer refreshed credential with a stale per-session copy.

Remove `COS_MODEL_API_KEY` as a prerequisite for the subscription profile and explicitly reject API fallback, including ambient API variables, base-URL overrides and inherited custom providers. Select the existing approved model/reasoning settings; check actual availability before live activation rather than silently substituting a model.

Report distinct states: paused, authentication missing, reauthentication required, entitlement/model unavailable, usage limited, dependency unavailable and ready. Keep cached-login detection distinct from verified inference. Diagnostic output must exclude tokens, account identifiers, private endpoint details and raw provider errors.

### 3. Connect CoS to the native provider

Refactor `bootstrap.ts`, `bridge/coordinator-launcher.ts`, `bridge/model-gateway.ts`, `bridge/model-policy.ts`, the restricted launch path and runner/provider integration according to the proved design. Reuse existing Codex lifecycle code rather than creating a second independent agent implementation. Keep fixture model transport available for automated tests, explicitly separated from production authentication.

Preserve the native CoS AgentGroup/session binding and its own durable Codex conversation. Replace unconditional startup continuation clearing with scoped resume and explicit invalidation/recovery. Include CoS provider state in protected-state preservation and compatible release recovery without bundling it into release images. Reuse supported native compaction; define bounded recovery if provider state is missing. Preserve `cos_context_get`, `cos_change_propose`, request reconciliation, exact approval previews and restricted delivery. Revalidate private membership and owner identity before execution and publication. Pause, unsubscribe, membership change, shutdown and lost authorization must cancel active work and prevent late output; resumption must revalidate access before reopening retained context.

Retain durable structural limits: bounded turns/attempts, tool calls, concurrency, wall time and payloads. Name each counter by what the native provider actually exposes. Do not present a turn count as a provider-request count, claim a dollar cap for subscription usage, or interpret unknown usage as zero. Handle exhausted subscription limits explicitly without an API fallback or uncontrolled retries.

Add tested trusted admin commands for sanitized readiness and bounded activation/pause. Activation must verify the exact private binding, provider capability, model profile and applicable owner authorization. Preserve prior consent where applicable; do not introduce another routine deployment approval.

### 4. Resolve review findings and run regressions

Add failing tests before each fix. Reject unsupported Claude coordinator bindings before any durable binding is written. Convert active-charter uniqueness collisions during approved edits into a durable conflict result, retiring the apply outbox work instead of retrying forever. Cover repeat attempts and concurrent conflicting decisions against the separate external test database.

Run root tests, typecheck, build, lint, formatting, runner typecheck/tests and S01 integration/demo using the devcontainer. Supply only the selected test database profile to trusted test processes. Keep real Mattermost and subscription credentials out of Mac fixtures.

### 5. Build, deploy and verify on the Pi

Build all affected Linux/ARM64 host, runtime and worker artifacts on the Mac. Execute final-image subscription-protocol fixtures and isolation tests without source overlays or real account access. Bind every artifact and receipt to the exact source/tree/image identities.

Recheck Pi capacity before transfer. Retain the current compatible release and protected native backups; do not assume earlier cleanup provides enough space. Use existing source push, pinned Pi checkout, transfer, migration, activation, health and rollback contracts. Any added runtime image must be included in archive verification, load/extraction, health and rollback checks. No Pi builds, dependency installation or source fixes.

After deployment, verify one active NanoClaw service, ordinary workload health, original data preservation and the dedicated paused binding. Run Pi-native synthetic provider/RPC/isolation probes. Confirm that stopping the Mac development runtime and closing administration SSH do not affect Pi operation. Report this separately from a physical Mac shutdown if that is not tested.

### 6. Run the bounded live Mattermost acceptance

Keep automated fixture success separate from live subscription acceptance. Use existing session authorization for live usage where it actually covers the test. Before the first real model call or assistant-sent test message, resolve any missing authority with a concrete scope: only the dedicated private CoS channel, the existing subscription identity, the approved model, a finite turn/attempt limit, an expiry and synthetic test records. Do not infer unrestricted account use from deployment authority. The owner can send the test prompts and approval commands directly.

The live walkthrough is:

1. Enable the verified subscription profile and send: “My goal is to launch a pilot. The active project is Pilot Alpha. Reliability matters more than adding features.”
2. Verify exact proposal previews. Approve the charter, goal and project using the displayed host-parsed commands.
3. Ask “What should I focus on?” Verify references to approved records and clear advisory wording.
4. Leave a different proposal unapproved and confirm it does not become an approved priority. Repeat an approval and confirm no duplicate record.
5. Discuss a synthetic, unapproved detail and ask a follow-up that depends on it. Restart through the authorised release/service path, then verify the CoS conversation resumes with that detail still available, while it remains unapproved. Verify approved records remain and normal NanoClaw conversations still work.
6. Send `cos pause automation`; verify it stops further work without a model call. Confirm the subscription profile never selected API billing. Preserve a sanitized receipt and leave activation in the explicitly agreed state.

Keep destructive database-outage and crash injection in isolated fixtures. Do not disrupt the user's ordinary live conversation or introduce valuable data while the programme lifecycle is disposable.

## Acceptance evidence

| ID    | Required evidence                                                                                                                                                                |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SUB01 | Pinned Codex capability proof and effective tool/egress policy; unsupported configurations fail closed.                                                                          |
| SUB02 | Subscription profile works with no API key; API-key, custom-endpoint and provider fallback attempts are refused.                                                                 |
| SUB03 | Credential canaries are absent from model-controlled files, environment, tools, logs, transcripts and release archives.                                                          |
| SUB04 | Missing, revoked, stale and refreshed authentication; concurrent ordinary/CoS use; interrupted refresh persistence.                                                              |
| SUB05 | Only admitted CoS tools execute; forged dispatch, shell, filesystem escape, arbitrary MCP and network attempts fail.                                                             |
| SUB06 | Pause, membership change, cancellation, maintenance and expired activation prevent further effects and late delivery.                                                            |
| SUB07 | Durable bounded usage, quota exhaustion and unknown outcomes cannot trigger automatic paid fallback or infinite retry.                                                           |
| SUB08 | S01 fixture conversation, exact approval/rejection, restart, duplicate replay and dependency-failure isolation pass.                                                             |
| SUB09 | Unsupported-provider and charter-conflict review regressions pass, including durable outbox completion.                                                                          |
| SUB10 | Final ARM64 artifacts, archive/source identity, actual Pi health, preservation and compatible rollback pass.                                                                     |
| SUB11 | Authorized live Mattermost flow succeeds using the subscription profile; cached login alone is insufficient.                                                                     |
| SUB12 | Independent Pi execution and separate activation, fixture, live-test and human-review status are recorded.                                                                       |
| SUB13 | One native CoS AgentGroup/session retains its own multi-turn Codex context across ordinary restarts and supported compaction; no pre-binding or cross-group history is imported. |
| SUB14 | Context invalidation/recovery is explicit and tested; revoked context cannot return through resume, while remembered discussion cannot bypass approval.                          |

## Delivery and resume point

Make small commits for capability/authentication, restricted-provider integration, review fixes, tests/operator commands and evidence, all within S01 while PR #54 remains its unmerged slice PR. If it has merged before work resumes, follow the programme's alignment-correction workflow rather than modifying a stale branch or skipping merged-source verification.

Update `docs/chief-of-staff/evidence/S01.md`, the PR description and the private execution ledger. Record the existing API-only candidate honestly; it remains useful deployment/recovery evidence but is not subscription acceptance. Preserve all existing receipts and unknown ledger fields.

Completion of this correction requires the SUB evidence, a tested deployment, and an accurately reported live-test status. Subscription-backed live readiness cannot be claimed until SUB11 passes. Human review/merge and a release rebuilt against the actual merged source remain prerequisites for S02. Full programme completion still requires S01–S11 and the final Pi-owned protected-data transition.

Implementation checkpoint: the native credential owner, ordinary-session coordination, restricted CoS provider, production launcher/runner wiring, durable conversation identity, account-bound attempt consent and access fencing have development tests. The pinned ARM64 fixture passes native refresh and actual CoS runner restart across visual reply threads, retaining the same conversation without importing ordinary/legacy state. See the decision record for exact evidence and limits; the Pi still runs the earlier candidate.

Protected history snapshots now pass host corruption/quiescence tests and a development proof using history from the actual pinned native runner. Deployment backs up retained generations privately without the replaceable access cache, then revalidates the snapshot before migration. This is backup evidence, not completed recovery or release acceptance.

Operator context inspection, first-use preparation and explicit clean-generation recovery now pass host tests. Recovery journals its identity, protects existing state, quarantines old pending work and remains paused without issuing consent. Local status distinguishes configuration and attempt budgets from unverified live entitlement. No protected snapshot automatically restores revoked context.

Finite activation issuance and deliberate resumption now pass development tests. The owner command freezes exact consent before usage, retains prior policies and charged attempts, and requires a separate operation to unpause. Resume replay never overrides a later emergency pause. Deployment still creates no live model consent, and these commands themselves perform no model call or message send.

The pinned native runner now passes an offline compaction fixture: one automatic compaction, retained opaque history after another runner restart, permitted context lookup and denied shell execution. This verifies native protocol behavior with synthetic responses, not live summarization quality or final-image/Pi acceptance.

Explicit resumption now retires cancelled input and undelivered replies/tool requests before reopening the boundary. Tests cover the former stale-delivery gap, queue/boundary interruption and lost receipts. The retained conversation and charged usage remain intact, and replay leaves later work untouched. Three native runner cancellation fixtures now pass: shutdown with a pending model response, the real membership guard stopping the runner, and shutdown with a pending tool response. They verify app-server exit, no late reply/retry and denial of another attempt. The repaired compaction regression and all 156 runner tests/typecheck pass. Complete deployed pause routing and context invalidation still need final-image/Pi acceptance.

The combined native 401/shared-owner fixture now passes. It exposed and repaired loss of the original 401 category when native access-only refresh fails: the shared turn handler recognizes only the pinned native authentication errors and delegates one renewal to the owner without replaying the interrupted turn. Two concurrent credential clients receive one native rotation; a new explicit CoS turn resumes the same conversation successfully. All 165 runner tests/typecheck and native compaction/cancellation regressions pass. This is development evidence with a staged-HOME fixture, not full ordinary-provider concurrency or production Docker-helper acceptance.

The production Docker authentication helper now passes three offline integration tests: concurrent owner requests rotate once; actual helper termination during refresh and a lost result after native exit both preserve the primary login and refuse automatic re-rotation after owner reconstruction. Tests inspect the running helper's real mounts and restrictions. They use synthetic credentials, fixture trust and host-code development overlays; final-image acceptance remains pending. Both final worker profiles must run these tests before release export.

Next implementation action: verify complete ordinary/CoS native provider concurrency, then final-image operator, cancellation and invalidation gates. Deliver and verify a compatible schema-22 recovery path before claiming release acceptance, then deploy the exact tested artifacts and perform separately authorized live acceptance. This plan itself authorizes no new real account action and changes no running service.
