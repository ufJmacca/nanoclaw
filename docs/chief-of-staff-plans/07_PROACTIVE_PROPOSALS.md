# S07 — Notice useful work without creating a task avalanche

**Status:** implemented and merged; exact merged-source technical/Pi acceptance passed; operator proposal assessment pending.

**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s07-proactive-proposals`  
**Depends on:** S06 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** The assistant notices a meaningful change or unresolved dependency, explains why it matters, and lets you accept, defer or dismiss the proposed work.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

A synthetic project has an approaching milestone and an unresolved decision. An admitted source changes. On the next scheduled review, the assistant proposes one investigation, cites the evidence and explains its relationship to the approved goal. Dismiss it and replay the same events: it does not return unchanged. Introduce genuinely new evidence and verify a new, linked proposal can appear. An inactive project is not labelled stalled.

## In scope

Observation processing, candidate deduplication, proposal prioritisation, feedback, cooldowns and digest integration. Suggestions are not authorised missions. Autonomous execution remains deferred to S08.

## Execution sequence

1. Add normalised observation records for existing source revisions, calendar snapshots, commitment transitions and mission outcomes. Use host-recorded event IDs and provenance. Do not add speculative email/Drive connectors to obtain more triggers.
2. Implement deterministic candidate filters before invoking a model: an approaching confirmed due date, an unresolved recorded dependency, a decision overdue for review, or absence of observed updates beyond an owner-approved interval. State “no progress observed in connected sources”, not “no work has happened”.
3. Give the coordinator a bounded batch of candidates with current approved goals and existing open proposals. It may recommend acting, waiting, stopping or asking a question. It must include evidence, uncertainty, effort/benefit assumptions and what the action would displace.
4. Store a `ProposalRevision` with a semantic deduplication key based on rule, target, relevant evidence and proposed action class. Keep the key stable across incidental wording changes. A proposal references the source versions that justified it and can become stale.
5. Add exact owner accept/defer/dismiss operations. Accepting a bounded research work order can authorise the corresponding S05/S06 mission after current policy checks. A vague idea becomes a clarified proposal, not an automatically executed mission. Deferral stores a review time; dismissal stores a reason and suppresses repetition without material new evidence.
6. Add a small notification budget and digest routing. Default to a small number of recommendations, not a minimum quota. Urgent interruption requires an explicit deterministic rule in the approved configuration. Suggestions should never repeatedly wake the user because the model rewrote them.
7. Record feedback metrics: accepted, dismissed, deferred, useful/not useful, review effort and repeated noise. Use feedback to propose preference changes. Do not silently rewrite the charter, goals, source-access policy or autonomy permissions.

## Proposal contract

Each proposal includes purpose, supporting goal/project, evidence references, confidence/uncertainty, expected benefit, estimated effort with assumptions, opportunity cost, proposed work order, permission requirements, status, deduplication key and review/expiry time.

A proposed task does not enter the commitment register until confirmed. A recommendation to stop a project does not deactivate it. A stale proposal cannot be accepted against a materially changed context without revalidation and a revised preview.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S07-T01 | Repeated source events and wording changes do not create repeated equivalent proposals. |
| S07-T02 | Inactive/exploratory projects are not treated as overdue commitments. |
| S07-T03 | Dismiss/defer suppresses reappearance until the defined change/review condition. |
| S07-T04 | Acceptance of a precise proposal creates one authorised mission; a suggestion alone creates none. |
| S07-T05 | Stale or revoked supporting evidence blocks acceptance/publication. |
| S07-T06 | Quiet hours and notification budgets hold under an event storm. |
| S07-T07 | Malicious observation content cannot modify rules, priorities or tool permissions. |
| S07-T08 | No connected-source update is described as missing observation, not proof of inactivity. |
| S07-T09 | Feedback cannot quietly change the user's approved goals. |
| S07-T10 | Candidate evaluation and retries respect bounded batches, model calls and deadlines. |

## External PostgreSQL requirements for this slice

Proposals, suppression keys and owner feedback stay authoritative in external PostgreSQL. A disconnected database must not cause fallback to an empty proposal history and renewed notifications. Acknowledge acceptance/dismissal only once its transaction is confirmed, or report the existing request as unresolved.

| ID | Additional required red → green behaviour |
|---|---|
| S07-PG01 | A partition and lost dismissal acknowledgement cannot reintroduce a dismissed suggestion or launch an unconfirmed accepted proposal. |

## Acceptance gate

Replay a synthetic week containing meaningful changes, routine churn, source outages and dismissed ideas. Show the resulting proposal history and digest. All safety/deduplication tests pass. Have the operator judge a small labelled proposal set and record false positives; do not call the system useful merely because it generated proposals.

## Rollback

Pause candidate generation and proposal notifications. Preserve owner dispositions and existing authorised missions. Do not convert previously proposed work into executable tasks on restart.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S07 --db-profile <selected-profile>` and `pnpm cos:demo --slice S07 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S07.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

