import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultRootArtifact } from './vault-root-artifact.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { verifyVaultMemory } from './vault-memory.js';
type Claim = { device: number; inode: number; mode: number };
type Paths = { configRoot: string; artifactRoot: string; vaultRoot: string };
type Journal = {
  contract: 'cos-vault-root-installation/v1';
  identityDigest: string;
  parents: Partial<Record<keyof Paths, Claim>>;
  artifacts: Record<string, Claim>;
  pendingArtifact?: { digest: string; claim: Claim };
  configuration?: { digest: string; claim: Claim };
  pendingConfiguration?: string;
};
export type VaultRootInstallControls = {
  /** Source-only fixture seams; no CLI, environment or root request can select installation paths. */
  paths?: Paths;
  runtimeVersion?: string;
  assertRole?(): void;
  assertMemory?(): void;
  assertAuthority(): Promise<void>;
};
const claim = (stat: fs.Stats): Claim => ({ device: stat.dev, inode: stat.ino, mode: stat.mode & 0o777 });
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const validClaim = (value: Claim) =>
  value &&
  Object.keys(value).sort().join(',') === 'device,inode,mode' &&
  Number.isSafeInteger(value.device) &&
  value.device >= 0 &&
  Number.isSafeInteger(value.inode) &&
  value.inode > 0 &&
  [0o700, 0o755, 0o555, 0o600].includes(value.mode);
/** Trusted release bootstrap only. Sealed bytes and live protected authority are prerequisites, never root commands. */
export async function installVaultRoot(
  input: { configuration: VaultRootConfiguration; sourceRoot: string },
  controls: VaultRootInstallControls,
) {
  const descriptors: number[] = [];
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      role =
        controls.assertRole ??
        (() => {
          if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
            throw Error('root_process_required');
        }),
      guard = () => {
        memory();
        role();
      };
    guard();
    const config = vaultRootConfiguration(input.configuration),
      configurationDigest = digest(config),
      identityDigest = vaultRootStateDigest(config),
      sourceRoot = input.sourceRoot,
      paths = Object.freeze({
        ...(controls.paths ?? {
          configRoot: '/etc/nanoclaw-cos',
          artifactRoot: '/opt/nanoclaw-cos',
          vaultRoot: '/opt/nanoclaw-cos/vault',
        }),
      });
    if (
      paths.vaultRoot !== paths.artifactRoot + '/vault' ||
      [sourceRoot, ...Object.values(paths)].some(
        (directory) => !path.isAbsolute(directory) || path.resolve(directory) !== directory || directory === '/',
      )
    )
      throw Error('installation_path_conflict');
    const verify = (root: string, ownerUid: number) =>
      verifyVaultRootArtifact(config, {
        root,
        ownerUid,
        executable: root + '/node',
        entrypoint: root + '/gateway.mjs',
        runtimeVersion: controls.runtimeVersion ?? process.versions.node,
        assertRole: role,
        assertMemory: memory,
      });
    const seal = verify(sourceRoot, config.owner.uid);
    const pins: Array<{ directory: string; fd: number; stat: fs.Stats }> = [];
    const pin = (directory: string) => {
      const fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.push(fd);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022 ||
        fs.realpathSync(directory) !== directory
      )
        throw Error('unsafe_installation_parent');
      const value = { directory, fd, stat };
      pins.push(value);
      return value;
    };
    const configParent = pin(path.dirname(paths.configRoot)),
      artifactParent = pin(path.dirname(paths.artifactRoot));
    let journal: Journal;
    const file = paths.configRoot + '/vault-installation.json',
      prior = fs.lstatSync(paths.configRoot, { throwIfNoEntry: false });
    const matches = (name: string, expected: Claim, directory: boolean) => {
      const stat = fs.lstatSync(name);
      if (
        (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) ||
        stat.uid !== process.getuid?.() ||
        digest(claim(stat)) !== digest(expected) ||
        fs.realpathSync(name) !== name
      )
        throw Error('installation_claim_changed');
    };
    if (prior) {
      if (
        !prior.isDirectory() ||
        prior.uid !== process.getuid?.() ||
        (prior.mode & 0o777) !== 0o700 ||
        fs.realpathSync(paths.configRoot) !== paths.configRoot
      )
        throw Error('unsafe_configuration_parent');
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_installation_journal');
      journal = readPrivate<Journal>(file, 16384);
      if (
        !journal ||
        journal.contract !== 'cos-vault-root-installation/v1' ||
        journal.identityDigest !== identityDigest ||
        Object.keys(journal).some(
          (name) =>
            ![
              'contract',
              'identityDigest',
              'parents',
              'artifacts',
              'pendingArtifact',
              'configuration',
              'pendingConfiguration',
            ].includes(name),
        ) ||
        !journal.parents ||
        !journal.artifacts ||
        Array.isArray(journal.parents) ||
        Array.isArray(journal.artifacts) ||
        Object.keys(journal.parents).some((name) => !Object.hasOwn(paths, name)) ||
        Object.values(journal.parents).some((value) => !validClaim(value!)) ||
        Object.entries(journal.artifacts).some(
          ([name, value]) => !hash(name) || !validClaim(value) || value.mode !== 0o555,
        ) ||
        (journal.pendingArtifact &&
          (!hash(journal.pendingArtifact.digest) || !validClaim(journal.pendingArtifact.claim))) ||
        (journal.configuration &&
          (!hash(journal.configuration.digest) ||
            !validClaim(journal.configuration.claim) ||
            journal.configuration.claim.mode !== 0o600)) ||
        (journal.pendingConfiguration !== undefined && !hash(journal.pendingConfiguration))
      )
        throw Error('installation_journal_conflict');
      if (!journal.parents.configRoot) throw Error('unclaimed_configuration_parent');
      matches(paths.configRoot, journal.parents.configRoot, true);
    } else {
      if (fs.lstatSync(paths.artifactRoot, { throwIfNoEntry: false })) throw Error('foreign_artifact_parent');
      journal = { contract: 'cos-vault-root-installation/v1', identityDigest, parents: {}, artifacts: {} };
    }
    const current = () => {
      guard();
      for (const { directory, stat } of pins) matches(directory, claim(stat), true);
      for (const [name, value] of Object.entries(journal.parents)) matches(paths[name as keyof Paths], value!, true);
      for (const [name, value] of Object.entries(journal.artifacts)) matches(paths.vaultRoot + '/' + name, value, true);
      if (journal.pendingArtifact)
        matches(paths.vaultRoot + '/' + journal.pendingArtifact.digest, journal.pendingArtifact.claim, true);
    };
    const authority = async () => {
      current();
      await controls.assertAuthority();
      current();
    };
    const save = () => {
      current();
      writeAtomic(paths.configRoot, 'vault-installation.json', journal);
      current();
    };
    await authority();
    for (const [name, parent, mode] of [
      ['configRoot', configParent, 0o700],
      ['artifactRoot', artifactParent, 0o755],
      ['vaultRoot', undefined, 0o755],
    ] as const) {
      if (!journal.parents[name]) {
        await authority();
        const directory = paths[name];
        if (fs.lstatSync(directory, { throwIfNoEntry: false })) throw Error('foreign_installation_parent');
        const anchor = parent ?? pins.find(({ directory }) => directory === paths.artifactRoot)!;
        const pinned = `/proc/self/fd/${anchor.fd}/${path.basename(directory)}`;
        fs.mkdirSync(pinned, { mode: 0o700 });
        const created = fs.openSync(pinned, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        try {
          fs.fchmodSync(created, mode);
          fs.fsyncSync(created);
          fs.fsyncSync(anchor.fd);
          journal.parents[name] = claim(fs.fstatSync(created));
        } finally {
          fs.closeSync(created);
        }
        save();
      }
      pin(paths[name]);
    }
    const destination = paths.vaultRoot + '/' + config.artifact.digest;
    await authority();
    if (journal.pendingArtifact && journal.pendingArtifact.digest !== config.artifact.digest)
      throw Error('pending_artifact_conflict');
    if (!journal.artifacts[config.artifact.digest]) {
      if (!journal.pendingArtifact) {
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('foreign_artifact');
        const parent = pins.find(({ directory }) => directory === paths.vaultRoot)!;
        fs.mkdirSync(`/proc/self/fd/${parent.fd}/${config.artifact.digest}`, { mode: 0o700 });
        fs.fsyncSync(parent.fd);
        journal.pendingArtifact = { digest: config.artifact.digest, claim: claim(fs.lstatSync(destination)) };
        save();
      }
      const directory = pin(destination);
      for (const name of ['gateway.mjs', 'node', 'artifact.json'] as const) {
        await authority();
        const expected = name === 'artifact.json' ? Buffer.from(JSON.stringify(seal) + '\n') : undefined,
          mode = name === 'node' ? 0o555 : 0o444,
          target = `/proc/self/fd/${directory.fd}/${name}`;
        if (!fs.lstatSync(destination + '/' + name, { throwIfNoEntry: false })) {
          const output = fs.openSync(
            target,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          try {
            if (expected) fs.writeFileSync(output, expected);
            else {
              const source = fs.openSync(sourceRoot + '/' + name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
                buffer = Buffer.alloc(65536),
                checksum = createHash('sha256');
              try {
                const before = fs.fstatSync(source),
                  pinned = fs.lstatSync(sourceRoot + '/' + name),
                  wanted = seal.files[name as 'gateway.mjs' | 'node'];
                if (
                  !before.isFile() ||
                  before.nlink !== 1 ||
                  before.uid !== config.owner.uid ||
                  before.ino !== pinned.ino ||
                  before.dev !== pinned.dev ||
                  before.size !== wanted.bytes ||
                  (before.mode & 0o777) !== mode
                )
                  throw Error('source_artifact_changed');
                let position = 0;
                while (position < before.size) {
                  guard();
                  const length = fs.readSync(
                    source,
                    buffer,
                    0,
                    Math.min(buffer.length, before.size - position),
                    position,
                  );
                  if (!length) throw Error('source_artifact_truncated');
                  let written = 0;
                  while (written < length) {
                    const count = fs.writeSync(output, buffer, written, length - written);
                    if (!count) throw Error('artifact_copy_failed');
                    written += count;
                  }
                  checksum.update(buffer.subarray(0, length));
                  position += length;
                }
                const after = fs.lstatSync(sourceRoot + '/' + name);
                if (
                  after.dev !== before.dev ||
                  after.ino !== before.ino ||
                  after.size !== before.size ||
                  after.mtimeMs !== before.mtimeMs ||
                  after.ctimeMs !== before.ctimeMs ||
                  checksum.digest('hex') !== wanted.sha256
                )
                  throw Error('source_artifact_changed');
              } finally {
                buffer.fill(0);
                fs.closeSync(source);
              }
            }
            fs.fchmodSync(output, mode);
            fs.fsyncSync(output);
          } finally {
            fs.closeSync(output);
            expected?.fill(0);
          }
        }
      }
      await authority();
      fs.fchmodSync(directory.fd, 0o555);
      fs.fsyncSync(directory.fd);
      directory.stat = fs.fstatSync(directory.fd);
      journal.pendingArtifact.claim = claim(directory.stat);
      save();
      verify(destination, process.getuid!());
      journal.artifacts[config.artifact.digest] = journal.pendingArtifact.claim;
      delete journal.pendingArtifact;
      save();
    }
    verify(destination, process.getuid!());
    await authority();
    const configurationFile = paths.configRoot + '/vault-root.json',
      existing = fs.lstatSync(configurationFile, { throwIfNoEntry: false });
    if (journal.pendingConfiguration && journal.pendingConfiguration !== configurationDigest)
      throw Error('pending_configuration_conflict');
    if (existing) {
      const old = vaultRootConfiguration(readPrivate(configurationFile, 16384));
      if (existing.nlink !== 1 || !existing.isFile() || fs.realpathSync(configurationFile) !== configurationFile)
        throw Error('unsafe_existing_configuration');
      if (journal.pendingConfiguration === configurationDigest && digest(old) === configurationDigest) {
        journal.configuration = { digest: configurationDigest, claim: claim(existing) };
        delete journal.pendingConfiguration;
        save();
      } else {
        if (!journal.configuration || digest(old) !== journal.configuration.digest)
          throw Error('foreign_configuration');
        matches(configurationFile, journal.configuration.claim, false);
        if (
          digest(old) !== configurationDigest &&
          (vaultRootStateDigest(old) !== identityDigest ||
            config.target.minimumGeneration <= old.target.minimumGeneration ||
            config.authority.operationId === old.authority.operationId)
        )
          throw Error('configuration_generation_conflict');
      }
    } else if (journal.configuration) throw Error('claimed_configuration_missing');
    if (journal.configuration?.digest !== configurationDigest) {
      journal.pendingConfiguration = configurationDigest;
      save();
      await authority();
      if (journal.configuration) matches(configurationFile, journal.configuration.claim, false);
      else if (fs.lstatSync(configurationFile, { throwIfNoEntry: false })) throw Error('foreign_configuration');
      writeAtomic(paths.configRoot, 'vault-root.json', config);
      journal.configuration = { digest: configurationDigest, claim: claim(fs.lstatSync(configurationFile)) };
      delete journal.pendingConfiguration;
      save();
    }
    await authority();
    matches(configurationFile, journal.configuration!.claim, false);
    if (digest(vaultRootConfiguration(readPrivate(configurationFile, 16384))) !== configurationDigest)
      throw Error('configuration_changed');
    verify(destination, process.getuid!());
    return Object.freeze({
      contract: 'cos-vault-root-installation-result/v1',
      status: 'installed',
      configurationDigest,
      identityDigest,
      artifactDigest: config.artifact.digest,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Source, inode and private authority diagnostics never enter installation receipts.
    throw Error('vault_root_installation_unavailable');
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}
