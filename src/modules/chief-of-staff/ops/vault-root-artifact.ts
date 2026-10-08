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
function seal(value: unknown): VaultRootArtifactSeal {
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
/** Verify all executable bytes before effects, then repeat at authority boundaries. No account environment is read. */
export function verifyVaultRootArtifact(
  input: VaultRootConfiguration,
  controls: VaultRootArtifactControls = {},
): VaultRootArtifactSeal {
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    (
      controls.assertRole ??
      (() => {
        if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
          throw Error('root_process_required');
      })
    )();
    const config = vaultRootConfiguration(input),
      root = controls.root ?? '/opt/nanoclaw-cos/vault/' + config.artifact.digest,
      owner = controls.ownerUid ?? 0;
    if (!path.isAbsolute(root) || path.resolve(root) !== root || fs.realpathSync(root) !== root)
      throw Error('unsafe_artifact_path');
    if (controls.root === undefined) {
      for (const directory of ['/opt', '/opt/nanoclaw-cos', '/opt/nanoclaw-cos/vault']) {
        const stat = fs.lstatSync(directory);
        if (!stat.isDirectory() || stat.uid !== 0 || stat.mode & 0o022 || fs.realpathSync(directory) !== directory)
          throw Error('unsafe_artifact_parent');
      }
    }
    const before = fs.lstatSync(root);
    const assertDirectory = () => {
      const now = fs.lstatSync(root);
      if (
        !now.isDirectory() ||
        now.uid !== owner ||
        (now.mode & 0o777) !== 0o555 ||
        now.dev !== before.dev ||
        now.ino !== before.ino ||
        fs.realpathSync(root) !== root ||
        fs.readdirSync(root).sort().join(',') !== 'artifact.json,gateway.mjs,node'
      )
        throw Error('artifact_directory_changed');
    };
    assertDirectory();
    const read = (name: string, maximum: number, mode: number, operation: (fd: number, stat: fs.Stats) => unknown) => {
      assertDirectory();
      const file = path.join(root, name),
        prior = fs.lstatSync(file);
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.uid !== owner ||
          stat.nlink !== 1 ||
          (stat.mode & 0o777) !== mode ||
          stat.dev !== prior.dev ||
          stat.ino !== prior.ino ||
          stat.size < 1 ||
          stat.size > maximum
        )
          throw Error('unsafe_artifact_file');
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
        return result;
      } finally {
        fs.closeSync(fd);
      }
    };
    const manifest = seal(read('artifact.json', 4096, 0o444, (fd) => JSON.parse(fs.readFileSync(fd, 'utf8'))));
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
    memory();
    return manifest;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Filesystem and payload diagnostics can disclose private installation paths.
    throw Error('vault_root_artifact_unavailable');
  }
}
