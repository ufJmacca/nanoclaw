import fs from 'node:fs';
import path from 'node:path';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { inspectBackupNasUnclaimedConfigurationStage } from './backup-nas-config-install.js';
import { inspectBackupNasUnclaimedUnderlay } from './backup-nas-underlay.js';
import { inspectBackupNasUnclaimedServiceStage } from './backup-nas-service-install.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasInitializationInspectionControls = {
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  /** Code-only fixtures. Installed requests expose no paths or resource selectors. */
  paths?: Readonly<{
    configRoot: string;
    controlRoot: string;
    storageRoot: string;
    mount: string;
    systemUnits: string;
  }>;
  configurationStage?: typeof inspectBackupNasUnclaimedConfigurationStage;
  underlay?: typeof inspectBackupNasUnclaimedUnderlay;
  serviceStage?: typeof inspectBackupNasUnclaimedServiceStage;
};
/** Fixed setup order. Namespace selection grants no ownership: each selected
 * inspector independently holds accepted G01 claims, the real kernel writer and
 * the exact resource through its final native closure. Ambiguity stays closed.
 */
export async function inspectBackupNasInitialization(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasInitializationInspectionControls,
): Promise<BackupNasInitializationResource> {
  const descriptors: number[] = [];
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault),
      paths = Object.freeze({
        ...(controls.paths ?? {
          configRoot: '/etc/nanoclaw-cos',
          controlRoot: '/etc/nanoclaw-cos/control',
          storageRoot: '/var/lib/nanoclaw-cos',
          mount: '/var/lib/nanoclaw-cos/nas',
          systemUnits: '/etc/systemd/system',
        }),
      });
    if (
      Object.keys(paths).sort().join(',') !== 'configRoot,controlRoot,mount,storageRoot,systemUnits' ||
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
      throw Error('unsafe_inspection_paths');
    const parents = (
      [
        ['configRoot', 0o700],
        ['controlRoot', 0o700],
        ['storageRoot', 0o711],
        ['systemUnits', 0o755],
      ] as const
    ).map(([name, mode]) => {
      const directory = paths[name],
        before = fs.lstatSync(directory),
        fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.push(fd);
      return { name, directory, before, fd, mode };
    });
    const guard = () => {
      role();
      for (const parent of parents) {
        for (const stat of [fs.fstatSync(parent.fd), fs.lstatSync(parent.directory)])
          if (
            !stat.isDirectory() ||
            stat.uid !== 0 ||
            (stat.mode & 0o7777) !== parent.mode ||
            stat.dev !== parent.before.dev ||
            stat.ino !== parent.before.ino
          )
            throw Error('inspection_parent_changed');
        if (fs.realpathSync(parent.directory) !== parent.directory) throw Error('inspection_parent_changed');
      }
    };
    guard();
    const contains = (parent: (typeof parents)[number], prefix: string, limit: number) => {
      guard();
      const directory = fs.opendirSync('/proc/self/fd/' + parent.fd, { bufferSize: 32 });
      let found = false;
      try {
        let count = 0,
          entry: fs.Dirent | null;
        while ((entry = directory.readSync())) {
          if (++count > limit) throw Error('inspection_bounds');
          if (entry.name.startsWith(prefix)) found = true;
        }
      } finally {
        directory.closeSync();
      }
      guard();
      return found;
    };
    const choose = () => {
      guard();
      if (contains(parents[0]!, '.backup-nas.', 128)) return 'configuration-stage' as const;
      if (!fs.lstatSync('/proc/self/fd/' + parents[1]!.fd + '/nas-mount.json', { throwIfNoEntry: false }))
        return 'closed-underlay' as const;
      if (contains(parents[3]!, '.nanoclaw-cos-backup-mount.', 1024)) return 'service-stage' as const;
      throw Error('unclaimed_initialization_resource_missing');
    };
    const assertAuthority = async () => {
      guard();
      await controls.assertAuthority();
      guard();
    };
    await assertAuthority();
    const kind = choose(),
      { configRoot, controlRoot, storageRoot, mount } = paths,
      common = { assertAuthority, assertMemory: memory };
    const observed =
      kind === 'configuration-stage'
        ? await (controls.configurationStage ?? inspectBackupNasUnclaimedConfigurationStage)(vault, nas, {
            ...common,
            paths: { configRoot, controlRoot, storageRoot },
          })
        : kind === 'closed-underlay'
          ? await (controls.underlay ?? inspectBackupNasUnclaimedUnderlay)(vault, nas, {
              ...common,
              paths: { configRoot, controlRoot, storageRoot, mount },
            })
          : await (controls.serviceStage ?? inspectBackupNasUnclaimedServiceStage)(vault, nas, { ...common, paths });
    // No new native await follows the selected inspector's verified completion.
    guard();
    const resource = backupNasInitializationResource(observed);
    if (resource.kind !== kind || choose() !== kind) throw Error('inspection_selection_changed');
    guard();
    return resource;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root namespaces, resource metadata and native permission diagnostics remain private.
    throw Error('backup_nas_initialization_inspection_unavailable');
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}
