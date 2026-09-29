# S07 — Notice useful work without creating a task avalanche

**Status:** not started  
**Branch:** `cos/s07-proactive-proposals`  
**Depends on:** S06 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** useful, evidence-backed suggestions with accept/defer/dismiss controls and suppression of repetitive noise.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Demonstration and scope

A synthetic active project has an approaching milestone and unresolved decision. An admitted source changes. At review, propose one investigation, cite the change and link it to an approved goal. Dismiss and replay the same observations: it does not return unchanged. Material new evidence can produce a linked new proposal. Inactive projects are not labelled stalled.

Add observation processing, candidate deduplication, prioritisation, feedback/cooldown and digest integration. Suggestions are not authorised work; standing autonomous execution arrives in S08.

## Implementation sequence

1. Normalise existing source revisions, calendar snapshots, commitment transitions and mission outcomes into host-recorded observations with stable event IDs and provenance. Do not invent new email/Drive integrations for more triggers.
2. Filter deterministically before model calls: approaching confirmed due dates, recorded unresolved dependencies, overdue decision reviews or missing observed updates beyond an approved interval. Say no progress was observed in connected sources, not that no work happened.
3. Provide bounded candidate batches, approved goals and open proposals to the coordinator. It may recommend act/wait/stop/ask. Include evidence, uncertainty, effort/benefit assumptions and displaced work.
4. Persist versioned proposals with a stable semantic deduplication key from rule, target, relevant evidence and action class, independent of incidental wording. Keep source versions, review/expiry and stale state.
5. Exact owner accept/defer/dismiss targets one revision. Acceptance of a precise bounded work order may authorise one S05/S06 mission after current checks. A vague idea is clarified, not executed. Deferral records review time; dismissal reason suppresses repetition until material evidence changes.
6. Enforce a small notification budget and quiet-hour digest. No minimum quota. Immediate interruption requires an approved deterministic rule, not repeated rewritten model urgency.
7. Record accepted/dismissed/deferred, usefulness, review effort and repeated noise. Feedback may suggest preference changes; it cannot silently rewrite goals, charter, access or permissions.

## Proposal contract

Purpose, supporting goal/project, evidence, uncertainty, expected benefit, effort assumptions, opportunity cost, proposed work order, required permissions, status, deduplication key and review/expiry. A proposed task is not a commitment; recommending stop does not deactivate a project. Stale context requires a revised preview before acceptance. Owner disposition must be durably recorded before acknowledgement; a DB partition cannot cause a dismissed item to be regenerated as new.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S07-T01 | Repeated events/wording do not create equivalent repeated proposals. |
| S07-T02 | Inactive/exploratory work is not treated as overdue commitment. |
| S07-T03 | Dismiss/defer suppresses recurrence until its documented condition. |
| S07-T04 | Precise acceptance authorises one mission; suggestions alone authorise none. |
| S07-T05 | Stale/revoked evidence blocks acceptance and publication. |
| S07-T06 | Quiet hours and notification budgets survive event storms. |
| S07-T07 | Untrusted observations cannot modify rules, priorities or tools. |
| S07-T08 | Missing updates are reported as missing observation, not proof of inactivity. |
| S07-T09 | Feedback cannot silently change approved goals. |
| S07-T10 | Batches/model calls/deadlines/retries remain bounded. |
| S07-PG01 | Partition and lost dismissal acknowledgement cannot resurrect a dismissed item or launch unconfirmed work. |

## Acceptance, rollback and handover

Replay a synthetic week with useful changes, churn, outages and dismissals. Show proposal/digest history. Owner assessment of a labelled sample records false positives and usefulness rather than treating proposal volume as success.

Pause candidate generation/notifications while preserving dispositions and authorised missions. Restart never turns old suggestions into executable work. Follow common release gates and write `docs/chief-of-staff/evidence/S07.md`; next slice requires verified human merge.
