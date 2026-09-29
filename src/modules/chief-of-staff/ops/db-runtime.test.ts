import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  localTarget: vi.fn(),
  fingerprint: vi.fn(),
  lease: vi.fn(),
  assert: vi.fn(),
  connect: vi.fn(),
  migrate: vi.fn(),
  query: vi.fn(),
  end: vi.fn(),
}));
vi.mock('./target-identity.js', () => ({ localTarget: mocks.localTarget, databaseFingerprint: mocks.fingerprint }));
vi.mock('./maintenance.js', () => ({ activeMaintenanceLease: mocks.lease, assertMaintenanceLease: mocks.assert }));
vi.mock('../store/preflight.js', async (original) => ({
  ...(await original<typeof import('../store/preflight.js')>()),
  connectChecked: mocks.connect,
}));
vi.mock('../store/migrations.js', () => ({ migrate: mocks.migrate, migrationStatus: vi.fn() }));
import { databaseCommand } from './db-cli.js';
const env = {
  COS_TARGET_STATE_DIR: '/fixture/private-target',
  COS_PGDATABASE: 'fixture',
  COS_PGUSER: 'fixture_runtime',
  COS_PGHOST: '192.168.50.10',
  COS_PG_MIGRATION_USER: 'fixture_migration',
  COS_PG_MIGRATION_PASSWORD: 'synthetic-migration',
  COS_PGSSLMODE: 'disable',
  COS_PG_ALLOW_PLAINTEXT: 'true',
};
const args = ['migrate', '--profile', 'runtime', '--confirm-database', 'fixture'];
beforeEach(() => {
  vi.resetAllMocks();
  mocks.localTarget.mockReturnValue({ binding: { databaseFingerprint: 'a'.repeat(64) } });
  mocks.fingerprint.mockResolvedValue('a'.repeat(64));
  mocks.lease.mockReturnValue({ owner: 'fixture-release', purpose: 'deployment' });
  mocks.connect.mockResolvedValue({ query: mocks.query, end: mocks.end });
  mocks.query.mockResolvedValue({ rows: [{ locked: true }] });
  mocks.migrate.mockResolvedValue(1);
});
describe('S01-OPS01 bound runtime migrations', () => {
  it('uses migration credentials and the current exclusive maintenance lease without an approval prompt', async () => {
    expect(await databaseCommand(args, env)).toMatchObject({ status: 'ok', schema_version: 1 });
    expect(mocks.connect).toHaveBeenCalledWith(env, 'runtime', 'migration');
    expect(mocks.migrate).toHaveBeenCalledOnce();
    expect(mocks.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock(73101003) AS locked');
    expect(mocks.assert).toHaveBeenCalled();
    expect(mocks.end).toHaveBeenCalledOnce();
  });
  it('refuses an unknown target before requesting credentials from the database', async () => {
    mocks.localTarget.mockImplementation(() => {
      throw new Error('target_binding_required');
    });
    await expect(databaseCommand(args, env)).rejects.toThrow();
    expect(mocks.connect).not.toHaveBeenCalled();
  });
  it('refuses a live writer or a different actual database and leaves the latch in place', async () => {
    mocks.query.mockResolvedValue({ rows: [{ locked: false }] });
    await expect(databaseCommand(args, env)).rejects.toThrow('maintenance_writer_active');
    expect(mocks.migrate).not.toHaveBeenCalled();
    mocks.query.mockResolvedValue({ rows: [{ locked: true }] });
    mocks.fingerprint.mockResolvedValue('b'.repeat(64));
    await expect(databaseCommand(args, env)).rejects.toThrow('database_identity_mismatch');
    expect(mocks.migrate).not.toHaveBeenCalled();
  });
});
