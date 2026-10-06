# Chief-of-Staff operations and recovery

These procedures use the installed corrected S11 candidate. Its fresh deployment,
backup, native checks, compatibility and preservation passed. Accepted earlier
maintenance and isolated restore evidence retains its original source identity.
Human review/merge and merged-source acceptance remain pending. Check [the acceptance receipt](evidence/S11.md)
for the exact installed identity. Keep CoS paused and the calendar writer disabled
until the separate live activation checks pass.

## Prerequisites and responsibilities

The external database administrator owns PostgreSQL availability, server
backups/PITR, role provisioning and password issuance. NanoClaw uses authenticated
client connections with verified TLS; it does not run or back up the remote
server's data directory. Keep runtime and migration logins separate. Prefer the
separate `COS_TEST_PG*` target for integration and restore tests, with its existing
protected test marker and a different observed database identity.

The NanoClaw operator owns the bound Pi service, private configuration, local
SQLite/session data, artifacts and retained release receipts. Runtime connection
fields belong in the private file named by the deployment settings'
`runtimeEnvironment`; migration credentials belong in `migrationEnvironment`.
Use mode 0600, the bound user and canonical paths. Keep certificate files readable
by that user and valid for the database hostname. The service receives only its
runtime profile through its existing environment-file configuration. Never source
or transfer the whole repository `.env`, put credentials in an image, or pass
database credentials to a model or specialist.

## Use the recorded installed payload

Obtain the current release ID, payload and settings path from the bound Pi's
deployment receipt. Use those verified absolute paths, not a moving branch:

```sh
COS_OPERATOR_PAYLOAD=/absolute/path/to/current/release/payload
COS_OPERATOR_SETTINGS=/absolute/path/to/current/staging/target.json
COS_OPERATOR_SCOPE=verified-cos-scope
cos_target() {
  "$COS_OPERATOR_PAYLOAD/node/bin/node" \
    "$COS_OPERATOR_PAYLOAD/dist/modules/chief-of-staff/ops/target-helper.js" \
    "$@" --settings "$COS_OPERATOR_SETTINGS"
}
cos_owner() {
  "$COS_OPERATOR_PAYLOAD/node/bin/node" \
    "$COS_OPERATOR_PAYLOAD/dist/modules/chief-of-staff/ops/target-owner-admin.js" \
    --settings "$COS_OPERATOR_SETTINGS" -- "$@"
}
```

Run these on the Pi as its existing NanoClaw user. The commands verify the tested
payload, recorded deployment and target paths. They use packaged Node and compiled
code; no dependency install or build runs on the Pi. Local development and project
tooling remain in the Mac devcontainer.

## Inspect and reduce authority

```sh
cos_owner database-check
cos_owner operator-status --scope "$COS_OPERATOR_SCOPE"
cos_owner operator-control --scope "$COS_OPERATOR_SCOPE" \
  --request-id NEW_UUID --text 'cos pause admission'
```

Database preflight reports bounded configuration, connection, TLS,
authentication and schema stages. A ready connection does not establish model
consent or resolve uncertain effects. Owner status shows scoped counts and safe
purpose, authority and evidence references; it withholds private records when
current database/channel authority is unavailable.

The same deterministic private Mattermost interface accepts `cos status`, category
pages, `cos inspect action ACTION_ID`, `cos pause admission`, `cos pause automation`,
`cos stop`, `cos cancel mission MISSION_ID`, `cos revoke source SOURCE_ID` and
`cos disable connector CONNECTOR_ID`. These controls use no model context or model
turn. Reply threads are visual grouping within the main CoS group. Specialists
retain their own separately authorised contexts.

The local `operator-control` path needs no database or channel credentials. Use
its stable request UUID again after a lost reply. It records native denial before
requesting precisely scoped CoS stops; ordinary NanoClaw execution is excluded.
Source/connector withdrawal pauses CoS and invalidates exposed retained context.
Native denial must reconcile with the current remote tombstones before a later
trusted context resume. A stop request does not prove an already-started provider
effect was absent or cancelled.

## Hold, shut down and restart safely

First pause the bound CoS and let ordinary NanoClaw workers finish. Choose one
maintenance UUID and retain it through retries:

```sh
cos_target operations-maintenance --request-id MAINTENANCE_UUID --phase hold
```

`held` means the recorded lease is quiescent and current database/schema checks
passed. The command stops only the bound host service and never issues Docker
stops for ordinary workers. It refuses a busy installation or another operation's
lease. Existing messages, sessions, approvals, journals and data roots remain.
The other workloads on the Pi are outside this operation.

`native_stopped_database_unverified` means the local service stopped but the
database backup barrier is not verified. CoS admission remains closed. Repair
access and repeat **the same UUID**; do not take this result as a complete backup
or clear a lease by hand. A lost stop/restart reply also uses the same operation.

After the intended maintenance, use:

```sh
cos_target operations-maintenance --request-id MAINTENANCE_UUID --phase release
```

Release verifies current access/schema before starting the same recorded payload.
It checks the new process, native host owner and actual injected runtime profile
before completing the lease. Failed health leaves it closed for repair/retry.
It restarts ordinary NanoClaw operation while the CoS binding remains paused;
`cosResumed` stays false. It grants no account, writer or model authority.

## Rotate credentials

Use the hold procedure before changing client credentials. An unreachable old
login can still stop the local service without claiming a database barrier. The
service shutdown closes its old pool; concurrent callers wait for the same
completion, and uncertain pool retirement cannot silently admit a replacement.

Have the database administrator issue the replacement secret. Replace only the
selected private runtime or migration profile through the existing secure
credential workflow, retaining ownership, mode 0600, hostname and certificate
validation. Do not paste either secret into chat or a command argument. Do not
change the service's target identity to bypass a failed login.

Repeat `hold` with the original UUID until it returns `held`, then run `release`.
Release checks authenticated new access and compares the selected runtime fields
with the restarted process in trusted memory. It rejects stale, duplicate,
test-profile or migration credentials in the service environment. Neither old/new
values nor password hashes are recorded. Changing a server password is a DBA
operation; restarting this bound service is already authorised by the programme.

## Coordinated backup and isolated restore

With a `held` maintenance lease, paused CoS and current private owner membership:

```sh
cos_owner operations-backup --scope "$COS_OPERATOR_SCOPE" \
  --request-id BACKUP_UUID --settings "$COS_OPERATOR_SETTINGS"
```

Retain its backup operation ID, checksums and operations manifest. The backup
pairs the scoped remote logical checkpoint, relevant central/session SQLite
snapshots, artifacts, conversation/mission/calendar state, software/schema
versions, revocations and independent action-journal identity. SQLite backup
handles journals/WAL; copying a live database file alone is insufficient. Bounded
logical-backup limits can refuse a large scope rather than quietly omit data.
Keep these private target backups on the Pi. Do not copy real conversation history
or account secrets to the Mac as fixtures.

The external server's backup/PITR policy remains separate and explicitly
unverified unless the DBA provides its own evidence. A release image archive,
logical CoS checkpoint and server backup serve different purposes.

Restore only to a different admitted test database and isolated local sandbox:

```sh
"$COS_OPERATOR_PAYLOAD/node/bin/node" \
  "$COS_OPERATOR_PAYLOAD/dist/modules/chief-of-staff/ops/target-owner-admin.js" \
  --settings "$COS_OPERATOR_SETTINGS" \
  --database-environment /absolute/private/selected-test.env -- \
  operations-restore-check --scope "$COS_OPERATOR_SCOPE" \
  --request-id RESTORE_UUID --backup-release BACKUP_OPERATION_ID \
  --settings "$COS_OPERATOR_SETTINGS"
```

The test environment file contains only `COS_TEST_PG*` connection/migration fields
and `COS_TEST_TARGET_ID`, with its Pi-resolved certificate path and mode 0600.
The restore process selects that profile alone. It checks database separation,
marker, schema/checksums and all paired artifacts. It never overwrites live Pi
SQLite, the runtime database, independent action journal or current admission.
Old approvals and copied authority do not become active.

After a restore, inspect stale leases, partial workers, outbox commands, native
schedules and effects newer than the backup. Retain original IDs. An older
database lacking an action receipt is not evidence that the action never occurred.
Provider read-back or the owner's disposition must resolve uncertainty before
writer admission. Post-backup native denials must match remote tombstones before
context resume. `operations-restore-check` produces evidence; it does not resume
CoS. See [calendar action operations](CALENDAR_ACTION_OPERATIONS.md) for the
separate live account/write proof and consent requirements.

## Export and retention

While held, use `owner-export --scope SCOPE --request-id UUID` through `cos_owner`.
It writes a private owner-local export and a checksum-only audit with a stable
identity. It includes owned priorities, readable work and currently admitted
staging-file sources. It excludes foreign/revoked sources, secrets, approval
challenges, provider credentials, ordinary conversation history and derived
artifacts.

`export-purge --scope SCOPE --request-id UUID --retention-days DAYS` accepts 0–365
days and removes only checked application-owned copies that have expired or are
no longer readable. It preserves unrelated files. Revocation cannot retract
copies already taken away, messages already delivered, provider storage or DBA
backup retention. Source/artifact retention and exposed-context purge retain
their existing separate checks in [delivery](DELIVERY.md).

## Install, upgrade, interrupted release and rollback

Follow [Mac release and Pi delivery](DELIVERY.md). Commit on the Mac, pass all
seven checks for the exact Linux/ARM64 host and both worker profiles, push that
source, then deliver its immutable manifest. The Pi verifies the detached pinned
source, loads/extracts the tested artifacts, backs up state, runs explicit scoped
migrations with its migration login, restarts and checks health. S11 uses schema
18 and native contract 22; it introduces no additional PostgreSQL migration.

Repeat an interrupted deployment with the same manifest and release ID. Its
receipt reconciles staging, load, extraction, migration, activation and health.
Use `--recover-from` only for the recorded failed predecessor after the new
candidate passes every Mac gate. Never clear a queue, drop a schema, steal a lock
or restore old live SQLite to force success.

Rollback selects only recorded artifacts compatible with the **current** schema
and native identities. It preserves current messages, sessions, approvals, intents
and effect receipts, and leaves CoS paused. Keep the current healthy release and
its complete compatible predecessor, source checkout, images and receipts.

Once S11 records an owner denial or revocation in native SQLite, S10 and older
releases are incompatible, even when their PostgreSQL/schema versions match.
Reconciled denials remain permanent downgrade barriers. Retain a tested S11
predecessor for rollback; if none is available, keep admission closed while a
compatible correction is built and tested on the Mac. Never delete denial records
or restore older live SQLite to make a downgrade pass.

## Programme closure and remaining live gates

After all S01–S11 and required corrections have verified human merges and mandatory
tests, delivery automatically seals the Pi lifecycle to `protected` before
operational repair can delay completion. A standalone closure command is
documented in [delivery](DELIVERY.md). No additional approval is required to
tighten protection. A stale/lost Mac ledger or code change cannot reopen disposal;
missing or contradictory closure history fails closed. Protected runtime cleanup
and in-place restore are refused. Continue tests on the separate admitted target.

If the exact final S11 release is already current when closure succeeds, the
Mac delivery command completes that release through its recorded maintenance
operation. It verifies the Pi-owned completion proof, exact payload/images and
retained clean source before releasing the service barrier. The operation has one
stable identity across retries. It refuses active workers and another operation’s
lease, and requires the bound native service and database health before restoring
admission. Database protection and the existing CoS pause remain in place.

If health is unverified during completion, retain the closed barrier and retry the
same tested release. Completion does not repeat migrations or restore data, grant
live account/model authority, or replace the original deployment receipt. A new
release or an interrupted deployment using an older retained helper continues
through the existing verified delivery and repair path.

The programme is complete only after the final reviewed source/images match the
healthy Pi release, recovery and independent-operation checks pass, and the actual
Pi protection receipt is confirmed. Keep code readiness distinct from live
activation. Subscription login, finite model policy, exact private channel/owner,
account consent, pilot usefulness and calendar writer reconciliation remain
separately gated. Deployment, restart, restore evidence or code review does not
approve a real action or extend an expired model allowance.
