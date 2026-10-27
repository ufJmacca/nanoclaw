# Morning and afternoon Mail reviews

G06 adds daily Mail reviews at 08:00 and 15:00 in Australia/Sydney. Each review uses the existing CoS conversation and private channel. Replies are saved as unsent Gmail drafts for the owner to inspect and send.

## Selection and limits

| Limit             | Behavior                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------ |
| Candidate threads | At most ten per review, prioritising unanswered requests and follow-ups                    |
| Model attempts    | At most three per review, including retries, also charged to the existing global allowance |
| New drafts        | At most five per Sydney calendar day, shared with ordinary owner requests                  |
| Tools             | At most sixteen calls per review, including the checked briefing                           |
| Review deadline   | Five minutes                                                                               |

CoS reads the selected Inbox/Sent capture. It excludes bulk mail, newsletters, automated receipts and no-reply senders. A review can still mention an eligible thread with an existing draft. The independent draft journal prevents another unsafe save. The host checks current message metadata and freezes the admitted references before model work. A stale or limited capture remains an explicit coverage limit.

A draft is not a sent message, an accepted commitment or a Calendar reservation. This release adds no email-send or Calendar-write operation. An uncertain save counts against the daily limit and is reconciled before another attempt. Edited, deleted and sent drafts are not blindly recreated.

## What appears in the channel

The host checks and delivers three sections: Needs attention, Drafts ready and Upcoming meetings. Sources, observation times, Mail freshness and coverage limits accompany the relevant items. When no useful changes are available, the briefing says so rather than creating unnecessary drafts.

Scheduled work retains the main conversation and shares its allowance ledger. Generic scheduled briefs and specialist contexts cannot acquire the review policy's draft-writing authority.

## Pauses and changed authority

Global CoS pause closes affected review work. Revoked reader access, changed writer consent, an invalid policy pin, a changed conversation identity, or expired/exhausted model authority also prevent the affected operations. Restart and recovery do not renew the allowance or restore withdrawn authority.

Use the existing trusted owner administration workflow for setup and recovery. Mail-only operating controls belong to G07 and must not be assumed available in G06. Account relinking or restored metadata does not automatically enable an old review policy.

Missed occurrences use native coalescing. CoS does not replay every missed daily review, create a second main context for a thread, or reset the shared daily draft cap after restart.

## Diagnosing a stopped review

The host reports fixed failure stages for admission, source preparation and dispatch. These reports contain no email content, credentials or underlying exception text. They identify the check that closed work; they do not grant permission to bypass it. A cancelled occurrence stays terminal. Diagnose it from its recorded state and logs, then verify through a later genuine occurrence.

The 28 October morning review exposed a preparation bug: normal resume clears the previous owner-message ingress, but preparation required it to be present. The correction resolves the retained main context through a host-only preparation path. It preserves the owner-message checks used by ordinary tools and still requires the claimed schedule, current policy, source access and model allowance before automatic work. Do not repair this by inserting a fabricated owner message or replaying the cancelled occurrence. See the evidence receipt for the correction's deployment status.

## Setup and recovery

Trusted setup requires the current protected G06 release, schema 21, paused native admission, current owner/channel membership, the existing reader and enabled writer grants, real consent, and verified independent recovery. The installed owner command publishes the SQL policy and two schedules, binds the independent journal pin, and publishes the private host profile. It does not resume CoS, perform a model turn, or create an allowance.

The new policy tables, schedule revisions and frozen run inputs are part of schema-21 checkpoints. Isolated recovery must preserve the live installation, newer independent effect and revocation journals, native conversation and consumed model counters. Credential copies remain inactive unless separately admitted through the trusted owner workflow.

A schema-20 release cannot read schema 21. Use only the compatible fallback recorded for the current deployment, or a compatible roll-forward. Preserve pause during recovery; do not downgrade or restore old database contents over live state.

See the [G06 evidence receipt](evidence/G06.md) for tested and installed identities and the actual acceptance status. Fixtures establish controlled behavior; they do not replace a live account demonstration or human review.
