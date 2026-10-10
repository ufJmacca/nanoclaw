import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
const f = vi.hoisted(() => ({ access: vi.fn(), memory: vi.fn(), vault: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access, verifyVaultStorage: f.vault }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
import { withVaultResticPassword } from './backup-password.js';
const temporary: string[] = [];
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
afterEach(() => {
  vi.restoreAllMocks();
  f.access.mockReset();
  f.memory.mockReset();
  f.vault.mockReset();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-password-'));
  temporary.push(root);
  const file = path.join(root, 'restic-password');
  const marker = path.join(root, 'backup-credential-installation.json');
  const installation = {
    contract: 'cos-backup-credential-installation/v1',
    rootsDigest: digest(roots),
    filesystemUuid: '11111111-1111-4111-8111-111111111111',
    operationId: '48f99256-b105-4ee3-848c-00140c98151d',
    credentialReference: '319c6740-24ba-4d68-9d3c-a4d53c9607d1',
    phase: 'ready',
  };
  fs.writeFileSync(marker, JSON.stringify(installation), { mode: 0o600 });
  f.vault.mockReturnValue({ volume: { filesystemUuid: installation.filesystemUuid } });
  fs.writeFileSync(file, 'synthetic-encryption-password-with-no-live-authority\n', { mode: 0o600 });
  f.access.mockImplementation(async (_roots, _area, operation) => operation(root));
  return { root, file, marker, installation };
}
it('passes only a held private credential descriptor under the vault and memory gate', async () => {
  const s = fixture(),
    read = vi.spyOn(fs, 'readFileSync');
  let fd = -1,
    check!: () => void;
  await withVaultResticPassword(roots, async (password) => {
    fd = password.fd;
    check = password.assertCurrent;
    await new Promise<void>((resolve) => setImmediate(resolve));
    password.assertCurrent();
    expect(fs.readlinkSync('/proc/self/fd/' + fd)).toBe(s.file);
  });
  expect(f.access.mock.calls[0].slice(0, 2)).toEqual([roots, 'backup-credentials']);
  expect(f.memory).toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  expect(() => fs.fstatSync(fd)).toThrow();
  expect(() => check()).toThrow(/^backup_password_unavailable$/);
});
it.each(['missing', 'preparing', 'wrong-vault', 'wrong-roots', 'symlink', 'hardlink', 'permissions'])(
  'refuses a %s installation marker before lending the password descriptor',
  async (reason) => {
    const s = fixture(),
      operation = vi.fn();
    if (reason === 'missing') fs.unlinkSync(s.marker);
    if (reason === 'preparing') fs.writeFileSync(s.marker, JSON.stringify({ ...s.installation, phase: 'preparing' }));
    if (reason === 'wrong-vault')
      fs.writeFileSync(
        s.marker,
        JSON.stringify({ ...s.installation, filesystemUuid: '22222222-2222-4222-8222-222222222222' }),
      );
    if (reason === 'wrong-roots')
      fs.writeFileSync(s.marker, JSON.stringify({ ...s.installation, rootsDigest: 'a'.repeat(64) }));
    if (reason === 'symlink') {
      fs.renameSync(s.marker, s.marker + '.original');
      fs.symlinkSync(s.marker + '.original', s.marker);
    }
    if (reason === 'hardlink') fs.linkSync(s.marker, s.marker + '.other');
    if (reason === 'permissions') fs.chmodSync(s.marker, 0o644);
    await expect(withVaultResticPassword(roots, operation)).rejects.toThrow(/^backup_password_unavailable$/);
    expect(operation).not.toHaveBeenCalled();
  },
);
it('detects changed installation identity across awaited password use', async () => {
  const s = fixture();
  let fd = -1;
  await expect(
    withVaultResticPassword(roots, async (password) => {
      fd = password.fd;
      fs.writeFileSync(
        s.marker,
        JSON.stringify({ ...s.installation, credentialReference: '8c462c7f-0c31-4d63-9a8f-54c68ba17994' }),
      );
    }),
  ).rejects.toThrow(/^backup_password_unavailable$/);
  expect(() => fs.fstatSync(fd)).toThrow();
});
it.each(['missing', 'linked', 'hardlink', 'permissions', 'oversized', 'empty', 'memory'])(
  'refuses %s before handing a password to any command',
  async (reason) => {
    const s = fixture(),
      operation = vi.fn();
    if (reason === 'missing') fs.unlinkSync(s.file);
    if (reason === 'linked') {
      fs.renameSync(s.file, s.file + '.original');
      fs.symlinkSync(s.file + '.original', s.file);
    }
    if (reason === 'hardlink') fs.linkSync(s.file, s.file + '.other');
    if (reason === 'permissions') fs.chmodSync(s.file, 0o644);
    if (reason === 'oversized') fs.writeFileSync(s.file, Buffer.alloc(4097));
    if (reason === 'empty') fs.writeFileSync(s.file, '');
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('private memory diagnostic');
      });
    await expect(withVaultResticPassword(roots, operation)).rejects.toThrow(/^backup_password_unavailable$/);
    expect(operation).not.toHaveBeenCalled();
  },
);
it('detects credential replacement across awaited work and releases the held descriptor', async () => {
  const s = fixture();
  let fd = -1;
  await expect(
    withVaultResticPassword(roots, async (password) => {
      fd = password.fd;
      fs.renameSync(s.file, s.file + '.previous');
      fs.writeFileSync(s.file, 'synthetic-replacement-password-no-live-authority\n', { mode: 0o600 });
      password.assertCurrent();
    }),
  ).rejects.toThrow(/^backup_password_unavailable$/);
  expect(() => fs.fstatSync(fd)).toThrow();
});
