# S09 implementation checkpoint

**Status:** incomplete; fixture evidence only. No S09 release, Pi deployment or review gate has passed.

The reviewed predecessor is S08 merge `462daabef958b9ba1874168719737ad7b39ef8e8`
([PR #65](https://github.com/ufJmacca/nanoclaw/pull/65)). The implementation branch is
`codex/s09-approved-calendar-actions`; this checkpoint covers source through
the separately committed increments described below. The final release source
has not been selected. Private logs and configuration remain outside Git.

The fixture implementation now proposes and records an exact owner-approved
calendar block, leases its execution, records request start before contacting the
provider, and verifies the original event by readback. The existing NanoClaw host
pump uses the retained main CoS conversation. Result notices are private, add
passive context without waking a model, and consume their send record in the
independent target journal before transport.

Coordinated PostgreSQL, SQLite and artifact backup/restore tests recover an event
created after the checkpoint by its original ID without a second create request.
The scoped PostgreSQL restore is a fixture helper; the production backup and
restore-proof admission path remains to be connected. The independent effect and
notification journal is never restored as historical permission.

Separate writer OAuth and vault owners request exactly owned-event write access
and calendar-list metadata. The existing reader's requested scope and stored
credential identity remain unchanged. The main context exposes only writer ID,
selected calendar, enabled state and the narrow action profile.

The writer vault now opens through a separate, explicitly enabled host
configuration. It verifies protected credential and backup storage and pins the
writer client, vault and denial journal; it never falls back to reader credentials.
The affected configuration/calendar run passed 182 tests in 16 files, including
15 writer configuration checks.

Restore verification now compares every remote scoped row and the isolated local
SQLite/artifact bytes, checks the protected test marker and repeats local checks
after database waits. Its backup/native preservation run passed 46 tests in four
files. The actual test-database restore uses the same database as its fixture
checkpoint and is explicitly ineligible for production writer admission. A copied
remote export with an unrestored database is rejected. Target recovery proof
recording and production writer admission remain pending.

The target deployment path now takes a second paired action backup after the
schema-16 migration and before recording migration acceptance. It checks the
current maintenance owner, stopped service/containers and absent native writer;
captures the central database and every existing session database; and verifies
retained conversation, specialist and protected calendar backups. Fourteen target
backup checks and the affected migration/journal/history checks passed together
as 85 tests in seven files. This is local fixture coverage of the concrete target
path; no S09 operation has run on the Pi yet.

The host consent profile now rejects broader scopes, foreign identities, changed
grant references and malformed private records. Recovery admission validates the
exact target backup, all backup families, schema 16, the independent journal and
a separately identified protected restore database. The calendar backup must
contain the exact writer vault/reference with its narrow scopes; archived tokens
are never returned or restored. These gates passed 246 affected tests in 19 files,
including 22 profile checks and six writer backup checks, with type checks and
zero-warning lint. The existing NanoClaw bootstrap now opens the separate action
host after confirming the database identity and schema. Writer discovery omits
disabled grants; an existing grant can still read back its original event when
new writes are disabled. Owner, session, binding, pause, storage and recovery
changes close provider admission, including changes during an awaited token.
Owner setup and link commands now verify protected storage, initialize only fresh
writer directories, take real fixture backups and use the existing loopback/PKCE
listener with exactly the writer scopes. Linking creates a separate consent
record and leaves writes disabled. Uncertain exchanges are never repeated and
corrupt setup history is preserved. The affected reader/owner/admin run passed
52 tests in five files, with types and zero-warning lint. Operator configuration
and proof recording remained at that checkpoint. The configuration command now
requires exact existing consent, ready protected credentials and the verified
separate-database recovery baseline before a confirmed admin commit can publish
host permission. The disable command changes only new-write admission and needs
no database or recovery connection. Its binding identity remains available for
admitted readback. Ten configuration checks and four native authority routes
passed together with the affected host/profile/owner tests: 90 tests in six files,
types and zero-warning lint. No production profile or live writer has been
created. Proof recording remains pending; see the
[operator runbook](../CALENDAR_ACTION_OPERATIONS.md).

The sandbox importer now admits only a fresh scope in a separately identified
protected test database. It checks the captured columns, scope identity, schema
and marker, inserts dependency-ordered rows and verifies the complete result.
It never updates or deletes existing rows. A durable start record permits an
unknown commit to be reconciled by readback without another insert. Seven new
import checks passed with the 22 backup checks. The real test database also
passed an import of synthetic foreign-source rows, dependent writer revisions,
retry readback and refusal from a different operation. All 30 PostgreSQL action
tests passed. No production recovery proof was issued from that synthetic source.
Types and zero-warning lint passed at that checkpoint.

The owner backup and restore-proof commands are now connected through the
existing paused private-channel and native host-lease controls. Fresh backup
checks the exact bound settings and existing independent journal. Restore selects
only the protected test database profile, verifies isolated local bytes before
import, matches the actual imported database to the verified proof and publishes
no host writer permission. The changed-database proof test first failed because
the mismatched proof was accepted, then passed with the identity check added.
The complete repository run passed 2,548 tests in 249 files; all 30 PostgreSQL
action tests, root types and zero-warning lint also passed. No production restore
proof, writer profile or live account activation was created.

Recorded development-container gates include:

- 29 external PostgreSQL action tests, including actual connection and commit-acknowledgement failures with a simulated provider;
- 39 coordinated backup and native preservation checks;
- 195 affected host, conversation, approval and scheduling regressions;
- 91 action/result/backup checks and 114 action/host/discovery checks;
- 178 OAuth/calendar checks and 171 vault/calendar checks;
- root type checks and zero-warning lint for the increments above.

The complete repository regression run passed 2,506 tests in 246 files after
connecting the action host. The earlier release-contract run exposed an S08 test
fixture that incorrectly included every new migration. Its corrected fixture
pins the historical S08 schema at 15; S09 requires exactly schema 16. The release
and native compatibility checks passed 46 tests in three files. Root types and
zero-warning lint passed for the runtime increment. These checks do
not constitute an S09 image build or deployment acceptance.

These are separate, overlapping runs, not an additive test total. The selected
separate test database is at schema 16. The Pi remains on the accepted S08 release
and schema 15. No real OAuth request, calendar write, model invocation or message
was made in this continuation.

Remaining S09 work includes verified target backup proof before live writer
admission, the complete native fixture
demonstration, cumulative release registration, exact Linux/ARM64 image tests,
source synchronization, Pi migration/deployment/preservation checks and one
reviewable PR. Live calendar consent and validation remain pending. S10 is not
eligible until S09 has a legitimate reviewed merge and accepted merged deployment.
