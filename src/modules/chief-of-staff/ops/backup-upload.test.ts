import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { BackupQueue } from './backup-queue.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import type { RemoteCheckpoint } from './backup-restic-transfer.js';
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
  deps: undefined as undefined | Record<string, unknown>,
}));
vi.mock('./vault-storage.js', () => ({ verifyVaultStorage: f.vault, withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./restic-artifact.js', () => ({ withVerifiedResticBinary: f.artifact }));
vi.mock('./backup-nas-access.js', () => ({ withSignedBackupRepository: f.nas }));
vi.mock('./backup-password.js', () => ({ withVaultResticPassword: f.password }));
vi.mock('./backup-capacity.js', () => ({ readBackupCapacity: f.capacity }));
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
import { uploadVaultBackup } from './backup-upload.js';
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
  f.access.mockImplementation(async (_roots, area, callback) => callback(areas[area]));
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
    return { upload: f.upload, verify: f.verify };
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
  return { roots, areas, profile, file, queue, producer };
}
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
