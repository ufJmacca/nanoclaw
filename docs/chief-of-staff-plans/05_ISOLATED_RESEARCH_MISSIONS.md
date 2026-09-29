# S05 — Delegate one bounded research mission safely

**Status:** not started  
**Repository:** `ufJmacca/nanoclaw`  
**Branch:** `cos/s05-isolated-research-missions`  
**Depends on:** S04 merged, with its acceptance receipt available.  
**Delivery unit:** one independently reviewable PR; multiple red–green commits are expected.  
**User-visible outcome:** You request research, receive a mission ID immediately, and later receive a reviewed answer from an isolated specialist.

Read [START HERE](00_START_HERE.md), [architecture/contracts](ARCHITECTURE_AND_CONTRACTS.md), [external PostgreSQL](EXTERNAL_POSTGRES.md), [goal execution](GOAL.md), [Mac-to-Pi delivery](MAC_TO_PI_DELIVERY.md), [Mattermost interaction](INTERACTION_MODEL.md), [implementation authority](IMPLEMENTATION_AUTHORITY.md), and [baseline](REPOSITORY_BASELINE.md) before implementation. This plan inherits their identity, scope, replay, approval, budget and retention rules; none may be postponed to S11.

## Demonstration

Ask “Compare the alternatives in these admitted notes and recommend an approach for Pilot Alpha.” The coordinator proposes a bounded work order. Under the exact user approval, a researcher runs with only those source revisions. You can inspect progress and cancel. A valid result returns to the originating private context for review. Repeat with two missions containing distinct synthetic canaries: neither can observe the other's prompt, files, provider state or source access.

## Critical integration correction

Do not implement this as ordinary `send_message(to='researcher')`. The inspected native route uses an agent-shared session and blocks Mattermost cross-agent routing [R04]. Sessions also share writable group state [R05]. This slice introduces a **new, explicitly authorised CoS host dispatch path**, not a silent relaxation of existing routing restrictions.

## Execution sequence

1. Define `Mission`, `Attempt`, `TemplateVersion`, `ContextManifest`, result submission and root budget records. First mission type is read-only comparison of admitted sources; no public web or external account writes are needed. Define the state machine and allowable actor for every transition.
2. Add a versioned researcher template with constrained instructions, provider profile and tool manifest. Template editing requires operator review. Initial delegation must be expressly enabled for the private scope. A model cannot create a new template or choose a more privileged provider.
3. Add `cos_mission_request`, `cos_mission_get`, cancellation and worker-only `cos_result_submit`. Creating a proposal does not launch it. Once authorised, a PostgreSQL transaction creates a queued attempt and stable dispatch command. The RPC returns promptly with the mission ID; it does not keep the coordinator container waiting for completion.
4. Materialise a distinct execution AgentGroup and session **per attempt**. Allocate an isolated workspace, provider state and scoped gateway identity. Mount only the immutable template and admitted context. No group-global memory, shared writable skills/state, generic destinations, owner roles or broad additional mounts. Reuse native container admission/wake/kill functions.
5. Add a host-owned dispatch binding from the originating CoS scope to this child attempt. For Mattermost, require an explicit owner-approved delegation scope and revalidate origin subscription at allocation, wake, result acceptance and publication. Keep the existing native cross-agent prohibition unchanged. The child has no messaging-group binding and cannot send directly to a channel.
6. Enforce the restricted profile against native tool routes and forged outbound rows. Prevent self-modification, arbitrary scheduling, generic create-agent, direct external writes and unrestricted network egress. Confirm selected provider built-ins cannot bypass the host permission surface. If confinement cannot be verified, block delegation instead of falling back to a permissive profile.
7. Have the dispatcher write one stable input ID and call `wakeContainer`. A false wake result means pending/deferred. Persist allocation steps and recover partial groups after crashes. Native message retries stay within the same attempt; CoS alone authorises a new generation.
8. Validate result schema, artifact integrity, accessible evidence, acceptance criteria and current authority. Record a coordinator review before completion. Return partial/blocked results honestly. Do not grant a researcher authority to change the project or approve its own answer.
9. Implement inspect/cancel immediately. Cancellation revokes the generation, prevents further reads/effects/publication, requests container stop, and reconciles remaining resources. Late results may be retained as labelled evidence but cannot become successful completion. Do not reuse a cancelled group's workspace.

## Work-order contract

The immutable admitted work order includes scope, origin, related goal/project, question, deliverable schema, acceptance criteria, source revision IDs, context digest, template/provider versions, deadline and structural limits. Defaults: one worker, one active attempt, bounded turns/tool calls and bounded wall time; configure and record concrete values at setup. A hard monetary cap is available only with provider-supported enforcement, not just an agent-reported cost estimate.

## Required red tests

| ID | Behaviour that must first fail |
|---|---|
| S05-T01 | Native A2A restrictions remain intact, including Mattermost-owned groups. |
| S05-T02 | Two attempts have distinct group/session/workspace/provider/gateway identities; inspect all mounts and prompts for canaries. |
| S05-T03 | Worker cannot read other scope/source IDs or acquire owner/admin/template-edit powers. |
| S05-T04 | Forged native tools and direct network attempts cannot bypass its admitted capabilities. |
| S05-T05 | Dispatch replay allocates one identity and input ID; a deferred wake is not failure or completion. |
| S05-T06 | Crash at each allocation step is reconciled with no unowned live worker. |
| S05-T07 | Cancel/unsubscribe/revoke fences the generation and prevents late result publication. |
| S05-T08 | Invalid citations, missing deliverables or failed acceptance checks cannot complete a mission. |
| S05-T09 | Native transport retry cannot create a fresh logical attempt or reset limits. |
| S05-T10 | PostgreSQL outage and policy uncertainty fail closed for worker reads/effects. |
| S05-T11 | Coordinator is free to handle another chat while the worker runs. |
| S05-T12 | Container smoke tests confirm the selected runtime's effective filesystem/network restrictions. |

## External PostgreSQL requirements for this slice

Database access is from the NanoClaw host only. Worker profiles have neither connection variables nor a network route to the external PostgreSQL service. When the database cannot validate authority, close admission and stop/fence affected CoS workers through host-local deny-only controls; reconcile cancellations and leases before any restart.

| ID | Additional required red → green behaviour |
|---|---|
| S05-PG01 | From a real test worker, direct database TCP access and credential discovery fail even when the host can connect. |
| S05-PG02 | Database loss during worker execution prevents reads, new wakes and publication, permits a trusted local stop and leaves unrelated agents operational. |
| S05-PG03 | Reconnection preserves the attempt identity and budget; a stale worker result cannot beat the reconciled generation fence. |

## Acceptance gate

Prove request → approve → allocate → execute → submit → verify → notify, plus cancellation and crash recovery. Use a deterministic provider fixture for CI and one explicit live-provider smoke test before enabling real missions. Isolation tests must inspect concrete execution inputs and mounts; asking a model “did you see the other secret?” is insufficient.

## Rollback

Close mission admission, revoke active generations, stop their exact containers and reconcile private artifacts. Retain mission/receipt history. Do not stop unrelated NanoClaw containers or repurpose orphan directories for a new mission.

## Automatic Mac-to-Pi implementation deployment

Implement, test and build this slice **on the Mac**. Run the current slice's mandatory local flow/regressions and the final Linux/ARM64 host/agent image tests. Only then transfer the exact tested image bundle to the bound Pi as specified in [MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md). The Pi verifies/loads/extracts the prebuilt artifacts, preserves its local NanoClaw state, runs scoped migrations using its own environment, activates/restarts the service and performs native smoke checks. No source fixes, dependency installs, image builds or mutable pulls on the Pi. All in-scope migration/deployment/recovery operations remain pre-authorised; PR merge remains separate.

Use one private Mattermost CoS channel for the live user flow and fixture channel events for local tests, following [INTERACTION_MODEL.md](INTERACTION_MODEL.md). Do not run a Mac bot with the Pi's token or share CoS context across Telegram. Record live interface/account readiness separately from fixture success.

Select `--db-profile test` with explicitly supplied Mac test credentials, or guarded `--db-profile runtime-disposable` while the Pi-owned lifecycle, maintenance lease and CoS quiescence are verified. Tests still run on the Mac. A missing second DB is not a blocker when shared-target safeguards pass; missing access or failed tests is. Never transfer a failing candidate to resolve a shared-schema problem. Keep exact local-image-test, bundle, transfer, Pi migration and Pi health receipts.

## Verification, checkpoint and continuation rule

Run `pnpm cos:test --slice S05 --db-profile <selected-profile>` and `pnpm cos:demo --slice S05 --fixture --db-profile <selected-profile>` after registering this slice. These commands are introduced by S01, not pre-existing NanoClaw commands. Run the root regression commands and the runner checks from the shared contract whenever their code paths are touched. Re-run earlier CoS slice contracts affected by this change.

Write a sanitised acceptance receipt at `docs/chief-of-staff/evidence/S05.md`: base/head SHA, scenario and test IDs, real red/green command results, migration version, policy changes, fixture demo evidence, rollback check, live-test status, residual limitations and reviewer decision. Private logs/artifacts stay outside Git. Record missing live credentials as **live validation pending**, not passed. Missing every eligible database target blocks the required integration gate; a missing separate test DB does not block the guarded disposable-runtime option. Include the plan revision, `cos-postgres/external-env-v3` conformance, selected test profile and target identity confirmation (without credentials/endpoints), actual local-test/final-image/transfer/Pi-migration/Pi-smoke receipts, source and image IDs, Pi-owned data lifecycle, actual remote failure tests and any pending operator configuration.

Update the persistent goal ledger and create or update this slice’s PR. If review/merge is pending, checkpoint `awaiting_review` with the exact resume condition; the overall goal remains incomplete. When an authorised human merge is verified, advance automatically to the next eligible slice under [GOAL.md](GOAL.md), without a new slice-specific instruction. Execute this slice's in-scope database migrations and target deployment/restart/rollback automatically under [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md), through the Mac-to-Pi release path, recording actual results without another human approval. Do not auto-merge, enable an unauthorised account, enlarge permissions or implement a dependent slice before its predecessor is merged. Resume unfinished work on its existing branch; never recreate a finished slice or discard an existing ledger.
## Pinned-source release gate

Apply [GITHUB_SOURCE_SYNC.md](GITHUB_SOURCE_SYNC.md) in this slice. Push the exact tested source commit from the Mac, fetch/verify it in a detached Pi release-source checkout, and require commit/tree agreement with the tested artifact manifest before activation. Record source-push/source-sync status and verified IDs in the acceptance/deployment receipt. Never use an unattended pull, change the active checkout, build on the Pi or mount fetched source over release code. S01 introduces tests S01-REL13–S01-REL18; later slices regress them where affected.

