# S05 — Delegate one bounded research mission safely

**Status:** not started  
**Branch:** `cos/s05-isolated-research-missions`  
**Depends on:** S04 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** receive a mission ID promptly, inspect/cancel isolated research and receive a reviewed result.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md). Isolation and authority are release-blocking requirements.

## Demonstration and integration correction

Request a comparison of alternatives in admitted Pilot Alpha notes. Approve a bounded work order. The researcher sees only permitted sources, progress is inspectable and cancellation works. A valid result returns to the originating private context for review. Two missions with distinct synthetic canaries cannot observe one another's prompts, files, provider state or retrieval access.

Do not delegate with ordinary `send_message(to='researcher')`. Native routing uses an agent-shared session and blocks Mattermost cross-agent routes; sessions also share writable group/provider state. Add a narrowly authorised host dispatcher while preserving those native protections. Persistent templates are reusable; execution AgentGroups are fresh per attempt.

## Implementation sequence

1. Define Mission, Attempt, TemplateVersion, ContextManifest, root budget and result submission. Initial work is read-only comparison of admitted sources; web/account writes are unnecessary. Specify actor/guard for every transition.
2. Version a constrained researcher template, approved provider and tool manifest. Operator reviews template changes and scope delegation. A model cannot create a template or choose a privileged provider.
3. Add `cos_mission_request`, `cos_mission_get`, cancellation and worker-only `cos_result_submit`. Proposal alone launches nothing. Once authorised, one PostgreSQL transaction creates a queued attempt and stable outbox dispatch. Return ID promptly; coordinator does not wait in a model turn.
4. Allocate a distinct AgentGroup/session/workspace/provider state/gateway identity per attempt. Mount only immutable template and admitted context. No global personal memory, shared writable skill/provider state, owner roles, broad additional mounts or generic destinations. Reuse native admission/wake/kill.
5. Host dispatch binds origin scope to child identity. Mattermost scope delegation is owner-approved; recheck subscription at allocation, wake, result acceptance and publication. Native A2A prohibition stays intact. Child has no messaging-group binding/direct channel output.
6. Enforce restricted profile across native tools, forged queue rows and provider built-ins. Deny self-modification, arbitrary scheduling/spawn, direct account writes and unapproved network egress. Confinement must be demonstrated; otherwise delegation stays unavailable.
7. Persist allocation intent and stable input ID. Replays recover partial allocations and reuse one identity; `wakeContainer=false` means deferred/pending. Native retries remain in one logical attempt. Only CoS creates another generation.
8. Validate result schema, artifacts, accessible citations, acceptance criteria and current authority. Coordinator records review before completion. Worker cannot update projects or approve itself. Partial/blocked evidence remains labelled.
9. Cancellation revokes generation, blocks future retrieval/effects/publication, requests exact container stop and reconciles resources. Late results cannot become successful completion. Never reuse cancelled workspaces.

## Work-order and budget contract

Immutable work order: scope/origin, related goal/project, purpose, result schema, criteria, permitted source revision IDs, context digest, template/provider versions, deadline and structural limits. Begin with one worker/active attempt and concrete configured turn/tool/wall-time bounds. Count native retries and every actual invocation against root limits. Unknown usage is not zero; a hard monetary ceiling requires provider enforcement and must not be advertised from estimates alone.

Database access is host-only. Worker lacks both credentials and a direct route to external PostgreSQL. On DB uncertainty, close admission and stop/fence CoS workers through host-local deny-only controls. Reconcile cancellations, leases and budgets before reopening. Unrelated agents remain operational.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S05-T01 | Native A2A/Mattermost restrictions remain unchanged. |
| S05-T02 | Two attempts have distinct execution/workspace/provider/gateway identities; inspect mounts/context canaries. |
| S05-T03 | Worker cannot access another scope/source or obtain owner/template-edit authority. |
| S05-T04 | Forged native actions and direct network attempts cannot bypass admitted capabilities. |
| S05-T05 | Dispatch replay allocates one identity/input; deferred wake is not completion/failure. |
| S05-T06 | Crash at each allocation stage leaves no unowned live worker. |
| S05-T07 | Cancel/unsubscribe/revoke fences generation and late publication. |
| S05-T08 | Invalid citations, missing output or failed criteria cannot complete a mission. |
| S05-T09 | Native retry cannot reset limits or create a new logical attempt. |
| S05-T10 | DB/policy uncertainty fails closed for worker retrieval/effects. |
| S05-T11 | Coordinator handles another conversation while the worker runs. |
| S05-T12 | Real container smoke demonstrates filesystem/network restrictions. |
| S05-PG01 | Direct DB TCP access and credential discovery fail inside a real worker while host access succeeds. |
| S05-PG02 | Mid-run DB loss prevents reads/wakes/publication and permits local stop without disrupting unrelated agents. |
| S05-PG03 | Reconnection preserves attempt/budget; stale results cannot beat generation fences. |

## Acceptance, rollback and handover

Prove request → approve → allocate → execute → submit → verify → notify plus cancellation and crash recovery. Fixture provider is required for deterministic CI; separately authorised live-provider smoke precedes real missions. Inspect actual isolation, not an LLM's claim. Pi-native isolation is mandatory in addition to Mac release tests.

Close mission admission, revoke generations, stop exact owned containers and reconcile artifacts; preserve history and unrelated work. Follow shared release and handover requirements, receipt `docs/chief-of-staff/evidence/S05.md`, then human merge before S06.
