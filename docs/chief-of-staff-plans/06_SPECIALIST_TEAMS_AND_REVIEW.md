# S06 — Coordinate bounded specialist teams

**Status:** not started  
**Branch:** `cos/s06-specialist-teams-and-review`  
**Depends on:** S05 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** one request produces independent analyses, evidence review and a finished recommendation without the owner supervising each worker.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Demonstration and scope

Approve a small graph with independent technical and operational analyses followed by synthesis/review. Observe progress within the concurrency limit and receive one recommendation with disagreement, uncertainty and sources. Inject required-worker failure: retry only within root limits or explicitly report partial/blocked work. Cancel another graph and fence all descendants.

Build a small acyclic step graph, approved templates, bounded parallel dispatch and review. Optional public-source retrieval is host-brokered and allowlisted. No arbitrary agent marketplace, recursive swarm or cross-domain collaboration.

## Implementation sequence

1. Add typed steps, dependencies, required/optional outputs and criteria. Validate acyclicity, maximum graph size, supported templates, sources and root budget before admission. The coordinator proposes; deterministic host checks and exact approval authorise.
2. Add analyst, writer and reviewer templates using S05's fresh execution identities. Role names grant no additional permissions. Reviewers receive only necessary artifacts and evidence, not every worker's private history.
3. Dispatch ready steps through the existing native queue/container capacity. Stable attempts start once and dependencies cannot start early. Reserve coordinator capacity or enforce a fair limit so workers cannot starve user interaction.
4. Reserve root limits before dispatch, account for children/retries and release unused reservations once. Unknown provider usage is not zero; subscription usage is not fictional dollar cost. Do not create a pool per worker or hold DB transactions while a model runs.
5. Implement deterministic joins: required failure blocks synthesis or yields expressly approved partial work; optional omissions remain visible. Results/events wake subsequent steps. Do not hold coordinator model turns or generate polling chatter while waiting.
6. Review evidence validity, factual gaps, contradictions and unmet criteria. Schema/access/citation checks block completion; semantic critique is advisory. Permit only bounded rework already inside the approved plan.
7. Optional public retrieval uses operator-approved providers/domains, time/size/content limits and DNS/IP/redirect checks blocking private, link-local and metadata endpoints. Treat pages as untrusted revisioned evidence. No unrestricted shell internet. Without search-provider configuration use supplied admitted URLs and report coverage limits.
8. Publish one consolidated result in the originating private scope. Intermediate work belongs in mission status, not other channels. Owner cancellation fences the entire graph.

## Graph contract

Each step has ID, template version, dependency IDs, input artifact references, permitted sources, required/optional designation, result schema and maximum rework count. Workers cannot add steps. Expanded cost, sources, deadline or authority requires a new approved revision. Preserve the S05 single-worker default for simple work.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S06-T01 | Cyclic/oversized graphs and unauthorised template/source expansion are rejected. |
| S06-T02 | Dependencies start once/in order with bounded parallelism and coordinator capacity. |
| S06-T03 | Parent limits include all descendants/retries and cannot reset through replanning. |
| S06-T04 | Required failure is visible; missing work is not an apparently complete result. |
| S06-T05 | Review/synthesis cannot acquire unrelated context or credentials. |
| S06-T06 | Whole-graph cancellation fences descendants and late events. |
| S06-T07 | Duplicate results/joins do not start duplicate synthesis or notifications. |
| S06-T08 | Disagreement survives synthesis; majority agreement is not evidence. |
| S06-T09 | Public fetch rejects SSRF, private redirects, excessive content and unapproved destinations. |
| S06-T10 | Simple tasks retain the single-worker path. |
| S06-PG01 | Concurrent admission and DB contention/disconnect cannot overspend or duplicate join work. |
| S06-PG02 | Ready-step storms respect pool/admission limits without per-worker pools or transaction-held model waits. |

## Acceptance, rollback and handover

Demonstrate successful parallel analysis, required failure and graph cancellation. Show one final result and inspectable step/budget history. New profiles require isolation regressions. Public web access may remain disabled and must not be described as a live search.

Disable team admission independently. Safely continue single-worker work or explicitly cancel team generations; never flatten incomplete graphs into successful missions. Follow common Mac/image/source/Pi gates and record `docs/chief-of-staff/evidence/S06.md`; S07 follows verified human merge.
