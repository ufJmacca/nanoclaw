# Daily briefs and confirmed commitments

S04 adds on-demand and scheduled briefs, confirmed commitments and decisions, and exact owner-approved changes to them. Briefs show up to three attention items, open commitments and decisions, upcoming events, evidence references and source-coverage warnings. Missing calendar data never means the day is free. Saved briefs retain the versions used to prepare them; historical reads are labeled and still respect revoked access.

CoS continues to use its existing NanoClaw AgentGroup and shared session. Mattermost reply threads only group messages visually. A scheduled brief uses that same session; a newer owner message interrupts scheduled work. Refreshing calendar evidence may replace the current provider generation when the old context contains superseded private evidence. This retains the same group/session and consent counters; it does not create a second parallel coordinator or a specialist context.

## Using it after live activation

These examples describe the intended conversational interface. They are not messages sent by the implementation tests, and live model phrasing has not yet been validated for S04.

1. Ask: “Give me today's brief in Australia/Sydney.” Expect the generated time, timezone, confirmed work and explicit coverage warnings. Calendar connection is optional for an empty-calendar brief.
2. Ask: “Propose a weekday brief at 08:30 Australia/Sydney, with quiet hours from 20:00 to 08:00.” Check the exact schedule, timezone, delivery destination and per-run limits in the private approval before approving it. A proposed schedule cannot run.
3. Ask: “Propose a commitment to prepare the project outline by Friday.” Resolve any date or project ambiguity, then approve the exact proposal. Merely mentioning a task does not create a commitment.
4. Ask for another brief and verify that the confirmed commitment appears. Ask to complete that exact item, approve its current revision, and verify that the following brief omits it from open work. Decisions, edits, deferrals and dismissals use the same versioned approval path.
5. Ask to snooze or pause the exact briefing schedule and approve the change. The global CoS pause remains available through the existing owner control.

One schedule is supported per CoS scope. Each approved occurrence allows at most three model turns, sixteen tool calls and five minutes, with at most thirty seconds for selected-calendar refresh; the owner can approve smaller limits. These limits are separate from the subscription model allowance and cannot extend it. Retries retain their original run, deadline and spent counters. Quiet hours and snooze delay dispatch; downtime coalesces into one current brief. Delivery is limited to one scheduled run per actual local date. Missing DST times shift forward; repeated times select the first occurrence.

The host sends the checked brief to the bound private channel and records its notification identity and any platform receipt. An ambiguous transport result becomes uncertain and is not blindly retried. This is not a claim of platform-level exactly-once delivery. Database unavailability prevents new private brief work; recovery reconciles the existing occurrence.

## Current live prerequisites

See [S04 acceptance evidence](evidence/S04.md) for the exact deployment state. The prior live allowance expired after ten charged attempts and CoS remains paused. Deployment does not renew that allowance or send test messages.

Before a live S04 demonstration, revalidate the private channel, owner and subscription binding, recover the native context to the current tool catalogue under the guarded operator procedure, and install a newly authorized bounded subscription allowance. These steps keep the existing Codex subscription runtime; no separate model API key is required. Source-aware briefs additionally need the existing host knowledge switch and approval for the selected sources. With retrieval disabled, source coverage is reported as unavailable rather than silently enabled.

Calendar refresh additionally requires the encrypted credential/backup storage, account consent, selected calendars and host configuration described in [calendar operations](CALENDAR_OPERATIONS.md). The currently unconfigured calendar can remain disconnected for a commitments-only demonstration. CoS specialist agents and account-writing actions belong to later slices.

## Fixture verification

Run project commands inside the repository devcontainer with only the selected external test-database profile and the fixture image/host-root configuration from [delivery](DELIVERY.md):

```sh
pnpm cos:test --slice S04 --db-profile test
pnpm cos:demo --slice S04 --fixture --db-profile test
```

The demo uses authenticated fixture owner ingress, private approval callbacks, an isolated MCP worker, the native inbound queue and real PostgreSQL. It approves a schedule, produces three briefs, confirms and completes a commitment, and checks its disappearance from the next brief. It also covers quiet hours, snooze, missed-run coalescing, a real host-process kill and a real fixture database-connection partition. Scripted provider responses and synthetic transports avoid live account use, real messages and subscription charges.

The release wrapper runs this flow again in both final ARM64 worker profiles without source mounts. Final image checks additionally exercise the native Codex subscription runtime with synthetic authentication/model endpoints, restart, compaction, pause, membership revocation and tool-catalogue recovery. These establish runtime integration and isolation, not live model quality.

## Recovery

Pause CoS and reconcile pending notifications as cancelled or uncertain before changing a live schedule deployment. Preserve confirmed work and previous decisions. Unrelated NanoClaw tasks, messages and sessions are not owned by this slice.

S04 requires PostgreSQL schema 6. The schema-3 S03 release is incompatible after this migration and is refused as a rollback target. Preserve closed admission on an unresolved failure and use tested schema-compatible recovery code; never restore old SQLite files over newer messages or reset the database to force a rollback. See [delivery recovery](DELIVERY.md) and the acceptance receipt for the actual recovery checks performed.
