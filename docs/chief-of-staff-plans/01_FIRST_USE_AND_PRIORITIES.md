# S01 — Capture direction and answer “what matters?”

**Status:** not started  
**Branch:** `cos/s01-first-use-and-priorities`  
**Depends on:** none; first slice.  
**Delivery unit:** one independently reviewable PR, multiple red–green commits.  
**User-visible outcome:** approve a small charter, goal and project in the private NanoClaw conversation, then receive a persistent, explainable priority brief.

Read and follow [shared execution rules](SLICE_EXECUTION_RULES.md) and their referenced contracts. All common deployment, identity, testing, receipt and rollback requirements apply now, not at S11.

## Demonstration

In a fixture conversation: “My goal is to launch a pilot. The active project is Pilot Alpha. Reliability is more important than adding features.” The assistant proposes exact charter/goal/project changes. The authenticated owner approves. Ask “What should I focus on?” and receive an answer linked to approved records. Restart the host and ask again: records survive on external PostgreSQL, while unapproved suggestions remain suggestions. Interrupt the harness DB connection; CoS becomes unavailable without breaking unrelated chat. Reconnect and recover without duplicate records.

## Scope

Feature-gated TypeScript host module, private scope binding, minimal PostgreSQL store, safe RPC, exact approval of internal changes and on-demand priorities. One persistent coordinator; no source scanning, calendar account, autonomous runs or external writes. Establish the first Mac-built/Pi-deployed vertical release alongside this flow.

## Implementation sequence

1. Revalidate actual Mac checkout, repository instructions, base SHA, existing test results, local builder, module/MCP registration, providers and approval identity path. Use read-only authorised Pi preflight to discover service, ARM64 platform and data roots. Preserve uncommitted work and existing deep research.
2. Implement the `COS_PG*` adapter, bounded shared `pg` pool, redacted diagnostics and explicit migration commands from EXTERNAL_POSTGRES.md. The existing LAN server/database/roles are supplied, not installed here. Add only scoped bindings, charter revisions, goals, projects, proposals, events, RPC operation receipts, approvals/effect receipts and transactional outbox tables in `cos`. Migrations are checksummed, locked and transactional; daemon startup only checks compatibility. Handle idle-pool errors, queue/connect/query deadlines and ambiguous commit acknowledgement.
3. Bind one suitable private Mattermost channel to a dedicated CoS coordinator. Fixture transport runs on Mac; real binding is on Pi. Verify single-operator identity and strict subscription rules. Do not repurpose a multi-user/cross-channel group or import old group/global memory/history implicitly. Shared system boilerplate must contain no private foreign context.
4. Implement `cos-rpc/v1`, `cos_context_get`, `cos_change_propose` and operation-status lookup through container MCP and host delivery registration. Container writes only its outbound queue; host replies in a host-owned response table in inbound.db. Validate schemas and correlation at both ends, bound waits/payloads and keep replies out of ordinary chat/model wakeups.
5. Enforce restricted identities at host execution and delivery boundaries, including forged queue rows. No self-mod, arbitrary A2A/create-agent, unrestricted scheduling, generic account credentials or broad mounts. Hidden tools alone are not enforcement. Disabling CoS or losing PostgreSQL must not make these identities unrestricted.
6. Extend native approvals backward-compatibly for stable CoS correlation, exact owner/private destination, expiry and resource version. Persist the proposal before its preview. Persist acceptance/rejection before acknowledging the UI row; apply an approved internal revision transactionally once. Recover commit/UI-ack gaps. Preserve existing non-CoS approval behaviour.
7. Return approved goals/projects/constraints, record IDs, freshness/coverage and an honest empty state. Model ranking is advice; it cannot create priorities. A deterministic fixture renderer is labelled as a fixture, not a live-model result.
8. Add the common test/demo/admin/release/deploy commands. Explicitly select external test or guarded runtime-disposable profiles. Introduce local ARM64 host-carrier and baked-code worker builds, image tests, pinned GitHub source verification, SSH delivery, Pi-env migrations, existing-service activation, native smoke and compatible rollback. Inventory assets and disable on-Pi per-group builds in release mode. Preserve stable runtime data roots.

## Tools

`cos_change_propose` accepts charter revision, goal/project create or versioned edit, reason and expected versions. It cannot approve/apply. Bound text sizes and record active/inactive state and provenance. `cos_context_get(view='today')` returns approved direction and source IDs; commitment inference is not part of S01. Reused request IDs with changed payload conflict. Exact retries return the original durable operation result.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S01-T01 | Disabled module starts without PostgreSQL and exposes no CoS tools. |
| S01-T02 | Proposed goal is absent from authoritative priorities until the correct owner approves. |
| S01-T03 | Duplicate request/click applies once; changed payload under reused ID conflicts. |
| S01-T04 | Spoofed user/scope/session, wrong approver and stale ingress cannot authorise change. |
| S01-T05 | Commit-before-SQLite/UI-ack crash returns the original result on recovery. |
| S01-T06 | Stale expected version cannot overwrite a later decision. |
| S01-T07 | Database outage blocks CoS effects without blocking ordinary NanoClaw chat. |
| S01-T08 | Forged native self-mod/create-agent/schedule/destination rows are denied for CoS identities. |
| S01-T09 | Protocol mismatch and timeout return bounded error/pending state, not false success. |
| S01-T10 | Secrets and real content are absent from generated config, logs and fixtures. |
| S01-PG01 | Invalid/missing env fails closed; disabled mode has no localhost/ambient PG fallback. |
| S01-PG02 | Test target marker or runtime-disposable binding/lifecycle/lease/quiescence is required; protected/foreign targets refuse destructive fixtures. |
| S01-PG03 | Valid TLS works; unknown CA, expired certificate, hostname mismatch and unapproved plaintext fail without downgrade. |
| S01-PG04 | Partition, refusal, exhausted pool and idle-client errors are bounded and isolated. |
| S01-PG05 | Lost commit ack resolves once, including retry racing the original transaction. |
| S01-PG06 | Runtime/test/migration secret canaries are absent from every agent/provider/helper environment, mount, tool result and log. |
| S01-PG07 | Daemon cannot run DDL; explicit migration uses its role/checksum/lock and preserves foreign schemas. |
| S01-OPS01 | A bound, tested scoped migration executes under existing operational approval and records evidence. |
| S01-OPS02 | Tested target deployment/restart checks health and performs compatible rollback or keeps unsafe admission closed. |
| S01-OPS03 | Explicit eligible runtime-disposable profile works without a second DB; partial/invalid config cannot silently switch. |
| S01-OPS04 | Deployment preserves protected SQLite/sessions/credentials and rejects foreign targets and runtime-agent admin requests. |
| S01-OPS05 | Protected lifecycle or unresolved real effects prevent disposable cleanup despite a stale ledger. |

Also implement S01-REL01–S01-REL12 in MAC_TO_PI_DELIVERY.md, S01-REL13–S01-REL18 in GITHUB_SOURCE_SYNC.md, and S01-UI01–S01-UI08 in INTERACTION_MODEL.md. These are part of this first slice's acceptance, not later work.

## Acceptance and rollback

Complete the fixture conversation through the real host/container bridge, local SQLite and eligible external PostgreSQL. Demonstrate one unchanged legacy approval and unrelated chat flow. Package/test the exact ARM64 release locally, verify its pinned source and deploy/smoke-test on the Pi under existing authority. Live model/channel activation is separately recorded, not fabricated. Rich callbacks are optional; the tested deterministic host-text confirmation path is sufficient.

Disable CoS admission/feature while retaining restrictions and all protected state. No volume removal or full-database reset. Scoped disposable cleanup remains subject to lifecycle/effect checks and cannot replace recovery tests.

## Handover

Execute all commands and record all evidence required by SLICE_EXECUTION_RULES.md. Receipt: `docs/chief-of-staff/evidence/S01.md`. Include actual source/tree/image IDs, source sync, DB profile and recovery, Pi deployment/health, migration checksums and readiness limits. Checkpoint the same goal at PR review; after a verified human merge select S02 automatically. None of these proposed commands is installed by this document.
