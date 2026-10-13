import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type SpawnOptions } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
const memory = vi.hoisted(() => vi.fn());
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: memory }));
import { executeBackupNasMount } from './backup-nas-mount-process.js';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  memory.mockReset();
});
function fixture(reason = '') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mount-process-'));
  const file = path.join(root, 'credential');
  fs.writeFileSync(file, 'synthetic-private-mount-password', { mode: 0o600 });
  const fd = fs.openSync(file, fs.constants.O_RDONLY);
  const script = path.join(root, 'mount.mjs');
  fs.writeFileSync(
    script,
    `
import fs from 'node:fs';
const bytes=fs.readFileSync(3);
try {
  fs.writeFileSync(process.env.FIXTURE_ROOT+'/observation.json',JSON.stringify({descriptorMatched:bytes.equals(Buffer.from('synthetic-private-mount-password')),args:process.argv.slice(2)}),{mode:0o600});
} finally {bytes.fill(0);}
process.stdout.write('PRIVATE_MOUNT_DIAGNOSTIC');process.stderr.write('PRIVATE_MOUNT_DIAGNOSTIC');
if(process.env.FIXTURE_REASON==='exit') process.exit(1);
if(['stall','abort'].includes(process.env.FIXTURE_REASON)) { process.on('SIGTERM',()=>{});setInterval(()=>{},1000);await new Promise(()=>{}); }
`,
    { mode: 0o600 },
  );
  const abort = new AbortController(),
    children: ReturnType<typeof spawn>[] = [];
  const lease = Object.freeze({ fd, signal: abort.signal, assertCurrent: vi.fn(async () => {}) });
  const destination = vi.fn((_phase: 'before' | 'after') => {});
  const controls = {
    assertRole: vi.fn(),
    deadlineMs: 1000,
    spawnMount: vi.fn((command: string, args: string[], options: SpawnOptions) => {
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
    fs.closeSync(fd);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    fd,
    abort,
    children,
    lease,
    destination,
    controls,
    input: { host: '192.168.56.12', userId: 1000, groupId: 1000 },
  };
}
it('passes only inherited descriptor 3 to the fixed signed mount command under fresh root and destination checks', async () => {
  const s = fixture();
  await executeBackupNasMount(s.input, s.lease, s.destination, s.controls);
  const [command, args, options] = s.controls.spawnMount.mock.calls[0];
  expect(command).toBe('/usr/sbin/mount.cifs');
  expect(args.slice(0, 3)).toEqual(['//192.168.56.12/nanoclaw-cos-backups', '/var/lib/nanoclaw-cos/nas', '-o']);
  expect(args[3]).toContain('credentials=/proc/self/fd/3');
  expect(options).toEqual({
    cwd: '/',
    detached: true,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'ignore', 'ignore', s.fd],
  });
  expect(JSON.stringify([args, options])).not.toContain('synthetic-private-mount-password');
  expect(JSON.parse(fs.readFileSync(path.join(s.root, 'observation.json'), 'utf8')).descriptorMatched).toBe(true);
  expect(s.destination.mock.calls).toEqual([['before'], ['after']]);
  expect(s.lease.assertCurrent).toHaveBeenCalledTimes(2);
  expect(s.children[0].exitCode).toBe(0);
  expect(fs.fstatSync(s.fd).isFile()).toBe(true);
});
it.each(['role', 'memory', 'lease', 'destination', 'aborted', 'descriptor', 'command', 'deadline'])(
  'denies initial %s without spawning mount.cifs',
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
    if (reason === 'lease') s.lease.assertCurrent.mockRejectedValue(Error('PRIVATE_LEASE'));
    if (reason === 'destination')
      s.destination.mockImplementation(() => {
        throw Error('PRIVATE_DESTINATION');
      });
    if (reason === 'aborted') s.abort.abort();
    if (reason === 'command') s.input.host = '8.8.8.8';
    if (reason === 'deadline') s.controls.deadlineMs = 20001;
    const lease = reason === 'descriptor' ? { ...s.lease, fd: 2 } : s.lease;
    await expect(executeBackupNasMount(s.input, lease, s.destination, s.controls)).rejects.toThrow(
      /^backup_nas_mount_unavailable$/,
    );
    expect(s.controls.spawnMount).not.toHaveBeenCalled();
  },
);
it.each(['exit', 'stall', 'abort', 'late-lease', 'late-destination'])(
  'fails closed on %s and awaits owned process termination',
  async (reason) => {
    const s = fixture(reason);
    if (reason === 'stall') s.controls.deadlineMs = 25;
    if (reason === 'late-lease')
      s.lease.assertCurrent.mockResolvedValueOnce(undefined).mockRejectedValue(Error('PRIVATE_LATE_LEASE'));
    if (reason === 'late-destination')
      s.destination.mockImplementation((phase) => {
        if (phase === 'after') throw Error('PRIVATE_LATE_DESTINATION');
      });
    await expect(executeBackupNasMount(s.input, s.lease, s.destination, s.controls)).rejects.toThrow(
      /^backup_nas_mount_unavailable$/,
    );
    expect(s.children[0].exitCode !== null || s.children[0].signalCode !== null).toBe(true);
    expect(fs.fstatSync(s.fd).isFile()).toBe(true);
  },
);

it('signal refusal cannot skip actual owned child closure or expose signal diagnostics', async () => {
  const s = fixture(),
    actual = process.kill;
  const spy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (s.children.some((child) => pid === -child.pid!))
      throw Object.assign(Error('PRIVATE_SIGNAL_DENIED'), { code: 'EPERM' });
    return actual(pid, signal);
  });
  s.controls.spawnMount.mockImplementation((_command, _args, options) => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{},125)'], options);
    s.children.push(child);
    s.abort.abort();
    return child;
  });
  try {
    await expect(executeBackupNasMount(s.input, s.lease, s.destination, s.controls)).rejects.toThrow(
      /^backup_nas_mount_unavailable$/,
    );
    expect(s.children[0].exitCode !== null || s.children[0].signalCode !== null).toBe(true);
    expect(s.destination.mock.calls.some((call) => call[0] === 'after')).toBe(false);
  } finally {
    spy.mockRestore();
  }
});
