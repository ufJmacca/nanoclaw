import fs from 'node:fs';
import path from 'node:path';
import { validateResticArtifactSeal, verifyResticBinary, type RESTIC_ARTIFACT } from './restic-artifact.js';

/** Public release bytes only. Credential-bearing processes still need their
 * separate live executable, vault, repository and target admission leases.
 */
export function verifyResticReleasePayload(root: string): typeof RESTIC_ARTIFACT {
  let fd: number | undefined;
  try {
    if (!path.isAbsolute(root) || path.resolve(root) !== root || root === '/' || fs.realpathSync(root) !== root)
      throw Error('unsafe_restic_release_root');
    const directory = fs.lstatSync(root),
      inventory = ['artifact.json', 'restic'];
    const currentDirectory = () => {
      const stat = fs.lstatSync(root);
      if (
        !stat.isDirectory() ||
        stat.dev !== directory.dev ||
        stat.ino !== directory.ino ||
        stat.uid !== directory.uid ||
        ![0, process.getuid?.()].includes(stat.uid) ||
        stat.mode !== directory.mode ||
        (stat.mode & 0o7022) !== 0 ||
        fs.realpathSync(root) !== root ||
        fs.readdirSync(root).sort().join(',') !== inventory.join(',')
      )
        throw Error('restic_release_root_changed');
    };
    currentDirectory();
    const file = path.join(root, 'artifact.json');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const initial = fs.fstatSync(fd),
      held = fd;
    const currentSeal = () => {
      currentDirectory();
      for (const stat of [fs.fstatSync(held), fs.lstatSync(file)])
        if (
          !stat.isFile() ||
          stat.nlink !== 1 ||
          stat.uid !== directory.uid ||
          (stat.mode & 0o7777) !== 0o444 ||
          stat.dev !== initial.dev ||
          stat.ino !== initial.ino ||
          stat.size !== initial.size ||
          stat.size < 1 ||
          stat.size > 4096 ||
          stat.mtimeMs !== initial.mtimeMs ||
          stat.ctimeMs !== initial.ctimeMs ||
          fs.realpathSync(file) !== file
        )
          throw Error('restic_release_seal_changed');
    };
    currentSeal();
    const bytes = Buffer.alloc(initial.size + 1);
    if (fs.readSync(held, bytes, 0, bytes.length, 0) !== initial.size) throw Error('restic_release_seal_changed');
    currentSeal();
    const seal = validateResticArtifactSeal(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, initial.size))),
    );
    verifyResticBinary(path.join(root, 'restic'));
    currentSeal();
    const repeated = Buffer.alloc(initial.size + 1);
    if (
      fs.readSync(held, repeated, 0, repeated.length, 0) !== initial.size ||
      !repeated.subarray(0, initial.size).equals(bytes.subarray(0, initial.size))
    )
      throw Error('restic_release_seal_changed');
    currentSeal();
    return seal;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Build paths and version subprocess diagnostics are private.
    throw Error('restic_release_payload_unverified');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
