# S04 — Deliver a daily brief and track confirmed commitments

**Status:** not started  
**Branch:** `cos/s04-daily-brief-and-commitments`  
**Depends on:** S03 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** scheduled useful briefings, confirmed follow-ups and reminders that stop when resolved.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Demonstration and scope

Approve a weekday morning brief in the private CoS channel. Advance the fixture clock and receive up to three substantive attention items with evidence, relevant calendar observations, unresolved decisions and coverage warnings. Confirm a follow-up, complete it through authenticated owner interaction, and verify later briefs no longer list it as open. Restart during briefing; one run is reconciled, not recreated.

Use native NanoClaw scheduling, brief lifecycle, confirmed commitments/decisions, quiet hours and deduplicated notification intent. No specialist delegation, general mandates or external account writes yet. The approved recurring brief is a narrow responsibility, not unrestricted autonomy.

## Implementation sequence

1. Add commitment/decision status, source evidence, related project, owner and due-date semantics. Extracted chat/calendar suggestions are proposals until exact owner confirmation.
2. Add `cos_brief_request` and proposal operations. Deterministically filter active projects, unresolved commitments, approaching events and stale sources. Model synthesis explains trade-offs without inventing facts or changing priorities.
3. Inspect/reuse actual native scheduling functions and recurrence encoding; no hand-written guessed cron queue fields. Persist approved CoS schedule revision and native task binding. Only the host schedules authorised CoS operations.
4. Stable occurrence key = scope + schedule revision + intended time. Transactionally create one BriefRun, reserve limits and outbox dispatch. Transport/model retries are not new occurrences.
5. Refresh selected sources within bounded time; when refresh fails but DB authority remains available, mark stale/not-connected sections visibly. A late briefing uses current data and generated-at time.
6. Host-controlled private notifications use stable IDs. Recheck owner/subscription/destination immediately before delivery; persist queued, delivered, failed or uncertain status and provider receipt. Do not claim provider exactly-once delivery.
7. Add pause/resume, quiet hours, snooze and missed-run coalescing. At most one current brief after downtime; explicit once-per-local-date/DST policy.
8. Confirm/edit/complete/defer/dismiss exact versioned items through owner controls. Ambiguous text cannot mutate an arbitrary item.

## Output and external DB rules

Persist generated_at, timezone, coverage, no more than three recommendations, due commitments, decisions, suggested work and evidence/record versions. There is no quota to fill with speculation. Empty confirmed work with disconnected calendar is valid. Historical brief versions remain intact, subject to current revocation checks.

Native schedule rows are wake signals, not offline authorisation. When PostgreSQL is unavailable, no private brief generation/publication, commitment mutation or delivery acknowledgement occurs. Reconnect, reconcile the original occurrence/current permissions, then coalesce safely.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S04-T01 | Duplicate native deliveries create one BriefRun and notification intent. |
| S04-T02 | Restart after dispatch/before receipt reconciles the same run. |
| S04-T03 | Confirmed/completed/deferred/dismissed items appear in correct views. |
| S04-T04 | Extracted urgency cannot authorise a commitment. |
| S04-T05 | Quiet hours, snooze, DST and missed runs obey schedule policy. |
| S04-T06 | Revocation between preparation and delivery prevents disclosure. |
| S04-T07 | Missing/stale coverage cannot become a false free-day claim. |
| S04-T08 | Native retry respects root turn/tool/deadline limits. |
| S04-T09 | Queued, delivered and uncertain are correctly distinguished. |
| S04-T10 | Generic scheduling or forged rows cannot create unapproved schedules. |
| S04-PG01 | Due task during DB outage does no unauthorised model/notification work and recovers to one current intent. |
| S04-PG02 | Lost commitment commit ack returns the original revision and preserves owner disposition. |

## Acceptance, rollback and handover

Complete approved schedule → brief → confirmed commitment → completion → next brief with fake clock and fixture connector. Real channel exercise requires its existing explicit activation authority; document adapter delivery guarantees and uncertainty.

Pause only CoS schedules and reconcile pending notifications without deleting unrelated schedules. Preserve commitments and decisions for on-demand use. Follow common release/source/image/Pi gates and write `docs/chief-of-staff/evidence/S04.md`; advance after verified human merge.
