# Repository baseline and integration corrections

**Repository:** `ufJmacca/nanoclaw`  
**Inspected branch:** `main`  
**Pinned commit:** `1a432912c00d96abf6c39cd19b1a312631d78a9c`  
**Plan prepared:** 28 September 2026  
**Manifest version:** `2.0.25`  
**Inspection:** source reads through the GitHub connector; no checkout, build, test execution, deployment inspection, or repository mutation was performed while preparing these plans.

The running installation may differ from this commit. S01 records its actual revision and configuration before implementation. Rebase the plans onto the current checkout when necessary; do not reset a deployment to this SHA. Existing documentation and type declarations are not substitutes for executable behaviour.

## Verified integration points

| ID | Inspected source | Relevant observation | Design consequence |
|---|---|---|---|
| R01 | [package.json](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/package.json) | TypeScript/ESM host; pnpm 10.33.0; Vitest, lint, typecheck, format and build scripts. | Implement the CoS host module in TypeScript in this repository. Do not introduce a Python service or another agent framework. |
| R02 | [modules/index.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/index.ts) | Imports approval, interactive, scheduling, permissions, agent-to-agent and self-mod modules. | Add a feature-gated CoS module through the established registration approach. |
| R03 | [delivery.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/delivery.ts) | `registerDeliveryAction` accepts host handlers with the actual session and host-owned inbound DB. Delivery tracking is separate from the container-owned outbound DB. | Use a narrow `cos_rpc` delivery action. Never give an agent PostgreSQL credentials. |
| R04 | [agent-route.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/agent-to-agent/agent-route.ts) | Native agent routing resolves the target with `agent-shared`; cross-agent routes involving Mattermost-owned groups are rejected. | Native messaging is not a per-mission dispatcher. Introduce a separately authorised CoS dispatch boundary without relaxing native routing rules. |
| R05 | [container-runner.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts#L690-L793) | Session workspace is separate, but the agent-group folder and `.claude-shared` state are shared and writable. Non-strict-Mattermost containers may receive global memory. | A new session alone does not provide complete mission isolation. Allocate a distinct execution AgentGroup per attempt, with an immutable specialist template. Deny inherited global/private mounts. |
| R06 | [container-runner.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts#L1-L250) | `wakeContainer` tracks immutable execution identities, capacity reservations and queued wakes. It can return false for deferral or transient failure. | Reuse it; do not interpret false as mission completion or build another container scheduler. |
| R07 | [approvals/index.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/approvals/index.ts) and [primitive.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/approvals/primitive.ts) | Public `requestApproval` / `registerApprovalHandler`; approval card is Approve/Reject. Request API currently returns void and generates IDs internally. | Reuse the UI, with a backward-compatible durable correlation extension. “Modify” means create a revised proposal, not an existing third button. |
| R08 | [approval response-handler.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/approvals/response-handler.ts) | Generic handler dispatches and then deletes the pending row, including after a caught handler error. | Pending rows are not a durable action ledger. CoS must persist decisions and effect receipts separately, and acknowledge UI responses only after durable acceptance. |
| R09 | [host-sweep.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/host-sweep.ts) | Processes acknowledgements, due work, container recovery and native recurrence. | Reuse native wake/recurrence. Add only bounded CoS reconciliation; distinguish transport retries from mission attempts. |
| R10 | [MCP server.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/src/mcp-tools/server.ts) and [core.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/src/mcp-tools/core.ts) | Tools register through `registerTools`; outbound calls write to the container-owned queue. A tool can say “sent” before remote delivery is confirmed. | CoS tools must return queued/pending/verified states accurately; tool visibility is not permission enforcement. |
| R11 | [runner package.json](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/package.json) | Runner uses Bun tests, TypeScript checks, MCP SDK and Zod. | Test the host and the container bridge; root Vitest alone is not enough. |
| R12 | [container mount code](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts#L690-L793) and [package.json](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/package.json) | Existing deep-research workflow integration is present. Current mount code composes `CLAUDE.md` and keeps `CLAUDE.local.md` writable. | Preserve existing research behaviour. Do not assume the older `AGENT.md` description is the active memory implementation. Adapt to the actual provider/memory composer. |

## Corrections to the earlier conversational design

1. **Specialist definition is not execution identity.** Templates are persistent. Every mission attempt gets a new execution group, session, writable directory and provider state. A group shared by many sessions is not the isolation guarantee required here.
2. **Mattermost delegation is a new capability.** Keep native cross-agent prohibitions intact. An operator-approved CoS boundary may dispatch a minimal work order into a child execution identity in the same privacy scope. It must not export channel history or bypass subscription checks.
3. **Approval UI is reusable; action durability is new.** The generic callback flow needs safe correlation, identity validation and recovery integration. CoS stores the exact proposal revision and execution receipt. It does not introduce a competing user-facing approval inbox.
4. **Queued is not delivered; model-finished is not mission-verified.** Name and test these states separately.
5. **A skill is guidance, not authority.** All permissions must be enforced by host code, including forged queue rows and attempts to use existing self-mod, scheduling, messaging or shell paths.

These observations are not a complete security audit. For example, reading the approval handler alone does not establish every upstream identity check. The plans require end-to-end checks rather than claim a confirmed vulnerability.

## Public API references for the optional calendar slices

- [Google Calendar Events: insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert): inspected. Supports caller-supplied event IDs and documents their format; IDs alone are not a blanket exactly-once guarantee. The plan adds read-back reconciliation and rejects guests in its initial action profile.
- [Google Calendar Events: list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list): implementation reference; re-read before coding. S03 deliberately uses bounded, paginated snapshots, not an unverified incremental-token algorithm.
- [Google Calendar OAuth scopes](https://developers.google.com/workspace/calendar/api/auth): implementation reference; verify the minimum scopes at implementation time.
- [PostgreSQL 17 SELECT / locking clauses](https://www.postgresql.org/docs/17/sql-select.html): inspected. Queue-consumer locking is available, but it does not create a transaction across PostgreSQL, SQLite and an external service.

Some general Google sync-guide fetches failed during research. No current sync-token contract is assumed by these plans. The calendar implementation gate must verify its selected API and OAuth flow against current primary documentation.

## Local revalidation record required by S01

Record actual base SHA, dirty-worktree status, root/runner package managers, runtime providers, selected private channel, CoS-disabled startup behaviour, existing relevant test results, module loading, approval identity path, database migration conventions, native recurrence encoding and container mount construction. Keep this synthetic and secret-free. Never copy production messages, credentials or environment dumps into a public PR.


## Plan revision 2 — deployment constraint, not a new repository inspection

The operator now requires PostgreSQL to run on a separate machine on the same network and connection credentials to be supplied through host environment variables. [EXTERNAL_POSTGRES.md](EXTERNAL_POSTGRES.md) is the new binding deployment contract. [GOAL.md](GOAL.md) replaces per-slice prompting with a persistent, review-gated objective. These are planning changes; the pinned source observations above have not been re-audited and no running database or deployment has been inspected in this revision.

S01 must additionally revalidate host-to-provider/helper environment construction. Exclude all database environment keys and secret values before any agent launch, not only before CoS worker launch. Record remote-server compatibility and test-target checks through redacted tooling, not environment dumps.

## Revision 3 implementation authority (not a source-code finding)

The owner subsequently declared the configured CoS database disposable until S01–S11 are implemented and pre-authorised live CoS migrations and deployment/restart/rollback on the designated NanoClaw machine. See [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md). This changes the plans' execution gates, not the source inspection above. Do not re-audit or modify remote infrastructure merely to adopt this policy. Native NanoClaw local data remains protected and code PR merge requirements are unchanged. No new repository, database or deployment operations were executed while revising the documents.

## Revision 4 source revalidation — 29 September 2026

The GitHub connector still reports `main` at `1a432912c00d96abf6c39cd19b1a312631d78a9c`. Additional reads for this revision:

| ID | Source | Verified observation and consequence |
|---|---|---|
| R13 | [container/Dockerfile](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/Dockerfile) | Source is explicitly not baked into the current agent image. Add a tested baked-code release variant; image transfer alone does not currently deploy source changes. |
| R14 | [container-runner.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts) | Per-group dependency images may be built by the host. Pi release mode must resolve prebuilt profiles and block rather than build an unavailable profile. |
| R15 | [mattermost.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost.ts) | Native Mattermost registration exists and uses host-side configuration. This does not establish a connected live account. |
| R16 | [mattermost-adapter.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-adapter.ts) | Adapter declares thread support and recovery; do not confuse presentation support with independent session routing. |
| R17 | [mattermost-subscription.ts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-subscription.ts) | Strict channel mapping sets shared mode and rejects threaded session identity. Initial CoS uses one private channel/coordinator, with separate host-dispatched worker attempts. |

The Mac architecture/tooling, Pi OS/service/runtime configuration, SSH reachability, environment and account status remain uninspected. Verify them during S01; do not infer success from these source reads. The new delivery/interaction documents contain the primary Docker references used for the proposed build and transfer mechanics.

## Revision 5 publication baseline

This plans-only PR is based on `main` at `dea16302f904ef57cf10e91b687a289d76c149f8`, observed through the GitHub connector on 29 September 2026. The earlier detailed implementation inspection remains pinned to `1a432912c00d96abf6c39cd19b1a312631d78a9c`; this publication does not claim a new application audit or test run. Preserve current main, including its intervening changes, and revalidate code against the actual checkout in S01. No open PR or existing `docs/chief-of-staff-plans/` directory was found at publication preflight. The source-synchronisation contract is a proposed addition, not an existing deployment capability.
