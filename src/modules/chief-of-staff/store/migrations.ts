import pg from 'pg';
import { createHash } from 'node:crypto';
import { DatabasePreflightError } from './preflight.js';

// Versioned source is part of the immutable host payload; startup only reads
// the ledger. DDL runs solely through the explicit migration command.
export const INITIAL_SCHEMA = `
CREATE TABLE cos.scopes (
  id text PRIMARY KEY, owner_id text NOT NULL, instance_id text NOT NULL,
  channel_id text NOT NULL, agent_group_id text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('active','paused','revoked')),
  version integer NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(instance_id,channel_id)
);
CREATE TABLE cos.records (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL CHECK (kind IN ('charter','goal','project')),
  title text NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  description text NOT NULL CHECK(length(description) <= 8000),
  lifecycle text NOT NULL CHECK(lifecycle IN ('active','inactive')),
  version integer NOT NULL CHECK(version > 0), provenance jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(scope_id,id)
);
CREATE UNIQUE INDEX one_active_charter ON cos.records(scope_id) WHERE kind='charter' AND lifecycle='active';
CREATE TABLE cos.proposals (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  session_id text NOT NULL, ingress_id text NOT NULL, owner_id text NOT NULL,
  change jsonb NOT NULL, payload_hash text NOT NULL, challenge_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('pending','approved','rejected','applied','conflict','expired')),
  expires_at timestamptz NOT NULL, decision_ingress_id text UNIQUE,
  applied_record_id text, version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.operations (
  session_id text NOT NULL, request_id text NOT NULL,
  scope_id text NOT NULL REFERENCES cos.scopes(id), method text NOT NULL,
  payload_hash text NOT NULL, result jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(session_id,request_id)
);
CREATE TABLE cos.events (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL, resource_id text NOT NULL, version integer NOT NULL,
  provenance jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE cos.outbox (
  id text PRIMARY KEY, scope_id text NOT NULL REFERENCES cos.scopes(id),
  kind text NOT NULL CHECK(kind IN ('approval_preview','proposal_apply','rpc_response')),
  payload jsonb NOT NULL, delivered_at timestamptz,
  attempts integer NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
`;
export const INITIAL_CHECKSUM = createHash('sha256').update(INITIAL_SCHEMA).digest('hex');
const LOCK_ID = 73101001;
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

function validateHistory(rows: Array<{ version: number; checksum: string }>): number {
  if (!rows.length) return 0;
  if (rows.length !== 1 || rows[0].version !== 1 || rows[0].checksum !== INITIAL_CHECKSUM) {
    throw new DatabasePreflightError('migration_checksum');
  }
  return 1;
}

export async function migrate(client: pg.Client, runtimeRole: string): Promise<number> {
  if (!runtimeRole || runtimeRole.length > 63 || /[\0\r\n]/.test(runtimeRole))
    throw new DatabasePreflightError('runtime_role_required');
  const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [LOCK_ID]);
  if (!lock.rows[0]?.locked) throw new DatabasePreflightError('migration_busy');
  try {
    await client.query('BEGIN');
    await client.query(`CREATE TABLE IF NOT EXISTS cos.schema_migrations (
      version integer PRIMARY KEY, checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp())`);
    const status = validateHistory(
      (await client.query('SELECT version,checksum FROM cos.schema_migrations ORDER BY version')).rows,
    );
    if (status === 0) {
      await client.query(INITIAL_SCHEMA);
      await client.query('INSERT INTO cos.schema_migrations(version,checksum) VALUES ($1,$2)', [1, INITIAL_CHECKSUM]);
    }
    await client.query(`GRANT SELECT ON cos.schema_migrations TO ${identifier(runtimeRole)}`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.scopes,cos.records,cos.proposals,cos.operations,cos.events,cos.outbox TO ${identifier(runtimeRole)}`,
    );
    await client.query('COMMIT');
    return 1;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
  }
}

export async function migrationStatus(client: pg.Client): Promise<number> {
  const check = await client.query("SELECT to_regclass('cos.schema_migrations') AS ledger");
  if (!check.rows[0]?.ledger) return 0;
  return validateHistory(
    (await client.query('SELECT version,checksum FROM cos.schema_migrations ORDER BY version')).rows,
  );
}
