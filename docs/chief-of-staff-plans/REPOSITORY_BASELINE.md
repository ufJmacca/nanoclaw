# Repository baseline and integration corrections

**Repository:** `ufJmacca/nanoclaw`  
**Detailed historical inspection:** `main` at `1a432912c00d96abf6c39cd19b1a312631d78a9c`, package 2.0.25.  
**Plan publication base:** `main` at `dea16302f904ef57cf10e91b687a289d76c149f8`, observed 29 September 2026.  
**Plan revision:** 5. Source reads used the GitHub connector. No application build/test, live machine audit, database migration or deployment is claimed by these planning files.

The publication base preserves intervening changes, including PR #52. It is not a new full audit of the runtime. Revalidate integration against the actual Mac checkout/Pi configuration in S01; do not reset to the historical reference. No existing plan directory or open PR was found during initial publication preflight. This contribution adds documentation only.

## Inspected integration points

All source links below are pinned to the detailed inspection, not mutable main.

| ID | Source | Observation and consequence |
|---|---|---|
| R01 | [package.json](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/package.json) | TypeScript/ESM, pnpm and test/lint/type/build scripts. Keep implementation in this fork, not Python/new framework. |
| R02 | [module registration](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/index.ts) | Native approval/interactive/scheduling/permissions/A2A/self-mod imports; add feature-gated CoS through registration. |
| R03 | [delivery](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/delivery.ts) | registerDeliveryAction receives real session and host inbound DB. Add typed RPC, preserve single-writer ownership. |
| R04 | [agent routing](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/agent-to-agent/agent-route.ts) | Routes to agent-shared and blocks Mattermost cross-agent traffic. New scoped host mission dispatch must not relax this. |
| R05 | [container runner](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts) | Group folder/provider state shared writable across sessions; non-strict contexts may receive global memory. Use fresh execution group per attempt, not merely new session. |
| R06 | [wake/admission](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts) | Native identity/capacity/reservation-aware wake may return false for deferral. Reuse it; false is not completion. |
| R07 | [approval primitive](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/approvals/primitive.ts) | requestApproval/registerApprovalHandler; Approve/Reject; internally generated correlation. Extend backward-compatibly, not invent third button. |
| R08 | [approval response](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/modules/approvals/response-handler.ts) | Pending row deleted after handler, including caught error. UI state is not durable success receipt; CoS needs its own decision/effect ledger. |
| R09 | [host sweep](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/host-sweep.ts) | Native ack/due/recovery/recurrence machinery; reuse with bounded CoS reconciliation, distinguishing transport and logical retries. |
| R10 | [MCP bootstrap](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/src/mcp-tools/server.ts) and [core](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/src/mcp-tools/core.ts) | registerTools and outbound queue; a tool can say sent before actual delivery. CoS must distinguish queued/pending/verified. |
| R11 | [runner package](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/agent-runner/package.json) | Bun tests, TypeScript, MCP SDK/Zod; host tests alone do not cover runner. |
| R12 | [runner mounts](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/container-runner.ts) | Existing research integration and composed CLAUDE.md/CLAUDE.local.md. Preserve actual behaviour rather than assuming old AGENT.md docs. |
| R13 | [Dockerfile](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/container/Dockerfile) | Current image omits runner source; builds alone do not deliver host/module changes. New release packages matching host and baked-code workers. |
| R14 | [Mattermost subscription](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-subscription.ts) and [adapter](https://github.com/ufJmacca/nanoclaw/blob/1a432912c00d96abf6c39cd19b1a312631d78a9c/src/channels/mattermost-adapter.ts) | Strict exclusive channel/shared-session model. Threads are not separate mission context; verify actual callbacks before relying on rich controls. |

These observations are not a complete security audit. Inspecting one approval handler does not establish every upstream check or prove a vulnerability. Tests must trace end-to-end identity and execution behaviour.

## Design corrections carried forward

Specialist template is not execution identity. Native A2A is not the mission dispatcher. Pending approval cards are not durable effect receipts. Queued is not delivered, model-finished is not verified, hidden tools are not permissions, and read-only mounts can still leak data. Mac-tested image deployment requires eliminating stale source overrides. Source fetch must pin the tested commit rather than run latest main.

## Implementation references

Verify current official [Google Events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list), [insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert) and [OAuth scopes](https://developers.google.com/workspace/calendar/api/auth) in S03/S09. Initial calendar algorithm is bounded snapshots, not an assumed incremental-token contract. Caller event IDs require provider-compatible format and read-back reconciliation, not blanket exactly-once claims.

External DB, Docker and Git primary references are recorded in EXTERNAL_POSTGRES.md, MAC_TO_PI_DELIVERY.md and GITHUB_SOURCE_SYNC.md. Earlier general sync-guide retrieval was incomplete; no unverified Google sync-token algorithm is assumed.

## S01 revalidation record

Record actual Mac base SHA/dirty work, package conventions, local builder, providers, selected private channel, module loading, approval identity, schema migration and recurrence encoding, effective mount/env/egress construction, source repository, Pi service/platform/runtime roots/profile inventory and existing relevant tests. Use secret-free metadata and fixtures. Do not publish production messages, environment dumps, credentials or private endpoints.
