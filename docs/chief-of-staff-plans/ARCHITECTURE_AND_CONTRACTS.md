# Chief of Staff: shared architecture and contracts

**Plan revision:** 5. **Applies to:** S01–S11. **Status:** implementation specification, not existing capabilities. [Repository baseline](REPOSITORY_BASELINE.md) distinguishes source observations from proposed changes.

## 1. Product and implementation boundary

One private single-operator CoS inside this NanoClaw fork; no other prior project is assumed. NanoClaw owns channel ingress/egress, sessions, providers, container capacity, native scheduling and approval presentation. CoS owns goals, projects, commitments, sources/evidence, decisions, proposals, missions, mandates, reviews and action receipts.

Use TypeScript and existing conventions; external LAN PostgreSQL `cos` schema for domain state; retain local central/session SQLite and host-owned source/artifact bytes. No FastAPI, Temporal, DBOS, Redis, graph/vector service, separate agent framework or new web dashboard is required. Logical separation does not require additional services.

One dedicated private Mattermost channel serves one persistent scoped coordinator. Do not merge other channels or import historic global/group memory without explicit admission. Specialists are internal isolated attempts. Telegram is not silently linked. See INTERACTION_MODEL.md.

Mac authors/tests/builds, GitHub carries pinned source, SSH carries tested ARM64 images, Pi runs the existing host service and worker containers, and the third machine hosts PostgreSQL. Follow MAC_TO_PI_DELIVERY.md and GITHUB_SOURCE_SYNC.md; no source mounts override release code and no Pi-side build/install finishes a release.

## 2. Proposed layout and narrow integration

```text
src/modules/chief-of-staff/
  index.ts
  contracts/       # versioned validation/DTOs/errors
  domain/          # work model, transitions and deterministic policy
  store/           # PostgreSQL repositories and checksummed SQL migrations
  bridge/          # authenticated RPC, outbox and reconciliation
  approvals/       # native presentation adapter and durable decisions
  knowledge/       # source revisions, retrieval and revocation
  calendar/        # reader; narrowly approved writer added in S09
  missions/        # attempts, templates, budgets and verification
  automation/      # native schedule bindings, observations and mandates
  strategy/        # assumptions/outcomes/reviews
  ops/             # inspect, pause, export and recovery
container/agent-runner/src/mcp-tools/chief-of-staff.ts
container/skills/chief-of-staff/
scripts/cos-test.ts
scripts/cos-demo.ts
scripts/cos-admin.ts
src/contracts/chief-of-staff/
ops/chief-of-staff/
```

These paths are proposed. Limit core changes to backward-compatible registration, authenticated ingress context, restricted identity enforcement, approved dispatch, approval receipts, RPC response storage and lifecycle hooks. Preserve existing research, providers and channel regressions. A skill is guidance, not an authorisation boundary.

## 3. Feature and dependency failure

`COS_ENABLED=false` by default: ordinary NanoClaw needs no PostgreSQL and exposes no CoS tools. Previously restricted identities remain restricted when disabled; never fall back to unrestricted ordinary-agent execution.

Enabled but unavailable/misconfigured PostgreSQL closes CoS admission, retrieval, mutation, approval acceptance, dispatch/wake and publication. Current scope/revocation cannot be inferred from stale cache. Healthy DB with a stale calendar snapshot is a different case and may produce explicit coverage warnings. Ordinary unrelated NanoClaw chats continue. Connect/retry/queue budgets are bounded so dependency failure cannot hang the host.

Host-only bindings contain scope, owner, channel, approved provider profiles, artifact roots, DB configuration reference and restrictions. No secret-bearing mounted config. Source reading permission and permission to transmit source data to a particular model are separate.

## 4. Host-derived identity and authority

The host derives context from actual session/queue identity and authenticated adapter/trigger records, never model-supplied userId, role, destination, mission or scope.

```ts
type CosRequestContext = {
  scopeId: string;
  agentGroupId: string;
  sessionId: string;
  origin:
    | { kind: 'user'; ingressId: string; userId: string }
    | { kind: 'schedule'; triggerId: string; mandateRevision?: string }
    | { kind: 'mission'; missionId: string; attemptId: string; generation: number };
  role: 'coordinator' | 'worker';
};
```

Validate this at runtime. A prior chat message is not indefinite authorisation. Source access uses current bindings; changes need the applicable exact approved revision or mandate. Workers never inherit owner/admin roles.

Only the designated owner approves CoS changes, not any generic channel administrator. Validate privacy, membership, owner and destination before exposing previews and again at action/delivery. No generic admin-first DM fallback and no cross-platform identity matching by display name. Subscribe/unsubscribe and revocation must affect in-flight work as well as new requests.

## 5. RPC and database ownership

Reuse container MCP registration and host `registerDeliveryAction` with a narrowly typed `cos_rpc`, not arbitrary SQL/HTTP. One canonical versioned schema is bundled for the runner with a drift test; do not import host database modules through unmounted paths.

```json
{"protocol":"cos-rpc/v1","request_id":"uuid","method":"cos_context_get","params":{"view":"today"}}
```

Container writes its outbound.db. Host authenticates actual session, validates method/payload, executes bounded work and writes a result into a new host-owned response table in inbound.db. Container reads that table; no ordinary chat result that recursively invokes another model. Additive session migration and version negotiation preserve older runners safely. Neither party writes the other's message DB.

Responses include protocol/request ID, typed result or safe error, operation/resource version and status ok/pending/denied/conflict/unavailable. Bound payload, pages, response and tool wait. Timeout reports pending only with honest correlation/acceptance state; no invented success.

Deduplicate `(session_id, request_id)` plus canonical payload hash. Reusing ID with changed payload conflicts. Domain mutation, operation result and necessary outbox command commit together in PostgreSQL, then response mirrors to SQLite. Crash after remote commit returns that original result. Status lookup has the original operation's authorisation requirements. Unknown commit uses same ID and resolves uniqueness races; a quick absent-row read is not rollback proof.

## 6. Domain conventions and slice scope

Private records have IDs, scope, UTC timestamps, versions, provenance and explicit lifecycle. Human schedules retain IANA zones/all-day date semantics. Optimistic expected_version checks protect reviewed changes. Enforce uniqueness in PostgreSQL, not only application prechecks.

| Slice | New records only as needed |
|---|---|
| S01 | bindings, charter/goals/projects, proposals/events, RPC/outbox and approval/effect receipts |
| S02 | sources/revisions/chunks/evidence/artifacts, derivation edges and tombstones |
| S03 | connector bindings, generations, event observations and coverage |
| S04 | commitments/decisions, brief runs, schedules and notifications |
| S05 | missions/attempts/templates/context manifests/budgets/results |
| S06 | step graph, verifier outputs and synthesis |
| S07 | observations/candidate proposals/dispositions/cooldowns |
| S08 | mandate revisions/triggers/policy decisions/autonomous reservations |
| S09 | exact intents, executor leases, external receipts/reconciliation |
| S10 | initiatives/milestones/assumptions/outcomes/reviews |
| S11 | backup/export/recovery manifests and verification |

Do not prebuild future tables because they appear here. Facts differ from opinions; interests differ from approved projects; inactive work is not stalled; proposals are not commitments or permissions; submitted results are not verified completion.

## 7. Cross-store consistency and retries

PostgreSQL, SQLite, files and providers share no transaction. Transactional domain outbox → stable command delivery → durable receipt → bounded reconciliation. Unknown external outcomes require read-back or owner disposition, not retry-everything.

Unique attempt/dispatch revision allocates one group/session and input message ID. Persist allocation intent and host ownership markers before partial allocation; replays recover resources rather than allocate anew. Reuse native wakes; a deferred wake is not completion. Native retries repeat the same attempt; only CoS may create a new generation.

Leases include owner, expiry and monotonic fencing generation; use database time for comparisons. Old workers cannot mutate/publish. Root budgets include every actual provider/tool call and retry across descendants. Do not multiply independent retry budgets. Do not hold pooled clients/transactions across model calls, approvals, network requests, container startup or file copies.

## 8. Specialist isolation and enforcement

Templates are versioned immutable definitions. Each mission attempt gets a fresh AgentGroup, session, workspace, provider state and scoped gateway identity. Current NanoClaw group memory/provider state is shared across sessions, so a new session alone is insufficient.

No shared writable specialist-global memory, global personal memory, inherited `.claude-shared`, sibling roots, broad mounts, owner roles or generic destinations. Mount immutable templates and explicit context manifests. Enforce restriction on every native outbound action, including forged DB rows, not just advertised tools. Reject self-mod, arbitrary spawn/schedule/message and non-admitted operations. Test provider built-ins and effective network/filesystem constraints. Direct DB/connector access is unavailable to workers; only approved gateway/retrieval endpoints are reachable. A NAT host-IP rule alone does not prove isolation. Unverifiable confinement blocks delegation.

Mattermost native cross-agent prohibition stays intact. New host dispatch is bound to an owner-approved same-scope delegation policy, releases only declared context and returns results to origin through the host. It does not copy full histories or grant broad A2A destination rows. Revocation/unsubscribe cancels/fences the family. Specialist outputs remain untrusted, even with valid citations.

## 9. Approval and effect durability

Reuse native approval presentation, extending backward-compatibly for stable correlation, exact owner/destination, expiry, delivery state and durable callback acknowledgement. Test legacy callers unchanged.

Approved ProposalRevision/ActionIntent is immutable: scope/action/exact payload/hash/resource versions/destination/requester/expiry/owner. A changed payload needs a new revision. No generic approve-this-agent shortcut.

CoS ledger owns state and effect receipts; native pending rows/cards are projections. Record acceptance/rejection/expiry durably after identity checks, then acknowledge/delete UI projection. A separate leased executor performs effects. Reconcile approved-before-ack and delivered-before-receipt gaps. Missing/unreachable approver is blocked. Never hold a model invocation or in-memory promise for human waiting.

## 10. Missions and verification

```text
proposed → authorised → queued → running → awaiting_review → completed
                                  ↘ waiting_approval / blocked / failed
nonterminal → cancelling → cancelled
ambiguous effect → outcome_uncertain → reconciled or owner-resolved
```

Define actors/guards and terminal states explicitly. Attempt failure may permit bounded mission retry; cancelled generations cannot publish ordinary success. Work order binds purpose, goal/project, sources/context digest, template/provider versions, criteria/deadline/budget/result schema/origin/authority. S05 one worker; S06 bounded acyclic graph. Workers cannot recursively spawn.

Completion requires valid artifacts, current accessible evidence, deterministic schema/citation/criteria checks and recorded coordinator review. LLM quality review is advisory, not proof by consensus. Missing mandatory sources block comprehensive claims; partial results remain partial.

Before dispatch reserve attempts/turns/tool calls/concurrency/wall time/payload limits. Track per-call reservations and real usage where supported. Unknown usage is never zero. Currency numbers are estimates unless an actual gateway/provider enforces the advertised ceiling.

## 11. Knowledge lifecycle and egress

Admit sources explicitly through safe staging/upload; no whole-home crawling. Enforce path/size/encoding/scope/revision limits. Raw capture is append-only during retention, not immune from deletion. Publish local bytes and remote metadata atomically/reconcilably. Full-text retrieval filters current scope/access before ranking and return, with digest/capture/source version and actual locator, not invented lines.

Revocation blocks future retrieval/publication/reuse, quarantines or removes derivatives/caches/prepared prompts and stops affected active contexts. Already delivered messages and provider disclosures cannot be recalled; record limitations and backup/provider retention. At-rest encryption and backups require configured/verifiable deployment controls, not assumptions about a private host.

Never commit tokens, private source content, runtime files or raw logs. Worker/model egress permissions are separate from source access. Logs hold concise explanations, identifiers and evidence rather than unnecessary sensitive content.

## 12. Scheduling and strategy

Inspect/reuse native recurrence parser/encoding; conversational cron examples are not raw DB formats. CoS binds one approved schedule revision and stable occurrence to native wake. Repeated deliveries resolve one run; coalesce downtime instead of backlog storms. A bounded reconciler repairs projections, not a competing scheduler.

Quiet hours, notification limits, snooze, acknowledgement and freshness are explicit. Missing/stale sources never become confident empty results. Calendar occupancy is not actual effort or progress. Strategic reviews offer evidence, alternatives, assumptions, opportunity cost, uncertainty and disconfirming conditions; they cannot rewrite approved direction.

## 13. Implementation/release/operational contracts

[SLICE_EXECUTION_RULES.md](SLICE_EXECUTION_RULES.md) owns repeated TDD, command, receipt and handover rules. [EXTERNAL_POSTGRES.md](EXTERNAL_POSTGRES.md) owns env/client/migration/failure contracts. [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md) records bounded automatic operations and monotonic disposable/protected lifecycle. [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) and [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) own tested source/artifact delivery. [INTERACTION_MODEL.md](INTERACTION_MODEL.md) defines exact controls and private presentation.

Use monotonically added compatible migrations and feature gates. Prefer compatible code rollback/roll-forward over destructive resets. Restore evidence precedes real external writes. Owner can pause/cancel/revoke/disable without stopping unrelated NanoClaw. Existing implementation migration/deployment authority never becomes runtime-agent authority, account access or automatic PR merge.
