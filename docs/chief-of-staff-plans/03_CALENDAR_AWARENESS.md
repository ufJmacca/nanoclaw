# S03 — Understand upcoming commitments from one real connector

**Status:** not started  
**Branch:** `cos/s03-calendar-awareness`  
**Depends on:** S02 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** calendar-aware advice with explicit freshness and coverage.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## Provider and demonstration

Google Calendar read-only is the first replaceable reference adapter, not an assumption that an account is connected. No Gmail/Drive marketplace or generic proxy is needed. A different provider requires a recorded contract decision, not speculative parallel implementations. Fixture flow works without live credentials; account linking/live validation remain separate.

Fixture events include an approaching meeting, all-day event, moved recurring instance and cancellation. Ask what needs preparation tomorrow. Use only selected calendars, display the configured timezone and mark uncertain project links as proposed. On disconnection report incomplete coverage, not an empty day.

## Implementation sequence

1. Define CalendarReader: bounded list/get for an allowlisted calendar and explicit coverage/auth status. Implement fixture and real Google adapters. No arbitrary URLs/methods exposed to agents.
2. Verify current official API/OAuth documentation during implementation; use least-privilege read scopes, supported auth flow, validated callback and host-only token storage. Linking is an operator action; no token in chat, logs, Git or runner environment.
3. Implement bounded paginated snapshots, initially 30 days back/90 days forward with owner-configurable limits. Keep one stable query window and snapshot generation throughout pagination. Publish complete coverage only after all pages and persistence succeed. Do not guess incremental-token semantics or combine them with moving windows.
4. Normalise timed/all-day events, recurrence exceptions, cancellation, source IDs/versions and proposed project links. Keep all-day dates as dates. Use IANA zones and explicit policies for ambiguous/nonexistent local times.
5. Idempotently store revisions and retire missing observations only within a successfully completed snapshot's coverage. Failed/partial sync never removes unseen events. Revoke/quarantine cached content when calendar access is lost.
6. Expose `cos_calendar_read` and bounded owner/host sync, both constrained by current bindings. Integrate S02 evidence without making the CoS DB authoritative for external events.
7. Add coverage to `cos_context_get`. Preparation suggestions remain proposals, not inferred commitments or goals.

## Records and database boundary

Connector bindings, selected calendar IDs, observed permissions, snapshot generations, event observations, last-success/attempt timestamps and credential references. Raw tokens are not stored in domain records. Read calendar pages outside transactions, then persist/promote the stable generation through the shared host pool. A DB failure retains last complete coverage; it cannot promote a partial snapshot.

S04 supplies native scheduled refresh; no competing synchroniser is needed now. S03 rejects write methods even with an accidentally overprivileged token. DB credentials must never enter calendar adapter context.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S03-T01 | Complete pagination; partial failure neither advertises complete coverage nor deletes missing observations. |
| S03-T02 | All-day, timed, recurring exception and cancellation normalise correctly. |
| S03-T03 | Duplicate sync creates no duplicate events/evidence revisions. |
| S03-T04 | Calendar/scope allowlist holds despite broader token privileges. |
| S03-T05 | Expired/revoked auth blocks reads and invalidates accessible cache. |
| S03-T06 | Adapter cannot write or target arbitrary HTTP endpoints. |
| S03-T07 | Rate-limit retries are bounded and honour provider hints. |
| S03-T08 | Source text grants no authority; secrets/sensitive error bodies are redacted. |
| S03-T09 | DST and ambiguous/nonexistent time policies are explicit and tested. |
| S03-T10 | Unavailable connector yields coverage warnings, not “nothing scheduled”. |
| S03-PG01 | Disconnect during persistence retains the last complete generation and does not retire unseen events. |
| S03-PG02 | Recovery reuses snapshot identity; database credentials stay out of calendar context. |

## Acceptance, rollback and handover

Demonstrate through the real host interface, external PostgreSQL and fixture provider. Supply a runbook for separately connecting one test calendar, inspecting read-only requests, revoking it and verifying access loss. Do not automatically link an account while implementing.

Disable the binding/refresh, retain tombstones and hide inaccessible evidence; S01/S02 continue. This slice modifies no calendar events. Follow common Mac/image/GitHub/Pi gates and write `docs/chief-of-staff/evidence/S03.md`; next slice follows verified human merge.
