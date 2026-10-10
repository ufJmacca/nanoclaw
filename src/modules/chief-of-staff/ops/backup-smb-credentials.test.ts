import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
const f = vi.hoisted(() => ({ access: vi.fn(), memory: vi.fn(), vault: vi.fn(), target: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access, verifyVaultStorage: f.vault }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./target-identity.js', () => ({ localTarget: f.target }));
import { withVaultSmbCredentials } from './backup-smb-credentials.js';
const temporary: string[] = [];
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
const expected = {
  filesystemUuid: '11111111-1111-4111-8111-111111111111',
  credentialReference: '319c6740-24ba-4d68-9d3c-a4d53c9607d1',
  targetDigest: 'a'.repeat(64),
  minimumGeneration: 10,
};
const binding = {
  hostFingerprint: 'b'.repeat(64),
  databaseFingerprint: 'c'.repeat(64),
  service: 'fixture.service',
  installationRoot: roots.installationRoot,
  dataRoot: roots.dataRoot,
};
expected.targetDigest = digest(binding);
const password = Buffer.from('synthetic-π-password');
const material = () =>
  Buffer.concat([Buffer.from('username=nanoclaw-cos-backup\npassword='), password, Buffer.from('\n')]);
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(f)) fn.mockReset();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-smb-'));
  temporary.push(root);
  const directory = path.join(root, 'backup-credentials');
  fs.mkdirSync(directory, { mode: 0o700 });
  const file = path.join(directory, 'smb-credentials'),
    marker = path.join(directory, 'backup-credential-installation.json');
  fs.writeFileSync(file, material(), { mode: 0o600 });
  const installation = {
    contract: 'cos-backup-credential-installation/v1',
    rootsDigest: digest(roots),
    filesystemUuid: expected.filesystemUuid,
    credentialReference: expected.credentialReference,
    operationId: '48f99256-b105-4ee3-848c-00140c98151d',
    phase: 'ready',
  };
  fs.writeFileSync(marker, JSON.stringify(installation), { mode: 0o600 });
  f.access.mockImplementation(async (_roots, _area, callback) => callback(directory));
  f.vault.mockReturnValue({ vaultRoot: root, volume: { filesystemUuid: expected.filesystemUuid } });
  f.target.mockReturnValue({
    binding,
    lifecycle: 'protected',
    maintenance: false,
    generation: 10,
    releaseId: 'release-fixture',
  });
  return { root, directory, file, marker, installation };
}
it('passes only a verified private descriptor while the encrypted owner scope stays current', async () => {
  const s = fixture();
  let fd = -1,
    current!: () => void;
  await withVaultSmbCredentials(roots, expected, async (credential) => {
    expect(Object.isFrozen(credential)).toBe(true);
    expect(Object.keys(credential).sort()).toEqual(['assertCurrent', 'fd', 'filesystemUuid', 'installationDigest']);
    expect(credential.filesystemUuid).toBe(expected.filesystemUuid);
    expect(credential.installationDigest).toBe(digest(s.installation));
    fd = credential.fd;
    current = credential.assertCurrent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    current();
    expect(fs.readlinkSync('/proc/self/fd/' + fd)).toBe(s.file);
  });
  expect(f.memory).toHaveBeenCalled();
  expect(() => fs.fstatSync(fd)).toThrow();
  expect(() => current()).toThrow(/^backup_smb_credentials_unavailable$/);
});
it.each([
  'missing',
  'symlink',
  'hardlink',
  'permissions',
  'oversized',
  'wrong-user',
  'extra-line',
  'invalid-utf8',
  'short-password',
  'long-password',
  'nul',
  'memory',
  'vault-uuid',
  'reference',
  'preparing',
  'target',
  'generation',
])('refuses %s before allowing any mount command', async (reason) => {
  const s = fixture(),
    callback = vi.fn(async () => {});
  if (reason === 'missing') fs.unlinkSync(s.file);
  if (reason === 'symlink') {
    fs.renameSync(s.file, s.file + '.old');
    fs.symlinkSync(s.file + '.old', s.file);
  }
  if (reason === 'hardlink') fs.linkSync(s.file, s.file + '.other');
  if (reason === 'permissions') fs.chmodSync(s.file, 0o644);
  if (reason === 'oversized') fs.writeFileSync(s.file, Buffer.alloc(4096));
  if (reason === 'wrong-user')
    fs.writeFileSync(s.file, Buffer.concat([Buffer.from('username=admin\npassword='), password, Buffer.from('\n')]));
  if (reason === 'extra-line') fs.appendFileSync(s.file, 'domain=foreign\n');
  if (reason === 'invalid-utf8') {
    const bytes = material();
    bytes[bytes.length - 2] = 0xff;
    fs.writeFileSync(s.file, bytes);
  }
  if (reason === 'short-password' || reason === 'long-password')
    fs.writeFileSync(
      s.file,
      Buffer.concat([
        Buffer.from('username=nanoclaw-cos-backup\npassword='),
        Buffer.alloc(reason === 'short-password' ? 15 : 65, 0x61),
        Buffer.from('\n'),
      ]),
    );
  if (reason === 'nul') {
    const bytes = material();
    bytes[bytes.length - 2] = 0;
    fs.writeFileSync(s.file, bytes);
  }
  if (reason === 'memory')
    f.memory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'vault-uuid')
    f.vault.mockReturnValue({ vaultRoot: s.root, volume: { filesystemUuid: '22222222-2222-4222-8222-222222222222' } });
  if (reason === 'reference')
    fs.writeFileSync(
      s.marker,
      JSON.stringify({ ...s.installation, credentialReference: '8c462c7f-0c31-4d63-9a8f-54c68ba17994' }),
    );
  if (reason === 'preparing') fs.writeFileSync(s.marker, JSON.stringify({ ...s.installation, phase: 'preparing' }));
  if (reason === 'target')
    f.target.mockReturnValue({
      binding,
      lifecycle: 'implementation_disposable',
      generation: 10,
      releaseId: 'release-fixture',
    });
  if (reason === 'generation')
    f.target.mockReturnValue({ binding, lifecycle: 'protected', generation: 9, releaseId: 'release-fixture' });
  await expect(withVaultSmbCredentials(roots, expected, callback)).rejects.toThrow(
    /^backup_smb_credentials_unavailable$/,
  );
  expect(callback).not.toHaveBeenCalled();
});
it.each(['file', 'directory', 'installation', 'target', 'memory'])(
  'refuses a late %s change and releases the credential descriptor',
  async (reason) => {
    const s = fixture();
    let fd = -1;
    await expect(
      withVaultSmbCredentials(roots, expected, async (credential) => {
        fd = credential.fd;
        if (reason === 'file') {
          fs.renameSync(s.file, s.file + '.old');
          fs.writeFileSync(s.file, material(), { mode: 0o600 });
        }
        if (reason === 'directory') {
          fs.renameSync(s.directory, s.directory + '.old');
          fs.mkdirSync(s.directory, { mode: 0o700 });
        }
        if (reason === 'installation')
          fs.writeFileSync(
            s.marker,
            JSON.stringify({ ...s.installation, credentialReference: '8c462c7f-0c31-4d63-9a8f-54c68ba17994' }),
          );
        if (reason === 'target') f.target.mockReturnValue({ ...f.target(), generation: 11 });
        if (reason === 'memory')
          f.memory.mockImplementation(() => {
            throw Error('PRIVATE_LATE_MEMORY');
          });
        credential.assertCurrent();
      }),
    ).rejects.toThrow(/^backup_smb_credentials_unavailable$/);
    expect(() => fs.fstatSync(fd)).toThrow();
  },
);
it('wipes the bounded file-validation buffer and never decodes or logs its password', async () => {
  fixture();
  const read = fs.readSync;
  const borrowed: Buffer[] = [];
  vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
    if (Buffer.isBuffer(args[1])) borrowed.push(args[1]);
    return read(...args);
  }) as typeof fs.readSync);
  await withVaultSmbCredentials(roots, expected, async () => {});
  expect(borrowed.length).toBeGreaterThan(0);
  expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
