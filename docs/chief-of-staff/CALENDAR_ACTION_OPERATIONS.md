# Approved calendar actions

S09 is in progress. No live writer is configured. Run these owner controls only
in the trusted NanoClaw host environment, with the service stopped under its
existing maintenance lease and the private CoS binding paused. The commands
recheck owner membership and native leases. They never call a model or send a
message.

## Prepare storage and obtain consent

Provision the existing calendar storage policy's supported encrypted credential
and backup filesystems first. Private file permissions alone are insufficient.
Place a separate desktop Google OAuth client in the protected host file
`calendar/writer-oauth-client.json`; use mode 0600 and the existing client format.
The writer never substitutes `calendar/oauth-client.json` or the reader vault.

Run `pnpm cos:admin action-setup --scope <scope> --request-id <new-uuid>
--backup-root <existing-encrypted-backup-directory>` in that host environment.
Setup backs up calendar state before and after creating fresh writer vault and
denial markers. Missing ownership in an existing directory requires investigation;
repeating setup cannot recreate it.

For explicit account consent, create a private mode-0600 selection file:

```json
{
  "calendarId": "operator-owned-test-calendar-id",
  "primaryCalendarId": "operator-primary-calendar-id",
  "processingProvider": "codex"
}
```

Use actual explicit IDs, including the primary calendar's ID. The alias `primary`
is rejected. The host checks actual account and data ownership again before any
event creation; this file is an operator selection, not proof of provider access.

Run `pnpm cos:admin action-link --scope <scope> --request-id <new-uuid>
--binding <new-uuid> --manifest <absolute-selection-file>` in an interactive
terminal. The command displays a private browser authorization URL. Its callback
listens only on IPv4 loopback; a remote terminal requires an appropriate existing
loopback forwarding arrangement. The command requests only owned-event write
access and calendar-list metadata, using PKCE and single-use state. It stores
and backs up tokens in the protected writer vault, then records a private consent
receipt. An uncertain exchange is never replayed. Repeating the same operation
can finish only with already committed ready credentials.

Linking returns `credentials_ready_writes_disabled`. It does not install a writer
binding, enable writes, resume the CoS or activate a model. Keep
`COS_ACTIONS_ENABLED=false` while recovery proof and final owner configuration
are pending.

## Configure or disable the writer

The guarded configuration command is `pnpm cos:admin action-configure --scope
<scope> --request-id <new-uuid> --manifest <absolute-private-grant-file>`. The
manifest follows `ActionHostGrant` in `actions/profile.ts`: current scope, owner,
main group/session, consent binding ID and credential reference, target backup
operation/digest, write-enabled boolean and the exact `cos-calendar-writer/v1`
binding. The binding pins the selected calendar, account fingerprint, native
private channel, two narrow scopes and restore-proof digest. Reconnection uses a
new consent ID; existing IDs cannot change their calendar or credential identity.

Configuration verifies the original completed consent, protected credentials and
all paired backup families. It requires schema 16 and proof of an actual restore
in a separately identified protected test database. A copied export or the
same-database fixture proof cannot enable it. Only the checked migration login
can install consent metadata; the runtime login can only read it. Permission is
published in the separate host profile after a confirmed commit. An uncertain
commit leaves new permission closed; retry checks the exact existing revision.
The command leaves the CoS paused and does not activate a model.

Run `pnpm cos:admin action-disable --scope <scope> --request-id <new-uuid>
--binding <consent-binding-uuid>` to disable a configured writer. This closes new
writes locally even if PostgreSQL or recovery verification is unavailable. It
preserves the event, consent and credential identities for admitted readback;
it neither deletes events nor revokes the calendar reader. All owner and
maintenance checks still apply. The service must reopen the checked configuration
through its existing restart/resume procedure.

The restore-proof production workflow is still being implemented. Do not activate
a writer by hand-editing its configuration or treating fixture checks as proof.
