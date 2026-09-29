# External PostgreSQL deployment contract

**Contract:** `cos-postgres/external-env-v3`  
**Applies to:** every slice, including fixtures, migration tooling and recovery.  
**Status:** requirements to implement; no database has been contacted or provisioned by this planning revision.  
**Implementation authority:** [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md) pre-authorises scoped live migrations and target deployments without additional human review; the bound CoS database is disposable until all slices are implemented.

## 0. Mac/Pi interpretation of this contract

[MAC_TO_PI_DELIVERY.md](MAC_TO_PI_DELIVERY.md) fixes three locations: Mac development/tests/builds, Pi NanoClaw runtime, and external PostgreSQL. “Host-service environment” below means the **Pi** for live runtime/migration operations. Mac test tools receive their **own explicitly supplied** process-env client profiles; they do not inherit, dump or copy the Pi service environment. No database credentials enter build stages, images or worker containers.

Local tests stay on the Mac and connect to remote PostgreSQL; neither development nor deployment provisions local PostgreSQL. Prefer the separate test DB for uninterrupted Pi service. The optional runtime-disposable profile remains allowed, but it requires current Pi-owned lifecycle verification, Pi CoS quiescence and a cross-host maintenance lease. The Mac's local lock/ledger is insufficient. Do not run a dev bot against Pi's live messaging identity. When a shared test changes schema incompatibly, leave CoS paused until a tested matching release or verified compatible schema is restored. Failure of local tests never authorises deploying the failed candidate.

The trusted Pi helper executes the actual runtime migrations after successful local release tests, with scoped Pi migration credentials. A tested host payload is transferred inside an image and extracted; no compilation or dependency installation occurs on the Pi. Service secrets are supplied by the actual target launcher; SSH does not automatically inherit them. After final implementation, the Pi's protected-data latch is authoritative and must be confirmed remotely.

## 1. Fixed deployment topology

PostgreSQL is an **existing, separately operated server on the same private network, on a different machine from NanoClaw**. The NanoClaw host is a PostgreSQL client. Only the trusted Pi CoS host module, scoped Pi administrative tools and explicitly configured Mac test/admin clients connect to it within their granted profiles.

NanoClaw central/session SQLite databases, source files and artifact bytes remain on the NanoClaw host. Do not move SQLite onto a network filesystem or convert NanoClaw runtime storage to PostgreSQL. Remote CoS storage does not make the host stateless or establish a multi-host NanoClaw deployment.

There must be **no PostgreSQL server container, package installation, database data volume, local server bootstrap, localhost fallback, or database `depends_on` service** in the application deployment. Do not add a local PostgreSQL server to make development, CI or a demonstration pass. A local TCP fault-injection proxy used only by tests is not a database server, and must be labelled as such. Its controlled transport override is confined to the test harness, retains the intended database TLS identity and protected test-target check, and is never accepted by the production configuration parser.

The external database administrator owns server installation, upgrades, storage, network/firewall rules, authentication configuration, database/role provisioning and server backups. These plans add client configuration, automatically authorised scoped application migrations and client-side operational runbooks. The trusted implementation process may deploy to the designated NanoClaw machine using its existing authorised execution/access route; it may not administer or SSH into the separate database server on the basis of this grant.

## 2. Environment-variable contract

The application reads connection settings from **the NanoClaw service process environment on its host**. It must not prompt for passwords in chat or obtain them through agent tools. Required values must be explicitly populated when CoS is enabled. Use the names below consistently throughout implementation.

| Variable | Requirement / default | Meaning |
|---|---|---|
| `COS_PGHOST` | Required | Private DNS name or private network IP of the separate database machine. No URL, socket path or implicit local default. |
| `COS_PGPORT` | `5432` | Explicitly parsed integer port, 1–65535. |
| `COS_PGDATABASE` | Required | Existing database selected for CoS; never infer from the OS username. |
| `COS_PGUSER` | Required | Least-privilege runtime login. |
| `COS_PGPASSWORD` | Required, secret | Runtime password, passed directly as a client property without URL encoding. |
| `COS_PGSSLMODE` | `verify-full` | Application-defined choices: `verify-full` or explicitly approved `disable`; see section 4. |
| `COS_PGSSLROOTCERT` | Optional | Absolute host-local CA bundle path when the server CA is not already trusted. Never mounted into agent containers. |
| `COS_PG_ALLOW_PLAINTEXT` | `false` | Must be `true` in addition to `COS_PGSSLMODE=disable` for an operator-approved plaintext LAN exception. |
| `COS_PG_POOL_MAX` | `5` | Maximum connections for the daemon's one shared runtime pool. |
| `COS_PG_CONNECT_TIMEOUT_MS` | `3000` | Connection/acquisition deadline. Test that the installed driver enforces both paths. |
| `COS_PG_STATEMENT_TIMEOUT_MS` | `5000` | Server-side statement deadline for normal domain operations. |
| `COS_PG_QUERY_TIMEOUT_MS` | `7000` | Client query deadline; configure greater than the statement deadline. |
| `COS_PG_LOCK_TIMEOUT_MS` | `2000` | Bound waiting for ordinary database locks. |
| `COS_PG_IDLE_TIMEOUT_MS` | `30000` | Idle pool connection eviction. |
| `COS_PG_IDLE_TX_TIMEOUT_MS` | `10000` | Terminate idle-in-transaction sessions. |
| `COS_PG_APPLICATION_NAME` | `nanoclaw-cos` | Non-sensitive label to distinguish application clients. |

These timeout/pool values are **initial design defaults**, not performance promises; bound and validate overrides. Credentials are opaque strings: do not trim, interpolate or log the password. Reject missing/empty required values and unchanged example placeholders. Restrict normal profile hostnames/IPs to the explicitly configured private-network target; reject loopback, wildcard addresses, local machine addresses and Unix sockets. A hostname alone does not prove another machine: record the operator's topology confirmation and verify resolution during deployment. Do not scan the LAN.

Use one validated configuration adapter for the host module, CLI, migration runner and test harness. Map the namespaced values into explicit `pg.Pool`/`pg.Client` properties. Do not use `new Pool()` with implicit defaults. Do not fall back to `DATABASE_URL`, ambient `PG*`, container defaults, `.pgpass`, or a different profile. Existing installations using other names may explicitly map them at the trusted service-launch boundary; the application still has one canonical contract. Do not implement competing URI and discrete-variable precedence rules.

Node-postgres documents both environment defaults and explicit configuration [PG01]. Our namespaced adapter and rejection rules are additional application requirements, not native `pg` variable names.

## 3. Service environment and credential boundaries

An interactive shell export is not evidence that a separately launched service received the same configuration. The deployment runbook must show how the **actual installed service manager** supplies these variables to the NanoClaw host process. Check presence through a redacted diagnostic, never by dumping `env`, `printenv`, a service environment, or a connection object into a model context or PR.

An operator-controlled environment file outside the repository can be used by the service launcher to populate its environment; it is optional, not an application dependency. It must be readable only by the relevant account/administrator and excluded from agent mounts, backups intended for export and Git. Do not put real values in `container.json`, a checked-in Compose file, a Docker build argument, an image, a skill, a prompt or an execution receipt. The included `POSTGRES_ENV.example` is documentation with placeholders, not live configuration.

The long-running daemon receives only runtime credentials. Supply migration credentials **only to the trusted migration process**. The implementing goal/deployment runner is pre-authorised to invoke it; no per-run human consent is required:

| Variable | Scope |
|---|---|
| `COS_PG_MIGRATION_USER` | Required by the explicitly invoked, standing-authorised migration command; never a daemon fallback. |
| `COS_PG_MIGRATION_PASSWORD` | Secret; required with migration user, only in that command's environment. |

Migration commands use the same explicit runtime host/port/database/TLS target, replacing the login with the migration login. They parse only that endpoint/security configuration and the selected migration login; they do not need the runtime password. Explicit diagnostics, tests and migration commands can run with `COS_ENABLED=false` without activating the CoS runtime. They never silently elevate a runtime connection. Missing migration credentials block schema changes, not unrelated chat.

At every host-to-provider, host-to-container and helper-process boundary, use an explicit safe environment allowlist. Strip all `COS_PG*`, `COS_TEST_PG*`, `COS_TEST_TARGET_ID`, ambient `PG*`, `DATABASE_URL` and any documented database aliases from **every agent** path, including unrelated agent/provider startup now sharing the host environment. Test synthetic secret canaries in environment values, provider contributions, mounted config, logs and generated commands. Merely excluding variables from Docker `-e` flags is not sufficient if a provider helper or inherited host subprocess can read them.

Only the trusted database client and explicitly selected database administration subprocess may receive the selected profile. Worker containers cannot reach the database directly; the CoS host broker remains the only source of authorised records. A LAN firewall that permits the host IP may also see NATed worker traffic as that IP, so test effective container egress isolation rather than treating a host-IP allowlist as proof of worker isolation.

For password rotation, drain/pause affected CoS work, update the operator's service-environment source, then perform the **standing-authorised service restart** and preflight without another approval. The same routine applies to migration/release restarts during implementation. A new shell export does not mutate the running daemon. Document the restart's impact on ordinary NanoClaw conversations rather than promising zero downtime. Dynamic secret reload is not required in this sequence.

## 4. Transport security and connectivity

`verify-full` means certificate-chain and server-name verification are both required. Implement it using explicit `pg` TLS options, `rejectUnauthorized: true`, the configured CA bundle when present, and the driver's normal hostname verification. Never override `checkServerIdentity` to accept arbitrary certificates. The certificate must match the configured DNS name or IP as appropriate. Test valid private-CA, unknown-CA, expired-certificate and hostname-mismatch cases against the selected driver/runtime. Node-postgres passes the TLS configuration into Node's TLS machinery [PG02].

The same LAN is not, by itself, a TLS exemption. An existing non-TLS installation can be used only after the operator explicitly accepts the risk and configures **both** `COS_PGSSLMODE=disable` and `COS_PG_ALLOW_PLAINTEXT=true`. Emit a non-secret warning and record that exception in deployment evidence. Never downgrade automatically after a TLS failure. Do not support permissive `prefer`, `allow`, or unverified `require` modes in this initial application contract. Do not use `NODE_TLS_REJECT_UNAUTHORIZED=0`.

The database administrator should restrict the configured database and roles to approved client addresses and use appropriate password authentication. PostgreSQL's `pg_hba.conf` selects connection/authentication rules [PG05]. The application must not edit those rules or open firewall ports automatically. Test/deployment access for a CI runner is a separate explicit network decision; do not expose the database publicly so hosted CI can reach it.

## 5. Database ownership and scoped migrations

Prefer a dedicated existing CoS database with a private `cos` schema. Sharing the **server** with other applications is allowed. Where the **database** itself is shared, the administrator must restrict CoS roles to `cos` and migrations must use fully qualified names; no changes to unrelated schemas, extensions, database defaults or roles.

The administrator provisions a schema-owner/migration login and a distinct runtime login. The runtime login gets only required connection, schema usage and table/sequence privileges; no superuser, `CREATEDB`, `CREATEROLE`, arbitrary schema creation, extension management or ability to become the migration role. Review inherited `PUBLIC` grants as part of provisioning; the application must not globally revoke grants in a shared database. Ensure new migration-created objects grant appropriate runtime access deliberately.

S01 introduces **proposed commands**, not commands that already exist:

```text
pnpm cos:db check --profile runtime
pnpm cos:db check --profile test
pnpm cos:db migrate-status --profile runtime
pnpm cos:db migrate --profile runtime --confirm-database <exact-database-name>
pnpm cos:db migrate --profile test --confirm-database <exact-test-database-name>
```

`check` is read-only: validate configuration, connect with bounded time, verify negotiated security and target identity, inspect server version, required privileges and schema compatibility; report safe status codes only. Server version is discovered, not upgraded. Verify compatibility against the actual externally operated major version and pin the application driver dependency accordingly.

`migrate-status` is read-only. `migrate` requires the explicit profile and confirmed database name, selected migration credentials, the recorded standing authority for the bound implementation target, checksummed migrations and a bounded migration lock. No human approval prompt or callback is required. Use one checked-out client and a session advisory lock held by that client across the migration sequence; on disconnect the runner stops and checks the ledger before retry. Transactional DDL is required for the initial migrations; any nontransactional operation needs its own documented, tested recovery procedure within the same standing operational authority. Normal daemon startup only checks schema compatibility and must never run DDL automatically. The trusted implementation/deployment runner invokes this migration phase non-interactively before starting the new release; the exact database-name argument is populated from its verified target binding, not requested from the owner each time.

Limit DDL to `cos`. Database/role creation, `DROP DATABASE`, server configuration and broad reset commands are out of scope. Routine rollback preserves data. During the disposable implementation period only, controlled fixture cleanup or a necessary scoped `cos` rebuild is allowed by the implementation-authority contract after target/quiescence/effect checks; never drop the database or foreign schemas. Long migrations use a separate explicitly bounded administrative timeout, not infinite runtime timeouts or hidden changes to server-wide settings. A schema compatibility failure disables CoS operations while unrelated NanoClaw work remains available.

## 6. Pools, timeouts and transaction handling

Use one small runtime pool per NanoClaw host process, not one pool per tool, mission, session or worker. Administrative/test processes have separately bounded pools; document their combined connection allowance before running them concurrently. Add an idle-pool `error` handler and release checked-out clients in `finally`. Destroy a client with uncertain transaction state rather than returning it to the pool. Node-postgres describes pool limits, client release, shutdown and background error events [PG03].

Use a bounded application queue in front of the pool (initially 20 pending operations) and a total request deadline. A full queue returns a safe busy/unavailable result instead of exhausting memory. A tool must finish within the declared RPC wait or return an honest pending/unavailable state. Do not stack five layers of independent retries. Start with at most three attempts for safe read-only requests, exponential backoff with jitter, a circuit-breaker/cooldown for connectivity failures, and no retry storms on invalid credentials or certificates.

Do not hold a transaction or pooled client across a model call, human approval, calendar HTTP request, container start or filesystem copy. Reserve/commit first, perform the external step, then record/reconcile. Statements in one transaction use the **same client**. Client/server statement, query and lock deadlines have separate meanings [PG04]; a client timeout is not proof of rollback.

## 7. Lost connections and ambiguous commits

Remote networking adds a specific failure boundary: the server can commit a transaction while the host loses the acknowledgement. For a mutating RPC, keep its stable `(session_id, request_id)` and canonical payload hash. Do not allocate a new request/mission/action merely because the first connection timed out.

After reconnection, resolve the original operation using a fresh connection and the unique operation record. Re-enter a deduplicated transaction under the same identity when necessary; uniqueness must resolve a race with the original transaction. Never infer rollback solely from a quick absent-row read while the old transaction might still be completing. Do not execute an external side effect until its required intent/authority commit is known to have succeeded.

If no durable operation was accepted, return unavailable without claiming that work was queued. If acceptance may have committed, return the original correlation ID with an explicit unresolved/pending status; do not invent a successful durable receipt. Restore the normal result only after reconciliation.

Loss of PostgreSQL blocks new CoS admissions, private retrieval, mutation, approval acceptance, worker wake and output publication. CoS content reads are **unavailable** when current source/authority checks cannot be made. Do not serve stale private content as a permission bypass. This differs from a stale calendar snapshot while PostgreSQL and current access policy are healthy.

The host maintains restrictive identity markers and an emergency pause latch locally. On detected database failure it closes CoS work admission and fences/stops affected CoS containers through that trusted local path, without needing a successful database write. Already in-flight provider requests cannot be recalled. No worker restart/renewal or new disclosure is permitted until authority and budgets are reconciled. Record pending stop/cancel intentions locally for replay; this is a **deny-only safety record**, not a writable offline CoS database or a new source of authorisation.

On reconnection, validate configuration, target/schema and current authority, reconcile operation results, leases, reservations and outbox records, then reopen only work that remains eligible. Respect explicit pause, cancelled generations and source revocations. Never reset budgets, clear receipts or replay every missed briefing. Use database time for lease comparisons; human schedules retain their IANA timezone semantics.

## 8. Explicit test profiles and the disposable implementation target

All integration tests use actual PostgreSQL on the separate LAN server. A second external database is optional during S01–S11 because the owner has explicitly declared the configured CoS runtime database disposable. Do not introduce an approval or infrastructure gate merely to restate that declaration.

### Profile selection

Add the explicit selector `--db-profile test|runtime-disposable` to `cos:test` and fixture `cos:demo`. Store the chosen profile in the private goal ledger and each test receipt. These are tool profile choices, not new database endpoints. No implicit runtime credential fallback is permitted.

| Selection | Connection source | Required checks |
|---|---|---|
| `test` | Independently configured `COS_TEST_PG*` | Separate admitted target, protected DBA marker and test-role boundary. |
| `runtime-disposable` | Existing `COS_PG*`, with migration credentials only in migration subprocesses | Bound runtime target, current disposable lifecycle, active incomplete goal, exclusive target lock, CoS quiescence, isolated local state and no unresolved real-effect hazard. |

When a complete separate test profile is supplied, prefer it. When none is configured, the goal may explicitly select `runtime-disposable` without another human approval. If an explicitly chosen profile is incomplete, unreachable or invalid, report that error; do not silently switch. In all cases, reject loopback/local database servers and unconstrained profile/target names supplied by model output.

### Separate external test target

The test profile uses the same suffixes as runtime with `COS_TEST_PG` replacing `COS_PG`, for example `COS_TEST_PGHOST`, `COS_TEST_PGDATABASE`, `COS_TEST_PGUSER`, `COS_TEST_PGPASSWORD`, `COS_TEST_PGSSLMODE`, `COS_TEST_PGSSLROOTCERT`. Parse it independently using documented non-secret defaults; never borrow missing runtime values. Migration credentials are `COS_TEST_PG_MIGRATION_USER` and `COS_TEST_PG_MIGRATION_PASSWORD`.

For this separate profile only, require `COS_TEST_TARGET_ID` to match the DBA-provisioned read-only marker in `cos_admin.target_identity`: `target_id` and `purpose='test'`. Roles may manage the test database's `cos` schema, not the marker. Reject a known runtime target masquerading as `test`; use the explicit runtime-disposable path when that is intended. Serialize suites or use independently provisioned targets for parallel jobs.

### Bound runtime-disposable target

S01's trusted host tool creates a private, host-owned target/lifecycle binding outside PostgreSQL and agent mounts, based on the actual service deployment and configured endpoint/database identity. The goal's standing authority is sufficient to initialise it while the programme is incomplete; do not require a new `ALLOW_LIVE_MIGRATION` flag, approval card, manual confirmation or DBA marker for this mode. Record only safe identifiers/fingerprints in public evidence. Check current configuration and database identity against the private binding every time.

The tool closes CoS admission, drains/fences CoS workers, checks external-effect safety and holds an exclusive target lock before testing. Use fixture scopes with explicit ownership/run IDs, isolated local SQLite and isolated artifact roots. Ordinary fixture cleanup deletes only that run's records. End with the correct runtime schema, reconcile affected CoS projections and reopen only still-authorised work. This may temporarily pause CoS; it must not destroy ordinary NanoClaw messages, sessions or other workloads.

Necessary destructive migration tests or disposable fixture resets are allowed only under the scoped checks in [IMPLEMENTATION_AUTHORITY.md](IMPLEMENTATION_AUTHORITY.md). Do not wipe effect identity/uncertainty records while an external calendar or message effect could still be replayed. Never use a cleanup to make a failed recovery assertion disappear, drop the whole database, alter `cos_admin`, modify foreign schemas or change server-wide configuration.

After all slices meet their implementation/merge criteria, or when valuable data is declared present earlier, automatically and monotonically close disposal before admitting that data. A protected or unknown lifecycle rejects runtime-disposable tests, in-place runtime restore and fixture resets. Reopening a goal or losing an execution ledger cannot restore this permission. Further destructive tests require a separately admitted disposable external target; routine data-preserving migrations/deployments for the bound goal still use automated safeguards rather than a new human review gate.

### Tests and network isolation

Missing every eligible test route blocks required integration acceptance. Missing just the separate `COS_TEST_PG*` database is not a blocker when runtime-disposable is valid. Unit work can proceed around an actual integration prerequisite failure, but mocks alone cannot satisfy the vertical gate.

CI needs an existing authorised network route and scoped credentials. Prefer an authorised runner on the private network. Never expose credentials to untrusted PR jobs or install a VPN/open firewall/start local PostgreSQL to bypass access problems. Fault injection operates on the harness connection or a controlled proxy only; do not stop the shared server or alter its global firewall. Keep certificates and normal runtime transport policy intact.

## 9. Health, backups and restore

Expose CoS dependency states: disabled, misconfigured, unreachable, authentication_failed, tls_failed, schema_incompatible, reconciling and ready. Separate them from NanoClaw process liveness. Diagnostic output contains safe status codes, variable **names** that are missing, schema/driver versions and counts; not secrets, full connection objects, raw SQL parameters or private server error details.

The PostgreSQL server has its own administrator-managed backup/retention/PITR policy. NanoClaw backups must additionally capture local SQLite, source/artifact files, host-owned restriction/binding metadata and the matching CoS checkpoint. A database backup does not include those local files. PostgreSQL documents the snapshot consistency of a database dump [PG06]; it does not provide a cross-store snapshot of this application.

Before actual S09 external writes, implement a quiesce barrier and a manifest pairing a recoverable remote database backup/checkpoint with consistent local SQLite backups and checksummed artifacts. Disposable content does not make a real calendar effect disposable. Routine implementation migrations/deployments require no human backup approval and no wait for a DBA-operated backup when scoped disposable CoS data is all that is affected; protected local-state backups and mandatory recovery tests still apply. S11 exercises the full drill. A client-side logical export can be an additional authorised artifact, not a claim that production backup/PITR is solved. Do not copy a remote server data directory or assume a local PostgreSQL volume exists.

For an implementation restore drill, prefer an admitted **separate external restore/test database** with its own environment and marker. If none is provisioned and the runtime is still eligible for disposal, the trusted goal may quiesce CoS and restore only its disposable `cos` data in place under the bound runtime-disposable contract. No extra human migration/deployment review is required. Disable effects and reconcile or conclusively exclude every real/uncertain external effect before an in-place drill. Never overwrite protected runtime records, foreign schemas or server configuration. Always restore local NanoClaw files into a separate isolated data root, never over the running installation's protected SQLite/sessions. Verify manifests, revocations and schema before restarting CoS, and preserve checkpoints outside the disposable DB. Once data is protected, an isolated external restore target is mandatory for destructive restore testing. No PostgreSQL server restart or role change is authorised. Keep passwords out of exports and re-inject them through the host environment separately.

## 10. Slice responsibilities

| Slice | Remote-database work in that vertical flow |
|---|---|
| S01 | Validated env configuration, external preflight, automatically authorised scoped migration/deploy tooling, credential isolation, commit reconciliation, explicit test profiles and host-owned disposable lifecycle. |
| S02 | Atomic publication across remote records/local files; no private retrieval during database-policy uncertainty. |
| S03 | No incomplete remote snapshot promotion after a database disconnect; connector credentials remain distinct from DB credentials. |
| S04 | One briefing occurrence after a partition; no stale-authority notification or backlog storm. |
| S05 | Workers have neither database credentials nor a database network route; deny-only local stop during database loss. |
| S06 | Root budget reservations and join state survive contention/connection loss; bounded shared pool. |
| S07 | Feedback/dismissal persists before acknowledgement and survives ambiguous commits. |
| S08 | No mandate admission/renewal/publication without current remote authority and budget checks. |
| S09 | Lost DB connection after remote calendar success cannot trigger a duplicate event. |
| S10 | Review input versions remain explicit; failed database snapshots cannot masquerade as complete strategic evidence. |
| S11 | Network-aware readiness, automatically authorised restart/deployment, coordinated backup and guarded restore, plus monotonic closure of disposable data at programme completion. |

## 11. Primary implementation references

These references support client behaviour, not proof that the target server is already configured. Revalidate driver APIs and the actual server version during implementation.

- **PG01 — [node-postgres connection configuration](https://node-postgres.com/features/connecting):** explicit settings and built-in environment/local defaults. CoS defines its own namespaced adapter.
- **PG02 — [node-postgres TLS](https://node-postgres.com/features/ssl):** explicit TLS options; mixing URI SSL parameters with an SSL object can replace the object. This plan avoids that ambiguity.
- **PG03 — [node-postgres pool API](https://node-postgres.com/apis/pool):** pool lifecycle, limits, checked-out clients, transactions and background errors.
- **PG04 — [node-postgres client API](https://node-postgres.com/apis/client):** statement/query/connect/lock timeouts, keepalive and idle-in-transaction options.
- **PG05 — [PostgreSQL client authentication](https://www.postgresql.org/docs/current/auth-pg-hba-conf.html):** server-side connection/authentication rules, owned by the database administrator.
- **PG06 — [PostgreSQL SQL dump](https://www.postgresql.org/docs/current/backup-dump.html):** database dump consistency and restoration; select the matching server-version documentation when operating it.
