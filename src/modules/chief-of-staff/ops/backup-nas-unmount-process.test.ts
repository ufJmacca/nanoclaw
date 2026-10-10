import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => vi.fn());
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: memory }));
import { executeBackupNasUnmount } from './backup-nas-unmount-process.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  memory.mockReset();
});
function fixture(reason = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-unmount-process-'));
  const script = path.join(root, 'unmount.mjs');
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
fs.writeFileSync(process.env.FIXTURE_ROOT+'/observation.json',JSON.stringify({args:process.argv.slice(2),privateEnvironment:Object.keys(process.env).some(key=>key.includes('PASSWORD'))}),{mode:0o600});
process.stdout.write('PRIVATE_UNMOUNT_DIAGNOSTIC');process.stderr.write('PRIVATE_UNMOUNT_DIAGNOSTIC');
if(process.env.FIXTURE_REASON==='busy') process.exit(32);
if(['stall','abort'].includes(process.env.FIXTURE_REASON)) { process.on('SIGTERM',()=>{}); setInterval(()=>{},1000); await new Promise(()=>{}); }
`,
    { mode: 0o600 },
  );
  const abort = new AbortController(),
    children: ReturnType<typeof spawn>[] = [];
  const lease = Object.freeze({ signal: abort.signal, assertCurrent: vi.fn(async () => {}) });
  const destination = vi.fn((_phase: 'before' | 'after') => {});
  const controls = {
    assertRole: vi.fn(),
    deadlineMs: 1000,
    spawnUnmount: vi.fn((command: string, args: string[], options: SpawnOptions) => {
      const child = spawn(process.execPath, [script, command, ...args], {
        ...options,
        env: { ...options.env, FIXTURE_ROOT: root, FIXTURE_REASON: reason },
      });
      children.push(child);
      if (reason === 'abort') setTimeout(() => abort.abort(), 25);
      return child;
    }),
  };
  cleanups.push(() => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    abort,
    children,
    lease,
    destination,
    controls,
    claim: { id: 42, device: 17, inode: 23, bindingDigest: 'a'.repeat(64) },
  };
}
it('uses only the fixed normal kernel unmount with fresh claimed destination checks and no credential descriptor', async () => {
  const s = fixture();
  await executeBackupNasUnmount(s.claim, s.lease, s.destination, s.controls);
  expect(s.controls.spawnUnmount.mock.calls[0]).toEqual([
    '/usr/bin/umount',
    ['--internal-only', '--no-canonicalize', '--no-mtab', '--types', 'cifs', '--', '/var/lib/nanoclaw-cos/nas'],
    {
      cwd: '/',
      detached: true,
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'ignore', 'ignore'],
    },
  ]);
  expect(s.destination.mock.calls).toEqual([
    ['before', s.claim],
    ['after', s.claim],
  ]);
  expect(s.lease.assertCurrent).toHaveBeenCalledTimes(2);
  expect(s.children[0].exitCode).toBe(0);
  expect(JSON.parse(fs.readFileSync(path.join(s.root, 'observation.json'), 'utf8')).privateEnvironment).toBe(false);
});
it.each(['role', 'memory', 'lease', 'destination', 'aborted', 'deadline', 'id', 'device', 'inode', 'binding', 'extra'])(
  'denies initial %s without a disconnect attempt',
  async (reason) => {
    const s = fixture();
    if (reason === 'role')
      s.controls.assertRole.mockImplementation(() => {
        throw Error('PRIVATE_ROLE');
      });
    if (reason === 'memory')
      memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'lease') s.lease.assertCurrent.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
    if (reason === 'destination')
      s.destination.mockImplementation(() => {
        throw Error('PRIVATE_DESTINATION');
      });
    if (reason === 'aborted') s.abort.abort();
    if (reason === 'deadline') s.controls.deadlineMs = 5001;
    if (reason === 'id') s.claim.id = 0;
    if (reason === 'device') s.claim.device = -1;
    if (reason === 'inode') s.claim.inode = 0;
    if (reason === 'binding') s.claim.bindingDigest = 'PRIVATE_BINDING';
    if (reason === 'extra') Object.assign(s.claim, { target: '/unrelated' });
    await expect(executeBackupNasUnmount(s.claim, s.lease, s.destination, s.controls)).rejects.toThrow(
      /^backup_nas_unmount_unavailable$/,
    );
    expect(s.controls.spawnUnmount).not.toHaveBeenCalled();
  },
);
it.each(['busy', 'stall', 'abort', 'late-lease', 'late-destination'])(
  'keeps %s uncertain and waits for termination of only its owned utility process',
  async (reason) => {
    const s = fixture(reason);
    if (reason === 'stall') s.controls.deadlineMs = 25;
    if (reason === 'late-lease')
      s.lease.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValue(Error('PRIVATE_LATE_AUTHORITY'));
    if (reason === 'late-destination')
      s.destination.mockImplementation((phase) => {
        if (phase === 'after') throw Error('PRIVATE_LATE_DESTINATION');
      });
    await expect(executeBackupNasUnmount(s.claim, s.lease, s.destination, s.controls)).rejects.toThrow(
      /^backup_nas_unmount_unavailable$/,
    );
    expect(s.children[0].exitCode !== null || s.children[0].signalCode !== null).toBe(true);
  },
);
