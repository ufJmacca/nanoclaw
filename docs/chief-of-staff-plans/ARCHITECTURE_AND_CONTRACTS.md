# Chief of Staff: shared architecture and contracts

**Status:** implementation specification, not a claim of existing features.  
**Applies to:** S01–S11.  
**Existing-code evidence:** [repository baseline](REPOSITORY_BASELINE.md).

## 1. Product and implementation boundary

Build one private, single-operator CoS capability inside the NanoClaw fork. The only assumed reusable project is this running NanoClaw installation. There is no dependency on previous personal projects, wikis, factories or other agent platforms.

NanoClaw owns channel ingress/egress, sessions, provider execution, container capacity, native schedules and the approval interaction. The new CoS module owns goals, projects, commitments, evidence, decisions, proposals, missions, mandates, review records and action receipts.

Use TypeScript and existing repository conventions. Connect to an externally hosted PostgreSQL server on a different machine on the same private network, using host-service environment variables and a private `cos` schema for domain state. Retain NanoClaw SQLite on the NanoClaw host for runtime state. [External PostgreSQL contract](EXTERNAL_POSTGRES.md) is mandatory for every slice; do not provision a local database server, container or data volume. Use host-owned filesystem objects for source/artifact bytes initially. Do not add FastAPI, Temporal, DBOS, Redis, Graphiti, a separate vector service, or a web dashboard in these slices. They are not prerequisites.

One dedicated private **Mattermost channel** is the initial user interface, as specified by [INTERACTION_MODEL.md](INTERACTION_MODEL.md). A dedicated persistent CoS AgentGroup serves that scope. Do not silently merge contexts from several channels. Preserve strict Mattermost wiring where applicable. Other private domains require separately approved scopes; no cross-domain federation is implemented here.

## 2. Proposed repository layout

All paths below are **new/proposed**, except existing files explicitly listed in the baseline.

```text
src/modules/chief-of-staff/
  index.ts                   # registration; disabled by default
  contracts/                 # versioned DTOs, validators, errors
  domain/                    # work model, lifecycle, deterministic policy
  store/                     # PostgreSQL repositories and SQL migrations
  bridge/                    # session authentication, RPC, outbox, reconciliation
  approvals/                 # adapter to NanoClaw's approval primitive
  knowledge/                 # source revisions, chunking, retrieval, revocation
  calendar/                  # read-only snapshots; approved writes added in S09
  missions/                  # attempt allocation, templates, budgets, review
  automation/                # schedule bindings, triggers, mandates, digests
  strategy/                  # assumption/outcome/portfolio reviews
  ops/                       # health, inspection, export, recovery
container/agent-runner/src/mcp-tools/chief-of-staff.ts
container/skills/chief-of-staff/  # guidance only; provider-compatible registration
scripts/cos-test.ts
scripts/cos-demo.ts
scripts/cos-admin.ts
src/contracts/chief-of-staff/    # integration and failure-injection fixtures
ops/chief-of-staff/              # private deployment examples and runbooks
```

Keep core patches narrow and backward-compatible: registration, authenticated ingress context, restricted-session enforcement, approved dispatch, approval receipts, session RPC responses, and lifecycle hooks. Preserve existing research and channel tests. Do not refactor unrelated modules just to match this layout.

## 3. Feature gate and failure policy

`COS_ENABLED=false` is the installation default. Configuration is host-owned and never edited by an agent. When disabled, normal NanoClaw starts without PostgreSQL and without CoS tools. Previously CoS-restricted identities remain restricted: disabling CoS must not turn them into unrestricted ordinary agents.

When enabled but external PostgreSQL is unavailable, CoS content reads are unavailable because current access/authority cannot be verified; all new CoS mutations, dispatch, approval acceptance and external effects fail closed. Only safe dependency-status metadata remains available. Stale calendar/source snapshots may be shown only while PostgreSQL and current access checks remain healthy. A host-local deny-only pause latch closes admissions and fences/stops affected CoS workers without needing a database write. Normal unrelated NanoClaw conversations continue. Use bounded connection/query deadlines and reconnection, not indefinite blocking or a local database fallback.

Runtime configuration includes an explicit private scope, owner identity, allowed messaging-group ID, approved model/provider profiles, artifact root, host-environment `COS_PG*` connection settings and CoS session restrictions. Use one validated client configuration and one bounded runtime pool; migration credentials exist only in a scoped administrative process, which the implementing goal is authorised to invoke without per-run human review. Every provider/helper/container launch must exclude database environment variables and secret values. Secrets never enter mounted config or error text. Source-specific model-processing permission is separate from permission to read a source.

## 4. Identity and authority

The host constructs `CosRequestContext` from actual queue/session identity and previously validated ingress or trigger records. Do not trust `userId`, `missionId`, destination, role or scope supplied by the model.

```ts
// Proposed contract; exact runtime validation is mandatory.
type CosRequestContext = {
  scopeId: string;
  agentGroupId: string;
  sessionId: string;
  origin: { kind: 'user'; ingressId: string; userId: string }
        | { kind: 'schedule'; triggerId: string; mandateRevision?: string }
        | { kind: 'mission'; missionId: string; attemptId: string; generation: number };
  role: 'coordinator' | 'worker';
};
```

User ingress must reference a verified adapter event recorded by the host, not a sender string inside model-readable content. Do not let an old user message become an indefinite authorisation token. Source access uses current bindings; state changes require a current exact proposal approval or an approved mandate.

Only the designated owner can approve CoS changes or control mandates. General channel admin status is insufficient for this single-operator scope. CoS approval previews/controls must be delivered only to the explicitly bound owner/private destination, not the primitive's generic admin-first fallback. The default is the verified owner-and-bot private Mattermost CoS channel; do not require unverified DM support. Use a tested button callback or host-parsed exact confirmation command bound to the same immutable intent. Validate that destination before sending the preview, not only when processing the click. Do not infer that two platform identities are the same person from names or email text. Revalidate role, private destination and subscription at request, execution and delivery. Workers never inherit owner/admin roles.

## 5. CoS tool transport

Use the existing container-side MCP registration and host `registerDeliveryAction` mechanism [R03, R10]. Register a narrowly typed `cos_rpc` action, not arbitrary SQL or HTTP execution. Keep one canonical protocol schema and generate/bundle the container's schema artifact with a drift test; do not import host database modules into the runner or assume an unmounted host source path exists in `/app`.

Container writes requests to its own `outbound.db`. Host validates the real session, method allowlist and payload, executes a bounded operation, and writes its result into a new **host-owned response table in `inbound.db`**. Container polls that table read-only. Do not send RPC responses as ordinary chat messages that recursively wake another model turn.

```json
{
  "protocol": "cos-rpc/v1",
  "request_id": "uuid",
  "method": "cos_context_get",
  "params": {"view": "today"}
}
```

Response: protocol, request_id, status (`ok`, `pending`, `denied`, `conflict`, `unavailable`), typed result or safe error, current resource version and optional operation ID. Set strict payload/page/response size limits and a bounded tool wait. On timeout return `pending` and the durable operation ID; do not claim failure or success without evidence.

Deduplicate by `(session_id, request_id)` plus a canonical payload hash. Reuse with changed payload is a conflict. The host persists mutation and request result in one PostgreSQL transaction, then mirrors the response to SQLite. A crash or connection loss after the PostgreSQL commit must return the same result on retry. A lost commit acknowledgement is unresolved until reconciled using the same request identity, unique operation row and payload hash; do not assume rollback or allocate new work. A status query must be authorised exactly like the original request.

A host-written response table requires additive session-DB migration and version negotiation. Old runners must fail safely or continue without CoS; never silently use an incompatible protocol. Neither side writes the other's owned message database through CoS code.

## 6. Domain record conventions

Every private record has `id`, `scope_id`, `created_at`, `updated_at`, `version`, provenance and an explicit lifecycle. Store timestamps in UTC with IANA timezone metadata for human schedules. Use optimistic concurrency (`expected_version`) for reviewed edits. Use PostgreSQL constraints for uniqueness, not only pre-insert checks.

| Slice | Records introduced |
|---|---|
| S01 | scopes/bindings, charter revisions, goals, projects, proposals, domain events, RPC operations, host outbox, approval/effect receipts |
| S02 | sources, source revisions, chunks, evidence references, derivation links, artifacts, revocation tombstones |
| S03 | connector bindings, snapshot generations, calendar observations, coverage state |
| S04 | commitments, decisions, brief runs, schedule bindings, notification receipts |
| S05 | missions, attempts, template versions, context manifests, budget reservations, result submissions |
| S06 | mission steps/dependencies, verifier results, synthesis artifacts |
| S07 | observations, candidate proposals, feedback/cooldowns |
| S08 | mandate revisions, trigger occurrences, policy decisions, autonomous-run reservations |
| S09 | concrete action intents, execution leases, external receipts and reconciliation results |
| S10 | initiatives/milestones as needed, strategic assumptions, outcome observations, reviews and review decisions |
| S11 | recovery/export manifests and restore-verification records |

Do not implement later tables early merely because they appear here. Each slice adds only what its end-to-end flow needs.

Facts and opinions are distinct. A project marked inactive is not considered stalled. Mentioning an idea does not activate a project. A proposal is not a commitment. A result submission is not verified completion.

## 7. Cross-database consistency and retries

Remote PostgreSQL, local NanoClaw SQLite, local files and external providers do not share a transaction. Use a transactional domain outbox and a bounded host reconciler. Transactions use one checked-out client and do not span model calls, human waits, file copies or external requests. Handle ambiguous commits and partitions as specified in [the remote database contract](EXTERNAL_POSTGRES.md); server-side leases use database time.

1. Commit domain changes, operation result and outbox command in PostgreSQL.
2. Deliver the command with a stable ID to the native session queue, approval UI, artifact store or external adapter.
3. Record the receipt; replay by command ID on interruption.
4. For unknown external outcomes, reconcile or require operator review. Never “retry everything”.

For mission dispatch, unique `(attempt_id, dispatch_revision)` selects one allocated group/session and stable input message ID. Repeated wakes reuse native `wakeContainer`. Resource allocation is recoverable: record intent before allocation, keep host-owned ownership markers, and reconcile partial groups. Do not allocate a fresh group on every transport retry.

A lease has an owner, expiry and monotonic generation/fencing token. A stale worker cannot publish results or mutate state. Native message retries repeat an existing attempt; only the CoS attempt state machine can create a new logical attempt. Count every actual provider/tool invocation against the root mission's limits; do not multiply retry budgets across layers.

## 8. Restricted execution and specialist isolation

Persistent specialist templates are immutable, versioned definitions. Materialise a **new AgentGroup for every mission attempt**, then a session for that group. This is intentional: the current runtime shares group memory and some provider state between sessions [R04–R05].

Each execution identity has a fresh workspace, provider state, OneCLI identity/policy where used, host-owned scope marker and explicit read-only template. No writable specialist-global folder, global personal memory, inherited `.claude-shared`, sibling workspaces, broad host mounts or arbitrary channel destinations.

A restricted-profile host gate covers every outbound action from a CoS identity, including forged DB rows, not just advertised MCP tools. Deny self-modification, new agents, arbitrary scheduling, unrestricted messaging and non-admitted actions. Deny shell/network paths that could bypass the integration gateway. Use a tested network policy appropriate to the installed runtime: only the approved model gateway and explicitly authorised retrieval endpoints. If confinement cannot be established, delegated execution is unavailable rather than silently permissive.

For Mattermost, keep existing native A2A prohibition and subscription validation. Add a narrowly scoped CoS host dispatch API authorised by an owner-approved scope binding. It releases only the declared context manifest to a child execution identity in the same privacy scope. The child has no channel binding. Results return through the host to the originating scope. Do not copy whole channel histories or add broad A2A destination rows. Unsubscribe/revocation cancels the family and blocks further publication.

Start with read-only researcher and no external write credentials. CoS policy is not implemented by a prompt. A specialist result is untrusted input to the coordinator, including when it contains valid citations.

## 9. Approval and effect contract

Reuse NanoClaw's approval surface. Extend the primitive **backward-compatibly** for CoS callers with stable correlation, exact approver binding, expiry, delivery status and durable callback acknowledgement. Existing non-CoS callers retain their behaviour and tests.

An approved object is an immutable `ActionIntent` or `ProposalRevision`: scope, action type, exact payload, payload hash, resource versions, destination, requester, approval expiry and owner identity. A revised payload creates a new intent. No “approve this agent in general” shortcut.

The CoS ledger owns proposal/action state and durable effect receipts. NanoClaw pending approval rows and cards are a projection of that record, not a second source of truth. A declined or expired card is also a durable event. A callback first validates identity and atomically records the decision; only then may the UI projection be acknowledged/deleted. Effect execution is a separate leased operation, not the callback's unrecorded side effect.

Handle crashes between PostgreSQL and SQLite with reconciliation, including approved-but-not-acknowledged and card-delivered-but-not-recorded states. A missing/unreachable approver means blocked, not approved. Do not retain a model invocation or an in-memory Promise while waiting for a human.

## 10. Mission contract and completion

```text
proposed → authorised → queued → running → awaiting_review → completed
                                   ↘ waiting_approval / blocked / failed
Any nonterminal state → cancelling → cancelled
Effect ambiguity → outcome_uncertain → reconciled or operator-resolved
```

Use explicit transition guards; document which are terminal. Attempts carry their own status and generation. An attempt may fail while the mission remains eligible for a bounded retry. A cancelled generation never publishes an ordinary successful result.

A mission contains purpose, related goal/project, allowed sources, context-manifest digest, template/provider versions, acceptance criteria, deadline, budgets, result schema, origin and authority revision. The initial topology is one worker; S06 adds a bounded acyclic step graph. Only the host allocates approved templates. Workers cannot recursively spawn workers.

Completion requires validated artifact references, evidence accessibility, deterministic acceptance checks and a recorded coordinator review. Semantic quality review is advisory; model agreement is not proof. Partial results stay labelled partial. An unavailable mandatory source blocks a claimed comprehensive result.

Budget enforcement begins before dispatch: maximum attempts, model turns, tool calls, concurrent workers, wall time and payload sizes. Track per-call reservations and provider usage where available. Currency estimates are labelled estimates. A hard dollar ceiling may only be advertised when the provider/gateway can actually enforce it; otherwise use hard structural limits and report cost uncertainty. Unknown usage cannot be treated as zero.

## 11. Knowledge, deletion and data egress

Use only explicitly admitted source roots or authenticated uploads. Do not recursively scan the host home directory. Imports are size-limited, path-safe, revisioned and scoped. Raw capture is append-only during retention, not exempt from deletion requirements.

Retrieval applies scope and current access checks before ranking and before returning content. Start with PostgreSQL full-text search and deterministic source locators. Store content digest, capture time and source version. Citations use source revision and locator, not fabricated line numbers.

Revocation immediately prevents further retrieval, publication and reuse. Quarantine or delete affected derivatives, cached results, prepared prompts and exported artifact access according to policy; terminate affected active contexts. Already-sent messages and already-disclosed provider inputs cannot be clawed back. Record those disclosures and the backup/provider retention limitations accurately.

Never include raw account tokens, production documents or personal artifacts in Git, CI logs or test fixtures. At-rest encryption and backup controls depend on the deployment; require operator configuration and verify it rather than declaring encryption merely because files are on a private host.

## 12. Scheduling, notifications and strategy

Use native NanoClaw recurrence/wake/retry machinery [R09]. Reuse its current schedule parser and encoding after inspecting the implementation; do not insert a guessed cron string directly into `recurrence`.

Store a CoS schedule binding and stable occurrence ID that links to the native task. Repeated native deliveries resolve to one domain run. Coalesce missed briefings rather than replaying a backlog. A small reconciliation hook repairs lost projections; do not create a competing general-purpose scheduler.

Quiet hours, notification budgets, snooze, acknowledgement and per-source freshness are explicit data. Display “not connected” and “stale” rather than infer no events. Calendar occupancy is not proof of actual time spent or strategic progress.

Strategic reviews create recommendations. They cannot rewrite approved goals, priorities or commitments. Every recommendation identifies supporting evidence, assumptions, alternatives, opportunity cost, confidence and a condition that would change the recommendation.

## 13. Test and delivery contract

Use red → green → refactor for each behaviour; retain a sanitised failing-test receipt before implementation and passing evidence afterwards. A setup/import error is not meaningful red evidence. Do not fabricate tests or recorded runs.

Root regression commands already exist: `pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`. Runner commands are `pnpm --dir container/agent-runner typecheck` and `(cd container/agent-runner && bun test)`. Revalidate dependency-install conventions locally.

S01 must introduce these **new command contracts**:

```text
pnpm cos:test --slice S01 --db-profile <test|runtime-disposable>
pnpm cos:demo --slice S01 --fixture --db-profile <test|runtime-disposable>
pnpm cos:admin status
pnpm cos:db check --profile runtime
pnpm cos:db check --profile test
pnpm cos:db migrate-status --profile runtime
pnpm cos:db migrate --profile test --confirm-database <test-database-name>
pnpm cos:db migrate --profile runtime --confirm-database <bound-database-name>
pnpm cos:release --slice S01 --target pi --db-profile <selected-profile>
pnpm cos:deploy --target pi --release-manifest <tested-manifest>
```

Every subsequent slice registers its own ID. A requested but unknown slice fails, not silently succeeds. Integration tests use real external PostgreSQL: either a separate `COS_TEST_PG*` target with its protected marker or the explicitly selected `runtime-disposable` profile under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md). The second option is pre-authorised during the disposable implementation period and requires bound-target, lifecycle, lock and quiescence checks; no second database is mandatory. Never silently fall back between profiles or start a local PostgreSQL server. Use isolated local SQLite, a fake clock, fixture connectors/provider and controlled launcher. If every eligible target is unavailable, required integration acceptance is blocked. Include a real container smoke check once isolation is introduced. Real account tests retain their separate opt-in gates.

A slice is implemented only when its full user flow and regressions pass or genuine pre-existing failures are explicitly recorded and reviewed. Account/model activation remains a separate gate; missing its credentials must not lead to fake success. In-scope database migration and NanoClaw deployment are already authorised and are executed automatically after the relevant checks, not left pending human approval.

## 14. Rollback and operator controls

All slices are feature-gated and add migrations monotonically. Prefer disabling the new slice and rolling code forward; do not drop private tables for routine rollback. Coordinated remote-database/local-SQLite/artifact backups and a tested restore through an eligible external test profile precede real external effects. A separate restore target is preferred; the guarded quiesced runtime-disposable path may be used while it remains effects-safe and disposable. Protected runtime data is never overwritten by a fixture drill. External server backups and host-local backups have distinct owners and must be paired by a recovery manifest. Never delete NanoClaw volumes or reset its central DB as a convenience.

Owner controls include pause automation, cancel a mission, revoke a source, disable a connector and stop new CoS admissions. On pause, release unused budget but do not claim already-sent actions were undone. Code review/merge and previously unauthorised live accounts remain human-controlled. The owner has separately delegated this programme's migrations and NanoClaw deployment/restart/rollback in [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md); do not require a further operational review. That grant applies to the implementing process, not the deployed CoS agents.

## 15. Disposable implementation lifecycle and standing operational authority

Follow [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md) for S01–S11. Live CoS database migrations and deployments on the designated NanoClaw machine are pre-authorised. Execute them non-interactively with target validation, regression gates and receipts, even when the current slice's code PR is still awaiting review. No additional human approval is required. Human PR merge remains the dependency gate.

The external CoS database is disposable during implementation; local NanoClaw databases, sessions and other workloads are protected. Prefer incremental migrations; permit only the contract's scoped fixture cleanup or controlled disposable resets. Keep operations/effect safety evidence outside anything that can be reset. After all slices meet their implementation/merge gates, automatically close the disposable period using a host-owned monotonic record before non-disposable data is admitted. A lost local ledger is not authority to reopen disposal.

S01 adds the Mac-side release coordinator and Pi helper in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md): local source tests, target-native image builds/final-image tests, authenticated transfer, target verification, protected-state backup, explicit Pi-env migration, activation of prebuilt payload/images, restart, native smoke checks and compatible rollback. S11 tests the complete deployment/recovery and protected-transition flow. This is administration by the trusted coding process, not a new tool exposed to workers.

## 16. Development, release and runtime placement

[MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) is mandatory. Source edits, coding-goal state, builds and local tests stay on the Mac. The Raspberry Pi runs the existing NanoClaw host service and agent containers. PostgreSQL remains a third-machine service. Only a successfully locally tested image bundle is transferred for deployment; the Pi never compiles or builds an application/profile image.

A release pairs a host-release carrier image (prebuilt Linux/ARM64 payload extracted for the existing service) with agent images containing their own code, skills and instructions. Audit and remove release-mode source bind mounts that would override packaged contents. Do not ship Mac-native dependencies or replace runtime data directories. Source-mounted local development may remain available independently. Effective worker images are selected from the immutable release map; an unbuilt profile is blocked, not built on the Pi.

The Mac has fixture SQLite/artifact roots and no live Pi bot credentials. The Pi owns live local SQLite/artifacts, deployment receipts and the monotonic data-lifecycle latch. Never synchronise these stores through the code release. Shared disposable-DB tests execute on the Mac only after Pi quiescence and cross-host target-lease verification. Runtime Pi credentials do not become Mac test credentials automatically. A Mac outage must have no effect on normal deployed CoS operation.

All scope and approval semantics in [INTERACTION_MODEL.md](INTERACTION_MODEL.md) apply to Mattermost. Stable mission/intent IDs, not a visual thread or chat history, determine work/approval identity. No implicit Telegram sharing is introduced.

## GitHub source synchronisation — revision 5

[GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) adds a pinned-source gate to the existing Mac-to-Pi release contract. The Mac authors/tests/builds/pushes; the Pi may fetch and prepare a separate detached checkout of the exact manifest commit without another operational approval. Preserve dirty work and active runtime paths. No automatic pull/merge, source execution, dependency installation, worker code override, runtime-state sync or expanded GitHub privilege is authorised. Source and artifact identities must agree before activation. Human PR merge gates and the existing disposal/secret boundaries remain unchanged.
