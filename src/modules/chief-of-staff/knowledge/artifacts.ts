import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { decodeSource, extractChunks, MAX_SOURCE_BYTES } from './text.js';
export const sourceDigest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const identity = /^[a-f0-9]{64}-[a-f0-9]{64}$/;
const marker = 'cos-knowledge-artifacts/v1\n';

function privateRoot(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    !stat.isDirectory() ||
    fs.realpathSync(root) !== root ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_knowledge_root');
  for (let ancestor = root; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(path.join(ancestor, '.git'), { throwIfNoEntry: false })) throw new Error('unsafe_knowledge_root');
    if (path.dirname(ancestor) === ancestor) break;
  }
}
function syncDirectory(root: string): void {
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function privateBytes(file: string, maximum = MAX_SOURCE_BYTES): Buffer {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > maximum
    )
      throw new Error('unsafe_knowledge_file');
    const bytes = Buffer.alloc(maximum + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = fs.readSync(fd, bytes, count, bytes.length - count, count);
      if (!read) break;
      count += read;
    }
    const after = fs.fstatSync(fd);
    if (count > maximum || count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('unstable_knowledge_file');
    return bytes.subarray(0, count);
  } finally {
    fs.closeSync(fd);
  }
}

/** Only trusted host import/admin code can construct this store. Never mount either root in a worker. */
export class KnowledgeArtifacts {
  constructor(
    readonly root: string,
    readonly staging: string,
  ) {
    privateRoot(root);
    privateRoot(staging);
    if (root === staging || root.startsWith(staging + '/') || staging.startsWith(root + '/'))
      throw new Error('unsafe_knowledge_root');
    const file = path.join(root, '.cos-artifacts');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
      if (fs.readdirSync(root).length) throw new Error('unowned_knowledge_root');
      const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, marker);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDirectory(root);
    }
    this.guard();
  }
  private guard(): void {
    privateRoot(this.root);
    if (privateBytes(path.join(this.root, '.cos-artifacts'), 128).toString('utf8') !== marker)
      throw new Error('unowned_knowledge_root');
  }
  capture(scopeId: string, filename: string) {
    this.guard();
    privateRoot(this.staging);
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId) || !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,120}\.(md|txt)$/i.test(filename))
      throw new Error('unsupported_source');
    const bytes = privateBytes(path.join(this.staging, filename));
    const text = decodeSource(bytes);
    const digest = sourceDigest(bytes),
      id = sourceDigest(Buffer.from(scopeId)) + '-' + digest,
      chunks = extractChunks(text);
    const final = path.join(this.root, id + '.blob');
    if (fs.lstatSync(final, { throwIfNoEntry: false })) this.read(id, digest);
    else {
      const temporary = path.join(this.root, '.pending-' + randomUUID());
      const fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Atomic publication leaves either an orphan temporary file or complete bytes.
      // Concurrent publishers of this scope/digest necessarily publish identical bytes.
      fs.renameSync(temporary, final);
      syncDirectory(this.root);
      this.read(id, digest);
    }
    return { id, digest, byteLength: bytes.length, text, chunks };
  }
  read(id: string, digest: string): string {
    this.guard();
    if (!identity.test(id) || !/^[a-f0-9]{64}$/.test(digest) || !id.endsWith('-' + digest))
      throw new Error('invalid_artifact');
    const bytes = privateBytes(path.join(this.root, id + '.blob'));
    if (sourceDigest(bytes) !== digest) throw new Error('artifact_integrity');
    return decodeSource(bytes);
  }
  /** Caller must hold import/GC exclusion and obtain a complete current DB reference set first. */
  reconcile(referenced: Set<string>, before: number): number {
    this.guard();
    if (!Number.isFinite(before) || before < 0 || [...referenced].some((id) => !identity.test(id)))
      throw new Error('invalid_artifact_reconciliation');
    let removed = 0;
    for (const name of fs.readdirSync(this.root)) {
      const blob = name.endsWith('.blob') && identity.test(name.slice(0, -5));
      if (!blob && !/^\.pending-[a-f0-9-]{36}$/.test(name)) continue;
      if (blob && referenced.has(name.slice(0, -5))) continue;
      const file = path.join(this.root, name),
        stat = fs.lstatSync(file);
      if (stat.mtimeMs >= before) continue;
      privateBytes(file);
      fs.unlinkSync(file);
      removed++;
    }
    if (removed) syncDirectory(this.root);
    return removed;
  }
}
