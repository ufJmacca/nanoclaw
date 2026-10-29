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

Initial setup uses `mail-review-configure`. Recovery after changed Mail consent uses the separate owner command `mail-review-rebind`, with the same explicit `--scope`, `--request-id` and protected `--manifest` arguments. Both commands require the exact current protected G06 helper and trusted migration credentials. A review tool, worker or ordinary channel message cannot invoke them. A source implementation is not available on the Pi until its complete release gates and matching deployment pass.

An uncertain account check remains closed. Do not remove its pending record or infer that a stored `ready` account row proves current access. Use fresh owner OAuth consent for the reader and its separately bound writer, verify their recovery copies, then use the existing retained-context recovery procedure. That procedure preserves the old history and consumed allowance while establishing a fresh main generation. Rebind checks the actual completed transition from the previous policy's generation, its retained history and the current account; a new identifier or restored receipt alone is insufficient.

The rebind manifest has format `cos-mail-review-rebind/v1` and contains the previous profile digest, expected independent pin revision/digest, and replacement profile. The account, owner, main session, installation, effect journal, policy ID, both schedule IDs, times and limits must remain the same. Only fresh reader/writer consent and the verified recovered context can change. Rebind increments the policy and schedule versions and preserves a disabled independent pin. It cannot resume CoS or reset the shared five-draft daily limit.

SQL commits before the independent pin and private profile are published. An interrupted acknowledgement remains closed and is reconciled using the same request and manifest. A different request, changed profile, unsettled review or later owner disable must be investigated rather than overwritten. Both new schedule revisions receive one actual database activation time; retries preserve it. Cancelled and missed earlier reviews remain recorded and are not replayed by the new revision. A successful result is `rebound_paused`; normal admission and the existing model allowance still govern resume.

The new policy tables, schedule revisions and frozen run inputs are part of schema-21 checkpoints. Isolated recovery must preserve the live installation, newer independent effect and revocation journals, native conversation and consumed model counters. Credential copies remain inactive unless separately admitted through the trusted owner workflow.

A schema-20 release cannot read schema 21. Use only the compatible fallback recorded for the current deployment, or a compatible roll-forward. Preserve pause during recovery; do not downgrade or restore old database contents over live state.

See the [G06 evidence receipt](evidence/G06.md) for tested and installed identities and the actual acceptance status. Fixtures establish controlled behavior; they do not replace a live account demonstration or human review.
