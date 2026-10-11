import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { ActionWitness, initializeActionWitness } from '../actions/witness.js';
import { targetBinding } from './target-host.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { recoveryReleaseForManifest } from './recovery-manifest.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';
import type { BackupRemoteRestore } from './backup-restic-transfer.js';
const f = vi.hoisted(() => ({
  vault: vi.fn(),
  remote: vi.fn(),
  complete: vi.fn(),
  reservation: vi.fn(),
  importer: vi.fn(),
}));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.vault }));
vi.mock('./backup-upload.js', () => ({ restoreVaultBackup: f.remote }));
vi.mock('./backup-recovered-state.js', () => ({ verifyRecoveredTargetVaultState: f.complete }));
vi.mock('./backup-test-restore-reservation.js', () => ({ withPinnedBackupTestRestoreReservation: f.reservation }));
vi.mock('./coordinated-backup.js', async (original) => ({
  ...(await original<typeof import('./coordinated-backup.js')>()),
  restoreRecoveredCoordinatedTestScope: f.importer,
}));
import { restoreTargetVaultBackupTestScope } from './backup-target-restore.js';
const roots: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-target-restore-');
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    userHome: root,
    installationRoot: root + '/app',
    dataRoot: root + '/app/data',
    stateRoot: root + '/state',
    releaseRoot: root + '/releases',
    stagingRoot: root + '/staging',
    sourceRoot: root + '/sources',
    runtimeEnvironment: root + '/.config/runtime',
    migrationEnvironment: root + '/.config/migration',
    service: 'nano.service',
    hostFingerprint: digest('host'),
    databaseFingerprint: digest('source database'),
  };
  fs.mkdirSync(settings.stateRoot + '/actions', { recursive: true, mode: 0o700 });
  const targetDigest = digest(targetBinding(settings)),
    owner = initializeActionWitness(settings.stateRoot + '/actions/effects', targetDigest),
    witness = new ActionWitness(settings.stateRoot + '/actions/effects', targetDigest, owner.generation),
    queueOperationId = randomUUID(),
    requestId = randomUUID(),
    current = vi.fn(),
    vaultGuard = vi.fn(),
    scopeGuard = vi.fn(),
    payloadGuard = vi.fn(),
    binding = {
      scopeId: 'scope',
      ownerId: 'owner',
      botId: 'bot',
      instanceId: 'instance',
      channelId: 'channel',
      agentGroupId: 'group',
      messagingGroupId: 'messaging',
      provider: 'codex' as const,
      sessionId: 'current-session',
    },
    recovery = recoveryReleaseForManifest(fixtureVaultRelease()),
    inputs = {
      context: {
        scopeId: 'scope',
        ownerId: 'owner',
        agentGroupId: 'group',
        sessionId: 'historical-session',
        ingressId: 'operator',
      },
      nativeDatabases: [settings.dataRoot + '/v2.db'],
      restrictionFiles: [settings.stateRoot + '/state.json'],
      artifactsRoot: settings.stateRoot + '/knowledge/artifacts',
    },
    header = {
      targetBindingDigest: targetDigest,
      operationId: 'release-action-' + queueOperationId,
      queueOperationId,
      inputs,
      checkpointDigest: digest('checkpoint'),
      journal: { installationDigest: targetDigest, generation: owner.generation },
    },
    verified = { header, snapshotDigest: digest(header), credentialsActivated: false, writerActivated: false },
    scope: BackupRestoreValidationScope = {
      directory: '/proc/self/fd/121',
      assertCurrent: scopeGuard,
      assertPayloadCurrent: payloadGuard,
      inspectFile: vi.fn(),
      withFileBytes: vi.fn(),
      ensureDirectory: vi.fn(),
    },
    remote: BackupRemoteRestore = {
      contract: 'cos-backup-remote-restore/v1',
      repositoryId: digest('repository'),
      ownerDigest: digest('repository owner'),
      kind: 'state',
      operationId: queueOperationId,
      snapshotId: digest('snapshot'),
      snapshotAt: '2026-10-11T00:00:00.000Z',
      archiveBytes: 16384,
      archiveSha256: digest('archive'),
      verifiedAt: '2026-10-11T00:01:00.000Z',
      receipt: {
        format: 'cos-backup-queue/v1',
        ownerDigest: digest('queue owner'),
        kind: 'state',
        operationId: queueOperationId,
        state: 'pending',
        createdAt: '2026-10-11T00:00:00.000Z',
        maximumBytes: 65536,
        bytes: 42,
        files: [],
      },
    },
    sandbox = { client: {} as pg.Client, config: { database: 'fixture' }, testTargetId: 'fixture-protected-test' },
    options = {
      settings,
      binding,
      witness,
      queueOperationId,
      recovery,
      expectedSnapshotDigest: verified.snapshotDigest,
      current,
    },
    port = { assertCurrent: vi.fn(), read: vi.fn(), create: vi.fn() },
    order: string[] = [];
  f.vault.mockImplementation(async (_roots, area, use) => {
    expect(area).toBe('staging');
    return use('/proc/self/fd/122', vaultGuard);
  });
  f.remote.mockImplementation(async (_roots, kind, operation, request, check, use) => {
    expect(kind).toBe('state');
    expect(operation).toBe(queueOperationId);
    expect(request).toBe(requestId);
    check();
    return { remote, validation: await use(scope, remote) };
  });
  f.complete.mockImplementation(async () => {
    order.push('complete');
    return verified;
  });
  f.reservation.mockImplementation(async (_directory, _binding, check, use) => {
    order.push('reservation');
    check();
    return use(port);
  });
  f.importer.mockImplementation(async (_options, _scope, _entries, _sandbox, _port, check) => {
    order.push('import');
    await check();
    return {
      format: 'cos-sandbox-scope-restore/v1',
      inserted: true,
      admissionRestored: false,
      eventJournalRestored: false,
      checkpointDigest: header.checkpointDigest,
      sandboxDatabaseFingerprint: digest('separate test'),
      restoredStateDigest: digest('readback'),
    };
  });
  return {
    settings,
    requestId,
    options,
    scope,
    remote,
    sandbox,
    verified,
    header,
    port,
    order,
    current,
    vaultGuard,
    scopeGuard,
    payloadGuard,
    run: () => restoreTargetVaultBackupTestScope(options, requestId, sandbox),
  };
}
it('requires complete capture verification and binds the live reservation before importing, then verifies again before acknowledgement', async () => {
  const s = fixture(),
    result = await s.run();
  expect(s.order).toEqual(['complete', 'reservation', 'import', 'complete']);
  expect(f.vault.mock.calls[0][0]).toEqual({
    targetRoot: s.settings.stateRoot,
    installationRoot: s.settings.installationRoot,
    dataRoot: s.settings.dataRoot,
  });
  expect(f.reservation.mock.calls[0].slice(0, 2)).toEqual([
    '/proc/self/fd/122',
    {
      requestId: s.requestId,
      targetDigest: s.header.targetBindingDigest,
      repositoryId: s.remote.repositoryId,
      repositoryOwnerDigest: s.remote.ownerDigest,
      queueOwnerDigest: s.remote.receipt.ownerDigest,
      operationId: s.remote.operationId,
      snapshotId: s.remote.snapshotId,
      archiveSha256: s.remote.archiveSha256,
      archiveBytes: s.remote.archiveBytes,
      snapshotDigest: s.verified.snapshotDigest,
      checkpointDigest: s.header.checkpointDigest,
      sourceDatabaseFingerprint: s.settings.databaseFingerprint,
      scopeId: 'scope',
      journal: s.header.journal,
    },
  ]);
  expect(f.importer.mock.calls[0][0]).toMatchObject({
    context: s.header.inputs.context,
    operationId: s.header.operationId,
    databaseFingerprint: s.settings.databaseFingerprint,
    witness: s.options.witness,
  });
  expect(f.importer.mock.calls[0][3]).toBe(s.sandbox);
  expect(f.importer.mock.calls[0][4]).toBe(s.port);
  expect(result.validation).toMatchObject({
    inserted: true,
    snapshotDigest: s.verified.snapshotDigest,
    credentialsActivated: false,
    writerActivated: false,
    admissionRestored: false,
    eventJournalRestored: false,
  });
  expect(s.payloadGuard).toHaveBeenCalled();
});
it('withholds any reservation or import after complete verification fails', async () => {
  const s = fixture();
  f.complete.mockRejectedValue(Error('PRIVATE_FULL_PAYLOAD_FAILURE'));
  await expect(s.run()).rejects.toThrow(/^target_vault_test_restore_unavailable$/);
  expect(f.reservation).not.toHaveBeenCalled();
  expect(f.importer).not.toHaveBeenCalled();
});
it.each([
  'caller',
  'settings',
  'binding',
  'release',
  'remote',
  'journal',
  'vault',
  'payload',
  'test-profile',
  'test-client',
])('refuses awaited %s changes before the scoped importer starts', async (kind) => {
  const s = fixture();
  f.complete.mockImplementation(async () => {
    await Promise.resolve();
    if (kind === 'caller')
      s.current.mockImplementation(() => {
        throw Error('PRIVATE_WITHDRAWN');
      });
    if (kind === 'settings') s.settings.databaseFingerprint = digest('foreign');
    if (kind === 'binding') s.options.binding.sessionId = 'changed';
    if (kind === 'release') s.options.recovery.manifestDigest = digest('foreign');
    if (kind === 'remote') s.remote.snapshotId = digest('foreign');
    if (kind === 'journal') fs.writeFileSync(s.options.witness.root + '/owner.json', JSON.stringify({ foreign: true }));
    if (kind === 'vault')
      s.vaultGuard.mockImplementation(() => {
        throw Error('PRIVATE_UNMOUNTED');
      });
    if (kind === 'payload')
      s.payloadGuard.mockImplementation(() => {
        throw Error('PRIVATE_CHANGED_FILE');
      });
    if (kind === 'test-profile') s.sandbox.config.database = 'different';
    if (kind === 'test-client') s.sandbox.client = {} as pg.Client;
    return s.verified;
  });
  await expect(s.run()).rejects.toThrow(/^target_vault_test_restore_unavailable$/);
  expect(f.importer).not.toHaveBeenCalled();
});
it('keeps payload, remote and current owner checks in the importer permission callback', async () => {
  const s = fixture();
  f.importer.mockImplementation(async (_options, _scope, _entries, _sandbox, _port, check) => {
    await check();
    await Promise.resolve();
    s.remote.archiveSha256 = digest('changed');
    await check();
    throw Error('must_not_acknowledge');
  });
  await expect(s.run()).rejects.toThrow(/^target_vault_test_restore_unavailable$/);
});
it('requires the same complete snapshot after import before acknowledging', async () => {
  const s = fixture();
  f.complete
    .mockImplementationOnce(async () => s.verified)
    .mockImplementationOnce(async () => ({ ...s.verified, snapshotDigest: digest('changed') }));
  await expect(s.run()).rejects.toThrow(/^target_vault_test_restore_unavailable$/);
});
it('expires the owner and payload callbacks after the admitted operation ends', async () => {
  const s = fixture();
  await s.run();
  const current = f.remote.mock.calls[0][4],
    check = f.importer.mock.calls[0][5],
    scope = f.importer.mock.calls[0][1];
  expect(() => current()).toThrow();
  await expect(check()).rejects.toThrow();
  expect(() => scope.assertPayloadCurrent()).toThrow();
});
it('refuses an invalid stable request before entering vault or repository access', async () => {
  const s = fixture();
  await expect(restoreTargetVaultBackupTestScope(s.options, '../foreign', s.sandbox)).rejects.toThrow(
    /^target_vault_test_restore_unavailable$/,
  );
  expect(f.vault).not.toHaveBeenCalled();
  expect(f.remote).not.toHaveBeenCalled();
});
