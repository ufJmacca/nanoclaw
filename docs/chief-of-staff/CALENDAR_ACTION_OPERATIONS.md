# Approved calendar actions

S09's fixture release is deployed and awaiting human review. No live writer is
configured. Run these owner controls only
in the trusted NanoClaw host environment, with the service stopped under its
existing maintenance lease and the private CoS binding paused. The commands
recheck owner membership and native leases. They never call a model or send a
message.

## Use the installed release

On the Pi, use the prebuilt payload identified by the current deployment receipt.
From the existing NanoClaw installation directory, define the command below with
that verified absolute payload path:

```sh
COS_ADMIN_PAYLOAD=/absolute/path/to/installed/release/payload
cos_admin() {
  "$COS_ADMIN_PAYLOAD/node/bin/node" \
    "$COS_ADMIN_PAYLOAD/dist/modules/chief-of-staff/ops/admin.js" "$@"
}
```

The command selects the required settings from the protected host environment.
Do not source or forward the entire environment file. Pi operations execute
compiled release code; they require no package installation or source build.
Mac fixture development uses the repository devcontainer.

## Prepare storage and obtain consent

Provision the existing calendar storage policy's supported encrypted credential
and backup filesystems first. Private file permissions alone are insufficient.
Place a separate desktop Google OAuth client in the protected host file
`calendar/writer-oauth-client.json`; use mode 0600 and the existing client format.
The writer never substitutes `calendar/oauth-client.json` or the reader vault.

Run `cos_admin action-setup --scope <scope> --request-id <new-uuid>
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

Run `cos_admin action-link --scope <scope> --request-id <new-uuid>
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

The guarded configuration command is `cos_admin action-configure --scope
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

Run `cos_admin action-disable --scope <scope> --request-id <new-uuid>
--binding <consent-binding-uuid>` to disable a configured writer. This closes new
writes locally even if PostgreSQL or recovery verification is unavailable. It
preserves the event, consent and credential identities for admitted readback;
it neither deletes events nor revokes the calendar reader. All owner and
maintenance checks still apply. The service must reopen the checked configuration
through its existing restart/resume procedure.

## Capture and verify recovery evidence

Keep the service stopped and CoS paused under the existing deployment maintenance
lease. After linking, run `cos_admin action-backup --scope <scope> --request-id
<new-uuid> --settings <absolute-private-target-settings-file>`. The command checks
the bound target and exact native admin lease, then captures PostgreSQL, every
existing native session database, artifacts, conversations, specialist state and
protected calendar credentials. It returns a backup operation ID and digest.

Supply only the separate `COS_TEST_PG*` migration profile and protected test marker
to `cos_admin action-restore-check --scope <scope> --request-id <new-uuid>
--backup-release <backup-operation-id>`. Resolve its TLS certificate path for the
trusted execution environment. The command verifies all backup families, copies
local bytes into an isolated private directory and imports the captured scope
only if that scope is fresh in the separately identified protected test database.
It checks every restored row and local byte before publishing a private proof.
Retry uses the same request ID and verifies the existing import; it never replaces
an unrelated test scope. An existing scope without that operation's start record
is refused. The production database, independent effect journal and live
conversation admission are never restored by this command.

Use the returned backup digest and proof digest in the exact owner grant for
`action-configure`. Both recovery commands leave the service paused and writer
admission disabled. These commands have fixture and guarded test-database
coverage; a real target backup and separate restore must still pass before live
writer admission. Do not hand-edit configuration or treat fixture proof as live
account consent.
