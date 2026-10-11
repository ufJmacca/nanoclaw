import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { databaseFingerprint, databasePhysicalFingerprint } from './target-identity.js';
const identity = { database: 'fixture', database_oid: '12345', server_address: '192.168.50.10', server_port: 5432 };
const config = {
  host: 'fixture-db.lan',
  port: 5432,
  database: 'fixture',
  user: 'fixture_runtime',
  password: 'synthetic-secret',
  ssl: { rejectUnauthorized: true, ca: 'fixture-ca' },
};
const client = (row = identity) =>
  ({ query: vi.fn().mockResolvedValue({ rows: [row] }) }) as unknown as Pick<pg.Client, 'query'>;
describe('S01 target database identity', () => {
  it('keeps the same target across role and password changes without retaining credentials', async () => {
    const runtime = await databaseFingerprint(client(), config);
    expect(runtime).toMatch(/^[a-f0-9]{64}$/);
    expect(
      await databaseFingerprint(client(), { ...config, user: 'fixture_migration', password: 'other-synthetic-secret' }),
    ).toBe(runtime);
  });
  it('detects an actual database replacement, endpoint change or trust-root change', async () => {
    const original = await databaseFingerprint(client(), config);
    expect(await databaseFingerprint(client({ ...identity, database_oid: '54321' }), config)).not.toBe(original);
    expect(await databaseFingerprint(client(), { ...config, host: 'other-db.lan' })).not.toBe(original);
    expect(await databaseFingerprint(client(), { ...config, ssl: { ...config.ssl, ca: 'other-ca' } })).not.toBe(
      original,
    );
  });
  it('does not bind malformed or non-private server metadata', async () => {
    await expect(databaseFingerprint(client({ ...identity, server_address: 'invalid' }), config)).rejects.toThrow(
      'database_identity_unavailable',
    );
    await expect(databaseFingerprint(client({ ...identity, database: 'foreign' }), config)).rejects.toThrow(
      'database_identity_unavailable',
    );
  });
});

describe('recovery database separation', () => {
  it('recognizes the same server database through different connection and trust labels', async () => {
    const original = await databasePhysicalFingerprint(client(), config);
    const alias = {
      ...config,
      host: 'alias-db.lan',
      port: 6543,
      user: 'other-role',
      password: 'other-synthetic-secret',
      ssl: { rejectUnauthorized: true, ca: 'other-trusted-ca' },
    };
    expect(await databaseFingerprint(client(), alias)).not.toBe(await databaseFingerprint(client(), config));
    expect(await databasePhysicalFingerprint(client(), alias)).toBe(original);
    expect(original).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([
    { ...identity, database: 'separate', database_oid: '54321' },
    { ...identity, database_oid: '54321' },
    { ...identity, server_address: '192.168.50.11' },
    { ...identity, server_port: 5433 },
  ])('distinguishes changed actual server/database metadata', async (row) => {
    expect(await databasePhysicalFingerprint(client(row), { database: row.database })).not.toBe(
      await databasePhysicalFingerprint(client(), config),
    );
  });
  it('refuses incomplete, foreign and multiple database identity rows', async () => {
    for (const row of [
      { ...identity, database: 'foreign' },
      { ...identity, server_address: 'invalid' },
      { ...identity, database_oid: 'invalid' },
      { ...identity, server_port: null },
    ]) {
      const query = vi.fn().mockResolvedValue({ rows: [row] });
      await expect(databasePhysicalFingerprint({ query } as unknown as pg.Client, config)).rejects.toThrow(
        'database_identity_unavailable',
      );
    }
    const query = vi.fn().mockResolvedValue({ rows: [identity, identity] });
    await expect(databasePhysicalFingerprint({ query } as unknown as pg.Client, config)).rejects.toThrow(
      'database_identity_unavailable',
    );
  });
});
