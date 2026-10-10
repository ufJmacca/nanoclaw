import fs from 'node:fs';
import path from 'node:path';
import { readPrivate, writeAtomic } from './target-state.js';
import { verifyVaultMemory } from './vault-memory.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
/** Source and maintenance generations change during reviewed delivery; claimed resource identity must not. */
export function vaultRootStateDigest(input: VaultRootConfiguration): string {
  const config = vaultRootConfiguration(input);
  return digest({ identity: config.identity, owner: config.owner });
}
type Paths = { configRoot: string; stateRoot: string; storageRoot: string };
type Claim = { device: number; inode: number };
type Journal = {
  contract: 'cos-vault-root-state/v1';
  identityDigest: string;
  phase: 'intent' | 'complete';
  claims: Partial<Record<'control' | 'storage', Claim>>;
};
/** Root configuration and executable have already been sealed and live owner proof verified. No existing root is adopted. */
export async function initializeVaultRootState(
  identityDigest: string,
  controls: {
    assertAuthority(): Promise<void>;
    assertMemory?(): void;
    assertRole?(): void;
  },
  paths: Paths = {
    configRoot: '/etc/nanoclaw-cos',
    stateRoot: '/etc/nanoclaw-cos/control',
    storageRoot: '/var/lib/nanoclaw-cos',
  },
): Promise<void> {
  const descriptors: number[] = [];
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role =
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
    paths = Object.freeze({ ...paths });
    if (
      !/^[a-f0-9]{64}$/.test(identityDigest) ||
      paths.stateRoot !== paths.configRoot + '/control' ||
      Object.values(paths).some((value) => !path.isAbsolute(value) || path.resolve(value) !== value || value === '/')
    )
      throw Error('root_state_scope_conflict');
    const config = fs.lstatSync(paths.configRoot);
    if (
      !config.isDirectory() ||
      config.uid !== process.getuid?.() ||
      (config.mode & 0o777) !== 0o700 ||
      fs.realpathSync(paths.configRoot) !== paths.configRoot
    )
      throw Error('unsafe_root_configuration_parent');
    const parents = [paths.configRoot, path.dirname(paths.storageRoot)].map((directory) => {
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.push(fd);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022 ||
        fs.realpathSync(directory) !== directory
      )
        throw Error('unsafe_root_state_parent');
      return { directory, fd, stat };
    });
    let journal: Journal | undefined;
    const currentParents = () => {
      guard();
      for (const { directory, stat } of parents) {
        const now = fs.lstatSync(directory);
        if (
          !now.isDirectory() ||
          now.dev !== stat.dev ||
          now.ino !== stat.ino ||
          now.uid !== stat.uid ||
          now.mode !== stat.mode ||
          fs.realpathSync(directory) !== directory
        )
          throw Error('root_state_parent_changed');
      }
      for (const [name, claim] of Object.entries(journal?.claims ?? {})) {
        const directory = name === 'control' ? paths.stateRoot : paths.storageRoot,
          mode = name === 'control' ? 0o700 : 0o711,
          now = fs.lstatSync(directory);
        if (
          !now.isDirectory() ||
          now.uid !== process.getuid?.() ||
          (now.mode & 0o777) !== mode ||
          now.dev !== claim.device ||
          now.ino !== claim.inode ||
          fs.realpathSync(directory) !== directory
        )
          throw Error('claimed_root_state_changed');
      }
    };
    const authority = async () => {
      currentParents();
      await controls.assertAuthority();
      currentParents();
    };
    await authority();
    const file = paths.configRoot + '/vault-bootstrap.json',
      stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat) {
      if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_root_bootstrap_claim');
      journal = readPrivate<Journal>(file, 4096);
      if (
        !journal ||
        Object.keys(journal).sort().join(',') !== 'claims,contract,identityDigest,phase' ||
        journal.contract !== 'cos-vault-root-state/v1' ||
        journal.identityDigest !== identityDigest ||
        !['intent', 'complete'].includes(journal.phase) ||
        !journal.claims ||
        typeof journal.claims !== 'object' ||
        Array.isArray(journal.claims) ||
        Object.keys(journal.claims).some((key) => !['control', 'storage'].includes(key))
      )
        throw Error('root_bootstrap_conflict');
      for (const claim of Object.values(journal.claims))
        if (
          !claim ||
          Object.keys(claim).sort().join(',') !== 'device,inode' ||
          !Number.isSafeInteger(claim.device) ||
          claim.device < 0 ||
          !Number.isSafeInteger(claim.inode) ||
          claim.inode < 1
        )
          throw Error('invalid_root_bootstrap_claim');
      if (journal.phase === 'complete' && Object.keys(journal.claims).sort().join(',') !== 'control,storage')
        throw Error('incomplete_root_bootstrap');
    } else {
      if (
        [paths.stateRoot, paths.storageRoot, paths.configRoot + '/vault.key'].some((value) =>
          fs.lstatSync(value, { throwIfNoEntry: false }),
        )
      )
        throw Error('unclaimed_root_state');
      journal = { contract: 'cos-vault-root-state/v1', identityDigest, phase: 'intent', claims: {} };
      writeAtomic(paths.configRoot, 'vault-bootstrap.json', journal);
    }
    for (const [name, directory, parent, mode] of [
      ['control', paths.stateRoot, parents[0]!, 0o700],
      ['storage', paths.storageRoot, parents[1]!, 0o711],
    ] as const) {
      await authority();
      const claim = journal.claims[name],
        before = fs.lstatSync(directory, { throwIfNoEntry: false });
      if (claim) {
        if (
          !before ||
          !before.isDirectory() ||
          before.uid !== process.getuid?.() ||
          (before.mode & 0o777) !== mode ||
          before.ino !== claim.inode ||
          before.dev !== claim.device ||
          fs.realpathSync(directory) !== directory
        )
          throw Error('claimed_root_state_changed');
      } else {
        if (before) throw Error('unclaimed_root_state');
        const pinned = `/proc/self/fd/${parent.fd}/${path.basename(directory)}`;
        fs.mkdirSync(pinned, { mode: 0o700 });
        const fd = fs.openSync(pinned, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          const created = fs.fstatSync(fd);
          if (
            !created.isDirectory() ||
            created.uid !== process.getuid?.() ||
            (created.mode & 0o777) !== 0o700 ||
            fs.realpathSync(directory) !== directory ||
            fs.lstatSync(directory).ino !== created.ino
          )
            throw Error('root_state_creation_changed');
          fs.fchmodSync(fd, mode);
          fs.fsyncSync(fd);
          fs.fsyncSync(parent.fd);
          currentParents();
          journal.claims[name] = { device: created.dev, inode: created.ino };
          writeAtomic(paths.configRoot, 'vault-bootstrap.json', journal);
        } finally {
          fs.closeSync(fd);
        }
      }
      await authority();
    }
    if (journal.phase !== 'complete') {
      journal.phase = 'complete';
      writeAtomic(paths.configRoot, 'vault-bootstrap.json', journal);
    }
    await authority();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root paths, claims and parent authority diagnostics remain private.
    throw Error('vault_root_state_unavailable');
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}
