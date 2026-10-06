# Chief of Staff for NanoClaw — ordered vertical-slice plans

**Target:** `ufJmacca/nanoclaw`, v2 fork.  
**Baseline:** `1a432912c00d96abf6c39cd19b1a312631d78a9c` (`package.json` 2.0.25).  
**Status:** planning specification retained; [S01–S11 implementation and protected Pi acceptance](../chief-of-staff/evidence/S11_MERGED.md) are verified. Final closure awaits the date-dependent fixture correction's human merge and merged-source acceptance. Live account/model activation remains separately gated.\
**Date:** 29 September 2026.  
**Plan revision:** 5 — GitHub-pinned source sync, Mac-tested images delivered to the Pi, external PostgreSQL, and Mattermost-first interaction.

## What this package builds

A chief-of-staff capability inside the existing NanoClaw fork: persistent direction and work records, evidence-backed knowledge, a calendar-aware daily brief, isolated specialist missions, proactive proposals, bounded standing mandates, exact-action approvals, strategic review and recovery controls.

Use NanoClaw's runtime, providers, messaging, container lifecycle, scheduling and approval UI. Add TypeScript host modules and connect to an existing PostgreSQL server on a different machine on the same private network, with connection settings supplied through the NanoClaw host-service environment. Keep NanoClaw SQLite and source/artifact files local. Do not add a PostgreSQL server/container/volume on the NanoClaw host. Do not build another general-purpose agent runtime or assume any other prior project exists.

## Delivery and interaction decisions

**Mac = development/build; Pi = always-on runtime; separate LAN machine = PostgreSQL.** S01 introduces a minimal image release path alongside the first useful CoS flow; no extra platform phase or second orchestrator is added. Later slices run the same path. Transfer the exact tested host-release carrier and agent images, not a working checkout. The Pi extracts the prebuilt host payload for its existing service and runs matching baked-code agent images; it performs no dependency installs or image builds. Database migrations and deployments stay pre-authorised after the local gates.

**One private Mattermost channel is the first CoS interface.** The owner chats, reviews briefs, approves exact proposals and inspects/cancels work there. Workers remain internal. Threads are presentation only, not session isolation. Telegram stays separate and is an optional future CoS surface; no new web/mobile interface is required. A live channel is configured only using already authorised credentials; fixtures allow implementation without assuming activation.

## Read and execute in this order

First read [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [interaction model](INTERACTION_MODEL.md), [repository baseline](REPOSITORY_BASELINE.md), [shared architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md) and [the execution goal](GOAL.md). Then execute the numbered slices sequentially under the same persistent goal. Every slice ends in a user-visible demonstration, tests, an acceptance receipt, a PR and a review gate.

| Order | Plan | What becomes usable |
|---|---|---|
| 1 | [S01 — First use and priorities](01_FIRST_USE_AND_PRIORITIES.md) | Approve direction and ask what matters, with durable records. |
| 2 | [S02 — Grounded knowledge](02_GROUNDED_KNOWLEDGE.md) | Import selected notes, answer with citations, correct and revoke evidence. |
| 3 | [S03 — Calendar awareness](03_CALENDAR_AWARENESS.md) | Read an approved calendar and show freshness/coverage. |
| 4 | [S04 — Daily brief and commitments](04_DAILY_BRIEF_AND_COMMITMENTS.md) | Receive scheduled briefs and track confirmed follow-ups. |
| 5 | [S05 — Isolated research missions](05_ISOLATED_RESEARCH_MISSIONS.md) | Delegate a bounded assignment, inspect it and cancel it. |
| 6 | [S06 — Specialist teams and review](06_SPECIALIST_TEAMS_AND_REVIEW.md) | Coordinate bounded parallel analysis and a reviewed recommendation. |
| 7 | [S07 — Proactive proposals](07_PROACTIVE_PROPOSALS.md) | Surface useful work without silently creating commitments or repeated noise. |
| 8 | [S08 — Standing mandates](08_STANDING_MANDATES.md) | Perform approved read-only/preparation work autonomously. |
| 9 | [S09 — Approved calendar actions](09_APPROVED_CALENDAR_ACTIONS.md) | Preview, approve, execute and verify one exact external effect. |
| 10 | [S10 — Strategic reviews](10_STRATEGIC_REVIEWS.md) | Compare activity with outcomes and propose changes for the owner to decide. |
| 11 | [S11 — Operations and recovery](11_OPERATIONS_AND_RECOVERY.md) | Inspect, pause, export, restore and operate the full capability. |

There are no independent horizontal “database”, “API” or “agent framework” delivery phases. Each slice includes the smallest changes across all layers necessary for that outcome. S01 carries more enabling work because it establishes the first complete path; later slices must not use that as an excuse to prebuild all future infrastructure.

## Important baseline corrections

The code inspection changed three integration assumptions from the discussion:

- Native A2A routes into an agent-shared session and deliberately blocks cross-agent routes involving Mattermost-owned groups. S05 adds a narrowly approved host dispatch boundary; it does not disable those protections.
- Separate sessions still share writable group memory/provider state. Every specialist attempt receives a fresh execution AgentGroup, session and workspace, while its specialist template remains reusable.
- Existing approval cards and handlers are useful, but pending UI rows are not a durable action ledger. S01 hardens correlation and decision handling; S09 adds external effect receipts and reconciliation.

See [the inspected source references](REPOSITORY_BASELINE.md). The running host/configuration has not been audited; S01 must revalidate it.

## How to use the files

1. After this planning PR is merged, fetch the fork on the Mac and use `docs/chief-of-staff-plans/00_START_HERE.md`. Alternatively extract the matching archive into `docs/`, comparing existing plan edits before replacement.
2. Open the coding-agent session at the **NanoClaw repository root on your Mac**. The Pi is only the deployment/runtime target, not the development checkout or coding-session host.
3. Set the coding agent's goal using [BOOTSTRAP_PROMPT.md](BOOTSTRAP_PROMPT.md). [GOAL.md](GOAL.md) defines the complete programme, not a single `TARGET_SLICE`. The agent discovers and resumes the earliest eligible unfinished slice.
4. Review each resulting PR and its evidence. Once an authorised merge is verified, the same running goal advances automatically. At a pending review it checkpoints; resume the same goal after the gate clears if the tool is no longer running. No slice-specific prompt edits are required.

The archive includes `EXECUTION_STATE.json` as a **v5 template**. Keep an active local copy at `.cos-plan-state/execution.json`, excluded from Git, and keep sanitised reviewed receipts in `docs/chief-of-staff/evidence/`. Preserve existing progress and upgrade older ledgers additively; never overwrite one with the blank template. Replace only the planning files after checking for your own edits when installing this bundle revision. Do not commit production task state, personal knowledge or credentials into this public fork.

## Execution and review rules

One slice branch and one independently reviewable PR at a time. Within a slice, iterate red → green → refactor in small commits. Do not begin a dependent slice until its predecessor is merged. An interrupted agent resumes from existing branch/tests/receipts rather than starting over.

The owner has declared all CoS database content disposable until every slice is implemented and has **pre-authorised live CoS migrations and deployments on the bound Raspberry Pi from the Mac release workflow**. The goal executes scoped migrations, tested releases, service restarts, health checks and safe rollbacks without an extra human review or confirmation prompt. This includes a tested candidate deployment before its PR is reviewed; human PR review/merge and dependency gates still apply. See [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md).

All development and mandatory local tests run on the Mac with synthetic data, fixture channels/models/connectors, real external PostgreSQL and Mac-isolated SQLite. Final Linux/ARM64 image tests run in the Mac-local Docker engine; Pi-native smoke/isolation tests follow artifact transfer. A separate `COS_TEST_PG*` target is optional during implementation: the goal can explicitly select guarded `runtime-disposable` against the configured external database after verifying Pi-owned disposal status and quiescing the Pi CoS under a cross-host target lease. The Mac test process needs its own securely supplied connection profile; no Pi secret copying is implied. No local PostgreSQL provisioning or silent profile fallback is allowed. Missing all eligible targets blocks integration acceptance; missing a second database alone does not.

Existing NanoClaw messages, SQLite databases, sessions and credentials are not disposable. Deployment preserves them and includes consistent backups where affected. Real account connections, messages, model charges and application-level external effects retain their existing approval rules; absence of account consent must not become a deployment-approval blocker. After all slices satisfy their implementation gates, the goal automatically marks data protected before valuable content is admitted.

The operator/database administrator supplies the external server, database, roles and network access. The implementation adds bounded client preflight and explicit migrations scoped to `cos`; it never administers the server. Runtime and migration credentials stay in their respective host process environments. Use an admitted separate test target or the explicitly selected guarded disposable runtime target, with isolated local data roots. The pinned baseline is a reference, not an instruction to reset your checkout or discard changes.

## Deliberate limits

The initial source importer handles Markdown/text. Google Calendar is the chosen first real external adapter and can remain disconnected. Initial external writes are only ordinary no-attendee calendar blocks after exact approval. Email/Drive connectors, binary document parsing, cross-domain federation, automatic email sending, deployment of unrelated software/products, arbitrary computer control, public dashboards and unrestricted autonomous agents are not hidden requirements of this sequence.

The connector, source and action contracts are extension points for those later features. This first programme proves the core chief-of-staff loop end to end before expanding access.

## Files used by every slice

[Architecture and contracts](ARCHITECTURE_AND_CONTRACTS.md) define state ownership, authority, RPC, mission isolation, approvals, replay and testing. [Acceptance matrix](ACCEPTANCE_MATRIX.md) maps requirements to slices and release gates. [External PostgreSQL](EXTERNAL_POSTGRES.md) and [environment example](POSTGRES_ENV.example) define networked storage and host credential handling. [Implementation authority](IMPLEMENTATION_AUTHORITY.md) defines automatic migrations/deployment, disposable data and the protected-data transition. [Goal](GOAL.md) and [goal bootstrap](BOOTSTRAP_PROMPT.md) define checkpointing, automatic slice selection, target operations and PR-review-gated continuation. [Revision notes](REVISION_NOTES.md) explain how to adopt this update. [Repository baseline](REPOSITORY_BASELINE.md) separates inspected code from proposed additions.

[Delivery contract](MAC_TO_PI_DELIVERY.md), [interaction contract](INTERACTION_MODEL.md) and [deployment environment example](DEPLOYMENT_ENV.example) are shared requirements for every slice. The active coding ledger stays on the Mac; authoritative deployment and disposal records stay on the Pi.

## GitHub source sync in revision 5

[GitHub source synchronisation](GITHUB_SOURCE_SYNC.md) is mandatory for every release. The Mac pushes a candidate commit; the Pi fetches and prepares a detached reference checkout of that exact commit. Source, tested images and the manifest must agree before activation. Fetching a branch does not deploy it. No unattended `git pull`, Pi-side build or checkout-source override is permitted. This is a plans-only PR based on the fork's existing main; application implementation remains not started.
