# S10 — Connect everyday work to long-term strategy

**Status:** not started  
**Branch:** `cos/s10-strategic-reviews`  
**Depends on:** S09 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** compare activity to approved outcomes, challenge assumptions and propose evidence-backed direction changes for the owner to decide.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Demonstration and scope

Seed two initiatives: many tasks but little outcome evidence versus few tasks and one confirmed useful result. Review distinguishes activity/outcomes, challenges an unsupported assumption and presents alternatives including continuing unchanged. Reject recommendation and verify no canonical changes. Approve a revised exact proposal and preserve rationale and superseded direction history.

Build assumption/outcome/decision records, bounded portfolio review and later outcome comparison using existing knowledge/missions. No graph database, new agent platform or automatic goal optimiser.

## Implementation sequence

1. Add initiatives/milestones only as needed, strategic assumptions, success measures, outcome observations and continue/change/stop proposals. Outcomes are evidenced, explicitly self-reported or unknown; not inferred from completed tasks alone.
2. Approve a review charter containing horizons, selected goals/projects, constraints, cadence and known evidence limits. Use S08 weekly/monthly mandates. Changes use normal owner confirmation.
3. `cos_review_request` snapshots approved goal/project/commitment versions, current coverage, mission results, decisions and outcomes. Scope-bounded context, not broad account access.
4. Use S06 specialists only when useful: evidence analyst and challenge/reviewer initially suffice; single-worker path remains. Identify missing/counterevidence, not majority-vote truth.
5. Produce outcomes sought, observed progress, supported/challenged/untested assumptions, opportunity costs, options, recommendation, uncertainty, experiment/decision and evidence that would change the advice. Include continue unchanged where reasonable.
6. Distinguish calendar allocation from actual effort and outcomes. Missing connected-source activity is not proof of no offline progress. Label self-reports and incomplete coverage.
7. Accepted direction changes become exact versioned proposals against current state. Pausing an initiative cannot silently cancel commitments/missions; preview consequences and obtain their specific approval. Retain historical choices/context.
8. Later compare recommendation, owner decision, observed outcome and assumptions. Record forecast horizon/uncertainty where used. Acceptance alone is not a success label.
9. Include review/attention cost and bounded exploration capacity. Recommend less or stopping where appropriate; never optimise task/agent-call count as the outcome.

## Review contract and database behaviour

Stable review ID, as-of timestamp, scope, charter/goal versions, coverage snapshot, sourced findings, typed assumptions, alternatives/trade-offs, recommendation, confidence, proposed experiments and owner disposition. New evidence creates a revision, not rewritten history. Exploratory interests remain distinct from active initiatives; suggestions do not grant contact/spend/project-creation rights.

Snapshot integrity is required before dispatch. A DB failure cannot produce a complete review from unchecked partial cache. Lost decision-commit acknowledgement resolves one operation/history entry and cannot repeat effects on associated work.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S10-T01 | Completed tasks alone cannot prove strategic outcomes. |
| S10-T02 | Facts/self-reports/assumptions/recommendations stay distinctly typed and rendered. |
| S10-T03 | Consequential findings have evidence or explicit uncertainty. |
| S10-T04 | Rejection changes no approved direction/commitment. |
| S10-T05 | Stale acceptance requires revalidation, not overwrite. |
| S10-T06 | Foreign private context is excluded from all reviewers. |
| S10-T07 | Counterevidence/options survive synthesis; model agreement is not proof. |
| S10-T08 | Calendar time is not silently actual effort/productivity. |
| S10-T09 | Later review preserves historical advice, including failures. |
| S10-T10 | Changed direction does not silently cancel work/events/commitments. |
| S10-PG01 | Snapshot DB failure yields blocked/incomplete evidence, not confident unchecked review. |
| S10-PG02 | Lost decision commit acknowledgement preserves one decision without repeated associated effects. |

## Acceptance, rollback and handover

Complete the two-initiative review with contradiction, uncertain outcome and accepted/rejected changes. Validate citations/state transitions deterministically. Record owner judgement of useful decisions, disagreements and limits separately from blocking tests.

Pause review mandates/hide unfinished recommendations without reverting actual approved choices. Follow common release gates and write `docs/chief-of-staff/evidence/S10.md`; human merge precedes S11.
