import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { openOwnerConfiguration } from './backup-nas-owner-setup.js';
import { backupNasSelection } from './backup-nas-selection.js';
import { readBackupCredentialInstallation } from './backup-credential-install.js';
import { verifyVaultStorage, withVaultDirectory } from './vault-storage.js';
import { verifyVaultMemory } from './vault-memory.js';
import { localTarget } from './target-identity.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { withSignedBackupShare } from './backup-nas-access.js';
import { withVerifiedResticBinary } from './restic-artifact.js';
import { withVaultResticPassword } from './backup-password.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import { BackupResticInitializer } from './backup-restic-initialize.js';
import { initializePinnedBackupRepository } from './backup-repository-initialize.js';
import { readBackupInitializationCapacity } from './backup-capacity.js';
import { BACKUP_LIMITS, admitBackupCapacity } from './backup-policy.js';
const pinned = (fd: number) => '/proc/self/fd/' + fd;
/** Installed composition only. No path, repository, credential, utility, role or
 * scope override is accepted from a caller or environment. Initialization must
 * follow healthy admission, independently of checkpoint service interruption. */
export async function initializeVaultBackups(input: {
  roots: CalendarStorageRoots;
  manifest: ReleaseManifest;
  operationId: string;
  assertCurrent(): void;
  check(): Promise<void>;
}): Promise<Record<string, unknown>> {
  let configuration: ReturnType<typeof openOwnerConfiguration> | undefined,
    selectionFd: number | undefined,
    rootFd: number | undefined;
  try {
    const manifest = validateReleaseManifest(input.manifest),
      roots = Object.freeze({ ...input.roots });
    input.assertCurrent();
    verifyVaultMemory();
    if (manifest.slice !== 'G02' || !manifest.vaultArtifact) throw Error('initialization_release_required');
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
      policy = verifyVaultStorage(roots);
    configuration = openOwnerConfiguration(roots.targetRoot);
    const vault = configuration.configuration;
    if (
      target.lifecycle !== 'protected' ||
      target.maintenance !== false ||
      target.releaseId !== manifest.releaseId ||
      vault.identity.targetDigest !== digest(target.binding) ||
      vault.identity.filesystemUuid !== policy.volume.filesystemUuid ||
      vault.owner.uid !== process.getuid?.() ||
      vault.owner.gid !== process.getgid?.() ||
      vault.owner.home !== os.homedir() ||
      vault.owner.targetRoot !== roots.targetRoot ||
      vault.target.binding.installationRoot !== roots.installationRoot ||
      vault.target.binding.dataRoot !== roots.dataRoot ||
      target.generation < vault.target.minimumGeneration ||
      vault.artifact.digest !== manifest.vaultArtifact.digest ||
      vault.artifact.sourceCommit !== manifest.source.commit ||
      vault.artifact.sourceTree !== manifest.source.tree
    )
      throw Error('initialization_scope_conflict');
    rootFd = fs.openSync(roots.targetRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldRoot = rootFd,
      parent = fs.fstatSync(heldRoot),
      file = path.join(pinned(heldRoot), 'backup-nas-selection.json');
    selectionFd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const heldSelection = selectionFd,
      initial = fs.fstatSync(heldSelection);
    const selectedMetadata = () => {
      for (const stat of [fs.fstatSync(heldRoot), fs.lstatSync(roots.targetRoot)])
        if (
          !stat.isDirectory() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o700 ||
          stat.dev !== parent.dev ||
          stat.ino !== parent.ino ||
          fs.realpathSync(roots.targetRoot) !== roots.targetRoot
        )
          throw Error('initialization_selection_parent_changed');
      for (const stat of [fs.fstatSync(heldSelection), fs.lstatSync(file)])
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== parent.uid ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.dev !== parent.dev ||
          stat.dev !== initial.dev ||
          stat.ino !== initial.ino ||
          stat.size < 1 ||
          stat.size > 8192 ||
          stat.size !== initial.size ||
          stat.mtimeMs !== initial.mtimeMs ||
          stat.ctimeMs !== initial.ctimeMs
        )
          throw Error('initialization_selection_changed');
    };
    selectedMetadata();
    const bytes = Buffer.alloc(initial.size + 1);
    let selection: ReturnType<typeof backupNasSelection>;
    try {
      if (fs.readSync(heldSelection, bytes, 0, bytes.length, 0) !== initial.size)
        throw Error('initialization_selection_changed');
      selectedMetadata();
      selection = backupNasSelection(
        JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, initial.size))),
        vault,
      );
    } finally {
      bytes.fill(0);
    }
    const guard = () => {
      input.assertCurrent();
      verifyVaultMemory();
      configuration!.check();
      selectedMetadata();
      if (digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot)) !== digest(target))
        throw Error('initialization_target_changed');
    };
    const mount = Object.freeze({
      host: selection.nas.host,
      share: 'nanoclaw-cos-backups' as const,
      mount: '/var/lib/nanoclaw-cos/nas',
    });
    guard();
    await input.check();
    guard();
    return await withVaultDirectory(roots, 'backup-credentials', async (directory, assertVault) => {
      assertVault();
      guard();
      const installation = readBackupCredentialInstallation(directory, roots, policy.volume.filesystemUuid);
      if (installation.credentialReference !== selection.nas.credentialReference)
        throw Error('initialization_credentials_conflict');
      const currentCredentials = () => {
        guard();
        assertVault();
        if (
          digest(readBackupCredentialInstallation(directory, roots, policy.volume.filesystemUuid)) !==
          digest(installation)
        )
          throw Error('initialization_credentials_changed');
      };
      const writer = new BackupRepositoryWriter(
        digest({
          contract: 'cos-backup-initialization-writer/v1',
          rootsDigest: digest(roots),
          filesystemUuid: policy.volume.filesystemUuid,
          selectionDigest: digest(selection),
        }),
        async (work) => {
          currentCredentials();
          const result = await work(directory);
          currentCredentials();
          return result;
        },
        '.cos-writer.lock',
      );
      return await writer.exclusive(async (lease) => {
        lease.assertCurrent();
        currentCredentials();
        return await withVerifiedResticBinary(path.join(roots.installationRoot, 'libexec/restic'), async (binary) =>
          withSignedBackupShare(mount, async (share) =>
            withVaultResticPassword(roots, async (password) =>
              withVaultDirectory(roots, 'cache', async (cacheDirectory, assertCache) => {
                const cacheFd = fs.openSync(
                  cacheDirectory,
                  fs.constants.O_RDONLY |
                    fs.constants.O_DIRECTORY |
                    (/^\/proc\/self\/fd\/\d+$/.test(cacheDirectory) ? 0 : fs.constants.O_NOFOLLOW),
                );
                try {
                  const before = fs.fstatSync(cacheFd);
                  const cache = Object.freeze({
                    fd: cacheFd,
                    assertCurrent() {
                      currentCredentials();
                      assertCache();
                      lease.assertCurrent();
                      for (const stat of [fs.fstatSync(cacheFd), fs.statSync(cacheDirectory)])
                        if (
                          !stat.isDirectory() ||
                          stat.uid !== process.getuid?.() ||
                          (stat.mode & 0o7777) !== 0o700 ||
                          stat.dev !== before.dev ||
                          stat.ino !== before.ino
                        )
                          throw Error('initialization_cache_changed');
                    },
                  });
                  const check = async () => {
                    cache.assertCurrent();
                    binary.assertCurrent();
                    share.assertCurrent();
                    password.assertCurrent();
                    await input.check();
                    cache.assertCurrent();
                    const capacity = await readBackupInitializationCapacity(roots, share);
                    admitBackupCapacity(capacity, { kind: 'credentials', bytes: 1 });
                    if (capacity.vaultFree < BACKUP_LIMITS.vaultReserve + 16384)
                      throw Error('initialization_capacity_unavailable');
                    cache.assertCurrent();
                    binary.assertCurrent();
                    share.assertCurrent();
                    password.assertCurrent();
                  };
                  await check();
                  return await initializePinnedBackupRepository({
                    roots,
                    filesystemUuid: policy.volume.filesystemUuid,
                    credentialReference: installation.credentialReference,
                    mount,
                    operationId: input.operationId,
                    directory,
                    share,
                    writer: lease,
                    check,
                    restic: (repository) =>
                      new BackupResticInitializer({ binary, password, repository, cache, writer: lease }, check),
                  });
                } finally {
                  fs.closeSync(cacheFd);
                }
              }),
            ),
          ),
        );
      });
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private storage, endpoint, credential and installed artifact diagnostics stay within the owner boundary.
    throw Error('backup_repository_initialization_unavailable');
  } finally {
    try {
      if (selectionFd !== undefined) fs.closeSync(selectionFd);
    } finally {
      try {
        if (rootFd !== undefined) fs.closeSync(rootFd);
      } finally {
        configuration?.close();
      }
    }
  }
}
