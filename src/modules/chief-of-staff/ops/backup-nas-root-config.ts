import fs from 'node:fs';
import path from 'node:path';
import { backupNasMountCommand } from './backup-nas-units.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasRootConfiguration = Readonly<{
  contract: 'cos-backup-nas-root-config/v1';
  host: string;
  credentialReference: string;
  vaultStateDigest: string;
}>;
/** NAS scope survives source/maintenance updates but cannot follow another vault or owner. */
export function backupNasRootConfiguration(value: unknown, input: VaultRootConfiguration): BackupNasRootConfiguration {
  try {
    const vault = vaultRootConfiguration(input);
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'contract,credentialReference,host,vaultStateDigest'
    )
      throw Error('invalid_nas_configuration');
    const config = value as Record<string, unknown>;
    if (
      config.contract !== 'cos-backup-nas-root-config/v1' ||
      typeof config.host !== 'string' ||
      typeof config.credentialReference !== 'string' ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(config.credentialReference) ||
      config.vaultStateDigest !== vaultRootStateDigest(vault)
    )
      throw Error('nas_configuration_scope_conflict');
    backupNasMountCommand({ host: config.host, userId: vault.owner.uid, groupId: vault.owner.gid });
    return Object.freeze({ ...config }) as BackupNasRootConfiguration;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Configuration contains private endpoint and credential references.
    throw Error('backup_nas_configuration_unavailable');
  }
}
/** Code-only fixture seams; the installed entry point has no root/path/role selector. */
export type BackupNasRootConfigurationControls = {
  root?: string;
  ownerUid?: number;
  assertMemory?(): void;
  assertRole?(): void;
};
/** Read metadata only from the fixed root-owned configuration, without creating or repairing it. */
export function readBackupNasRootConfiguration(
  vault: VaultRootConfiguration,
  controls: BackupNasRootConfigurationControls = {},
): BackupNasRootConfiguration {
  let rootFd: number | undefined, fd: number | undefined, bytes: Buffer | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      role =
        controls.assertRole ??
        (() => {
          if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
            throw Error('root_process_required');
        });
    const guard = () => {
      memory();
      role();
    };
    guard();
    const root = controls.root ?? '/etc/nanoclaw-cos',
      owner = controls.ownerUid ?? 0;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/' || fs.realpathSync(root) !== root)
      throw Error('unsafe_nas_configuration_parent');
    const before = fs.lstatSync(root);
    if (!before.isDirectory() || before.uid !== owner || (before.mode & 0o7777) !== 0o700)
      throw Error('unsafe_nas_configuration_parent');
    rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldRoot = rootFd;
    const currentParent = () => {
      guard();
      for (const stat of [fs.fstatSync(heldRoot), fs.lstatSync(root)])
        if (
          !stat.isDirectory() ||
          stat.uid !== owner ||
          (stat.mode & 0o7777) !== 0o700 ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino
        )
          throw Error('nas_configuration_parent_changed');
      if (fs.realpathSync(root) !== root) throw Error('nas_configuration_parent_changed');
    };
    currentParent();
    const file = '/proc/self/fd/' + heldRoot + '/backup-nas.json',
      initial = fs.lstatSync(file);
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    const privateFile = (current: fs.Stats) => {
      if (
        !current.isFile() ||
        current.uid !== owner ||
        (current.mode & 0o7777) !== 0o600 ||
        current.nlink !== 1 ||
        current.dev !== before.dev ||
        current.dev !== stat.dev ||
        current.ino !== stat.ino ||
        current.size < 1 ||
        current.size > 4096 ||
        current.size !== stat.size ||
        current.mtimeMs !== stat.mtimeMs ||
        current.ctimeMs !== stat.ctimeMs
      )
        throw Error('nas_configuration_file_changed');
    };
    privateFile(stat);
    privateFile(initial);
    currentParent();
    bytes = Buffer.alloc(stat.size + 1);
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('nas_configuration_changed');
    privateFile(fs.fstatSync(fd));
    privateFile(fs.lstatSync(file));
    currentParent();
    const result = backupNasRootConfiguration(JSON.parse(bytes.subarray(0, stat.size).toString('utf8')), vault);
    currentParent();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private paths and configuration contents are not public diagnostics.
    throw Error('backup_nas_configuration_unavailable');
  } finally {
    bytes?.fill(0);
    try {
      if (fd !== undefined) fs.closeSync(fd);
    } finally {
      if (rootFd !== undefined) fs.closeSync(rootFd);
    }
  }
}
