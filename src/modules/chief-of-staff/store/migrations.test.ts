import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { migrate, migrationStatus, SCHEMA_VERSION } from './migrations.js';

describe('S01-PG07 explicit checksummed migrations', () => {
  it('S09 adds immutable action identities and request-start receipts without enabling a writer', async () => {
    const query = vi
      .fn()
      .mockImplementation(async (sql: string) =>
        sql.includes('pg_try_advisory_lock') ? { rows: [{ locked: true }] } : { rows: [] },
      );
    expect(await migrate({ query } as unknown as pg.Client, 'fixture_runtime')).toBe(16);
    const statements = query.mock.calls.map(([sql]) => sql).join('\n');
    expect(statements).toContain('CREATE TABLE cos.action_intents');
    expect(statements).toContain('CREATE TABLE cos.action_request_starts');
    expect(statements).toContain(
      'REVOKE UPDATE,DELETE,TRUNCATE ON cos.action_intents,cos.action_request_starts,cos.action_receipts',
    );
    expect(statements).toContain('GRANT SELECT ON cos.action_writer_bindings,cos.action_writer_revisions');
    expect(statements).not.toMatch(/INSERT INTO cos.action_writer_bindings/);
  });
  it('serialises migrations under a bounded advisory lock and commits one version', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      return { rows: [] };
    });
    expect(await migrate({ query } as unknown as pg.Client, 'fixture_runtime')).toBe(SCHEMA_VERSION);
    const calls = query.mock.calls.map(([sql]) => sql);
    expect(calls.some((sql) => sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(calls).toContain('BEGIN');
    expect(calls).toContain('COMMIT');
    expect(calls.some((sql) => sql.includes('CREATE TABLE cos.sources'))).toBe(true);
    expect(calls.some((sql) => sql.includes('CREATE TABLE cos.calendar_bindings'))).toBe(true);
    expect(calls.some((sql) => sql.includes('CREATE TABLE cos.work_items'))).toBe(true);
    expect(calls.some((sql) => sql.includes('GRANT SELECT,INSERT ON cos.work_revisions'))).toBe(true);
    expect(calls.some((sql) => sql.includes('CREATE TABLE cos.brief_schedules'))).toBe(true);
    expect(calls.some((sql) => sql.includes('CREATE TABLE cos.brief_runs'))).toBe(true);
    expect(calls.some((sql) => sql.includes('REVOKE UPDATE,DELETE,TRUNCATE ON cos.brief_call_reservations'))).toBe(
      true,
    );
    expect(calls.some((sql) => sql.includes('REVOKE UPDATE,DELETE,TRUNCATE ON cos.brief_schedule_revisions'))).toBe(
      true,
    );
    expect(calls.some((sql) => sql.includes('GRANT SELECT,INSERT,UPDATE,DELETE ON cos.calendar_bindings'))).toBe(true);
    expect(calls.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
  });

  it('refuses a busy migration lock without applying DDL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: false }] });
    await expect(migrate({ query } as unknown as pg.Client, 'fixture_runtime')).rejects.toThrow('migration_busy');
    expect(query.mock.calls.some(([sql]) => /CREATE|ALTER|GRANT/.test(sql))).toBe(false);
  });

  it('rejects modified migration history instead of overwriting its checksum', async () => {
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
      if (sql.startsWith('SELECT version,checksum')) return { rows: [{ version: 1, checksum: 'changed' }] };
      return { rows: [] };
    });
    await expect(migrate({ query } as unknown as pg.Client, 'fixture_runtime')).rejects.toThrow('migration_checksum');
  });

  it('status never executes DDL, even with an absent schema ledger', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ ledger: null }] });
    expect(await migrationStatus({ query } as unknown as pg.Client)).toBe(0);
    expect(query).toHaveBeenCalled();
    expect(query.mock.calls.every(([sql]) => sql.startsWith('SELECT'))).toBe(true);
  });
});
