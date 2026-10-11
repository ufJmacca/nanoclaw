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
  deps: undefined as undefined | Record<string, unknown>,
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
import { uploadVaultBackup, maintainVaultBackups, restoreVaultBackup } from './backup-upload.js';
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
  const policy = {
    targetDigest: digest(roots.targetRoot),
    volume: { filesystemUuid: '11111111-1111-4111-8111-111111111111' },
  };
  f.vault.mockReturnValue(policy);
  f.target.mockReturnValue({ lifecycle: 'protected', maintenance: false, releaseId: 'release-fixture' });
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
    return { upload: f.upload, verify: f.verify, maintain: f.maintain, restore: f.restore };
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
const restoreRequest = '14d948fc-4d6d-4e88-851b-257b701b4088';
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
