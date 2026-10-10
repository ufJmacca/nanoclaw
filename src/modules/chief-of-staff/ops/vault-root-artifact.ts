import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { verifyVaultMemory } from './vault-memory.js';
export type VaultRootArtifactSeal = {
  contract: 'cos-vault-root-artifact/v1';
  sourceCommit: string;
  sourceTree: string;
  runtime: { name: 'node'; version: string; architecture: 'arm64' };
  files: Record<'gateway.mjs' | 'node', { bytes: number; sha256: string }>;
};
/** Code-only fixture seams; the installed entrypoint accepts no path or role selector. */
export type VaultRootArtifactControls = {
  root?: string;
  ownerUid?: number;
  executable?: string;
  entrypoint?: string;
  runtimeVersion?: string;
  assertRole?(): void;
  assertMemory?(): void;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
export function vaultRootArtifactSeal(value: unknown): VaultRootArtifactSeal {
  const keys = (item: Record<string, unknown>, expected: string) => Object.keys(item).sort().join(',') === expected;
  if (
    !object(value) ||
    !keys(value, 'contract,files,runtime,sourceCommit,sourceTree') ||
    value.contract !== 'cos-vault-root-artifact/v1' ||
    typeof value.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    typeof value.sourceTree !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceTree) ||
    !object(value.runtime) ||
    !keys(value.runtime, 'architecture,name,version') ||
    value.runtime.name !== 'node' ||
    value.runtime.architecture !== 'arm64' ||
    typeof value.runtime.version !== 'string' ||
    !/^22\.\d+\.\d+$/.test(value.runtime.version) ||
    !object(value.files) ||
    !keys(value.files, 'gateway.mjs,node')
  )
    throw Error('invalid_artifact_seal');
  for (const [name, maximum] of [
    ['gateway.mjs', 2 * 1024 * 1024],
    ['node', 150 * 1024 * 1024],
  ] as const) {
    const file = value.files[name];
    if (
      !object(file) ||
      !keys(file, 'bytes,sha256') ||
      !Number.isSafeInteger(file.bytes) ||
      Number(file.bytes) < 1 ||
      Number(file.bytes) > maximum ||
      typeof file.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    )
      throw Error('invalid_artifact_file');
  }
  return Object.freeze({
    ...value,
    runtime: Object.freeze({ ...value.runtime }),
    files: Object.freeze({
      'gateway.mjs': Object.freeze({ ...(value.files['gateway.mjs'] as object) }),
      node: Object.freeze({ ...(value.files.node as object) }),
    }),
  }) as VaultRootArtifactSeal;
}
export type VaultRootArtifactLease = Readonly<{ seal: VaultRootArtifactSeal; assertCurrent(): void }>;
/** All bytes are verified while the descriptors are held. Fresh checks retain the same
 * immutable files; no serialized seal or previously returned receipt grants a lease.
 */
function openVaultRootArtifact(input: VaultRootConfiguration, controls: VaultRootArtifactControls = {}) {
  const descriptors: number[] = [];
  let active = false;
  const close = () => {
    active = false;
    for (const fd of descriptors.splice(0).reverse()) fs.closeSync(fd);
  };
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
    const config = vaultRootConfiguration(input),
      root = controls.root ?? '/opt/nanoclaw-cos/vault/' + config.artifact.digest,
      owner = controls.ownerUid ?? 0;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root)
      throw Error('unsafe_artifact_path');
    const parents =
      controls.root === undefined
        ? ['/opt', '/opt/nanoclaw-cos', '/opt/nanoclaw-cos/vault'].map((directory) => {
            const stat = fs.lstatSync(directory);
            if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || fs.realpathSync(directory) !== directory)
              throw Error('unsafe_artifact_parent');
            const fd = fs.openSync(
              directory,
              fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
            );
            descriptors.push(fd);
            return { directory, stat, fd };
          })
        : [];
    const before = fs.lstatSync(root);
    const rootFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    descriptors.push(rootFd);
    const assertDirectory = () => {
      guard();
      for (const parent of parents) {
        for (const stat of [fs.fstatSync(parent.fd), fs.lstatSync(parent.directory)])
          if (
            !stat.isDirectory() ||
            stat.uid !== 0 ||
            stat.dev !== parent.stat.dev ||
            stat.ino !== parent.stat.ino ||
            stat.mode !== parent.stat.mode ||
            stat.mode & 0o022
          )
            throw Error('artifact_parent_changed');
        if (fs.realpathSync(parent.directory) !== parent.directory) throw Error('artifact_parent_changed');
      }
      for (const now of [fs.fstatSync(rootFd), fs.lstatSync(root)])
        if (
          !now.isDirectory() ||
          now.uid !== owner ||
          (now.mode & 0o7777) !== 0o555 ||
          now.dev !== before.dev ||
          now.ino !== before.ino ||
          now.ctimeMs !== before.ctimeMs ||
          fs.realpathSync(root) !== root ||
          fs.readdirSync(root).sort().join(',') !== 'artifact.json,gateway.mjs,node'
        )
          throw Error('artifact_directory_changed');
    };
    const files: { file: string; fd: number; stat: fs.Stats }[] = [];
    const assertFiles = () => {
      assertDirectory();
      for (const held of files) {
        for (const stat of [fs.fstatSync(held.fd), fs.lstatSync(held.file)])
          if (
            !stat.isFile() ||
            stat.uid !== owner ||
            stat.gid !== held.stat.gid ||
            stat.mode !== held.stat.mode ||
            stat.nlink !== 1 ||
            stat.dev !== held.stat.dev ||
            stat.ino !== held.stat.ino ||
            stat.size !== held.stat.size ||
            stat.mtimeMs !== held.stat.mtimeMs ||
            stat.ctimeMs !== held.stat.ctimeMs
          )
            throw Error('artifact_file_changed');
        if (fs.realpathSync(held.file) !== held.file) throw Error('artifact_file_changed');
      }
    };
    assertDirectory();
    const read = (name: string, maximum: number, mode: number, operation: (fd: number, stat: fs.Stats) => unknown) => {
      assertDirectory();
      const file = path.join(root, name),
        prior = fs.lstatSync(file);
      const fd = fs.openSync(
        '/proc/self/fd/' + rootFd + '/' + name,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
      descriptors.push(fd);
      const stat = fs.fstatSync(fd);
      if (
        !stat.isFile() ||
        stat.uid !== owner ||
        stat.nlink !== 1 ||
        (stat.mode & 0o7777) !== mode ||
        stat.dev !== before.dev ||
        stat.dev !== prior.dev ||
        stat.ino !== prior.ino ||
        stat.size < 1 ||
        stat.size > maximum
      )
        throw Error('unsafe_artifact_file');
      files.push({ file, fd, stat });
      assertFiles();
      const result = operation(fd, stat),
        after = fs.lstatSync(file);
      if (
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        fs.realpathSync(file) !== file
      )
        throw Error('artifact_file_changed');
      assertDirectory();
      assertFiles();
      return result;
    };
    const manifest = vaultRootArtifactSeal(
      read('artifact.json', 4096, 0o444, (fd, stat) => {
        const bytes = Buffer.alloc(stat.size + 1);
        try {
          if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== stat.size) throw Error('artifact_manifest_changed');
          return JSON.parse(bytes.subarray(0, stat.size).toString('utf8'));
        } finally {
          bytes.fill(0);
        }
      }),
    );
    if (
      digest(manifest) !== config.artifact.digest ||
      manifest.sourceCommit !== config.artifact.sourceCommit ||
      manifest.sourceTree !== config.artifact.sourceTree ||
      manifest.runtime.version !== (controls.runtimeVersion ?? process.versions.node) ||
      (controls.executable ?? process.execPath) !== root + '/node' ||
      (controls.entrypoint ?? process.argv[1]) !== root + '/gateway.mjs'
    )
      throw Error('artifact_binding_conflict');
    for (const name of ['gateway.mjs', 'node'] as const) {
      const expected = manifest.files[name];
      read(name, expected.bytes, name === 'node' ? 0o555 : 0o444, (fd, stat) => {
        if (stat.size !== expected.bytes) throw Error('artifact_length_conflict');
        const hash = createHash('sha256'),
          buffer = Buffer.alloc(65536);
        try {
          let position = 0;
          while (position < stat.size) {
            memory();
            const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
            if (length < 1) throw Error('artifact_truncated');
            hash.update(buffer.subarray(0, length));
            position += length;
          }
          if (hash.digest('hex') !== expected.sha256) throw Error('artifact_digest_conflict');
        } finally {
          buffer.fill(0);
        }
      });
    }
    guard();
    active = true;
    const assertCurrent = () => {
      try {
        if (!active) throw Error('artifact_lease_released');
        assertFiles();
      } catch {
        active = false;
        // eslint-disable-next-line preserve-caught-error -- Private payload and memory diagnostics remain private.
        throw Error('vault_root_artifact_unavailable');
      }
    };
    const lease: VaultRootArtifactLease = Object.freeze({ seal: manifest, assertCurrent });
    lease.assertCurrent();
    return { lease, close };
  } catch {
    close();
    // eslint-disable-next-line preserve-caught-error -- Filesystem and payload diagnostics can disclose private installation paths.
    throw Error('vault_root_artifact_unavailable');
  }
}
/** Synchronous compatibility boundary still verifies every byte on every invocation. */
export function verifyVaultRootArtifact(
  input: VaultRootConfiguration,
  controls: VaultRootArtifactControls = {},
): VaultRootArtifactSeal {
  const held = openVaultRootArtifact(input, controls);
  try {
    held.lease.assertCurrent();
    return held.lease.seal;
  } finally {
    held.close();
  }
}
/** Retain the newly verified descriptors only for this awaited operation. */
export async function withVaultRootArtifact<T>(
  input: VaultRootConfiguration,
  operation: (lease: VaultRootArtifactLease) => Promise<T>,
  controls: VaultRootArtifactControls = {},
): Promise<T> {
  const held = openVaultRootArtifact(input, controls);
  try {
    const result = await operation(held.lease);
    held.lease.assertCurrent();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Awaited artifact users may have private diagnostics; no receipt becomes authority.
    throw Error('vault_root_artifact_unavailable');
  } finally {
    held.close();
  }
}
