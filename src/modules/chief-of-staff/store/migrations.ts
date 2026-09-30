import pg from 'pg';
import { DatabasePreflightError } from './preflight.js';

// Versioned source is part of the immutable host payload; startup only reads
// the ledger. DDL runs solely through the explicit migration command.
import { INITIAL_SCHEMA, INITIAL_CHECKSUM } from './schema-definition.js';
export { INITIAL_SCHEMA, INITIAL_CHECKSUM } from './schema-definition.js';
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
