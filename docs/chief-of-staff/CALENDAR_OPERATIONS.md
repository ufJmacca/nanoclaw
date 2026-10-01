# Calendar operator controls

S03 is in development. These commands have development-container tests; no S03 release or live calendar link is accepted yet. Google Calendar reads are optional and disabled by default. The Pi continues to run accepted S02 with CoS paused.

Calendar administration uses the existing native CoS binding. The target must have its maintenance lease, a stopped service and workers, a paused CoS binding, and current private owner/bot membership. The command takes the target and host locks and derives scope ownership from NanoClaw. It leaves CoS paused and does not invoke a model or send a message.

Run project commands in the Mac devcontainer with fixtures. On the Pi, use the activated release's packaged Node and `dist/modules/chief-of-staff/ops/admin.js` under the trusted host environment. Do not install dependencies on the Pi or run its bot identity on the Mac.

## Configure protected storage and a desktop client

Both credential and backup directories must pass the encrypted-storage verifier; private file permissions alone are insufficient. The inspected Pi storage currently needs operator provisioning before real linking. Setup does not encrypt disks, create mounts, change machine privileges or open network ports. Provisioning that storage is a separate operator action.

The service user must own a canonical `0700` directory at `COS_TARGET_STATE_DIR/calendar` on verified dm-crypt storage, plus an empty `0700` backup directory outside the target, application and data roots. The verifier supports ext4, XFS and Btrfs and checks all reported members sharing the filesystem UUID. Neither directory may be inside Git or reached through a symbolic link. Keep encryption keys outside the release artifacts and worker mounts.

Create a Google OAuth **Desktop app** client for the explicitly authorized test account. In the protected calendar directory, provision a `0600` regular `oauth-client.json` file containing `clientId` and, when supplied by Google, `clientSecret`. These are the desktop client's values, not an OpenAI API key. The downloaded Google configuration uses different field names; select its `client_id` and `client_secret` into this narrow file shape. Never paste their values into chat, command arguments, Git, a worker environment or logs. [Google desktop OAuth documentation](https://developers.google.com/identity/protocols/oauth2/native-app).

```text
pnpm cos:admin calendar-setup --scope SCOPE --request-id SETUP_UUID --backup-root /absolute/protected/backups
```

Setup verifies storage and backup ownership, pins the client configuration, initializes fresh credential and denial directories, and takes protected snapshots. Repeating the command preserves existing tokens and denials. It cannot replace a configured filesystem, client or backup destination, repair missing ownership markers, or recreate lost credential directories after completed setup. An interrupted initialization remains closed if ownership cannot be proved. Do not delete setup records to force adoption.

## Link one selected test calendar

Linking is an explicit account action and does not happen during deployment. Use the trusted service user's interactive terminal, under the maintenance/private-membership prerequisites above. A redirected terminal is rejected before authorization starts; the browser authorization URL is displayed only on the interactive terminal.

Prepare a private `0600` regular selection manifest. Calendar IDs must be explicit; the connector does not request permission to enumerate the account's calendars. The currently bound model provider must be included in the selected processing policy. For the existing Codex coordinator:

```json
{
  "calendarIds": ["TEST_CALENDAR_ID"],
  "timeZone": "Australia/Sydney",
  "processingProviders": ["codex"]
}
```

```text
pnpm cos:admin calendar-link --scope SCOPE --binding NEW_BINDING_UUID --request-id LINK_UUID --manifest /absolute/private/selection.json
```

The Google consent request uses `calendar.events.readonly`, an exact loopback callback, PKCE and single-use state. Select the intended test account in the browser and inspect the requested permissions. Provider scope and selected-calendar restrictions are checked independently; even a broader token cannot enable write requests. No calendar events are fetched by linking. [Google Calendar scopes](https://developers.google.com/workspace/calendar/api/auth).

When the command runs on the Pi and the browser runs on the Mac, note the port in the authorization URL's `redirect_uri`. In a second Mac terminal, forward that same loopback port before opening the URL:

```text
ssh -N -L 127.0.0.1:PORT:127.0.0.1:PORT nanoclaw-pi
```

The listener binds only Pi IPv4 loopback; no public callback or firewall change is needed. Authorization expires after ten minutes. Close the forwarding session afterwards. Do not share or log the URL. The terminal running the command needs a TTY, such as an interactive `ssh -t nanoclaw-pi` session invoking the packaged administration entry.

Tokens remain in the protected host directory and are backed up before database binding. The command leaves refresh and model activation unchanged. If database admission returns `pending` or `unavailable` after tokens were saved, repeat the exact binding, link UUID and selection manifest: the command inspects the durable credentials and does not repeat OAuth. An interrupted authorization without usable saved credentials returns `calendar_link_uncertain`; start a separately authorized attempt with a new binding and link UUID. Never clear a pending or denial record. Changing selected calendars, timezone or processing permissions also requires disconnecting the old binding and linking a new one; a retry cannot widen an existing selection.

## Inspect, refresh and disconnect

The following commands assume a configured, separately authorized account. Use distinct stable UUIDs for setup, linking, each refresh and disconnection.

```text
pnpm cos:admin calendar-status --scope SCOPE
pnpm cos:admin calendar-status --scope SCOPE --offset NEXT_OFFSET
pnpm cos:admin calendar-sync --scope SCOPE --binding BINDING_UUID --request-id REQUEST_UUID --manifest /absolute/private/sync.json
pnpm cos:admin calendar-disconnect --scope SCOPE --binding BINDING_UUID --request-id DISCONNECT_UUID
```

`calendar-status` reports selected-calendar coverage, database auth state, local access and whether refresh is enabled. It does not open OAuth tokens. Follow `next_offset` for subsequent ten-entry pages. Missing snapshots and unavailable local access mean incomplete coverage, not an empty calendar.

`calendar-sync` requires `COS_CALENDAR_ENABLED=true` in the trusted host environment and a private regular JSON manifest, owned by the service user with mode `0600`. No symbolic or hard links are accepted. A minimal manifest is `{"calendarId":"SELECTED_CALENDAR_ID"}`. The initial default window spans 30 days back and 90 days forward in the binding's configured timezone. To select an explicit bounded window, use:

```json
{
  "calendarId": "SELECTED_CALENDAR_ID",
  "window": {
    "timeMin": "2026-10-01T00:00:00Z",
    "timeMax": "2026-10-10T00:00:00Z",
    "timeZone": "Australia/Sydney"
  }
}
```

Keep the same request UUID and manifest when retrying an uncertain refresh. The command freezes its initial window, including the default window, and rejects changes to the request or binding. It takes protected credential/journal snapshots before and after refresh. Terminal results contain status and snapshot identity; provider content and prepared event bytes are excluded. A `pending` or `unavailable` result does not establish complete coverage. Interrupted provider access checks can require a new account binding; never delete their pending records to reopen access.

`calendar-disconnect` works with refresh disabled and does not require usable OAuth credentials. After verifying native owner authority, it durably closes local access before contacting PostgreSQL, then records the disconnection in the database and backs up the denial journal. A database or backup failure leaves the local denial in place. Repeat the same command to reconcile the database; do not restore older credential or denial files. Disconnect prevents local use; it does not revoke the app's grant at Google or erase already delivered messages/provider disclosures. Explicit reconnect requires a new binding identity.

To check provider revocation in a separately approved live test, remove this desktop app's access in the test Google account, then request a fresh sync UUID. The next rejected token/calendar request must close local access and report incomplete coverage. A still-valid cached token may last until Google rejects it; use local disconnect for an immediate local stop. Compare `calendar-status` before and after. Do not interpret a failed read as zero events. Existing exposed CoS context must pass the normal recovery checks before it can be reused; account linking cannot recover or resume it.

The fixture suite verifies fixed Google GET event requests and the separate fixed OAuth token POST. S03 has no event-write endpoint. For a live test, verify selected events and snapshot/freshness metadata using these commands without recording Authorization headers, token bodies, raw event content or the private browser URL in shared logs. Linking or deployment alone is not evidence of a successful live read.

Calendar reads cannot edit Google events. Preparation advice remains a proposal. Model activation and context recovery retain their separate existing controls; none of these commands resumes CoS or replenishes its allowance.
