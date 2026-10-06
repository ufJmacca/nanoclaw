# S10 — Connect everyday work to long-term strategy

**Status:** PR #67 owner-merged; required source-evolution and collection-limit corrections verified, PR #68 human review/merge pending

**Repository:** `ufJmacca/nanoclaw`

**Branch:** `codex/s10-strategic-reviews`

**Required correction branch:** `codex/s10-current-observations`

**Depends on:** S09 merged, with its acceptance receipt available.

**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.
**User-visible outcome:** You receive a review that compares activity with approved outcomes, challenges assumptions and proposes evidence-backed changes for your decision.

The owner merged S09 PR #66, and its actual merge
`60ad9d5dd08d4dd4a64377745ad49a4cc22254fe` passed fresh local/final-image gates,
exact Pi deployment, native checks, preservation, recovery and Pi-owned
independence. See [the accepted predecessor receipt](../chief-of-staff/evidence/S09_MERGED.md).
S10 starts from that merge. CoS remains paused; S09 live writer admission and
fresh finite model/channel authority are separate pending gates.

The S10 candidate passed all seven Mac release gates, exact Pi delivery, both
native profiles, preservation, recovery verification and Pi-owned independence.
See [the S10 evidence](../chief-of-staff/evidence/S10.md) and
[operator runbook](../chief-of-staff/STRATEGIC_REVIEWS.md). The owner assessed both
reviews as useful with limitations because their structure was unclear.
The [tested correction](../chief-of-staff/evidence/S10_STRUCTURE.md)
puts the decision first and preserves original saved text. Legitimate human
review/merge was completed by the owner in PR #67. Its P1 review finding required
a [source-evolution correction](../chief-of-staff/evidence/S10_SOURCE_EVOLUTION.md)
so historical observations cannot permanently prevent fresh reviews. PR #68's
P2 finding also required a
[collection-limit correction](../chief-of-staff/evidence/S10_OBSERVATION_CAP.md)
so retired history cannot crowd out current evidence. That exact final candidate
is deployed, healthy and technically verified. Its human merge and actual
merged-source acceptance remain pending; S11 is not yet eligible.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

Seed two synthetic initiatives. One has many completed tasks but little evidence of its desired outcome; the other has few tasks but a confirmed useful result. Run a strategic review. The assistant distinguishes activity from outcomes, highlights an unsupported assumption, presents alternatives including continuing unchanged, and proposes a specific decision. Reject its recommendation and verify no goal or active-project status changes. Accept a revised proposal and verify the new direction is recorded with rationale and superseded versions.

## In scope

Strategic assumptions, outcome observations, decision history, portfolio-level review, long-horizon recommendations and learning from actual results. Use the work/knowledge/mission foundation already built. Do not introduce a new agent platform, graph database or automatic goal optimiser.

## Execution sequence

1. Extend the work model only where necessary: initiatives/milestones, strategic assumptions, success measures, outcome observations, review records and continue/change/stop decision proposals. Outcomes are supported by evidence, explicitly self-reported, or unknown; they are not inferred solely from completed tasks.
2. Add an approved review charter defining horizons, selected goals/projects, resource constraints, review cadence and evidence limitations. Reviews may use the S08 weekly/monthly mandate mechanism. Changing the review charter requires the normal owner-confirmation path.
3. Implement `cos_review_request` that snapshots approved goal/project/commitment versions, source coverage, mission results, decisions and outcome observations. Give reviewers bounded context across authorised records within this privacy scope, not uncontrolled access to every account.
4. Use S06 specialists only when useful: one evidence analyst and one challenge/review perspective are sufficient initially. A single-worker review remains available. Reviewers identify counterevidence and missing data; they do not vote a recommendation into truth.
5. Produce a structured review: outcomes sought, observed progress, assumptions supported/challenged/untested, opportunity costs, options, recommendation, uncertainty, proposed next action and evidence that would change the recommendation. Include an explicit “continue unchanged” option where reasonable.
6. Keep calendar allocation separate from actual effort and outcome achievement. Report incomplete sources and self-report limitations. A lack of observed activity is not proof that the operator made no progress outside connected systems.
7. Turn accepted direction changes into versioned proposals against current state. A recommendation to pause an initiative does not cancel its commitments or running missions automatically; present those consequences and obtain approval for the specific changes. Preserve historical decisions and their context.
8. Add a later review comparison: what was recommended, what the owner chose, what happened and whether the underlying assumptions changed. Record forecast horizons and uncertainty where used. Acceptance by the owner is not a success label; subsequent outcomes provide the evidence.
9. Include attention-cost feedback and exploration capacity. The system may recommend doing less or stopping a low-value activity; it must not optimise for number of tasks completed or agent calls made.

## Review artifact contract

A review has a stable ID, as-of timestamp, scope, goal/charter versions, source-coverage snapshot, findings with evidence references, explicit assumptions, options/trade-offs, recommendation, confidence, proposed experiments/decisions and owner disposition. New evidence creates a new review revision, not a rewrite of what was previously recommended.

Exploratory ideas stay distinct from approved initiatives. Long-term suggestions do not grant the assistant permission to create projects, contact people, spend funds or change the operating charter.

## Required red tests

| ID      | Behaviour that must first fail                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------- |
| S10-T01 | Completed tasks alone cannot be reported as achieved strategic outcomes.                                 |
| S10-T02 | Facts, self-reports, assumptions and recommendations remain distinctly typed/rendered.                   |
| S10-T03 | Every consequential finding has supporting evidence or an explicit uncertainty label.                    |
| S10-T04 | Rejecting a recommendation changes no approved goals/projects/commitments.                               |
| S10-T05 | Accepting a stale proposal triggers revalidation rather than overwriting new priorities.                 |
| S10-T06 | Private data outside the authorised review scope is excluded from all specialist contexts.               |
| S10-T07 | Contradictory evidence and alternatives survive synthesis; agent agreement is not treated as proof.      |
| S10-T08 | Calendar time is not silently converted into actual effort or productivity.                              |
| S10-T09 | Later review preserves what was recommended/decided at the time, including unsuccessful recommendations. |
| S10-T10 | Changing direction cannot silently cancel missions, external events or commitments.                      |

## External PostgreSQL requirements for this slice

Build the review context from explicit remote record/source versions using short bounded reads; release connections before specialist analysis. Do not claim a complete strategic snapshot if the database goes down during context assembly. Accepted direction changes still use exact proposals and commit reconciliation.

| ID       | Additional required red → green behaviour                                                                                                                        |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S10-PG01 | Database failure during review snapshot creation yields blocked/incomplete evidence, not a confident strategic review assembled from an unchecked partial cache. |
| S10-PG02 | A lost accepted-decision commit acknowledgement preserves one historical decision and does not reapply side effects on associated missions.                      |

## Acceptance gate

Complete an end-to-end review with two synthetic initiatives, at least one contradiction, one uncertain outcome and an accepted/rejected direction change. Validate evidence and state transitions deterministically. Have the owner assess whether the review exposed a useful decision, recording disagreements and limitations rather than turning subjective judgement into an automatic release score.

## Rollback

Pause review mandates and hide unfinished recommendations. Keep approved direction and decision history intact. No reversion of actual strategic choices occurs merely because the review feature is disabled.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S10 --db-profile <selected-profile>` and `pnpm cos:demo --slice S10 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S10.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.

## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.
