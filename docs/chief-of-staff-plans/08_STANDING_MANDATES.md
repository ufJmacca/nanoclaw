# S08 — Perform useful background work under a standing mandate

**Status:** not started  
**Branch:** `cos/s08-standing-mandates`  
**Depends on:** S07 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** approve a narrow ongoing responsibility once; receive autonomous preparation within its scope, limits and notification rules.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Demonstration and scope

Approve meeting preparation using selected important calendar events and Pilot Alpha notes, with no attendee contact or calendar modification. A matching event admits one mission without a fresh approval. Pause while a subsequent mission runs: revoke remaining authority and prevent stale-authority publication.

Add immutable mandate revisions, typed triggers, deterministic policy, budget reservations, read-only/preparation missions and renewal/pause/expiry. No implicit external write permission; S09 adds a separate exact-action approval.

## Implementation sequence

1. Define MandateRevision: owner/scope/purpose, permitted source selectors/templates/operations, triggers, output destination, quiet hours, structural budget, start/end/review and failure behaviour. Natural language compiles into a typed proposal, never an executable script.
2. Keep trigger language small: selected event approaching, project changed, recorded commitment due or native scheduled review. Bound time windows/cardinality. No arbitrary code, SQL, shell or model-generated callback URLs.
3. Use S01 exact approval for initial mandate, renewal and expansion. Show all delegated authority/limits. Revisions are immutable; replacement revokes the prior one. Editing descriptive text grants no authority.
4. Deterministically evaluate current source binding, origin, owner/subscription, expiry, template and operation. In one PostgreSQL transaction deduplicate occurrence, reserve root budget and create mission/outbox.
5. Link every child to the mandate revision. Revalidate at retrieval, worker wake, output publication and privileged boundaries. Pause/revocation affects existing work, not only future scheduling.
6. Reuse native S04/S07 scheduling/events and bounded startup/outbox reconciliation. Duplicate provider events or clock ticks never create multiple missions. No separate general-purpose scheduler.
7. Implement pause/resume/revoke/expiry, failure thresholds and automatic suspension on repeated failures/unknown usage. Resume does not replay an unlimited backlog or revive cancelled generations. Unknown monetary usage is never free work.
8. Digest the mandate, trigger, work, result, accessed sources, consumed limits and decisions. Immediate alerts follow approved escalation. Record no-op checks without model invocation or user interruption.

## Initial templates

Meeting preparation reads approved calendar/project sources and creates a private brief. Project health review creates proposals/summaries, not project-state edits. Weekly operating review proposes next steps without creating commitments. Enable one first; shipping a template does not activate it. No mandate can expand its own sources, expiry or authority.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S08-T01 | Unapproved/expired/revoked/out-of-scope mandates cannot admit work. |
| S08-T02 | Duplicate/concurrent triggers reserve/create once. |
| S08-T03 | Pause/revoke fences descendants and blocks subsequent retrieval/publication. |
| S08-T04 | Model cannot widen actions/sources/templates or extend expiry. |
| S08-T05 | All children/retries count; unknown usage is not zero. |
| S08-T06 | Missed occurrences coalesce and repeated failure suspends rather than spawning endlessly. |
| S08-T07 | Source/event text cannot become executable trigger code. |
| S08-T08 | Schedule repair cannot bypass approval or replay cancelled generations. |
| S08-T09 | No-op checks avoid model execution and notification noise. |
| S08-T10 | External calendar/email writes remain denied despite claimed implied permission. |
| S08-PG01 | DB loss during admission/renewal starts no new worker, resets no spend and permits no stale-authority publication. |
| S08-PG02 | Emergency host-local pause during partition survives reconnect until explicit eligible owner resume. |

## Acceptance, rollback and handover

Prove approve → trigger → autonomous preparation → digest plus pause, expiry, exhaustion, duplicates, restart and source revocation. A live read-only mandate requires the selected runtime/provider's S05 isolation evidence and separately valid account/model authority. Record actual bounds and distinguish estimates from enforceable limits.

Close mandate admission, revoke descendants and pause owned schedules while retaining evidence. Distinguish cancelled from already-completed work; delivered content is not retracted. Follow common release gates and write `docs/chief-of-staff/evidence/S08.md`; human merge precedes S09.
