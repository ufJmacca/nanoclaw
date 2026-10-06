# Strategic reviews

CoS can compare approved initiatives with observed outcomes, challenge
assumptions and offer a decision about continuing, changing, pausing or stopping
an initiative. A completed task, an agent's agreement or time reserved on a
calendar does not establish that an outcome was achieved.

Reviews belong to the existing NanoClaw CoS AgentGroup and retained main
conversation. Mattermost reply threads group messages visually. Specialists have
their own contexts when their separate delegation authority is configured.

## Using the conversational flow after live activation

These examples describe the implemented interface. Fixture tests use scripted
responses; live model interpretation and usefulness have not been validated for
S10.

1. Select existing approved goals or projects and sources already admitted to
   CoS. Ask for a review charter naming those initiatives, the outcomes you want,
   how to observe them, assumptions, start/end dates, resource constraints and
   exploration time. Inspect and approve the exact host preview. The charter's
   cadence is manual and does not grant a schedule or permission to do work.
2. Ask CoS to propose an observation about an outcome, assumption, attention cost
   or actual effort. Approve its exact wording and basis. Evidence-backed
   observations cite admitted source evidence; self-reports remain labelled and
   unknown outcomes remain unknown. Conflicting observations can coexist.
3. Ask: “Review these initiatives against the approved charter. Compare completed
   work with observed outcomes, preserve counterevidence and offer alternatives
   including continuing unchanged.” The host captures current authorised record
   versions and source coverage before analysis. Missing or interrupted evidence
   is reported rather than filled in from unchecked cached text.
4. Read the checked review. The recommendation, reason and proposed next action
   come first. Alternatives, outcomes/evidence and findings have separate
   sections; later reviews bring the prior advice and owner choices forward.
   It distinguishes facts, self-reports, assumptions and recommendations;
   includes trade-offs, opportunity costs, uncertainty and a
   forecast horizon; and states what evidence could change its recommendation.
   Calendar allocation remains separate from actual effort and outcomes.
5. Reject a recommendation or select a different exact option. Rejection records
   the choice without changing approved work. An approved direction records its
   rationale and version after current-state validation. Stale approvals require
   revalidation. Pausing an initiative does not cancel commitments, missions,
   mandates or calendar events; each consequence needs its own proposal and
   approval.
6. After observing a result, approve the new observation and ask for a later
   revision of the same review. It compares original advice, uncertainty,
   forecasts and owner choices with later evidence. Approval is a decision, not
   a success label. Superseded direction versions and unsuccessful advice remain
   in history.

Saved reviews retain the rendering version used when published. A layout change
does not rewrite the original advice; new reviews use the clearer structure.

Historical redisplay still requires current source and native-context permission.
If access is withdrawn, CoS must not reconstruct withheld review text from the
conversation. Operational decision history is retained; private review artifacts
follow the existing revocation and purge rules.

Fresh reviews omit historical observations whose evidence is no longer selected
or currently authorised, and report limited coverage. Their private text is
withheld while the immutable approved observations remain stored. A revised
source needs current evidence and a newly approved observation to support a new
outcome claim. After withdrawal, remove the unavailable source through an exact
approved charter change before requesting a fresh review. Retained context and
saved-review permission checks still apply. See the
[source-evolution correction](evidence/S10_SOURCE_EVOLUTION.md).

A snapshot includes at most 20 observations. Retired source evidence cannot crowd
out newly approved current evidence before that limit is applied. Withheld or
overflowing history still produces limited coverage. See the
[collection-limit correction](evidence/S10_OBSERVATION_CAP.md).

## Scope and present limits

One active manual charter selects at most ten initiatives and six sources. The
host bounds snapshots, findings, options, observations and output; oversized or
unavailable evidence cannot become a claimed complete review. Snapshot admission
expires after at most fifteen minutes or the charter's end, whichever comes
first.

S10 does not admit automatic weekly/monthly strategic reviews. Scheduled briefs,
standing mandates, proactive tasks and specialist-result review turns cannot use
these strategic tools. Existing separately approved research missions may supply
analyst/challenger evidence; their agreement is advisory, and incomplete results,
contrary claims and review limitations remain visible.

The six coordinator tools propose charters, observations and directions; capture
snapshots; submit checked drafts; and read review revisions. They are available
through the existing image-owned MCP server when resuming an older conversation,
without creating a second coordinator context or rewriting its history. The
trusted host remains responsible for identity, current permission, previews,
owner decisions and application.

## Current live prerequisites

The previous live allowance expired after ten charged attempts, and CoS remains
paused. Deployment does not renew that allowance or send messages. Live testing
needs a newly authorised finite subscription/model and private-channel allowance,
plus current verification of the owner, private channel, subscription binding and
selected source processing permission. It uses NanoClaw's existing Codex
subscription runtime; no separate model API key is required.

Calendar and specialist evidence are optional and need their existing account or
delegation admission. The S09 calendar writer has separate consent, protected
storage and restore-proof gates. A strategic recommendation grants no writer
authority.

## Fixture verification and recovery

Run project tooling in the repository devcontainer with only the selected
external test profile and the fixture image/root configuration described in
[delivery](DELIVERY.md):

```sh
pnpm cos:test --slice S10 --db-profile test
pnpm cos:demo --slice S10 --fixture --db-profile test
```

The native demonstration seeds two synthetic initiatives: one has many completed
tasks and an unknown outcome; the other has an observed benefit. It retains a
contradiction and unsupported assumption, rejects a pause recommendation,
approves a revised smaller experiment, records a later disappointing observation,
supersedes the direction and redisplays original advice after host restart. It
uses the real host, isolated MCP, owner ingress/approval, publication checks and
external PostgreSQL, with synthetic model and message transports.

S10 requires PostgreSQL schema 18. Keep approved choices and history when review
work is paused. The retained S09/schema-16 release is ineligible for rollback
after this migration. Preserve closed CoS admission on uncertainty and recover
with verified schema-18 artifacts. Never restore old live SQLite over newer
messages or reset the database to force a rollback.
