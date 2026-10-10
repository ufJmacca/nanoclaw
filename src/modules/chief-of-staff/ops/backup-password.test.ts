import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ access: vi.fn(), memory: vi.fn() }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
import { withVaultResticPassword } from './backup-password.js';
const temporary: string[] = [];
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
afterEach(() => {
  vi.restoreAllMocks();
  f.access.mockReset();
  f.memory.mockReset();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-password-'));
  temporary.push(root);
  const file = path.join(root, 'restic-password');
  fs.writeFileSync(file, 'synthetic-encryption-password-with-no-live-authority\n', { mode: 0o600 });
  f.access.mockImplementation(async (_roots, _area, operation) => operation(root));
  return { root, file };
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
