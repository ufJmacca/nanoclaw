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
  calendarOpen: vi.fn(),
  actionOpen: vi.fn(),
}));
vi.mock('./store/preflight.js', async (original) => ({
  ...(await original<typeof import('./store/preflight.js')>()),
  connectChecked: f.connect,
}));
vi.mock('./ops/target-identity.js', () => ({ localTarget: f.target, databaseFingerprint: f.fingerprint }));
vi.mock('./store/migrations.js', async (original) => ({
  ...(await original<typeof import('./store/migrations.js')>()),
  migrationStatus: f.schema,
}));
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
vi.mock('./calendar/config.js', async (original) => ({
  ...(await original<typeof import('./calendar/config.js')>()),
  openCalendarCredentials: f.calendarOpen,
}));
vi.mock('./actions/host.js', () => ({ openActionHost: f.actionOpen }));
import { connectCosHostStore } from './host-store.js';
import { SCHEMA_VERSION } from './store/migrations.js';
afterEach(() => vi.resetAllMocks());
function fixture() {
  f.connect.mockResolvedValue(f.check);
  f.check.end.mockResolvedValue(undefined);
  f.target.mockReturnValue({ binding: { databaseFingerprint: 'bound-database' } });
  f.fingerprint.mockResolvedValue('bound-database');
  f.schema.mockResolvedValue(SCHEMA_VERSION);
  f.open.mockReturnValue(f.artifacts);
  f.configure.mockResolvedValue({});
}
it('keeps the ordinary host store available while lost vault protection closes Google readers and writers', async () => {
  fixture();
  f.calendarOpen.mockImplementation(() => {
    throw Error('calendar_configuration_unavailable');
  });
  f.actionOpen.mockRejectedValue(Error('action_host_unavailable'));
  const store = await connectCosHostStore(
    { COS_CALENDAR_ENABLED: 'true', COS_ACTIONS_ENABLED: 'true' },
    { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
    () => true,
    {},
    undefined,
    undefined,
    undefined,
    () => null,
  );
  expect(store.knowledge).toBeDefined();
  expect(store.calendar).toBeUndefined();
  expect(store.actions.dependencies).toBeUndefined();
  expect(f.configure).toHaveBeenCalledOnce();
});
it('propagates unexpected host setup failures rather than classifying them as vault unavailability', async () => {
  fixture();
  f.calendarOpen.mockImplementation(() => {
    throw Error('unexpected_host_fault');
  });
  await expect(
    connectCosHostStore(
      { COS_CALENDAR_ENABLED: 'true' },
      { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
      () => true,
    ),
  ).rejects.toThrow('unexpected_host_fault');
});
it('S09 opens the production writer after checking the exact target database/schema with a separate main authority', async () => {
  fixture();
  const roots = { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
    admitted = () => true,
    authority = vi.fn(() => null),
    writer = vi.fn(() => null),
    witness = {} as import('./actions/witness.js').EffectWitness;
  f.actionOpen.mockResolvedValue({ authority, writer, witness });
  const store = await connectCosHostStore(
    { COS_ACTIONS_ENABLED: 'true' },
    roots,
    admitted,
    {},
    undefined,
    undefined,
    undefined,
    authority,
  );
  expect(f.actionOpen).toHaveBeenCalledWith({ COS_ACTIONS_ENABLED: 'true' }, roots, admitted, authority);
  expect(f.actionOpen.mock.invocationCallOrder[0]).toBeGreaterThan(f.schema.mock.invocationCallOrder[0]);
  expect(store.actions.dependencies?.witness).toBe(witness);
  expect(store.missions.authority).toBeUndefined();
  expect(f.calendarOpen).not.toHaveBeenCalled();
});
it('S09 passes separate trusted action dependencies through host admission without requiring specialist delegation', async () => {
  fixture();
  const context = { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'main', sessionId: 'main', ingressId: 'owner' },
    authority = {
      bindingDigest: 'a'.repeat(64),
      contextGeneration: 'retained',
      actionProfileDigest: 'b'.repeat(64),
      provider: { profile: 'codex-subscription/coordinator-v1', model: 'fixture', policyDigest: 'c'.repeat(64) },
    },
    admitted = vi.fn(() => true),
    resolve = vi.fn(() => authority),
    writer = vi.fn(() => null),
    witness = {} as import('./actions/witness.js').EffectWitness;
  const store = await connectCosHostStore(
    {},
    { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
    admitted,
    {},
    undefined,
    undefined,
    { authority: resolve, writer, witness },
  );
  expect(store.actions.dependencies?.authority(context)).toEqual(authority);
  expect(store.actions.dependencies?.witness).toBe(witness);
  expect(
    store.actions.dependencies?.writer(context, 'fixture', {} as import('./actions/binding.js').ActionWriterBinding),
  ).toBeNull();
  expect(store.missions.authority).toBeUndefined();
  admitted.mockReturnValue(false);
  expect(store.actions.dependencies?.authority(context)).toBeNull();
  expect(
    store.actions.dependencies?.writer(context, 'fixture', {} as import('./actions/binding.js').ActionWriterBinding),
  ).toBeNull();
  expect(writer).toHaveBeenCalledTimes(1);
  expect(resolve).toHaveBeenCalledTimes(1);
});
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
  expect(f.calendarOpen).not.toHaveBeenCalled();
});
it.each([...Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1), SCHEMA_VERSION + 1])(
  'rejects incompatible schema %s before creating artifacts or a runtime pool',
  async (version) => {
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
  },
);
it('opens the protected calendar owner only after target/schema verification and shares the bounded pool', async () => {
  fixture();
  f.calendarOpen.mockReturnValue({ fences: { assertOpen: vi.fn(), deny: vi.fn() }, credentials: {} });
  const store = await connectCosHostStore(
    { COS_CALENDAR_ENABLED: 'true' },
    { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' },
    () => true,
  );
  expect(f.calendarOpen).toHaveBeenCalledWith({
    targetRoot: '/state',
    installationRoot: '/install',
    dataRoot: '/install/data',
  });
  expect(store.calendar).toBeDefined();
  expect(f.calendarOpen.mock.invocationCallOrder[0]).toBeGreaterThan(f.schema.mock.invocationCallOrder[0]!);
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
it('passes only the trusted mission resolver and closes it when host admission is lost', async () => {
  fixture();
  const roots = { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' };
  const context = { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'main', sessionId: 'main', ingressId: 'event' };
  const authority = {
    bindingDigest: 'a'.repeat(64),
    delegationDigest: 'b'.repeat(64),
    contextGeneration: 'retained',
    provider: { profile: 'codex-subscription/research-v1', model: 'fixture', policyDigest: 'c'.repeat(64) },
  };
  const resolve = vi.fn(() => authority),
    admitted = vi.fn(() => true);
  const store = await connectCosHostStore({}, roots, admitted, {}, resolve);
  expect(store.missions.authority?.(context)).toEqual(authority);
  admitted.mockReturnValue(false);
  expect(store.missions.authority?.(context)).toBeNull();
  expect(resolve).toHaveBeenCalledTimes(1);
  const unconfigured = await connectCosHostStore({}, roots, () => true);
  expect(unconfigured.missions.authority).toBeUndefined();
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
it('S06-T01/T05 keeps team admission separate and fences both through the same host admission and pool', async () => {
  fixture();
  const roots = { targetRoot: '/state', installationRoot: '/install', dataRoot: '/install/data' };
  const context = { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'main', sessionId: 'main', ingressId: 'event' };
  const authority = {
    bindingDigest: 'a'.repeat(64),
    delegationDigest: 'b'.repeat(64),
    contextGeneration: 'retained',
    provider: { profile: 'codex-subscription/research-v1', model: 'fixture', policyDigest: 'c'.repeat(64) },
  };
  const team = { ...authority, templateBundleDigest: 'd'.repeat(64), teamPolicyDigest: 'e'.repeat(64) };
  const admitted = vi.fn(() => true),
    resolve = vi.fn(() => authority),
    resolveTeam = vi.fn(() => team);
  const store = await connectCosHostStore({}, roots, admitted, {}, resolve, resolveTeam);
  expect(store.missions.authority?.(context)).toEqual(authority);
  expect(store.teams.authority?.(context)).toEqual(team);
  expect(store.teams.knowledge?.database).toBe(store.database);
  admitted.mockReturnValue(false);
  expect(store.teams.authority?.(context)).toBeNull();
  expect(resolveTeam).toHaveBeenCalledTimes(1);
  const singleOnly = await connectCosHostStore({}, roots, () => true, {}, resolve);
  expect(singleOnly.teams.authority).toBeUndefined();
});
