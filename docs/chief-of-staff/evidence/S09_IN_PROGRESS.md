# S09 implementation checkpoint

**Status:** incomplete; fixture evidence only. No S09 release, Pi deployment or review gate has passed.

The reviewed predecessor is S08 merge `462daabef958b9ba1874168719737ad7b39ef8e8`
([PR #65](https://github.com/ufJmacca/nanoclaw/pull/65)). The implementation branch is
`codex/s09-approved-calendar-actions`; this checkpoint covers source through
`6da15fc54c684acd016ce62fa5913f05f54db0b3`. Private logs and configuration remain outside Git.

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

Recorded development-container gates include:

- 29 external PostgreSQL action tests, including actual connection and commit-acknowledgement failures with a simulated provider;
- 39 coordinated backup and native preservation checks;
- 195 affected host, conversation, approval and scheduling regressions;
- 91 action/result/backup checks and 114 action/host/discovery checks;
- 178 OAuth/calendar checks and 171 vault/calendar checks;
- root type checks and zero-warning lint for the increments above.

The complete repository regression run passed 2,425 tests in 242 files after
adding S09's schema-16 release checks. The preceding run exposed an S08 test
fixture that incorrectly included every new migration. Its corrected fixture
pins the historical S08 schema at 15; S09 requires exactly schema 16. The release
and native compatibility checks passed 46 tests in three files. These checks do
not constitute an S09 image build or deployment acceptance.

These are separate, overlapping runs, not an additive test total. The selected
separate test database is at schema 16. The Pi remains on the accepted S08 release
and schema 15. No real OAuth request, calendar write, model invocation or message
was made in this continuation.

Remaining S09 work includes production configuration and operator setup,
verified target backup proof before writer admission, the complete native fixture
demonstration, cumulative release registration, exact Linux/ARM64 image tests,
source synchronization, Pi migration/deployment/preservation checks and one
reviewable PR. Live calendar consent and validation remain pending. S10 is not
eligible until S09 has a legitimate reviewed merge and accepted merged deployment.
