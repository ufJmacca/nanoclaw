# S09 — Execute one precisely approved external action

**Status:** not started  
**Branch:** `cos/s09-approved-calendar-actions`  
**Depends on:** S08 merged with receipt.  
**Delivery unit:** one independently reviewable PR.  
**Outcome:** preview, approve, create and verify an exact focus-work calendar block without inviting anyone.

Follow [shared execution rules](SLICE_EXECUTION_RULES.md) and all referenced contracts.

## First action and demonstration

Create one ordinary private event on an explicitly selected operator-owned calendar with no attendees. “Focus-work block” is a UI label, not an assumption about provider-specific focus-time features. No email, invitations, recurring events, existing-event edits/deletes, spending, sharing or arbitrary API calls. Even mandate-originated writes require exact approval in this slice.

Ask for an hour tomorrow for Pilot Alpha. Read fresh availability, preview exact calendar, start/end, timezone and minimal title. Owner approves; host rechecks authority/availability, creates, reads back and reports verified ID/link. Changing time after approval invalidates that approval.

## Implementation sequence

1. Verify current provider insert/get/OAuth semantics. Add a separately enabled minimum-scope writer binding and selected test calendar. Keep S03 reader read-only. Implementation/deployment authority does not connect an account.
2. Persist immutable ActionIntent: scope, origin, exact calendar/time/zone, minimal approved title/description, attendees empty, no attachments/conferencing, observed resource versions, payload hash, owner and expiry. Do not leak detailed project material into titles by default.
3. `cos_action_propose` obtains fresh availability and previews conflicts/coverage. Ambiguous times or incomplete coverage block a claim of a free slot. Approval never allows choosing another slot later.
4. Bind exact intent/revision/hash/owner/private destination/expiry through hardened approval. Persist decision before UI acknowledgement. Reject replay, stale payload and wrong owner. No unrecorded provider call in an approval callback.
5. Implement leased executor states proposed, waiting_approval, authorised, queued, executing, verified, blocked, failed, outcome_uncertain and cancelled. Recheck current subscription/owner/source/model policy/credential/calendar/availability before sending. A new conflict requires a new preview.
6. Generate one stable high-entropy provider-compatible event ID from action identity and retain it across recovery. Verify Google's documented ID constraints and distributed collision caveat. Add an opaque private correlation property where supported; an ID alone is not universal exactly-once delivery.
7. Persist request-start before provider call, then receipt. Read back and compare approved semantic fields before verified completion; handle server defaults without ignoring changed date/destination/guests.
8. Timeout/crash after request-start is uncertain. Query the same ID with bounded backoff: match verifies, mismatch blocks, unresolved absence stays uncertain. Never recover by creating a new-ID event. Any permitted retry retains identity and explicit visible risk/approval policy.
9. Notify privately with exact times and verification state. Cancellation before execution prevents sending. Cancellation after creation does not delete the event; deletion is a separate future action profile.

## Privacy, backup and database boundaries

Reject extra fields, guests, attachments, conferencing, recurrence, calendar substitution and generic URLs even when a token is overprivileged. Private event visibility is not secrecy from every administrator or connected application. Sharing/notifications remain provider-account properties.

Before real writes, demonstrate recoverable coordinated CoS/NanoClaw backup and sandbox restore of receipts; S11 is not a reason to postpone this. Do not hold PostgreSQL transactions across provider calls. If remote creation succeeds while DB receipt persistence fails, keep original identity and reconcile rather than resend blindly. Unknown request-start/authority commit, expired lease or local pause blocks sending.

## Required red → green tests

| ID | Behaviour |
|---|---|
| S09-T01 | No provider write before exact current owner approval. |
| S09-T02 | Changed payload/time/calendar/resource version invalidates approval. |
| S09-T03 | Guests/attachments/conferencing/recurrence/arbitrary APIs are rejected. |
| S09-T04 | Concurrent approvals/claims produce one action and one active executor lease. |
| S09-T05 | Timeout after creation reconciles same event without new-ID creation. |
| S09-T06 | Mismatch or unresolved outcome remains blocked/uncertain. |
| S09-T07 | Fresh conflicts/revoked credentials/subscription block unexecuted approved work. |
| S09-T08 | Lost UI/DB acknowledgement recovers without losing decisions or repeating verified effects. |
| S09-T09 | Cancel-before prevents; cancel-after does not silently delete. |
| S09-T10 | Restore retains effect identity and reconciles events newer than the backup. |
| S09-T11 | Existing non-CoS approval handlers retain behaviour. |
| S09-PG01 | Provider success followed by DB loss reconciles original event on reconnect. |
| S09-PG02 | Unknown commit/expired lease/local pause blocks requests; no transaction spans provider IO. |

## Acceptance, rollback and handover

Pass success/conflict/timeout-after-success/crash fixtures. A separately authorised non-sensitive calendar test inspects actual created event and records sanitised evidence. Without consent/credentials, writer activation stays off while fixture code/deployment remain testable. No universal exactly-once claims.

Disable writer admission, keep uncertain actions reconcilable with IDs/receipts, retain reader functionality. Do not delete events or erase the ledger to clean the queue. Follow common release gates and write `docs/chief-of-staff/evidence/S09.md`; human merge precedes S10.
