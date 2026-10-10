import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { backupNasMountJournal, type BackupNasMountJournal } from './backup-nas-mount-state.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { verifyVaultMemory } from './vault-memory.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
import { observeBackupNasMount } from './backup-nas-kernel.js';

type Paths = Readonly<{ configRoot: string; controlRoot: string; storageRoot: string; mount: string }>;
export type BackupNasUnderlayControls = {
  /** Fresh installed owner/native maintenance and sealed-artifact checks, never a stored receipt. */
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  /** Code-only fixtures. Installed invocation exposes no path, role or kernel-inspection selector. */
  paths?: Paths;
  isMounted?(directory: string): boolean;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const inode = (stat: fs.Stats) => ({ device: stat.dev, inode: stat.ino });
function isMounted(directory: string): boolean {
  const result = spawnSync('/usr/bin/findmnt', ['--json', '--mountpoint', directory, '--output', 'TARGET'], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 8192,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (result.error || result.signal || result.status === null) throw Error('mount_inspection_unavailable');
  if (result.status === 1 && result.stdout.trim() === '') return false;
  if (result.status !== 0) throw Error('mount_inspection_unavailable');
  const value: unknown = JSON.parse(result.stdout);
  if (
    !object(value) ||
    !Array.isArray(value.filesystems) ||
    value.filesystems.length !== 1 ||
    !object(value.filesystems[0]) ||
    value.filesystems[0].target !== directory
  )
    throw Error('mount_inspection_unavailable');
  return true;
}
/** Creates only an empty closed underlay. G01 root ownership must already be complete.
 * No existing directory is adopted, and no mount is activated. The real kernel writer
 * serializes programme helpers; exclusive writes and inode claims refuse collisions.
 */
export function prepareBackupNasUnderlay(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasUnderlayControls,
): Promise<BackupNasMountJournal> {
  return withBackupNasUnderlay(input, selected, controls, 'prepare');
}
/** Private metadata observation only. This requires current root/native setup
 * authority and returns a held, independently closed kernel identity. It never
 * adopts an unclaimed resource; a separate fresh resource-bound grant is required
 * before recovery can act on the observation. No installed route exposes it yet.
 */
export function inspectBackupNasUnclaimedUnderlay(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasUnderlayControls,
): Promise<BackupNasInitializationResource> {
  return withBackupNasUnderlay(input, selected, controls, 'inspect');
}
function withBackupNasUnderlay(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasUnderlayControls,
  mode: 'prepare',
): Promise<BackupNasMountJournal>;
function withBackupNasUnderlay(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasUnderlayControls,
  mode: 'inspect',
): Promise<BackupNasInitializationResource>;
async function withBackupNasUnderlay(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasUnderlayControls,
  mode: 'prepare' | 'inspect',
): Promise<BackupNasMountJournal | BackupNasInitializationResource> {
  const descriptors: number[] = [];
  let journalFd: number | undefined, underlayFd: number | undefined, finalObservation: (() => void) | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_process_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault);
    const scope = Object.freeze({
      configurationDigest: digest(nas),
      bindingDigest: digest({ host: nas.host, share: 'nanoclaw-cos-backups', mount: '/var/lib/nanoclaw-cos/nas' }),
    });
    const paths = Object.freeze({
      ...(controls.paths ?? {
        configRoot: '/etc/nanoclaw-cos',
        controlRoot: '/etc/nanoclaw-cos/control',
        storageRoot: '/var/lib/nanoclaw-cos',
        mount: '/var/lib/nanoclaw-cos/nas',
      }),
    });
    if (
      Object.keys(paths).sort().join(',') !== 'configRoot,controlRoot,mount,storageRoot' ||
      paths.controlRoot !== paths.configRoot + '/control' ||
      paths.mount !== paths.storageRoot + '/nas' ||
      Object.values(paths).some(
        (directory) =>
          !path.isAbsolute(directory) ||
          path.resolve(directory) !== directory ||
          directory === '/' ||
          fs.realpathSync(path.dirname(directory)) !== path.dirname(directory),
      )
    )
      throw Error('unsafe_nas_paths');
    const roots = (
      [
        ['configRoot', 0o700],
        ['controlRoot', 0o700],
        ['storageRoot', 0o711],
      ] as const
    ).map(([name, mode]) => {
      const directory = paths[name],
        before = fs.lstatSync(directory);
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.push(fd);
      if (
        !before.isDirectory() ||
        before.uid !== 0 ||
        (before.mode & 0o7777) !== mode ||
        fs.realpathSync(directory) !== directory
      )
        throw Error('unsafe_root_parent');
      return { directory, fd, before, mode };
    });
    const [config, control, storage] = roots;
    const guard = () => {
      role();
      for (const root of roots)
        for (const stat of [fs.fstatSync(root.fd), fs.lstatSync(root.directory)])
          if (
            !stat.isDirectory() ||
            stat.uid !== 0 ||
            (stat.mode & 0o7777) !== root.mode ||
            stat.dev !== root.before.dev ||
            stat.ino !== root.before.ino ||
            fs.realpathSync(root.directory) !== root.directory
          )
            throw Error('root_parent_changed');
    };
    const metadata = (root: (typeof roots)[number], name: string) => {
      guard();
      const file = '/proc/self/fd/' + root.fd + '/' + name;
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.push(fd);
      const before = fs.fstatSync(fd);
      const check = () => {
        guard();
        for (const stat of [fs.fstatSync(fd), fs.lstatSync(file)])
          if (
            !stat.isFile() ||
            stat.uid !== 0 ||
            stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.dev !== root.before.dev ||
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.size < 1 ||
            stat.size > 4096 ||
            stat.size !== before.size ||
            stat.mtimeMs !== before.mtimeMs ||
            stat.ctimeMs !== before.ctimeMs
          )
            throw Error('root_metadata_changed');
      };
      check();
      const bytes = Buffer.alloc(before.size + 1);
      try {
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('root_metadata_changed');
        check();
        const value: unknown = JSON.parse(bytes.subarray(0, before.size).toString('utf8'));
        return { fd, value, check };
      } finally {
        bytes.fill(0);
      }
    };
    const bootstrap = metadata(config!, 'vault-bootstrap.json'),
      claim = bootstrap.value;
    if (
      !object(claim) ||
      Object.keys(claim).sort().join(',') !== 'claims,contract,identityDigest,phase' ||
      claim.contract !== 'cos-vault-root-state/v1' ||
      claim.phase !== 'complete' ||
      claim.identityDigest !== vaultRootStateDigest(vault) ||
      !object(claim.claims) ||
      Object.keys(claim.claims).sort().join(',') !== 'control,storage'
    )
      throw Error('accepted_vault_state_required');
    for (const [key, root] of [
      ['control', control!],
      ['storage', storage!],
    ] as const)
      if (
        !object(claim.claims[key]) ||
        Object.keys(claim.claims[key]).sort().join(',') !== 'device,inode' ||
        digest(claim.claims[key]) !== digest(inode(root.before))
      )
        throw Error('vault_root_claim_changed');
    const authority = async () => {
      guard();
      bootstrap.check();
      await controls.assertAuthority();
      bootstrap.check();
      guard();
    };
    await authority();
    const writer = new BackupRepositoryWriter(
      digest({ contract: 'cos-backup-nas-mount-writer/v1', configurationDigest: scope.configurationDigest }),
      async (operation) => {
        guard();
        const result = await operation('/proc/self/fd/' + control!.fd);
        guard();
        return result;
      },
    );
    const result = await writer.exclusive(async (lease) => {
      const current = async () => {
        lease.assertCurrent();
        await authority();
        lease.assertCurrent();
      };
      const absent = () => {
        guard();
        const value = (controls.isMounted ?? isMounted)(paths.mount);
        if (typeof value !== 'boolean' || value) throw Error('nas_mount_must_be_closed');
        guard();
      };
      await current();
      absent();
      const journal = '/proc/self/fd/' + control!.fd + '/nas-mount.json',
        point = '/proc/self/fd/' + storage!.fd + '/nas';
      const existing = fs.lstatSync(journal, { throwIfNoEntry: false });
      if (mode === 'inspect') {
        if (existing) throw Error('claimed_underlay_observation_denied');
        const before = fs.lstatSync(point);
        underlayFd = fs.openSync(point, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const held = underlayFd,
          resource = backupNasInitializationResource({
            kind: 'closed-underlay',
            device: before.dev,
            inode: before.ino,
          });
        const state = backupNasMountJournal(
          {
            contract: 'cos-backup-nas-mount-state/v1',
            configurationDigest: scope.configurationDigest,
            underlay: inode(before),
            phase: 'closed',
            attemptId: null,
            mount: null,
          },
          scope,
        );
        const observe = () => {
          guard();
          bootstrap.check();
          absent();
          if (fs.lstatSync(journal, { throwIfNoEntry: false })) throw Error('underlay_claim_appeared');
          for (const stat of [fs.fstatSync(held), fs.lstatSync(point)]) {
            if (
              !stat.isDirectory() ||
              stat.uid !== 0 ||
              (stat.mode & 0o7777) !== 0 ||
              stat.nlink !== 2 ||
              stat.dev !== storage!.before.dev ||
              stat.dev !== before.dev ||
              stat.ino !== before.ino ||
              stat.mtimeMs !== before.mtimeMs ||
              stat.ctimeMs !== before.ctimeMs
            )
              throw Error('observed_underlay_changed');
          }
          if (fs.realpathSync(paths.mount) !== paths.mount || fs.readdirSync('/proc/self/fd/' + held).length)
            throw Error('observed_underlay_not_empty');
          const actual = observeBackupNasMount(vault, nas, state, { mount: paths.mount, assertMemory: memory });
          if (actual.state !== 'closed' || digest(actual.underlay) !== digest(state.underlay))
            throw Error('observed_underlay_not_closed');
          guard();
          bootstrap.check();
        };
        finalObservation = observe;
        observe();
        await current();
        observe();
        return resource;
      }
      let record: BackupNasMountJournal, read: ReturnType<typeof metadata> | undefined;
      if (existing) {
        read = metadata(control!, 'nas-mount.json');
        record = backupNasMountJournal(read.value, scope);
      } else {
        if (fs.lstatSync(point, { throwIfNoEntry: false })) throw Error('unclaimed_nas_underlay');
        await current();
        absent();
        fs.mkdirSync(point, { mode: 0o700 });
        underlayFd = fs.openSync(point, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const created = fs.fstatSync(underlayFd);
        if (
          !created.isDirectory() ||
          created.uid !== 0 ||
          created.dev !== storage!.before.dev ||
          fs.lstatSync(point).ino !== created.ino
        )
          throw Error('nas_underlay_creation_changed');
        fs.fchmodSync(underlayFd, 0);
        fs.fsyncSync(underlayFd);
        fs.fsyncSync(storage!.fd);
        await current();
        absent();
        record = backupNasMountJournal(
          {
            contract: 'cos-backup-nas-mount-state/v1',
            configurationDigest: scope.configurationDigest,
            underlay: inode(created),
            phase: 'closed',
            attemptId: null,
            mount: null,
          },
          scope,
        );
        const bytes = Buffer.from(JSON.stringify(record) + '\n');
        try {
          journalFd = fs.openSync(
            journal,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          guard();
          lease.assertCurrent();
          bootstrap.check();
          fs.writeFileSync(journalFd, bytes);
          fs.fsyncSync(journalFd);
          fs.fsyncSync(control!.fd);
        } finally {
          bytes.fill(0);
        }
        read = metadata(control!, 'nas-mount.json');
      }
      const closed = () => {
        absent();
        const stat = fs.lstatSync(point);
        if (
          !stat.isDirectory() ||
          stat.uid !== 0 ||
          (stat.mode & 0o7777) !== 0 ||
          digest(inode(stat)) !== digest(record.underlay) ||
          stat.dev !== storage!.before.dev ||
          fs.realpathSync(paths.mount) !== paths.mount ||
          fs.readdirSync(point).length
        )
          throw Error('nas_underlay_changed');
        read!.check();
        if (digest(backupNasMountJournal(read!.value, scope)) !== digest(record)) throw Error('nas_journal_changed');
      };
      closed();
      await current();
      closed();
      // A replay can observe bytes from a previous failed sync. Repeat durability before acknowledging them.
      fs.fsyncSync(read!.fd);
      fs.fsyncSync(control!.fd);
      fs.fsyncSync(storage!.fd);
      await current();
      closed();
      return record;
    });
    // Keep the observed directory and G01 descriptors current through the final
    // writer await; no new native permission await follows writer release.
    finalObservation?.();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root resource paths, selected configuration and native-authority diagnostics remain private.
    throw Error(mode === 'prepare' ? 'backup_nas_underlay_unavailable' : 'backup_nas_underlay_observation_unavailable');
  } finally {
    try {
      if (journalFd !== undefined) fs.closeSync(journalFd);
    } finally {
      try {
        if (underlayFd !== undefined) fs.closeSync(underlayFd);
      } finally {
        for (const fd of descriptors.reverse()) fs.closeSync(fd);
      }
    }
  }
}
