import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { observeBackupNasMount } from './backup-nas-kernel.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(mounted = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-kernel-'));
  roots.push(root);
  const storage = path.join(root, 'storage'),
    mount = path.join(storage, 'nas');
  fs.mkdirSync(storage, { mode: 0o711 });
  fs.mkdirSync(mount, { mode: 0o700 });
  const stat = fs.lstatSync(mount);
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const journal = {
    contract: 'cos-backup-nas-mount-state/v1' as const,
    configurationDigest: digest(nas),
    underlay: { device: stat.dev, inode: stat.ino },
    phase: 'closed' as const,
    attemptId: null,
    mount: null,
  };
  const fd = fs.openSync(mount, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  const mountId = Number(fs.readFileSync('/proc/self/fdinfo/' + fd, 'utf8').match(/^mnt_id:\s+(\d+)$/m)![1]);
  fs.closeSync(fd);
  const observed = {
    target: mount,
    source: '//192.168.56.12/nanoclaw-cos-backups',
    fstype: 'cifs',
    id: mountId,
    options:
      'rw,nosuid,nodev,noexec,nodfs,soft,vers=2.1,sec=ntlmsspi,username=nanoclaw-cos-backup,addr=192.168.56.12,uid=1000,forceuid,gid=1000,forcegid,file_mode=0600,dir_mode=0700',
  };
  const inspect = vi.fn(() => (mounted ? JSON.stringify({ filesystems: [observed] }) : null));
  if (mounted) {
    fs.chownSync(mount, 1000, 1000);
    const statfs = fs.statfsSync;
    vi.spyOn(fs, 'statfsSync').mockImplementation(
      (file, options) =>
        ({ ...statfs(file, options), type: options?.bigint ? 0xfe534d42n : 0xfe534d42 }) as ReturnType<typeof statfs>,
    );
  } else fs.chmodSync(mount, 0);
  return { root, storage, mount, vault, nas, journal, observed, controls: { mount, inspect, assertMemory: vi.fn() } };
}
it('admits only the recorded empty root-owned closed underlay with actual root role and descriptors', () => {
  const s = fixture();
  expect(process.getuid?.()).toBe(0);
  expect(observeBackupNasMount(s.vault, s.nas, s.journal, s.controls)).toEqual({
    state: 'closed',
    underlay: s.journal.underlay,
  });
  expect(s.controls.inspect).toHaveBeenCalledTimes(2);
});
it('independently proves the signed owner-private SMB2 mount and descriptor mount ID without requiring a repository', () => {
  const s = fixture(true);
  const value = observeBackupNasMount(s.vault, s.nas, s.journal, s.controls);
  expect(value).toEqual({
    state: 'mounted',
    mount: {
      id: s.observed.id,
      device: fs.lstatSync(s.mount).dev,
      inode: fs.lstatSync(s.mount).ino,
      bindingDigest: digest({ host: s.nas.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' }),
    },
  });
  expect(value.state).toBe('mounted');
  if (value.state !== 'mounted') throw Error('fixture_mount_missing');
  expect(Object.isFrozen(value.mount)).toBe(true);
  expect(fs.readdirSync(s.mount)).toEqual([]);
  expect(s.controls.inspect).toHaveBeenCalledWith('/usr/bin/findmnt', [
    '--json',
    '--submounts',
    '--mountpoint',
    s.mount,
    '--output',
    'TARGET,SOURCE,FSTYPE,OPTIONS,ID',
  ]);
});
it.each(['unclaimed', 'permissions', 'foreign-owner', 'nonempty', 'linked', 'parent-permissions', 'scope', 'memory'])(
  'denies a closed %s underlay without repairing it',
  (reason) => {
    const s = fixture();
    if (reason === 'unclaimed') s.journal.underlay.inode++;
    if (reason === 'permissions') fs.chmodSync(s.mount, 0o700);
    if (reason === 'foreign-owner') fs.chownSync(s.mount, 1000, 1000);
    if (reason === 'nonempty') fs.writeFileSync(path.join(s.mount, 'private'), 'PRIVATE_PAYLOAD');
    if (reason === 'linked') {
      fs.rmdirSync(s.mount);
      fs.symlinkSync(s.storage, s.mount);
    }
    if (reason === 'parent-permissions') fs.chmodSync(s.storage, 0o777);
    if (reason === 'scope') s.journal.configurationDigest = 'f'.repeat(64);
    if (reason === 'memory')
      s.controls.assertMemory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    expect(() => observeBackupNasMount(s.vault, s.nas, s.journal, s.controls)).toThrow(
      /^backup_nas_kernel_unverified$/,
    );
  },
);
it.each([
  'unsigned',
  'share',
  'uid',
  'gid',
  'forceuid',
  'permissions',
  'owner',
  'group',
  'special-mode',
  'mount-id',
  'nested',
  'filesystem',
  'kernel-error',
  'oversized',
])('denies mounted %s before a mount claim can be recorded', (reason) => {
  const s = fixture(true);
  if (reason === 'unsigned') s.observed.options = s.observed.options.replace('ntlmsspi', 'ntlmssp');
  if (reason === 'share') s.observed.source = '//192.168.56.12/unrelated';
  if (reason === 'uid') s.observed.options = s.observed.options.replace('uid=1000', 'uid=1001');
  if (reason === 'gid') s.observed.options = s.observed.options.replace('gid=1000', 'gid=1001');
  if (reason === 'forceuid') s.observed.options = s.observed.options.replace(',forceuid', '');
  if (reason === 'permissions') fs.chmodSync(s.mount, 0o755);
  if (reason === 'owner') fs.chownSync(s.mount, 1001, 1000);
  if (reason === 'group') fs.chownSync(s.mount, 1000, 1001);
  if (reason === 'special-mode') fs.chmodSync(s.mount, 0o2700);
  if (reason === 'mount-id') s.observed.id++;
  if (reason === 'nested') Object.assign(s.observed, { children: [{ target: s.mount + '/foreign' }] });
  if (reason === 'filesystem') vi.restoreAllMocks();
  if (reason === 'kernel-error')
    s.controls.inspect.mockImplementation(() => {
      throw Error('PRIVATE_KERNEL_DIAGNOSTIC');
    });
  if (reason === 'oversized') s.controls.inspect.mockReturnValue('x'.repeat(262145));
  expect(() => observeBackupNasMount(s.vault, s.nas, s.journal, s.controls)).toThrow(/^backup_nas_kernel_unverified$/);
});
it.each(['mount-id', 'closed-to-mounted', 'mounted-to-closed', 'directory', 'parent'])(
  'rejects %s changes during independent kernel inspection',
  (reason) => {
    const s = fixture(reason !== 'closed-to-mounted');
    s.controls.inspect.mockImplementationOnce(() =>
      reason === 'closed-to-mounted' ? null : JSON.stringify({ filesystems: [s.observed] }),
    );
    s.controls.inspect.mockImplementation(() => {
      if (reason === 'mount-id') s.observed.id++;
      if (reason === 'directory') {
        fs.renameSync(s.mount, s.mount + '-old');
        fs.mkdirSync(s.mount, { mode: 0o700 });
        fs.chownSync(s.mount, 1000, 1000);
      }
      if (reason === 'parent') {
        fs.renameSync(s.storage, s.storage + '-old');
        fs.mkdirSync(s.storage, { mode: 0o711 });
      }
      return reason === 'mounted-to-closed' ? null : JSON.stringify({ filesystems: [s.observed] });
    });
    expect(() => observeBackupNasMount(s.vault, s.nas, s.journal, s.controls)).toThrow(
      /^backup_nas_kernel_unverified$/,
    );
  },
);
