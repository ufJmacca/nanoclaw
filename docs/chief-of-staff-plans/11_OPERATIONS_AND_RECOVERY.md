# S11 — Inspect, pause and recover the whole assistant

**Status:** not started  
**Branch:** `cos/s11-operations-and-recovery`  
**Depends on:** S10 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** inspect purpose/authority/progress, stop safely, export records and recover the complete system without repeating external actions.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts. This is not the first security/reliability phase; earlier controls already apply.

## Demonstration

With a mission and scheduled brief present, inspect state, authority, budget uncertainty, coverage and decisions. Pause and prove no new admission. Restart and recover queued work; inspect uncertain external effects without duplication. Restore a coordinated test backup into an isolated environment with egress closed, reconcile and then deliberately resume. Prove the healthy Pi runs with Mac offline.

## Implementation sequence

1. Add `cos_status` and owner CLI inspection of goals, commitments, proposals, attempts, mandates, approvals, actions, blocked operations, coverage and limits. Link each item to purpose/authority and safe evidence.
2. Authenticated controls: admission/automation pause, mission cancel, source revoke, connector disable, uncertain-action inspect. Target precisely; no unrelated container termination. Trusted local deny-only controls remain available during DB/model outage, without revealing unchecked private content.
3. Distinguish process liveness from dependency readiness: misconfigured, unreachable, auth/TLS failure, incompatible schema, reconciling or ready. Include queue/outbox lag, capacity/orphans and unknown effects. Redacted structured logs retain concise reasons and evidence, not sensitive full prompts/private chain-of-thought.
4. Coordinate external PostgreSQL backup/checkpoint, consistent local SQLite backups including WAL/journal semantics, host-owned artifacts and configuration/schema references through a quiesce barrier. DB backup alone omits local files. Credentials are restored separately through trusted environment, not portable exports.
5. Manifest includes backup generation, source/image/software/schema versions, checksums, revocation markers and external reconciliation checkpoint. Restore to a separately admitted external restore/test DB with isolated local roots and egress/admission disabled. During implementation, an eligible quiesced disposable-runtime restore can be used only under the exact authority/lease/effect rules; never overwrite protected local NanoClaw state or protected runtime DB as a fixture.
6. Reconcile stale leases, allocations, containers, outbox, native schedules and effects newer than the backup. Absence of an old receipt does not prove an external action never happened. Read back or obtain owner disposition before reopening writers.
7. Scoped retention/export honours revocation, uses owner-local/private short-lived delivery and audits export. Explain limits on already-delivered messages/provider inputs/backups.
8. Replay S01–S10 acceptance and inject DB partition/auth/TLS/pool failure, worker crash, host restart, duplicate/out-of-order events, late approvals, access loss, missing connectors and timeout-after-remote-success. Each run reaches known terminal or explicitly uncertain state.
9. Document install/upgrade, source/image identity, shutdown/start, environment-based credential rotation, revocation, cancellation, effect reconciliation, coordinated restore, rollback and limitations. Existing restart authority applies; do not change global coding-agent permissions to simplify deployment.
10. Release assessment separates code, Mac image tests, pinned GitHub source, Pi deployment/native checks and account/model/channel activation. Writer stays disabled without S09 account-specific evidence.
11. After all eleven slices and alignment changes meet tests and verified human merges, monotonically close disposal on the Pi before valuable data admission. Verify target state rather than claiming protection after an unreachable SSH call. Lost/stale Mac ledger cannot reopen disposal. Continue only data-preserving authorised completion deployments with backup/compatibility checks.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S11-T01 | Accurate queued/running/blocked/review/uncertain/cancelled status. |
| S11-T02 | Pause closes admission while inspection and unrelated NanoClaw continue. |
| S11-T03 | Schema/checksum mismatch or missing restore artifact cannot enable execution. |
| S11-T04 | Old restore cannot repeat an already-created external action without reconciliation. |
| S11-T05 | Revocation tombstones survive restore and prevent resurrection. |
| S11-T06 | Export is scoped/private and secret-free. |
| S11-T07 | Orphan/lease/schedule repair preserves identities without duplicate workers. |
| S11-T08 | Host/DB/connector outages cannot masquerade as confident complete knowledge. |
| S11-T09 | Global CoS stop affects only owned execution/resources. |
| S11-T10 | Upgrade/rollback preserves approvals, intents and receipt semantics. |
| S11-PG01 | Preflight distinguishes network/auth/TLS/schema/reconciliation without env disclosure. |
| S11-PG02 | Remote/local restore targets an admitted test DB or eligible quiesced disposable runtime, never protected data/local live state. |
| S11-PG03 | Authorised credential-rotation restart closes old pool and validates new access without leaking either password. |
| S11-PG04 | Faults affect test route, not server restart/global firewall/local DB provisioning. |
| S11-OPS01 | Tested final release migrates/deploys/restarts/verifies under existing approval; health failure recovers or blocks technically. |
| S11-OPS02 | All implementation/merge gates close disposal before valuable admission. |
| S11-OPS03 | Restart/stale ledger/blank template cannot reopen protected disposal. |
| S11-OPS04 | Cleanup/restore cannot erase real-effect identities or ordinary NanoClaw state. |
| S11-OPS05 | Human PR/account/action approvals remain; operational receipts are evidence, not new consent gates. |
| S11-REL01 | Final merged source/images match healthy Pi, independent of Mac availability. |
| S11-REL02 | Interrupted sync/staging/load/extract/migrate/restart reconciles one release without Pi builds. |
| S11-REL03 | Rollback preserves current messages/sessions and selects only compatible recorded artifacts. |
| S11-REL04 | Pi-owned protection survives stale/lost Mac ledger, code-root changes and restart. |

Regress S01-REL13–S01-REL18, including retained exact source and GitHub/Mac offline operation.

## Final gates

**Code:** all slice contracts, relevant legacy regressions, migrations and runtime isolation pass with real evidence. Every limitation has an owner and operational consequence; security tests are not waived by plausible model output.

**Pilot:** a few expressly admitted sources support a briefing, mission, read-only mandate, strategy review and restore drill. Record net value after supervision, missed commitments, errors, noise and cost visibility as observations, not promises. Missing live account authority stays visible and does not fake pilot success.

**Write:** S09's separate non-sensitive test-calendar checks pass before writer activation. Merge/deployment is not universal account access.

**Programme:** verified merges, mandatory Mac/native Pi tests, healthy matching final release, retained recovery evidence and confirmed protected lifecycle. Genuine target failure blocks completion; it is not a request for another deployment approval.

## Rollback and handover

Close CoS admission, revoke in-flight authority, retain safe inspection/reconciliation and state. Restore only through the tested isolated procedure; never clear queues/receipts or reset NanoClaw to make it look healthy. Follow common receipt rules at `docs/chief-of-staff/evidence/S11.md`, final goal report and additive ledger checkpoint. No hidden S12 or automatic deployment of unrelated products.
