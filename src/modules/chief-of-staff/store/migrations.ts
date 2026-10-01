import pg from 'pg';
import { DatabasePreflightError } from './preflight.js';

// Versioned source is part of the immutable host payload; startup only reads
// the ledger. DDL runs solely through the explicit migration command.
import { INITIAL_SCHEMA, INITIAL_CHECKSUM } from './schema-definition.js';
import { KNOWLEDGE_SCHEMA, KNOWLEDGE_CHECKSUM } from './knowledge-schema.js';
import { CALENDAR_SCHEMA, CALENDAR_CHECKSUM } from './calendar-schema.js';
import { WORK_SCHEMA, WORK_CHECKSUM } from './work-schema.js';
import { SCHEDULE_SCHEMA, SCHEDULE_CHECKSUM } from './schedule-schema.js';
import { BRIEF_SCHEMA, BRIEF_CHECKSUM } from './brief-schema.js';
import { MISSION_SCHEMA, MISSION_CHECKSUM } from './mission-schema.js';
export { INITIAL_SCHEMA, INITIAL_CHECKSUM } from './schema-definition.js';
export const SCHEMA_VERSION = 7;
export const MIGRATIONS = [
  { version: 1, checksum: INITIAL_CHECKSUM, sql: INITIAL_SCHEMA },
  { version: 2, checksum: KNOWLEDGE_CHECKSUM, sql: KNOWLEDGE_SCHEMA },
  { version: 3, checksum: CALENDAR_CHECKSUM, sql: CALENDAR_SCHEMA },
  { version: 4, checksum: WORK_CHECKSUM, sql: WORK_SCHEMA },
  { version: 5, checksum: SCHEDULE_CHECKSUM, sql: SCHEDULE_SCHEMA },
  { version: 6, checksum: BRIEF_CHECKSUM, sql: BRIEF_SCHEMA },
  { version: 7, checksum: MISSION_CHECKSUM, sql: MISSION_SCHEMA },
] as const;
const LOCK_ID = 73101001;
const identifier = (value: string) => '"' + value.replaceAll('"', '""') + '"';

function validateHistory(rows: Array<{ version: number; checksum: string }>): number {
  if (!rows.length) return 0;
  if (
    rows.length > MIGRATIONS.length ||
    rows.some((row, index) => row.version !== MIGRATIONS[index].version || row.checksum !== MIGRATIONS[index].checksum)
  ) {
    throw new DatabasePreflightError('migration_checksum');
  }
  return rows.length;
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
    for (const migration of MIGRATIONS.slice(status)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO cos.schema_migrations(version,checksum) VALUES ($1,$2)', [
        migration.version,
        migration.checksum,
      ]);
    }
    await client.query(`GRANT SELECT ON cos.schema_migrations TO ${identifier(runtimeRole)}`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.scopes,cos.records,cos.proposals,cos.operations,cos.events,cos.outbox TO ${identifier(runtimeRole)}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.artifacts,cos.sources,cos.source_revisions,cos.chunks,cos.evidence_refs,cos.derivation_links,cos.revocation_tombstones TO ${identifier(runtimeRole)}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.calendar_bindings,cos.calendar_states,cos.calendar_snapshots,cos.calendar_observations,cos.calendar_event_revisions TO ${identifier(runtimeRole)}`,
    );
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON cos.work_items TO ${identifier(runtimeRole)}`);
    await client.query(`GRANT SELECT,INSERT ON cos.work_revisions TO ${identifier(runtimeRole)}`);
    await client.query(`REVOKE UPDATE,DELETE,TRUNCATE ON cos.work_revisions FROM ${identifier(runtimeRole)}`);
    await client.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON cos.brief_schedules TO ${identifier(runtimeRole)}`);
    await client.query(`GRANT SELECT,INSERT ON cos.brief_schedule_revisions TO ${identifier(runtimeRole)}`);
    await client.query(`REVOKE UPDATE,DELETE,TRUNCATE ON cos.brief_schedule_revisions FROM ${identifier(runtimeRole)}`);
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.brief_runs,cos.brief_notifications TO ${identifier(runtimeRole)}`,
    );
    await client.query(`GRANT SELECT,INSERT ON cos.brief_call_reservations TO ${identifier(runtimeRole)}`);
    await client.query(`REVOKE UPDATE,DELETE,TRUNCATE ON cos.brief_call_reservations FROM ${identifier(runtimeRole)}`);
    await client.query(`GRANT SELECT ON cos.mission_template_versions TO ${identifier(runtimeRole)}`);
    await client.query(
      `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON cos.mission_template_versions FROM ${identifier(runtimeRole)}`,
    );
    await client.query(
      `GRANT SELECT,INSERT,UPDATE,DELETE ON cos.missions,cos.mission_attempts TO ${identifier(runtimeRole)}`,
    );
    const immutableMissions =
      'cos.mission_context_manifests,cos.mission_work_orders,cos.mission_budget_reservations,cos.mission_result_submissions,cos.mission_reviews';
    await client.query(`GRANT SELECT,INSERT ON ${immutableMissions} TO ${identifier(runtimeRole)}`);
    await client.query(`REVOKE UPDATE,DELETE,TRUNCATE ON ${immutableMissions} FROM ${identifier(runtimeRole)}`);
    await client.query('COMMIT');
    return SCHEMA_VERSION;
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
