import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import type { VaultRootArtifactSeal } from './vault-root-artifact.js';
/** Build tooling only. Call from the Mac's ARM64 devcontainer after compiling an exact exported source tree. */
export function packageVaultRootArtifact(
  input: { sourceCommit: string; sourceTree: string; gateway: string; output: string },
  controls: { assertToolchain?(): void } = {},
) {
  let pending: string | undefined;
  try {
    (
      controls.assertToolchain ??
      (() => {
        if (process.platform !== 'linux' || process.arch !== 'arm64' || process.versions.node !== '22.23.2')
          throw Error('unverified_root_toolchain');
      })
    )();
    if (
      !/^[a-f0-9]{40}$/.test(input.sourceCommit) ||
      !/^[a-f0-9]{40}$/.test(input.sourceTree) ||
      !path.isAbsolute(input.output) ||
      path.resolve(input.output) !== input.output ||
      !path.isAbsolute(input.gateway) ||
      fs.realpathSync(input.gateway) !== input.gateway
    )
      throw Error('invalid_root_package_input');
    fs.mkdirSync(input.output, { mode: 0o700, recursive: true });
    const parent = fs.lstatSync(input.output);
    if (
      !parent.isDirectory() ||
      parent.uid !== process.getuid?.() ||
      (parent.mode & 0o777) !== 0o700 ||
      fs.realpathSync(input.output) !== input.output
    )
      throw Error('unsafe_root_package_output');
    pending = fs.mkdtempSync(path.join(input.output, '.pending-'));
    const copy = (source: string, name: string, maximum: number, mode: number) => {
      const prior = fs.lstatSync(source),
        fd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      const destination = fs.openSync(
        path.join(pending!, name),
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      const buffer = Buffer.alloc(65536),
        hash = createHash('sha256');
      try {
        const stat = fs.fstatSync(fd);
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.ino !== prior.ino ||
          stat.dev !== prior.dev ||
          stat.size < 1 ||
          stat.size > maximum
        )
          throw Error('invalid_root_package_file');
        let position = 0;
        while (position < stat.size) {
          const length = fs.readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - position), position);
          if (!length) throw Error('root_package_truncated');
          let written = 0;
          while (written < length) {
            const count = fs.writeSync(destination, buffer, written, length - written);
            if (count < 1) throw Error('root_package_write_failed');
            written += count;
          }
          hash.update(buffer.subarray(0, length));
          position += length;
        }
        const after = fs.lstatSync(source);
        if (
          after.ino !== stat.ino ||
          after.dev !== stat.dev ||
          after.size !== stat.size ||
          after.ctimeMs !== stat.ctimeMs ||
          after.mtimeMs !== stat.mtimeMs
        )
          throw Error('root_package_source_changed');
        fs.fchmodSync(destination, mode);
        fs.fsyncSync(destination);
        return Object.freeze({ bytes: stat.size, sha256: hash.digest('hex') });
      } finally {
        buffer.fill(0);
        fs.closeSync(destination);
        fs.closeSync(fd);
      }
    };
    const files = Object.freeze({
      'gateway.mjs': copy(input.gateway, 'gateway.mjs', 2 * 1024 * 1024, 0o444),
      node: copy(process.execPath, 'node', 150 * 1024 * 1024, 0o555),
    });
    const seal: VaultRootArtifactSeal = Object.freeze({
      contract: 'cos-vault-root-artifact/v1',
      sourceCommit: input.sourceCommit,
      sourceTree: input.sourceTree,
      runtime: Object.freeze({ name: 'node', version: process.versions.node, architecture: 'arm64' }),
      files,
    });
    const artifactDigest = digest(seal),
      root = path.join(input.output, artifactDigest);
    if (fs.lstatSync(root, { throwIfNoEntry: false })) throw Error('root_package_already_exists');
    const fd = fs.openSync(
      path.join(pending, 'artifact.json'),
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o444,
    );
    try {
      fs.writeFileSync(fd, JSON.stringify(seal) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    const directory = fs.openSync(pending, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fchmodSync(directory, 0o555);
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    fs.renameSync(pending, root);
    pending = undefined;
    const output = fs.openSync(
      input.output,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(output);
    } finally {
      fs.closeSync(output);
    }
    return Object.freeze({ root, digest: artifactDigest, seal });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Build paths and compiler payloads are private.
    throw Error('vault_root_package_unavailable');
  } finally {
    if (pending) {
      fs.chmodSync(pending, 0o700);
      fs.rmSync(pending, { recursive: true, force: true });
    }
  }
}
