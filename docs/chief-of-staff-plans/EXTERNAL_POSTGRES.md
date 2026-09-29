# External PostgreSQL deployment contract

**Contract:** `cos-postgres/external-env-v3`  
**Plan revision:** 5. **Applies to:** all slices, tests, migrations and recovery. **Status:** requirements, not evidence that a database was contacted.

## 1. Topology and ownership

Use an existing separately operated PostgreSQL server on another machine on the same private network. Mac trusted test tools and Pi trusted host/admin processes are clients. NanoClaw central/session SQLite and source/artifact files stay local; do not move SQLite onto network storage or convert runtime storage to PostgreSQL. Remote domain state does not make NanoClaw stateless or multi-host.

No local PostgreSQL server/container/package/data volume/bootstrap/localhost fallback/Compose depends_on on Mac or Pi, including CI. A controlled test TCP fault proxy is not a DB server: confine override to the harness, retain intended TLS identity and target guards, and reject it in production parsing.

The DBA owns server installation/upgrades, storage, network/auth rules, databases/roles and server backups. Application operations cover scoped `cos` migrations and client runbooks only. No server SSH/admin, foreign schemas, extensions, DROP DATABASE, global grants or firewall changes.

## 2. Canonical environment contract

Read runtime configuration from the Pi NanoClaw service process environment, not a model prompt, chat, implicit shell assumption or mounted worker config. Names are application-defined and mapped explicitly to `pg.Pool`/`pg.Client` properties.

| Variable | Requirement/default |
|---|---|
| COS_PGHOST | Required private DNS/IP of separate machine; no URI/socket/local default. |
| COS_PGPORT | 5432; validate 1–65535. |
| COS_PGDATABASE | Required existing target; never derive from OS user. |
| COS_PGUSER | Required least-privilege runtime login. |
| COS_PGPASSWORD | Required opaque secret; do not trim/interpolate/log. |
| COS_PGSSLMODE | verify-full; only other supported value is explicitly approved disable. |
| COS_PGSSLROOTCERT | Optional absolute host-local CA path, not a worker mount. |
| COS_PG_ALLOW_PLAINTEXT | false; must also be true for a pre-approved disable exception. |
| COS_PG_POOL_MAX | 5 for one shared daemon pool. |
| COS_PG_CONNECT_TIMEOUT_MS | 3000; bound connection and acquisition paths. |
| COS_PG_STATEMENT_TIMEOUT_MS | 5000 server-side ordinary statement limit. |
| COS_PG_QUERY_TIMEOUT_MS | 7000 client deadline, greater than statement limit. |
| COS_PG_LOCK_TIMEOUT_MS | 2000 ordinary lock wait. |
| COS_PG_IDLE_TIMEOUT_MS | 30000 pool idle eviction. |
| COS_PG_IDLE_TX_TIMEOUT_MS | 10000 idle-in-transaction limit. |
| COS_PG_APPLICATION_NAME | nanoclaw-cos, non-sensitive. |

These are validated initial defaults, not performance promises. Reject absent/empty/unchanged placeholders. Normal targets reject loopback, wildcard, Unix socket and local machine addresses; verify DNS resolution and known installation/database binding. Hostname alone does not prove another machine; record existing topology and do not scan the LAN.

One parser serves daemon, CLI, migration and tests. No `new Pool()` implicit defaults, DATABASE_URL, ambient PG variables, .pgpass, container defaults or competing URI precedence. Existing env names may be mapped deliberately by the trusted launcher; application input remains canonical.

Migration credentials `COS_PG_MIGRATION_USER` and `COS_PG_MIGRATION_PASSWORD` enter only the selected migration process. Reuse explicit runtime endpoint/TLS settings but replace login; runtime password is not needed to migrate. Daemon never retains or falls back to migration privilege. Missing migration credentials block DDL, not unrelated chat. Diagnostics/admin tools may run with COS_ENABLED=false without enabling runtime CoS.

## 3. Service environment and credential boundaries

An interactive export does not prove a service manager received variables. Document the actual installed manager/launcher and verify presence with redacted diagnostics, not env/printenv dumps or credential objects. An optional owner-controlled env file outside Git/mounts may feed the launcher; protect permissions and exclude it from portable exports.

Pi runtime/admin secrets stay on Pi. Mac tests need a separately supplied process-env profile, including when using the disposable runtime endpoint; never copy/dump Pi secret files over SSH. SSH does not automatically inherit systemd service env. Migration helper must deliberately use the existing protected injection mechanism.

Every host-to-provider/container/helper boundary uses a safe env allowlist, stripping all COS_PG*, COS_TEST_PG*, COS_TEST_TARGET_ID, ambient PG*, DATABASE_URL and documented aliases. Apply to unrelated agent paths sharing the host process too. Inspect synthetic canaries in contributions, mounts, commands, logs and downstream environments. Excluding only Docker -e flags is insufficient if a provider helper inherits secrets.

Workers cannot reach PostgreSQL directly. Host-IP allowlists may also match NATed workers, so verify actual network confinement. Only the host broker provides scoped records. Rotation pauses affected work, updates the protected env source and uses the already authorised restart/preflight; no zero-downtime claim and no automatic plaintext downgrade.

## 4. TLS and access

verify-full requires chain and hostname verification, explicit TLS options with rejectUnauthorized true and configured CA when needed. Do not override hostname validation. Test private-CA success, unknown/expired certificates and mismatched name/IP against the chosen driver. Revalidate current node-postgres APIs at implementation.

LAN membership is not a TLS exemption. Existing plaintext requires a separately accepted exception with both SSLMODE=disable and ALLOW_PLAINTEXT=true, visible non-secret warning and evidence. Never downgrade after failure; do not support permissive allow/prefer/unverified require or NODE_TLS_REJECT_UNAUTHORIZED=0.

DBA restricts client routes and database/role authentication. CI access is an explicit network decision; do not expose database ports publicly, create a VPN or alter firewall/auth rules to make tests pass. Prefer an already authorised LAN runner. Do not expose DB test secrets to untrusted PR jobs.

## 5. Scoped privileges and migrations

Prefer a dedicated existing database with `cos` schema; sharing the server is fine. If database is shared, use fully qualified owned names and restricted roles. DBA provisions a schema-owner/migrator and distinct runtime login with only necessary CONNECT/USAGE/table/sequence grants; no superuser, CREATEDB/CREATEROLE or role escalation. DBA reviews inherited PUBLIC grants; app does not revoke them globally. New objects receive deliberate runtime grants.

S01 introduces proposed commands:

```text
pnpm cos:db check --profile runtime
pnpm cos:db check --profile test
pnpm cos:db migrate-status --profile runtime
pnpm cos:db migrate --profile runtime --confirm-database <verified-name>
pnpm cos:db migrate --profile test --confirm-database <verified-test-name>
```

Check/status are read-only, bounded and redacted: configuration, target identity, negotiated security, actual server version/compatibility, privileges/schema. Driver/version compatibility is discovered and pinned; no server upgrade.

Migrate requires explicit target/profile, scoped migration env, checksums and bounded lock. The exact-target argument is a machine assertion filled from verified binding, not another human confirmation. Existing standing approval covers in-scope runtime DDL. Hold a session advisory migration lock on one checked-out client; disconnect stops runner and checks ledger before retry. Initial DDL is transactional; nontransactional changes require a documented reviewed recovery design. Daemon startup never runs DDL. Bound administrative timeout separately, not infinite/server-wide changes. No destructive routine rollback.

## 6. Pooling and deadlines

One runtime pool per host, not per tool/session/worker. Bound admin/test connections and total concurrency. Add pool error handlers; release clients in finally and destroy uncertain-transaction clients. A transaction uses the same checked-out client. Do not hold it across models, human waits, HTTP, container startup or file copies.

Use bounded application queue (initially 20 waiting operations) and total RPC deadline; return busy/unavailable rather than unbounded memory growth. Safe read-only retries initially at most three with exponential jitter/cooldown; no invalid-auth/cert storm or stacked independent retry multiplication. Client timeout does not prove rollback. Poll waits return an honest durable operation/correlation state.

## 7. Partitions, ambiguous commits and fail-closed recovery

Remote server can commit before acknowledgement is lost. Preserve `(session_id,request_id)` and payload hash. Reconnect and resolve using unique operation records; if necessary re-enter same deduplicated transaction, allowing uniqueness to resolve races with an original still completing. Do not interpret a fast absent-row read as rollback or create a new mission/action ID. External effects require known committed intent/authority.

Not accepted means unavailable, not queued. Possibly committed means original correlation with explicit unresolved state, not fabricated durable receipt. Once reconciled return original result.

DB uncertainty stops new CoS admission/private retrieval/mutation/approval acceptance/wake/publication. No stale-private-content cache bypass. Local host restriction markers and emergency pause latch close/fence/stop CoS execution without depending on another DB write. In-flight external requests cannot be recalled. Local records are deny-only stop/cancel intentions, not an offline CoS authorisation database.

Reconnect validates target/schema/current permissions, reconciles operations/leases/budgets/outbox and explicit cancellation/revocation before reopening eligible work. Pause stays until authorised resume. No budget reset, receipt erasure or missed-brief backlog. Leases use DB time; human schedules retain timezone semantics.

## 8. Test profiles and disposable period

Preferred separate external DB uses independently parsed COS_TEST_PG* equivalents of every runtime suffix, plus COS_TEST_PG_MIGRATION_USER/PASSWORD. No runtime fallback/inherited security config. COS_TEST_TARGET_ID must match DBA-owned read-only `cos_admin.target_identity` row containing target_id UUID and purpose=test. Runtime/migration test roles cannot modify that marker. Reject known runtime target aliases. Serialize suites with bounded lock or use separately provisioned test targets; clean only owned fixture rows/artifacts, not whole database/foreign schemas.

During this programme the owner permits explicit `--db-profile runtime-disposable` when no separate profile is selected and target safety checks pass. This does not require another DBA marker or approval flag: verify existing Pi-owned installation/database/lifecycle declaration, active incomplete goal, cross-host target lease and Pi CoS quiescence. Never silently switch from partial/failing test configuration. Mac tests use isolated local SQLite/artifacts and explicitly provided DB credentials.

Fixture scopes do not isolate schema changes. Keep Pi CoS paused after incompatible tests until safely restored or a locally tested matching release is deployed. Failing local tests do not justify deploying untested code. A Mac lock alone cannot stop Pi writers. Lost Mac process requires target receipt/lease reconciliation; uncertainty prevents automatic resume. First S01 may use validated existing maintenance operations to prove no writer before the new helper exists.

Routine cleanup is scope-limited. Exceptional disposable rebuild needs no additional consent but must refuse protected state, active workers or real/uncertain effects whose identities might be replayed. Preserve native projections and external receipts; no database drop, cos_admin alteration, foreign schema or protected local-state reset. At all-slice completion the Pi lifecycle becomes protected monotonically; runtime-disposable is then unavailable. See IMPLEMENTATION_AUTHORITY.md.

Missing every eligible target blocks integration gates; unit work may proceed but mocks cannot satisfy DB acceptance. A missing second database alone does not block valid disposable-runtime tests. Fault injection alters only test connection/proxy, not server or firewall.

## 9. Backups, restore and slice responsibilities

DBA-managed backups/PITR are separate from application checkpoints. CoS must pair remote recoverable database state with consistent local SQLite, artifacts, bindings/restrictions and schema/software/image manifest. No remote data-directory copy/local Postgres volume assumption. Logical exports are additional authorised artifacts, not proof of complete PITR.

Before S09 writes, quiesce and demonstrate coordinated restore. Prefer a separate admitted external restore/test DB with isolated local roots and no egress/admission until checks and newer-effect reconciliation pass. Eligible disposable-runtime tests may exercise scoped fixture restore under its strict lifecycle/lease/effect contract; protected runtime and actual local NanoClaw data are never overwritten. Reprovision secret env separately. An older DB missing a receipt does not establish absence of a real provider effect.

S01 implements env/role/pool/preflight/migration/secret guards and commit reconciliation. S02 protects file+remote publication. S03 snapshots cannot promote partially. S04 occurrences remain stable. S05 stops/fences workers with no direct DB access. S06 roots/budgets/joins survive contention. S07 preserves dispositions. S08 denies stale mandates. S09 reconciles provider success after DB loss. S10 requires complete approved review snapshots. S11 tests redacted readiness, rotation and cross-store restore. Individual PG test IDs are specified in each plan and mandatory.

## References

- [node-postgres configuration](https://node-postgres.com/features/connecting)
- [node-postgres TLS](https://node-postgres.com/features/ssl)
- [Pool API](https://node-postgres.com/apis/pool) and [Client API](https://node-postgres.com/apis/client)
- [PostgreSQL authentication](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html)
- [PostgreSQL SQL dump](https://www.postgresql.org/docs/current/backup-dump.html)

These support client behaviour, not proof the user's server is configured. Verify selected versions during implementation. Repeated execution/release/receipt rules live in SLICE_EXECUTION_RULES.md.
