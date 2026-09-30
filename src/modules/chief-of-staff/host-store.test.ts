import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
  check: { end: vi.fn() },
  connect: vi.fn(),
  fingerprint: vi.fn(),
  target: vi.fn(),
  schema: vi.fn(),
  artifacts: {},
  open: vi.fn(),
  pool: { end: vi.fn() },
  configure: vi.fn(),
}));
vi.mock('./store/preflight.js', async (original) => ({
  ...(await original<typeof import('./store/preflight.js')>()),
  connectChecked: f.connect,
}));
vi.mock('./ops/target-identity.js', () => ({ localTarget: f.target, databaseFingerprint: f.fingerprint }));
vi.mock('./store/migrations.js', () => ({ SCHEMA_VERSION: 3, migrationStatus: f.schema }));
vi.mock('./store/config.js', async (original) => ({
  ...(await original<typeof import('./store/config.js')>()),
  parseDatabaseConfig: () => ({}),
  externalDatabaseConfig: f.configure,
}));
vi.mock('./knowledge/config.js', async (original) => ({
  ...(await original<typeof import('./knowledge/config.js')>()),
  openKnowledgeArtifacts: f.open,
}));
vi.mock('./store/client.js', async (original) => ({
  ...(await original<typeof import('./store/client.js')>()),
  BoundedDatabase: { fromConfig: vi.fn(() => ({ pool: f.pool })) },
}));
import { connectCosHostStore } from './host-store.js';
afterEach(() => vi.resetAllMocks());
function fixture() {
  f.connect.mockResolvedValue(f.check);
  f.check.end.mockResolvedValue(undefined);
  f.target.mockReturnValue({ binding: { databaseFingerprint: 'bound-database' } });
  f.fingerprint.mockResolvedValue('bound-database');
  f.schema.mockResolvedValue(3);
  f.open.mockReturnValue(f.artifacts);
  f.configure.mockResolvedValue({});
}
it('connects the current schema with knowledge guards present even when retrieval is disabled', async () => {
  fixture();
  const store = await connectCosHostStore(
    {},
    { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
    () => true,
  );
  expect(store.knowledge).toBeDefined();
  expect(store.knowledge!.retrievalEnabled()).toBe(false);
  expect(store.knowledge!.retentionMs).toBe(30 * 86400000);
  expect(f.open).toHaveBeenCalledWith('/state', ['/install', '/install/data']);
  expect(f.check.end).toHaveBeenCalledOnce();
});
it.each([1, 2, 4])('rejects incompatible schema %s before creating artifacts or a runtime pool', async (version) => {
  fixture();
  f.schema.mockResolvedValue(version);
  await expect(
    connectCosHostStore(
      {},
      { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
      () => true,
    ),
  ).rejects.toThrow('schema_incompatible');
  expect(f.open).not.toHaveBeenCalled();
  expect(f.configure).not.toHaveBeenCalled();
  expect(f.check.end).toHaveBeenCalledOnce();
});
it('checks database identity before touching knowledge roots', async () => {
  fixture();
  f.fingerprint.mockResolvedValue('foreign-database');
  await expect(
    connectCosHostStore(
      {},
      { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
      () => true,
    ),
  ).rejects.toThrow('database_identity_mismatch');
  expect(f.open).not.toHaveBeenCalled();
  expect(f.check.end).toHaveBeenCalledOnce();
});
it('honors explicit retrieval and retention settings and rejects malformed settings before connection', async () => {
  fixture();
  const roots = { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' };
  const store = await connectCosHostStore(
    { COS_KNOWLEDGE_ENABLED: 'true', COS_KNOWLEDGE_RETENTION_DAYS: '7' },
    roots,
    () => true,
  );
  expect(store.knowledge!.retrievalEnabled()).toBe(true);
  expect(store.knowledge!.retentionMs).toBe(7 * 86400000);
  f.connect.mockClear();
  await expect(connectCosHostStore({ COS_KNOWLEDGE_RETENTION_DAYS: '-1' }, roots, () => true)).rejects.toThrow();
  expect(f.connect).not.toHaveBeenCalled();
});
