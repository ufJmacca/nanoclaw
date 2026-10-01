import pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { migrate, migrationStatus, SCHEMA_VERSION } from './migrations.js';

describe('S01-PG07 explicit checksummed migrations', () => {
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
