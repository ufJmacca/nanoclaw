# S06 — Coordinate bounded specialist teams

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s06-specialist-teams-and-review`  
**Depends on:** S05 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** One request can produce independent analyses, an evidence review and a finished recommendation without you managing each agent.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

Request a comparison requiring both technical and operational analysis. The coordinator proposes a small step graph: two independent specialists, then synthesis/review. Approve it once. Observe concurrent progress within the configured limit; receive a recommendation that includes disagreement, uncertainty and source references. One specialist fails: the system either retries within the root budget or labels the final result partial rather than silently omitting that perspective.

## In scope

A small acyclic mission-step graph, approved specialist templates, bounded parallel dispatch, result dependencies and explicit synthesis/review. Optional host-brokered public source retrieval from an operator-approved domain allowlist. No arbitrary agent marketplace, recursive swarms or cross-domain collaboration.

## Execution sequence

1. Extend the mission contract with typed steps, dependency IDs, required/optional outputs and per-step acceptance criteria. Validate acyclicity, a small maximum step count, supported templates and a root budget before admission. The coordinator proposes the plan; host validation and approval authorise it.
2. Add analyst, writer and reviewer templates using S05's attempt isolation. A role label grants no extra permissions. A reviewer receives only the necessary submitted artifacts and evidence access, not private working histories from every worker.
3. Implement a bounded dependency dispatcher in the CoS module using existing native queue/container capacity. Ready steps get stable attempts; blocked steps never start early. Reserve part of native capacity for the coordinator or configure a fair limit so workers cannot indefinitely starve user interaction.
4. Add root-budget accounting. Reserve limits before dispatch, account for retries and descendant steps, and release unused reservations exactly once. Record provider usage uncertainty; do not compare subscription usage to fictional dollar costs. Hard per-call limits require adapter support.
5. Implement join semantics: required failed work blocks synthesis or yields explicitly approved partial output; optional failures are visible. Coordinator returns to idle while steps run. Results/events, not open model turns or polling chatter, wake the next step.
6. Define structured review outputs: evidence validity, factual gaps, contradictions, unmet criteria, recommended revisions and confidence. Deterministic citation/access/schema tests are blocking. LLM quality judgements remain advisory and can request a bounded rework step, not expand the plan indefinitely.
7. Optionally add public retrieval through a host broker. Use an operator-approved provider/domain list, time/size/content limits, DNS/IP and redirect validation, and no access to private/link-local/metadata endpoints. Retrieved pages remain untrusted source revisions. Do not enable a general-purpose shell internet connection as “research access”. With no configured search service, use supplied/admitted URLs and state the research coverage limit.
8. Publish one consolidated result through the original scope. Route intermediate output to mission status, not unrelated messaging channels. Allow owner cancellation of the whole graph and fence all remaining children.

## Graph contract

Each step has `step_id`, `template_version`, `depends_on`, `input_artifact_refs`, source scope, required status, result schema and maximum rework count. No worker can add steps. A plan change that expands cost, sources, deadline or authority requires a new approved revision.

Keep the original S05 single-worker route as the default. Use the team route only where the request benefits from independent work; do not force three agents to answer a simple question.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S06-T01 | Cyclic/oversized/unsupported graphs and unauthorised template/source expansion are rejected. |
| S06-T02 | Dependencies start once, in valid order, with bounded parallelism and preserved user capacity. |
| S06-T03 | Parent limits include every child/retry and cannot be reset by re-planning. |
| S06-T04 | Required failure is visible; missing work cannot become an apparently complete recommendation. |
| S06-T05 | Review/synthesis cannot acquire a worker's unrelated context or credentials. |
| S06-T06 | Entire-graph cancellation fences all descendants and late events. |
| S06-T07 | Duplicate result/join events do not start duplicate synthesis or notification runs. |
| S06-T08 | Disagreement remains visible; majority vote cannot convert unsupported claims into facts. |
| S06-T09 | Public fetch rejects SSRF, redirects into private networks, excessive size and unapproved destinations. |
| S06-T10 | A simple task still uses the cheaper single-worker path. |

## External PostgreSQL requirements for this slice

Parallel agents do not create parallel PostgreSQL pools. Reserve root budgets and dependency/join transitions through the one bounded host pool using database-time leases. Do not hold a client while waiting for workers or models, and do not reset reservations when the LAN connection breaks.

| ID | Additional required red → green behaviour |
|---|---|
| S06-PG01 | Concurrent step admission plus database contention/connection loss cannot overspend a root reservation or start duplicate join work. |
| S06-PG02 | Many ready steps respect the pool/admission limit and preserve coordinator responsiveness; no per-worker pools or transaction-held model waits appear. |

## Acceptance gate

Complete three fixture scenarios: successful parallel analysis, required-worker failure and cancelled graph. Demonstrate one final brief with references and an inspectable step/budget history. New specialist/provider profiles require isolation regression tests. Public web capability may remain disabled; document that state rather than simulate a live search.

## Rollback

Disable team admission, let already-safe single-worker missions continue, or explicitly cancel team generations. Do not flatten partially completed graphs into successful single-worker missions.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S06 --db-profile <selected-profile>` and `pnpm cos:demo --slice S06 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S06.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

