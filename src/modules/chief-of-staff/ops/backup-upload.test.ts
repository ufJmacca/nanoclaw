import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { BackupQueue } from './backup-queue.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import type { RemoteCheckpoint } from './backup-restic-transfer.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import { makeCredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { makeCredentialCapture, streamCredentialCapture, readCredentialCaptureArchive } from './credential-capture.js';
const f = vi.hoisted(() => ({
  vault: vi.fn(),
  access: vi.fn(),
  memory: vi.fn(),
  artifact: vi.fn(),
  nas: vi.fn(),
  password: vi.fn(),
  capacity: vi.fn(),
  queue: vi.fn(),
  writer: vi.fn(),
  target: vi.fn(),
  transfer: vi.fn(),
  upload: vi.fn(),
  verify: vi.fn(),
  maintain: vi.fn(),
  restore: vi.fn(),
  credentialSnapshot: vi.fn(),
  captureUpload: vi.fn(),
  captureRestore: vi.fn(),
  admitted: vi.fn(),
  deps: undefined as undefined | Record<string, unknown>,
  producerFile: '',
}));
vi.mock('./vault-storage.js', () => ({ verifyVaultStorage: f.vault, withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./restic-artifact.js', () => ({ withVerifiedResticBinary: f.artifact }));
vi.mock('./backup-nas-access.js', () => ({ withSignedBackupRepository: f.nas }));
vi.mock('./backup-password.js', () => ({ withVaultResticPassword: f.password }));
vi.mock('./backup-capacity.js', async (original) => ({
  ...(await original<typeof import('./backup-capacity.js')>()),
  readBackupCapacity: f.capacity,
}));
vi.mock('./target-identity.js', () => ({ localTarget: f.target }));
vi.mock('./backup-queue.js', async (original) => ({
  ...(await original<typeof import('./backup-queue.js')>()),
  createVaultBackupQueue: f.queue,
}));
vi.mock('./backup-repository-lease.js', async (original) => ({
  ...(await original<typeof import('./backup-repository-lease.js')>()),
  createVaultBackupRepositoryWriter: f.writer,
}));
vi.mock('./backup-restic-transfer.js', () => ({ BackupResticTransfer: f.transfer }));
vi.mock('./backup-producer-file.js', () => ({ backupProducerFile: () => f.producerFile }));
vi.mock('./credential-vault-snapshot.js', () => ({ withVaultCredentialSnapshot: f.credentialSnapshot }));
vi.mock('./maintenance.js', async (original) => ({
  ...(await original<typeof import('./maintenance.js')>()),
  admittedGeneration: f.admitted,
}));
import {
  uploadVaultBackup,
  maintainVaultBackups,
  restoreVaultBackup,
  uploadVaultCredentialCapture,
  restoreVaultCredentialCapture,
} from './backup-upload.js';
const temporary: string[] = [],
  held: number[] = [];
const operationId = 'fe682c6d-d762-40fb-89e6-e0f1e34edfc0';
afterEach(() => {
  for (const fd of held.splice(0)) fs.closeSync(fd);
  for (const fn of Object.values(f)) if (vi.isMockFunction(fn)) fn.mockReset();
  f.deps = undefined;
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-upload-'));
  temporary.push(root);
  const roots = {
    targetRoot: path.join(root, 'state'),
    installationRoot: path.join(root, 'install'),
    dataRoot: path.join(root, 'data'),
  };
  for (const directory of Object.values(roots)) fs.mkdirSync(directory, { mode: 0o700 });
  const areas = Object.fromEntries(
    ['backup-credentials', 'cache', 'journals', 'staging'].map((name) => {
      const directory = path.join(root, name);
      fs.mkdirSync(directory, { mode: 0o700 });
      return [name, directory];
    }),
  );
  const producer = path.join(roots.installationRoot, 'dist/modules/chief-of-staff/ops/backup-archive-producer.js');
  fs.mkdirSync(path.dirname(producer), { recursive: true, mode: 0o700 });
  fs.writeFileSync(producer, '// synthetic fixture; never executed', { mode: 0o500 });
  fs.writeFileSync(
    path.join(path.dirname(producer), 'credential-capture-producer.js'),
    '// separate synthetic fixture; never executed',
    { mode: 0o500 },
  );
  f.producerFile = producer;
  const policy = {
    targetDigest: digest(roots.targetRoot),
    volume: { filesystemUuid: '11111111-1111-4111-8111-111111111111' },
  };
  f.vault.mockReturnValue(policy);
  f.target.mockReturnValue({
    lifecycle: 'protected',
    maintenance: false,
    releaseId: 'release-fixture',
    generation: 7,
    binding: { syntheticBinding: true },
  });
  f.admitted.mockReturnValue(7);
  f.access.mockImplementation(async (_roots, area, callback) => callback(areas[area], () => {}));
  const profile = {
    contract: 'cos-backup-repository/v1',
    rootsDigest: digest(roots),
    filesystemUuid: policy.volume.filesystemUuid,
    repositoryId: 'b'.repeat(64),
    mount: { host: '192.0.2.10', share: 'nanoclaw-cos-backups', mount: path.join(root, 'nas') },
  };
  const file = path.join(areas['backup-credentials'], 'backup-repository.json');
  fs.writeFileSync(file, JSON.stringify(profile), { mode: 0o600 });
  const fd = fs.openSync(areas.cache, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  held.push(fd);
  const scope = { fd, assertCurrent: vi.fn() };
  f.artifact.mockImplementation(async (_file, callback) => callback(scope));
  f.nas.mockImplementation(async (_binding, callback) => callback(scope));
  f.password.mockImplementation(async (_roots, callback) => callback(scope));
  f.capacity.mockResolvedValue({
    staging: 4096,
    cache: 4096,
    credentials: 4096,
    repository: 4096,
    nasFree: 2 ** 42,
    vaultFree: 1024 ** 3,
  });
  const queue = new BackupQueue(
    digest({ targetDigest: policy.targetDigest, filesystemUuid: policy.volume.filesystemUuid }),
    async (kind, callback) => callback(areas[kind === 'state' ? 'staging' : 'journals']),
  );
  await queue.capture(
    'state',
    operationId,
    async (sink) => {
      sink.write('coordinated/remote.json', Buffer.from('synthetic checkpoint'));
    },
    131072,
  );
  f.queue.mockReturnValue(queue);
  const lockOwner = digest({
    targetDigest: policy.targetDigest,
    filesystemUuid: policy.volume.filesystemUuid,
    repositoryId: profile.repositoryId,
  });
  f.writer.mockReturnValue(
    new BackupRepositoryWriter(lockOwner, async (callback) => callback(areas['backup-credentials'])),
  );
  f.transfer.mockImplementation(function (options) {
    f.deps = options;
    return {
      upload: f.upload,
      verify: f.verify,
      maintain: f.maintain,
      restore: f.restore,
      uploadCredentialCapture: f.captureUpload,
      restoreCredentialCapture: f.captureRestore,
    };
  });
  let recorded: RemoteCheckpoint | undefined;
  f.upload.mockImplementation(async (kind, id, archive) => {
    const deps = f.deps! as unknown as {
      admitUpload(kind: string, bytes: number): Promise<void>;
      cache: { assertCurrent(): void };
      ownerDigest: string;
    };
    deps.cache.assertCurrent();
    await deps.admitUpload(kind, archive.bytes);
    recorded = {
      contract: 'cos-backup-remote-checkpoint/v1',
      repositoryId: profile.repositoryId,
      ownerDigest: deps.ownerDigest,
      kind,
      operationId: id,
      snapshotId: 'c'.repeat(64),
      archiveBytes: archive.bytes,
      archiveSha256: archive.sha256,
      reconciled: false,
      snapshotAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
    };
    return recorded;
  });
  f.verify.mockImplementation(async (kind, id, archive) => {
    if (
      !recorded ||
      recorded.kind !== kind ||
      recorded.operationId !== id ||
      recorded.archiveBytes !== archive.bytes ||
      recorded.archiveSha256 !== archive.sha256
    )
      throw Error('fixture_remote_missing');
    return { ...recorded, reconciled: true, verifiedAt: new Date().toISOString() };
  });
  f.maintain.mockImplementation(async (admit) => {
    await admit();
    return {
      contract: 'cos-backup-repository-maintenance/v1',
      status: 'backup_repository_maintained',
      repositoryId: profile.repositoryId,
      ownerDigest: lockOwner,
      state: { retained: 1, removed: 0 },
      credentials: { retained: 0, removed: 0 },
      integrity: 'verified',
    };
  });
  const parts: Buffer[] = [];
  await queue.withPending('state', operationId, async (directory, receipt) =>
    streamBackupArchive(directory, receipt, async (bytes) => {
      parts.push(Buffer.from(bytes));
    }),
  );
  const archive = Buffer.concat(parts);
  for (const part of parts) part.fill(0);
  f.restore.mockImplementation(async (kind, id, ownerDigest, sink, admit) => {
    await admit();
    const read = await readBackupArchive(
      (async function* () {
        yield Buffer.from(archive);
      })(),
      { kind, operationId: id, ownerDigest },
      sink,
      () => {},
    );
    await admit();
    return {
      contract: 'cos-backup-remote-restore/v1',
      repositoryId: profile.repositoryId,
      ownerDigest: lockOwner,
      kind,
      operationId: id,
      snapshotId: 'c'.repeat(64),
      snapshotAt: new Date().toISOString(),
      archiveBytes: read.archiveBytes,
      archiveSha256: read.archiveSha256,
      verifiedAt: new Date().toISOString(),
      receipt: read.receipt,
    };
  });
  return { roots, areas, profile, file, queue, producer };
}
async function completeFixture() {
  const s = await fixture(),
    ownerDigest = digest({ targetDigest: digest(s.roots.targetRoot), filesystemUuid: s.profile.filesystemUuid }),
    bytes = Buffer.from('PRIVATE_COMPLETE_CAPTURE_FIXTURE');
  const event = makeCredentialEvent(
    {
      sourceKind: 'backup_repository',
      sourceKey: 'e'.repeat(64),
      generation: 1,
      phase: 'ready',
      files: [{ name: 'repository.json', bytes }],
    },
    ownerDigest,
  );
  let released = false;
  f.credentialSnapshot.mockImplementation(async (roots, options, operation) => {
    expect(roots).toEqual(s.roots);
    options.assertAuthority();
    try {
      return await operation({
        ownerDigest,
        sources: [
          {
            event,
            files: [{ name: 'repository.json', destination: 'backup-credentials/backup-repository.json', bytes }],
          },
        ],
        assertCurrent: options.assertAuthority,
      });
    } finally {
      bytes.fill(0);
      released = true;
    }
  });
  f.captureUpload.mockImplementation(async (capture, archive) => {
    expect(released).toBe(true);
    expect(bytes.every((byte) => byte === 0)).toBe(true);
    const options = f.deps! as unknown as {
      credentialProducer(capture: unknown): string[];
      admitUpload(kind: string, bytes: number): Promise<void>;
    };
    const command = options.credentialProducer(capture);
    expect(command.slice(1)).toEqual([
      path.join(path.dirname(s.producer), 'credential-capture-producer.js'),
      s.roots.targetRoot,
      s.roots.installationRoot,
      s.roots.dataRoot,
      'release-fixture',
      '7',
      capture.cycleAt,
      capture.operationId,
      capture.set.operationId,
    ]);
    await options.admitUpload('credentials', archive.bytes);
    return {
      contract: 'cos-backup-remote-checkpoint/v1',
      repositoryId: s.profile.repositoryId,
      ownerDigest: 'b'.repeat(64),
      kind: 'credentials',
      operationId: capture.operationId,
      snapshotId: 'c'.repeat(64),
      snapshotAt: new Date().toISOString(),
      archiveBytes: archive.bytes,
      archiveSha256: archive.sha256,
      verifiedAt: new Date().toISOString(),
      reconciled: false,
    };
  });
  const at = new Date();
  at.setUTCMinutes(0, 0, 0);
  return { ...s, cycleAt: at.toISOString() };
}
it('prepares and uploads a complete capture under installed scopes after clearing primary buffers, without retiring a queue item', async () => {
  const s = await completeFixture(),
    before = await s.queue.pending('state'),
    guard = vi.fn();
  const result = await uploadVaultCredentialCapture(s.roots, s.cycleAt, guard);
  expect(result.kind).toBe('credentials');
  expect(guard).toHaveBeenCalled();
  expect(f.captureUpload).toHaveBeenCalledOnce();
  expect(f.upload).not.toHaveBeenCalled();
  expect(await s.queue.pending('state')).toEqual(before);
  expect((await s.queue.inspectDelivery('credentials')).items).toEqual([]);
});
it('refuses a complete capture with missing current target admission before opening a repository', async () => {
  const s = await completeFixture();
  f.admitted.mockReturnValue(null);
  await expect(uploadVaultCredentialCapture(s.roots, s.cycleAt, () => {})).rejects.toThrow(
    'backup_credential_capture_unavailable',
  );
  expect(f.nas).not.toHaveBeenCalled();
  expect(f.credentialSnapshot).not.toHaveBeenCalled();
});
it('refuses a changed installed capture producer during awaited upload work', async () => {
  const s = await completeFixture(),
    upload = f.captureUpload.getMockImplementation()!;
  f.captureUpload.mockImplementation(async (...args) => {
    const result = await upload(...args);
    fs.chmodSync(path.join(path.dirname(s.producer), 'credential-capture-producer.js'), 0o600);
    (f.deps!.cache as { assertCurrent(): void }).assertCurrent();
    return result;
  });
  await expect(uploadVaultCredentialCapture(s.roots, s.cycleAt, () => {})).rejects.toThrow(
    'backup_credential_capture_unavailable',
  );
});
const restoreRequest = '14d948fc-4d6d-4e88-851b-257b701b4088';
async function credentialRestoreFixture() {
  const s = await fixture(),
    ownerDigest = digest({ targetDigest: digest(s.roots.targetRoot), filesystemUuid: s.profile.filesystemUuid }),
    bytes = Buffer.from('PRIVATE_ISOLATED_CREDENTIAL_RECOVERY'),
    event = makeCredentialEvent(
      {
        sourceKind: 'backup_repository',
        sourceKey: 'd'.repeat(64),
        generation: 1,
        phase: 'ready',
        files: [{ name: 'repository.json', bytes }],
      },
      ownerDigest,
    ),
    sources = [
      { event, files: [{ name: 'repository.json', destination: 'backup-credentials/backup-repository.json', bytes }] },
    ],
    capture = makeCredentialCapture(
      ownerDigest,
      '2026-10-16T00:00:00.000Z',
      makeRoutedCredentialRecoveryManifest(ownerDigest, sources),
    ),
    chunks: Buffer[] = [];
  await streamCredentialCapture({ ownerDigest, sources, assertCurrent() {} }, capture, async (chunk) => {
    chunks.push(Buffer.from(chunk));
  });
  f.captureRestore.mockImplementation(async (id, owner, sink, admit) => {
    await admit();
    const decoded = await readCredentialCaptureArchive(
      (async function* () {
        for (const chunk of chunks) yield Buffer.from(chunk);
      })(),
      { operationId: id, ownerDigest: owner },
      () => {},
      sink,
    );
    await admit();
    return {
      contract: 'cos-backup-credential-capture-restore/v1',
      repositoryId: s.profile.repositoryId,
      ownerDigest: (f.deps! as { ownerDigest: string }).ownerDigest,
      kind: 'credentials',
      operationId: id,
      snapshotId: 'c'.repeat(64),
      snapshotAt: new Date().toISOString(),
      verifiedAt: new Date().toISOString(),
      archiveBytes: decoded.archiveBytes,
      archiveSha256: decoded.archiveSha256,
      capture: decoded.capture,
    };
  });
  const invoke = <T>(validate: Parameters<typeof restoreVaultCredentialCapture<T>>[4], current = () => {}) =>
    restoreVaultCredentialCapture(s.roots, capture.operationId, restoreRequest, current, validate);
  return { ...s, capture, bytes, invoke };
}
it('recovers a complete credential capture only into a fresh encrypted workspace under both actual writers', async () => {
  const s = await credentialRestoreFixture(),
    before = await s.queue.pending('state');
  let escaped: (() => void) | undefined;
  const result = await s.invoke(async (scope, remote) => {
    scope.assertPayloadCurrent();
    escaped = scope.assertCurrent;
    expect(scope).not.toHaveProperty('sink');
    expect(Object.isFrozen(scope)).toBe(true);
    const name = 'credential-sources/' + remote.capture.set.origins[0].source + '/repository.json';
    expect(scope.withFileBytes(name, 1024, (bytes) => bytes.toString())).toBe(s.bytes.toString());
    expect(fs.existsSync(s.areas['backup-credentials'] + '/backup-repository.json')).toBe(true);
    await expect(s.queue.capture('state', restoreRequest, async () => {}, 65536)).rejects.toThrow(
      'backup_queue_unavailable',
    );
    await expect(maintainVaultBackups(s.roots, () => {})).rejects.toThrow('backup_maintenance_unavailable');
    return { credentialsActivated: false };
  });
  expect(result.validation).toEqual({ credentialsActivated: false });
  expect(result.remote.capture).toEqual(s.capture);
  expect(result.remote).not.toHaveProperty('receipt');
  expect(f.restore).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.credentialSnapshot).not.toHaveBeenCalled();
  expect(await s.queue.pending('state')).toEqual(before);
  expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
  expect(() => escaped!()).toThrow();
});
it.each(['caller', 'validator', 'request', 'operation', 'capacity'])(
  'denies complete credential recovery before readback for invalid %s',
  async (reason) => {
    const s = await credentialRestoreFixture(),
      validate = vi.fn(async () => {});
    if (reason === 'capacity')
      f.capacity.mockResolvedValue({
        staging: 4096,
        cache: 96 * 1024 ** 2,
        credentials: 4096,
        repository: 4096,
        nasFree: 2 ** 42,
        vaultFree: 1024 ** 3,
      });
    await expect(
      restoreVaultCredentialCapture(
        s.roots,
        reason === 'operation' ? '../foreign' : s.capture.operationId,
        reason === 'request' ? '../foreign' : restoreRequest,
        reason === 'caller' ? (undefined as never) : () => {},
        reason === 'validator' ? (undefined as never) : validate,
      ),
    ).rejects.toThrow(/^backup_credential_restore_check_unavailable$/);
    expect(validate).not.toHaveBeenCalled();
    expect(f.captureRestore).not.toHaveBeenCalled();
    expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
  },
);
it.each(['repository', 'owner', 'capture', 'bytes', 'operation'])(
  'rejects changed complete credential %s evidence before the validator',
  async (reason) => {
    const s = await credentialRestoreFixture(),
      read = f.captureRestore.getMockImplementation()!,
      validate = vi.fn(async () => {});
    f.captureRestore.mockImplementation(async (...args) => {
      const remote = await read(...args);
      if (reason === 'repository') remote.repositoryId = 'e'.repeat(64);
      if (reason === 'owner') remote.ownerDigest = 'e'.repeat(64);
      if (reason === 'capture') remote.capture.ownerDigest = 'e'.repeat(64);
      if (reason === 'bytes') remote.archiveBytes++;
      if (reason === 'operation') remote.operationId = restoreRequest;
      return remote;
    });
    await expect(s.invoke(validate)).rejects.toThrow(/^backup_credential_restore_check_unavailable$/);
    expect(validate).not.toHaveBeenCalled();
  },
);
it.each(['payload', 'evidence', 'caller', 'validator', 'capacity'])(
  'rechecks complete credential %s after awaited validation and preserves original pending work',
  async (reason) => {
    const s = await credentialRestoreFixture(),
      before = await s.queue.pending('state'),
      guard = vi.fn();
    await expect(
      s.invoke(async (scope, remote) => {
        await Promise.resolve();
        if (reason === 'payload')
          fs.writeFileSync(
            scope.directory + '/credential-sources/' + remote.capture.set.origins[0].source + '/repository.json',
            'CHANGED',
          );
        if (reason === 'evidence') remote.capture.cycleAt = '2026-10-16T01:00:00.000Z';
        if (reason === 'caller')
          guard.mockImplementation(() => {
            throw Error('PRIVATE_WITHDRAWN');
          });
        if (reason === 'validator') throw Error('PRIVATE_VALIDATOR');
        if (reason === 'capacity')
          f.capacity.mockResolvedValue({
            staging: 4096,
            cache: 129 * 1024 ** 2,
            credentials: 4096,
            repository: 4096,
            nasFree: 2 ** 42,
            vaultFree: 1024 ** 3,
          });
      }, guard),
    ).rejects.toThrow(/^backup_credential_restore_check_unavailable$/);
    expect(await s.queue.pending('state')).toEqual(before);
    if (['payload', 'caller'].includes(reason))
      expect(fs.readdirSync(s.areas.staging)).toContain('.cos-restore-' + restoreRequest);
  },
);
it('recovers through the installed gates and actual shared writers, then validates only the new isolated files', async () => {
  const s = await fixture(),
    before = await s.queue.pending('state'),
    guard = vi.fn();
  const result = await restoreVaultBackup(
    s.roots,
    'state',
    operationId,
    restoreRequest,
    guard,
    async (scope, remote) => {
      scope.assertCurrent();
      expect(scope).not.toHaveProperty('sink');
      expect(Object.isFrozen(scope)).toBe(true);
      expect(scope.inspectFile('coordinated/remote.json')).toMatchObject({
        file: 'coordinated/remote.json',
        bytes: 20,
      });
      expect(scope.withFileBytes('coordinated/remote.json', 1024, (bytes) => bytes.toString())).toBe(
        'synthetic checkpoint',
      );
      scope.ensureDirectory('conversation-backup/history/empty');
      expect(fs.readFileSync(scope.directory + '/coordinated/remote.json', 'utf8')).toBe('synthetic checkpoint');
      expect(remote.receipt.ownerDigest).toBe(before[0].ownerDigest);
      await expect(
        s.queue.capture('state', '5b0d580b-f7bf-47c7-997a-ade6d328fa65', async () => {}, 65536),
      ).rejects.toThrow(/^backup_queue_unavailable$/);
      await expect(maintainVaultBackups(s.roots, guard)).rejects.toThrow(/^backup_maintenance_unavailable$/);
      return { syntheticPayloadVerified: true };
    },
  );
  expect(result.validation).toEqual({ syntheticPayloadVerified: true });
  expect(result.remote).toMatchObject({
    contract: 'cos-backup-remote-restore/v1',
    operationId,
    repositoryId: s.profile.repositoryId,
  });
  expect(f.restore).toHaveBeenCalledOnce();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(f.maintain).not.toHaveBeenCalled();
  expect(await s.queue.pending('state')).toEqual(before);
  expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
  expect(guard).toHaveBeenCalled();
});
it.each(['caller', 'validator', 'request', 'checkpoint'])(
  'requires bound %s before any installed factory or workspace',
  async (reason) => {
    const s = await fixture(),
      validate = vi.fn(async () => {});
    await expect(
      restoreVaultBackup(
        s.roots,
        'state',
        reason === 'checkpoint' ? '00000000-0000-0000-0000-000000000000' : operationId,
        reason === 'request' ? '../outside' : restoreRequest,
        reason === 'caller' ? (undefined as never) : () => {},
        reason === 'validator' ? (undefined as never) : validate,
      ),
    ).rejects.toThrow(/^backup_restore_check_unavailable$/);
    expect(f.artifact).not.toHaveBeenCalled();
    expect(f.restore).not.toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
  },
);
it('requires conservative measured cache and vault headroom before opening a restore workspace', async () => {
  const s = await fixture();
  f.capacity.mockResolvedValue({
    staging: 4096,
    cache: 96 * 1024 ** 2,
    credentials: 4096,
    repository: 4096,
    nasFree: 2 ** 42,
    vaultFree: 1024 ** 3,
  });
  await expect(
    restoreVaultBackup(
      s.roots,
      'state',
      operationId,
      restoreRequest,
      () => {},
      async () => {},
    ),
  ).rejects.toThrow(/^backup_restore_check_unavailable$/);
  expect(f.restore).not.toHaveBeenCalled();
  expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
});
it('denies success when the trusted payload validator rejects without changing the pending checkpoint', async () => {
  const s = await fixture(),
    before = await s.queue.pending('state');
  await expect(
    restoreVaultBackup(
      s.roots,
      'state',
      operationId,
      restoreRequest,
      () => {},
      async () => {
        throw Error('PRIVATE_NATIVE_CHECK_FAILED');
      },
    ),
  ).rejects.toThrow(/^backup_restore_check_unavailable$/);
  expect(await s.queue.pending('state')).toEqual(before);
  expect(fs.readdirSync(s.areas.staging)).toEqual(['backup-queue']);
});
it.each(['capacity', 'target'])(
  'rechecks %s after an awaited payload validator before reporting success',
  async (reason) => {
    const s = await fixture();
    await expect(
      restoreVaultBackup(
        s.roots,
        'state',
        operationId,
        restoreRequest,
        () => {},
        async () => {
          await Promise.resolve();
          if (reason === 'capacity')
            f.capacity.mockResolvedValue({
              staging: 4096,
              cache: 129 * 1024 ** 2,
              credentials: 4096,
              repository: 4096,
              nasFree: 2 ** 42,
              vaultFree: 1024 ** 3,
            });
          else f.target.mockReturnValue({ lifecycle: 'protected', maintenance: true, releaseId: 'release-fixture' });
        },
      ),
    ).rejects.toThrow(/^backup_restore_check_unavailable$/);
    expect((await s.queue.pending('state'))[0].state).toBe('pending');
    if (reason === 'target') expect(fs.readdirSync(s.areas.staging)).toContain('.cos-restore-' + restoreRequest);
  },
);
it('refuses a withdrawn caller after readback and retains the new private residue', async () => {
  const s = await fixture(),
    guard = vi.fn();
  await expect(
    restoreVaultBackup(s.roots, 'state', operationId, restoreRequest, guard, async () => {
      guard.mockImplementation(() => {
        throw Error('PRIVATE_WITHDRAWN');
      });
    }),
  ).rejects.toThrow(/^backup_restore_check_unavailable$/);
  expect(fs.readdirSync(s.areas.staging)).toContain('.cos-restore-' + restoreRequest);
  expect((await s.queue.pending('state'))[0].state).toBe('pending');
});
it('checks the returned repository and queue owner before invoking the trusted validator', async () => {
  const s = await fixture(),
    validate = vi.fn(async () => {});
  f.restore.mockResolvedValue({
    contract: 'cos-backup-remote-restore/v1',
    repositoryId: 'e'.repeat(64),
    ownerDigest: 'f'.repeat(64),
    kind: 'state',
    operationId,
    receipt: { ownerDigest: 'f'.repeat(64), kind: 'state', operationId },
  });
  await expect(restoreVaultBackup(s.roots, 'state', operationId, restoreRequest, () => {}, validate)).rejects.toThrow(
    /^backup_restore_check_unavailable$/,
  );
  expect(validate).not.toHaveBeenCalled();
});
it('maintains through the same admitted installed scopes without uploading or changing the local capture', async () => {
  const s = await fixture(),
    guard = vi.fn();
  expect(await maintainVaultBackups(s.roots, guard)).toMatchObject({
    status: 'backup_repository_maintained',
    repositoryId: s.profile.repositoryId,
    integrity: 'verified',
  });
  expect(guard).toHaveBeenCalled();
  expect(f.maintain).toHaveBeenCalledOnce();
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.verify).not.toHaveBeenCalled();
  expect(await s.queue.pending('state')).toMatchObject([{ operationId, state: 'pending' }]);
});
it('supplies the fixed primary catalog with the live repository authority and returns metadata only', async () => {
  const s = await fixture(),
    guard = vi.fn(),
    unchanged = vi.fn(),
    maintain = f.maintain.getMockImplementation()!;
  const event = { syntheticEvent: true },
    bytes = Buffer.from('PRIVATE_FIXTURE_BORROWED');
  f.credentialSnapshot.mockImplementation(async (roots, options, operation) => {
    expect(roots).toEqual(s.roots);
    options.assertAuthority();
    return operation({
      ownerDigest: 'a'.repeat(64),
      sources: [{ event, files: [{ name: 'credential.json', destination: 'fixed-fixture', bytes }] }],
      assertPrimaryUnchanged: unchanged,
    });
  });
  f.maintain.mockImplementation(async (admit) => {
    const inventory = await (f.deps!.credentialInventory as () => Promise<unknown>)();
    expect(inventory).toEqual({
      ownerDigest: 'a'.repeat(64),
      sources: [{ event, files: [{ name: 'credential.json', destination: 'fixed-fixture' }] }],
    });
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE_FIXTURE_BORROWED');
    return maintain(admit);
  });
  await maintainVaultBackups(s.roots, guard);
  expect(unchanged).toHaveBeenCalledOnce();
  expect(guard).toHaveBeenCalled();
  await expect((f.deps!.credentialInventory as () => Promise<unknown>)()).rejects.toThrow();
});
it('refuses retention while a durable upload retirement still requires its original remote snapshot', async () => {
  const s = await fixture(),
    unlink = fs.unlinkSync;
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/remote.json')) throw Error('interrupted');
    return unlink(file);
  });
  try {
    await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow('backup_upload_unavailable');
  } finally {
    fault.mockRestore();
  }
  await expect(maintainVaultBackups(s.roots, () => {})).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(f.maintain).not.toHaveBeenCalled();
  expect(await s.queue.inspectDelivery('state')).toMatchObject({ items: [{ operationId, disposition: 'reconcile' }] });
});
it('requires bounded prune headroom and checks the live caller after measuring capacity', async () => {
  const s = await fixture(),
    usage = await f.capacity();
  f.capacity.mockResolvedValue({ ...usage, repository: 20 * 1024 ** 3 - 64 * 1024 ** 2 });
  await expect(maintainVaultBackups(s.roots, () => {})).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(f.maintain).not.toHaveBeenCalled();
  let open = true;
  f.capacity.mockImplementation(async () => {
    open = false;
    return usage;
  });
  await expect(
    maintainVaultBackups(s.roots, () => {
      if (!open) throw Error('private withdrawal');
    }),
  ).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(f.maintain).not.toHaveBeenCalled();
});
it.each(['cache', 'vault'])('refuses maintenance without local %s headroom for temporary packs', async (area) => {
  const s = await fixture(),
    usage = await f.capacity();
  f.capacity.mockResolvedValue({
    ...usage,
    ...(area === 'cache' ? { cache: 96 * 1024 ** 2 } : { vaultFree: 1024 ** 2 }),
  });
  await expect(maintainVaultBackups(s.roots, () => {})).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(f.maintain).not.toHaveBeenCalled();
});
it('refuses maintenance when the target enters maintenance during a repository command', async () => {
  const s = await fixture();
  f.maintain.mockImplementation(async (admit) => {
    await admit();
    f.target.mockReturnValue({ lifecycle: 'protected', maintenance: true, releaseId: 'release-fixture' });
    await admit();
  });
  await expect(maintainVaultBackups(s.roots, () => {})).rejects.toThrow(/^backup_maintenance_unavailable$/);
});
it('checks the background caller before artifact or NAS access', async () => {
  const s = await fixture();
  await expect(
    uploadVaultBackup(s.roots, 'state', operationId, () => {
      throw Error('caller closed');
    }),
  ).rejects.toThrow('backup_upload_unavailable');
  expect(f.artifact).not.toHaveBeenCalled();
  expect(f.nas).not.toHaveBeenCalled();
  expect(await s.queue.pending('state')).toMatchObject([{ operationId, state: 'pending' }]);
});
it('rechecks the background caller after remote readback and before local retirement', async () => {
  const s = await fixture();
  let open = true;
  const usage = await f.capacity();
  f.capacity.mockClear();
  f.capacity.mockResolvedValueOnce(usage).mockImplementationOnce(async () => {
    open = false;
    return usage;
  });
  await expect(
    uploadVaultBackup(s.roots, 'state', operationId, () => {
      if (!open) throw Error('caller closed');
    }),
  ).rejects.toThrow('backup_upload_unavailable');
  expect(f.upload).toHaveBeenCalledOnce();
  expect(await s.queue.pending('state')).toMatchObject([{ operationId, state: 'pending' }]);
  expect(fs.existsSync(s.areas.staging + '/backup-queue/full/data/coordinated/remote.json')).toBe(true);
});
it('connects only installed vault, artifact, NAS, password and writer gates before transfer admission', async () => {
  const s = await fixture(),
    result = await uploadVaultBackup(s.roots, 'state', operationId);
  expect(result.operationId).toBe(operationId);
  expect(f.upload).toHaveBeenCalledOnce();
  expect(f.artifact.mock.calls[0][0]).toBe(path.join(s.roots.installationRoot, 'libexec/restic'));
  expect(f.nas.mock.calls[0][0]).toEqual(s.profile.mount);
  expect(f.password.mock.calls[0][0]).toEqual(s.roots);
  const deps = f.deps! as unknown as { producer(kind: string, id: string): string[] };
  expect(deps.producer('state', operationId)).toEqual([
    process.execPath,
    s.producer,
    s.roots.targetRoot,
    s.roots.installationRoot,
    s.roots.dataRoot,
    'state',
    operationId,
  ]);
  expect(f.capacity).toHaveBeenCalledTimes(2);
  expect(await s.queue.pending('state')).toEqual([]);
  const ack = JSON.parse(fs.readFileSync(s.areas.staging + '/backup-queue/.cos-last-ack.json', 'utf8'));
  expect(result).toMatchObject(ack.remote);
  expect(ack.remote).not.toHaveProperty('verifiedAt');
});
it('reconciles interrupted cleanup with fresh verification and never invokes another upload', async () => {
  const s = await fixture();
  const unlink = fs.unlinkSync;
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/remote.json')) throw Error('interrupted');
    return unlink(file);
  });
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
  fault.mockRestore();
  expect(await s.queue.pending('state')).toMatchObject([{ operationId, state: 'failed' }]);
  f.verify.mockRejectedValueOnce(Error('NAS_OFFLINE'));
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
  const result = await uploadVaultBackup(s.roots, 'state', operationId);
  expect(result.reconciled).toBe(true);
  expect(f.upload).toHaveBeenCalledOnce();
  expect(f.verify).toHaveBeenCalledTimes(2);
  expect(await s.queue.pending('state')).toEqual([]);
});
it('freshly verifies a lost final response without touching a newer full checkpoint', async () => {
  const s = await fixture();
  await uploadVaultBackup(s.roots, 'state', operationId);
  const next = '6ea53126-7177-469b-8bc1-cedd11635b79';
  await s.queue.capture('state', next, async (sink) => sink.write('next.json', Buffer.from('next')), 65536);
  await uploadVaultBackup(s.roots, 'state', operationId);
  expect(f.upload).toHaveBeenCalledOnce();
  expect(f.verify).toHaveBeenCalledOnce();
  expect(await s.queue.pending('state')).toMatchObject([{ operationId: next, state: 'pending' }]);
});
it.each([
  'foreign-roots',
  'foreign-volume',
  'invalid-repository',
  'extra-secret',
  'linked-profile',
  'maintenance',
  'unprotected',
])('refuses %s before artifact or NAS access', async (reason) => {
  const s = await fixture();
  if (reason === 'foreign-roots') s.profile.rootsDigest = '0'.repeat(64);
  if (reason === 'foreign-volume') s.profile.filesystemUuid = '22222222-2222-4222-8222-222222222222';
  if (reason === 'invalid-repository') s.profile.repositoryId = 'unverified';
  if (reason === 'extra-secret') Object.assign(s.profile, { password: 'synthetic-private-sentinel' });
  fs.writeFileSync(s.file, JSON.stringify(s.profile));
  if (reason === 'linked-profile') {
    fs.renameSync(s.file, s.file + '.previous');
    fs.symlinkSync(s.file + '.previous', s.file);
  }
  if (reason === 'maintenance')
    f.target.mockReturnValue({ lifecycle: 'protected', maintenance: true, releaseId: 'release-fixture' });
  if (reason === 'unprotected')
    f.target.mockReturnValue({
      lifecycle: 'implementation_disposable',
      maintenance: false,
      releaseId: 'release-fixture',
    });
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
  expect(f.artifact).not.toHaveBeenCalled();
  expect(f.nas).not.toHaveBeenCalled();
  expect(f.password).not.toHaveBeenCalled();
});
it('refuses unavailable NAS before password handoff and retains the pending queue', async () => {
  const s = await fixture();
  f.nas.mockImplementation(() => {
    throw Error('private NAS diagnostic');
  });
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
  expect(f.password).not.toHaveBeenCalled();
  expect(f.upload).not.toHaveBeenCalled();
  expect((await s.queue.pending('state'))[0].state).toBe('pending');
});
it('refuses measured quota exhaustion before issuing a transfer and keeps its source', async () => {
  const s = await fixture();
  f.capacity.mockResolvedValue({
    staging: 4096,
    cache: 4096,
    credentials: 4096,
    repository: 20 * 1024 ** 3,
    nasFree: 2 ** 42,
    vaultFree: 1024 ** 3,
  });
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
  expect((await s.queue.pending('state'))[0].state).toBe('pending');
});
it.each(['profile', 'producer', 'maintenance'])(
  'refuses a late %s change before acknowledging transfer',
  async (reason) => {
    const s = await fixture();
    let changed = false;
    f.upload.mockImplementation(async () => {
      if (reason === 'profile')
        fs.writeFileSync(s.file, JSON.stringify({ ...s.profile, repositoryId: 'd'.repeat(64) }));
      if (reason === 'producer') {
        fs.renameSync(s.producer, s.producer + '.previous');
        fs.writeFileSync(s.producer, '// changed synthetic producer', { mode: 0o500 });
      }
      if (reason === 'maintenance')
        f.target.mockReturnValue({ lifecycle: 'protected', maintenance: true, releaseId: 'release-fixture' });
      changed = true;
      return { snapshotId: 'c'.repeat(64) };
    });
    await expect(uploadVaultBackup(s.roots, 'state', operationId)).rejects.toThrow(/^backup_upload_unavailable$/);
    expect(changed).toBe(true);
    expect((await s.queue.pending('state'))[0].state).toBe('pending');
  },
);

it('selects the verified helper payload producer when the data installation has no compiled dist directory', async () => {
  const s = await fixture(),
    oldProducer = path.join(s.roots.installationRoot, 'dist/modules/chief-of-staff/ops/backup-archive-producer.js'),
    retained = path.join(
      path.dirname(s.roots.installationRoot),
      'retained-payload/dist/modules/chief-of-staff/ops/backup-archive-producer.js',
    );
  fs.mkdirSync(path.dirname(retained), { recursive: true, mode: 0o700 });
  fs.renameSync(oldProducer, retained);
  fs.rmSync(path.join(s.roots.installationRoot, 'dist'), { recursive: true });
  f.producerFile = retained;
  await expect(uploadVaultBackup(s.roots, 'state', operationId)).resolves.toMatchObject({ operationId });
  expect((f.deps!.producer as (kind: string, id: string) => string[])('state', operationId)).toEqual([
    process.execPath,
    retained,
    s.roots.targetRoot,
    s.roots.installationRoot,
    s.roots.dataRoot,
    'state',
    operationId,
  ]);
  expect(fs.existsSync(path.join(s.roots.installationRoot, 'dist'))).toBe(false);
});
