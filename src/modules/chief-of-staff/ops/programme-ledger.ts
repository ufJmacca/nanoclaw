import fs from 'node:fs';
import path from 'node:path';

/** Programme history is separate from the smaller production target receipts. */
export const PROGRAMME_LEDGER_MAXIMUM_BYTES = 8 * 1024 * 1024;

export function readProgrammeLedger<T>(file: string): T {
  const root = path.dirname(file),
    directory = fs.lstatSync(root);
  if (
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    fs.realpathSync(root) !== root ||
    !directory.isDirectory() ||
    directory.uid !== process.getuid?.() ||
    (directory.mode & 0o7777) !== 0o700
  )
    throw Error('unsafe_programme_ledger');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      before.uid !== process.getuid?.() ||
      (before.mode & 0o7777) !== 0o600 ||
      !Number.isSafeInteger(before.size) ||
      before.size < 1 ||
      before.size > PROGRAMME_LEDGER_MAXIMUM_BYTES ||
      fs.realpathSync(file) !== file
    )
      throw Error('unsafe_programme_ledger');
    const readBytes = () => {
      const bytes = Buffer.alloc(before.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
        if (read === 0) break;
        count += read;
      }
      if (count !== before.size) throw Error('programme_ledger_changed');
      return bytes.subarray(0, count);
    };
    const unchanged = (stat: fs.Stats) =>
      stat.dev === before.dev &&
      stat.ino === before.ino &&
      stat.uid === before.uid &&
      stat.mode === before.mode &&
      stat.nlink === before.nlink &&
      stat.size === before.size &&
      stat.mtimeMs === before.mtimeMs &&
      stat.ctimeMs === before.ctimeMs;
    const assertCurrent = () => {
      const currentDirectory = fs.lstatSync(root);
      if (
        !unchanged(fs.fstatSync(fd)) ||
        !unchanged(fs.lstatSync(file)) ||
        currentDirectory.dev !== directory.dev ||
        currentDirectory.ino !== directory.ino ||
        currentDirectory.uid !== directory.uid ||
        currentDirectory.mode !== directory.mode ||
        fs.realpathSync(file) !== file
      )
        throw Error('programme_ledger_changed');
    };
    assertCurrent();
    const bytes = readBytes();
    assertCurrent();
    // Docker's shared filesystem can coalesce timestamps for equal-size edits.
    if (!readBytes().equals(bytes)) throw Error('programme_ledger_changed');
    assertCurrent();
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as T;
  } finally {
    fs.closeSync(fd);
  }
}
