import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { RESTIC_ARTIFACT, verifyResticBinary } from './restic-artifact.js';

/** Mac devcontainer build input: a public pinned executable, never a credential path. */
export function packageResticReleaseArtifact(input: { binary: string; output: string }): typeof RESTIC_ARTIFACT {
  let pending: string | undefined, source: number | undefined;
  try {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      !input ||
      typeof input !== 'object' ||
      Object.keys(input).sort().join(',') !== 'binary,output' ||
      !path.isAbsolute(input.binary) ||
      path.resolve(input.binary) !== input.binary ||
      fs.realpathSync(input.binary) !== input.binary ||
      !path.isAbsolute(input.output) ||
      path.resolve(input.output) !== input.output ||
      fs.lstatSync(input.output, { throwIfNoEntry: false })
    )
      throw Error('invalid_restic_package_input');
    const parent = path.dirname(input.output),
      initialParent = fs.lstatSync(parent);
    const currentParent = () => {
      const stat = fs.lstatSync(parent);
      if (
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o7777) !== 0o700 ||
        stat.dev !== initialParent.dev ||
        stat.ino !== initialParent.ino ||
        fs.realpathSync(parent) !== parent
      )
        throw Error('unsafe_restic_package_parent');
    };
    currentParent();
    source = fs.openSync(input.binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(source);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0, process.getuid?.()].includes(before.uid) ||
      before.size !== RESTIC_ARTIFACT.bytes ||
      (before.mode & 0o111) === 0
    )
      throw Error('unsafe_restic_package_source');
    const heldSource = source,
      currentSource = () => {
        for (const stat of [fs.fstatSync(heldSource), fs.lstatSync(input.binary)])
          if (
            stat.dev !== before.dev ||
            stat.ino !== before.ino ||
            stat.mode !== before.mode ||
            stat.uid !== before.uid ||
            stat.nlink !== before.nlink ||
            stat.size !== before.size ||
            stat.mtimeMs !== before.mtimeMs ||
            stat.ctimeMs !== before.ctimeMs
          )
            throw Error('restic_package_source_changed');
        if (fs.realpathSync(input.binary) !== input.binary) throw Error('restic_package_source_changed');
      };
    currentSource();
    pending = fs.mkdtempSync(path.join(parent, '.restic-release-'));
    fs.chmodSync(pending, 0o700);
    const file = path.join(pending, 'restic'),
      destination = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600),
      hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    try {
      let position = 0;
      while (position < before.size) {
        const count = fs.readSync(source, buffer, 0, Math.min(buffer.length, before.size - position), position);
        if (count < 1) throw Error('restic_package_source_truncated');
        hash.update(buffer.subarray(0, count));
        let written = 0;
        while (written < count) {
          const amount = fs.writeSync(destination, buffer, written, count - written);
          if (amount < 1) throw Error('restic_package_write_failed');
          written += amount;
        }
        position += count;
      }
      currentSource();
      currentParent();
      if (hash.digest('hex') !== RESTIC_ARTIFACT.sha256) throw Error('restic_package_hash_mismatch');
      fs.fchmodSync(destination, 0o555);
      fs.fsyncSync(destination);
    } finally {
      fs.closeSync(destination);
    }
    verifyResticBinary(file);
    currentSource();
    currentParent();
    const seal = fs.openSync(path.join(pending, 'artifact.json'), 'wx', 0o444);
    try {
      fs.writeFileSync(seal, JSON.stringify(RESTIC_ARTIFACT) + '\n');
      fs.fchmodSync(seal, 0o444);
      fs.fsyncSync(seal);
    } finally {
      fs.closeSync(seal);
    }
    const directory = fs.openSync(pending, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(directory);
    } finally {
      fs.closeSync(directory);
    }
    currentSource();
    currentParent();
    if (fs.lstatSync(input.output, { throwIfNoEntry: false })) throw Error('restic_package_output_exists');
    fs.renameSync(pending, input.output);
    pending = undefined;
    const parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      fs.fsyncSync(parentFd);
    } finally {
      fs.closeSync(parentFd);
    }
    return RESTIC_ARTIFACT;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private build paths and subprocess diagnostics stay out of receipts.
    throw Error('restic_release_package_unavailable');
  } finally {
    if (source !== undefined) fs.closeSync(source);
    if (pending) fs.rmSync(pending, { recursive: true, force: true });
  }
}
