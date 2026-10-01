# Calendar operator controls

S03 is in development. These commands have development-container tests; no S03 release or live calendar link is accepted yet. Google Calendar reads are optional and disabled by default. The Pi continues to run accepted S02 with CoS paused.

Calendar administration uses the existing native CoS binding. The target must have its maintenance lease, a stopped service and workers, a paused CoS binding, and current private owner/bot membership. The command takes the target and host locks and derives scope ownership from NanoClaw. It leaves CoS paused and does not invoke a model or send a message.

Run project commands in the Mac devcontainer with fixtures. On the Pi, use the activated release's packaged Node and `dist/modules/chief-of-staff/ops/admin.js` under the trusted host environment. Do not install dependencies on the Pi or run its bot identity on the Mac.

## Inspect, refresh and disconnect

The examples assume a separately authorized, configured account. Protected setup and account-linking commands are still being implemented. Both credential and backup directories must pass the encrypted-storage verifier; private file permissions alone are insufficient. The inspected Pi storage currently needs operator provisioning before real linking.

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

`calendar-disconnect` works with refresh disabled and does not require usable OAuth credentials. After verifying native owner authority, it durably closes local access before contacting PostgreSQL, then records the disconnection in the database and backs up the denial journal. A database or backup failure leaves the local denial in place. Repeat the same command to reconcile the database; do not restore older credential or denial files. Disconnect prevents local use; it does not revoke the app's grant at Google or erase already delivered messages/provider disclosures. Explicit reconnect will require a new binding identity.

Calendar reads cannot edit Google events. Preparation advice remains a proposal. Model activation and context recovery retain their separate existing controls; none of these commands resumes CoS or replenishes its allowance.
