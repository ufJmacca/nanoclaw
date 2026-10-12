import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { verifyResticReleasePayload } from './restic-release-payload.js';
import { withVerifiedResticBinary, verifyResticBinary } from './restic-artifact.js';

const sameFile = (a: fs.Stats, b: fs.Stats) =>
  a.dev === b.dev &&
  a.ino === b.ino &&
  a.uid === b.uid &&
  a.nlink === b.nlink &&
  a.mode === b.mode &&
  a.size === b.size &&
  a.mtimeMs === b.mtimeMs &&
  a.ctimeMs === b.ctimeMs;

/** Public pinned artifact delivery only. Existing files are verified, never
 * replaced. Callers hold the target operation and independent upload locks.
 * An interrupted partial destination remains closed to executable admission. */
export async function installResticRuntimeArtifact(input: {
  installationRoot: string;
  payload: string;
  manifest: ReleaseManifest;
  check(): void;
}): Promise<{ status: 'installed' | 'already_installed'; bytes: number; sha256: string }> {
  let appFd: number | undefined,
    parentFd: number | undefined,
    output: number | undefined,
    created: fs.Stats | undefined,
    lastWrite: fs.Stats | undefined,
    completed = false;
  try {
    input.check();
    const manifest = validateReleaseManifest(input.manifest),
      app = input.installationRoot,
      root = path.join(app, 'libexec'),
      source = path.join(input.payload, 'libexec'),
      destination = path.join(root, 'restic');
    if (
      manifest.slice !== 'G02' ||
      !manifest.backupArtifact ||
      !path.isAbsolute(app) ||
      path.resolve(app) !== app ||
      app === '/' ||
      !path.isAbsolute(input.payload) ||
      path.resolve(input.payload) !== input.payload ||
      app === input.payload ||
      app.startsWith(input.payload + '/') ||
      input.payload.startsWith(app + '/')
    )
      throw Error('runtime_artifact_scope_conflict');
    const seal = verifyResticReleasePayload(source);
    if (digest(seal) !== digest(manifest.backupArtifact)) throw Error('runtime_artifact_seal_conflict');
    appFd = fs.openSync(app, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldApp = appFd,
      initialApp = fs.fstatSync(heldApp);
    const checkApp = () => {
      input.check();
      for (const stat of [fs.fstatSync(heldApp), fs.lstatSync(app)])
        if (
          !stat.isDirectory() ||
          stat.dev !== initialApp.dev ||
          stat.ino !== initialApp.ino ||
          stat.uid !== process.getuid?.() ||
          stat.mode & 0o7022 ||
          fs.realpathSync(app) !== app
        )
          throw Error('runtime_artifact_installation_changed');
    };
    checkApp();
    if (!fs.lstatSync(root, { throwIfNoEntry: false })) {
      fs.mkdirSync('/proc/self/fd/' + heldApp + '/libexec', { mode: 0o700 });
      fs.fsyncSync(heldApp);
    }
    parentFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const heldParent = parentFd,
      parent = fs.fstatSync(heldParent),
      file = '/proc/self/fd/' + heldParent + '/restic';
    const current = () => {
      checkApp();
      for (const stat of [fs.fstatSync(heldParent), fs.lstatSync(root)])
        if (
          !stat.isDirectory() ||
          stat.dev !== parent.dev ||
          stat.ino !== parent.ino ||
          stat.dev !== initialApp.dev ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o700 ||
          fs.realpathSync(root) !== root
        )
          throw Error('runtime_artifact_parent_changed');
    };
    current();
    if (fs.lstatSync(file, { throwIfNoEntry: false })) {
      verifyResticBinary(destination);
      current();
      return { status: 'already_installed', bytes: seal.bytes, sha256: seal.sha256 };
    }
    return await withVerifiedResticBinary(path.join(source, 'restic'), async (binary) => {
      current();
      binary.assertCurrent();
      output = fs.openSync(
        file,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      created = lastWrite = fs.fstatSync(output);
      const buffer = Buffer.alloc(65536);
      try {
        let offset = 0;
        for (;;) {
          current();
          binary.assertCurrent();
          const count = fs.readSync(binary.fd, buffer, 0, Math.min(buffer.length, seal.bytes - offset + 1), offset);
          if (count === 0) break;
          if (offset + count > seal.bytes) throw Error('runtime_artifact_copy_bounds');
          current();
          binary.assertCurrent();
          if (!sameFile(fs.fstatSync(output), lastWrite!) || !sameFile(fs.lstatSync(file), lastWrite!))
            throw Error('runtime_artifact_copy_changed');
          let written = 0;
          while (written < count) {
            const copied = fs.writeSync(output, buffer, written, count - written);
            if (copied < 1) throw Error('runtime_artifact_copy_stalled');
            written += copied;
          }
          offset += count;
          lastWrite = fs.fstatSync(output);
        }
        if (offset !== seal.bytes || !sameFile(fs.lstatSync(file), lastWrite!))
          throw Error('runtime_artifact_copy_incomplete');
        fs.fchmodSync(output, 0o555);
        lastWrite = fs.fstatSync(output);
        fs.fsyncSync(output);
        fs.fsyncSync(heldParent);
      } finally {
        buffer.fill(0);
        fs.closeSync(output);
        output = undefined;
      }
      current();
      binary.assertCurrent();
      verifyResticBinary(destination);
      if (digest(verifyResticReleasePayload(source)) !== digest(seal)) throw Error('runtime_artifact_source_changed');
      current();
      binary.assertCurrent();
      completed = true;
      return { status: 'installed', bytes: seal.bytes, sha256: seal.sha256 };
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Paths, private target checks and utility diagnostics do not leave artifact delivery.
    throw Error('backup_runtime_artifact_unavailable');
  } finally {
    let cleanupFailed = false;
    const attempt = (operation: () => void) => {
      try {
        operation();
        // eslint-disable-next-line no-catch-all/no-catch-all -- Close every descriptor, then deny success with the fixed cleanup failure below.
      } catch {
        cleanupFailed = true;
      }
    };
    if (output !== undefined) attempt(() => fs.closeSync(output!));
    if (parentFd !== undefined) {
      const heldParent = parentFd;
      attempt(() => {
        if (!completed && created && lastWrite) {
          // Retire only this call's unchanged new inode after an ordinary failure.
          // Existing partial files and unexplained replacements are retained.
          const file = '/proc/self/fd/' + heldParent + '/restic';
          const stat = fs.lstatSync(file, { throwIfNoEntry: false });
          if (
            stat?.isFile() &&
            stat.nlink === 1 &&
            sameFile(stat, lastWrite) &&
            stat.dev === created.dev &&
            stat.ino === created.ino
          ) {
            fs.unlinkSync(file);
            fs.fsyncSync(heldParent);
          }
        }
      });
      attempt(() => fs.closeSync(heldParent));
    }
    if (appFd !== undefined) attempt(() => fs.closeSync(appFd!));
    // eslint-disable-next-line no-unsafe-finally -- Failed cleanup must deny both success and private diagnostics with the same fixed public failure.
    if (cleanupFailed) throw Error('backup_runtime_artifact_unavailable');
  }
}
