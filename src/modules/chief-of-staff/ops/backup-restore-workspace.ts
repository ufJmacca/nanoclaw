import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { BackupArchiveRestoreSink } from './backup-archive-reader.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type IsolatedBackupRestore = {
  directory: string;
  sink: BackupArchiveRestoreSink;
  assertCurrent(): void;
};
type Node = { stat: fs.Stats; directory: boolean; sha256?: string };
const pinned = (fd: number) => '/proc/self/fd/' + fd;
function same(initial: fs.Stats, current: fs.Stats, directory: boolean): void {
  if (
    current.dev !== initial.dev ||
    current.ino !== initial.ino ||
    current.uid !== initial.uid ||
    (current.mode & 0o7777) !== (directory ? 0o700 : 0o600) ||
    (directory
      ? !current.isDirectory()
      : !current.isFile() ||
        current.nlink !== 1 ||
        current.size !== initial.size ||
        current.mtimeMs !== initial.mtimeMs ||
        current.ctimeMs !== initial.ctimeMs)
  )
    throw Error('restore_node_changed');
}
/** Trusted composition only: directory must be a held vault staging descriptor,
 * with the current encrypted-mount, target, shared writer and measured staging
 * budget admitted by the installed caller. This component cannot admit a vault.
 * It creates a new operation only, never reuses an interrupted destination and
 * removes only its complete unchanged graph. Unexplained residue is held. */
export async function withIsolatedBackupRestore<T>(
  directory: string,
  requestId: string,
  maximumBytes: number,
  assertCaller: () => void,
  operation: (scope: IsolatedBackupRestore) => Promise<T>,
): Promise<T> {
  let stageFd: number | undefined,
    rootFd: number | undefined,
    rootStat: fs.Stats | undefined,
    active = false,
    failed = false,
    result: T | undefined;
  const nodes = new Map<string, Node>(),
    closeFiles = new Set<() => void>();
  let used = 0;
  const rootName = '.cos-restore-' + requestId;
  try {
    if (
      process.platform !== 'linux' ||
      !/^\/proc\/self\/fd\/\d+$/.test(directory) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(requestId) ||
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes < 16384 ||
      maximumBytes > BACKUP_LIMITS.staging ||
      typeof assertCaller !== 'function' ||
      typeof operation !== 'function'
    )
      throw Error('restore_scope_required');
    assertCaller();
    stageFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    const stage = fs.fstatSync(stageFd);
    if (!stage.isDirectory() || stage.uid !== process.getuid?.() || (stage.mode & 0o7777) !== 0o700)
      throw Error('restore_stage_unverified');
    const stageCurrent = () => {
      assertCaller();
      same(stage, fs.fstatSync(stageFd!), true);
      same(stage, fs.statSync(directory), true);
    };
    const capacity = (growth: number, reserve = true) => {
      stageCurrent();
      const stat = fs.statfsSync(pinned(stageFd!), { bigint: true });
      if (
        typeof stat.bavail !== 'bigint' ||
        typeof stat.bsize !== 'bigint' ||
        stat.bavail < 0n ||
        stat.bsize < 1n ||
        (reserve && used + growth > maximumBytes) ||
        stat.bavail * stat.bsize < BigInt(growth + BACKUP_LIMITS.vaultReserve)
      )
        throw Error('restore_capacity_unavailable');
    };
    capacity(8192);
    const rootPath = path.join(pinned(stageFd), rootName);
    fs.mkdirSync(rootPath, { mode: 0o700 });
    rootFd = fs.openSync(rootPath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    rootStat = fs.fstatSync(rootFd);
    if (rootStat.dev !== stage.dev || rootStat.uid !== stage.uid || (rootStat.mode & 0o7777) !== 0o700)
      throw Error('restore_root_changed');
    same(rootStat, fs.lstatSync(rootPath), true);
    fs.fsyncSync(stageFd);
    used = 8192;
    active = true;
    const current = () => {
      if (!active) throw Error('restore_scope_released');
      stageCurrent();
      same(rootStat!, fs.fstatSync(rootFd!), true);
      same(rootStat!, fs.lstatSync(rootPath), true);
    };
    const parents = <U>(name: string, create: boolean, use: (fd: number, basename: string) => U): U => {
      current();
      let parent = rootFd!,
        prefix = '';
      const held: number[] = [],
        parts = name.split('/'),
        basename = parts.pop()!;
      try {
        for (const part of parts) {
          prefix = prefix ? prefix + '/' + part : part;
          const pathname = path.join(pinned(parent), part);
          let known = nodes.get(prefix);
          if (!known && create) {
            fs.mkdirSync(pathname, { mode: 0o700 });
            known = { stat: fs.lstatSync(pathname), directory: true };
            nodes.set(prefix, known);
            fs.fsyncSync(parent);
          }
          if (!known?.directory) throw Error('restore_directory_unowned');
          if (known.stat.dev !== stage.dev || known.stat.uid !== stage.uid) throw Error('restore_directory_changed');
          const child = fs.openSync(
            pathname,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          held.push(child);
          same(known.stat, fs.fstatSync(child), true);
          same(known.stat, fs.lstatSync(pathname), true);
          parent = child;
        }
        current();
        return use(parent, basename);
      } finally {
        for (const fd of held.reverse()) fs.closeSync(fd);
      }
    };
    const sink: BackupArchiveRestoreSink = {
      async open(name, bytes) {
        current();
        if (
          typeof name !== 'string' ||
          name.length > 192 ||
          name.split('/').length > 8 ||
          !name.split('/').every((part) => /^(?:[A-Za-z0-9]|\.cos-)[A-Za-z0-9_.-]*$/.test(part)) ||
          !Number.isSafeInteger(bytes) ||
          bytes < 0 ||
          bytes > maximumBytes ||
          nodes.has(name) ||
          nodes.size >= 8192 ||
          closeFiles.size
        )
          throw Error('restore_file_bounds');
        const parts = name.split('/');
        let missing = 0;
        for (let i = 1; i < parts.length; i++) if (!nodes.has(parts.slice(0, i).join('/'))) missing++;
        if (nodes.size + missing + 1 > 8192) throw Error('restore_node_bounds');
        const growth = Math.ceil(bytes / 4096) * 4096 + (missing + 1) * 8192;
        capacity(growth);
        const fd = parents(name, true, (parent, basename) =>
          fs.openSync(
            path.join(pinned(parent), basename),
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          ),
        );
        const known: Node = { stat: fs.fstatSync(fd), directory: false };
        const content = createHash('sha256');
        nodes.set(name, known);
        used += growth;
        let written = 0,
          closed = false;
        const close = () => {
          if (!closed) {
            known.sha256 = content.digest('hex');
            closed = true;
            fs.closeSync(fd);
            closeFiles.delete(close);
          }
        };
        closeFiles.add(close);
        const fileCurrent = () => {
          current();
          if (closed) throw Error('restore_file_closed');
          if (known.stat.dev !== stage.dev || known.stat.uid !== stage.uid) throw Error('restore_file_changed');
          same(known.stat, fs.fstatSync(fd), false);
          parents(name, false, (parent, basename) =>
            same(known.stat, fs.lstatSync(path.join(pinned(parent), basename)), false),
          );
        };
        return {
          async write(chunk) {
            fileCurrent();
            if (!Buffer.isBuffer(chunk) || chunk.length < 1 || chunk.length > 65536 || written + chunk.length > bytes)
              throw Error('restore_write_bounds');
            capacity(Math.min(bytes - written, 65536), false);
            let offset = 0;
            while (offset < chunk.length) {
              const count = fs.writeSync(fd, chunk, offset, chunk.length - offset, written);
              if (count < 1) throw Error('restore_short_write');
              content.update(chunk.subarray(offset, offset + count));
              written += count;
              offset += count;
              known.stat = fs.fstatSync(fd);
            }
            fileCurrent();
          },
          async close() {
            try {
              fileCurrent();
              if (written !== bytes) throw Error('restore_incomplete_file');
              fs.fsyncSync(fd);
              fileCurrent();
            } finally {
              close();
            }
          },
        };
      },
    };
    try {
      result = await operation({ directory: pinned(rootFd), sink, assertCurrent: current });
      current();
      capacity(0);
      if (closeFiles.size) throw Error('restore_files_unclosed');
      // eslint-disable-next-line no-catch-all/no-catch-all -- Private verifier and transport errors are collapsed after descriptor cleanup.
    } catch {
      failed = true;
    }
    for (const close of [...closeFiles]) close();
    const checkContent = (parent: number, basename: string, node: Node) => {
      if (node.directory) return;
      if (!node.sha256) throw Error('restore_file_unclosed');
      const pathname = path.join(pinned(parent), basename),
        fd = fs.openSync(pathname, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK),
        buffer = Buffer.alloc(65536),
        hash = createHash('sha256');
      try {
        same(node.stat, fs.fstatSync(fd), false);
        for (let offset = 0; offset < node.stat.size; ) {
          current();
          const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, node.stat.size - offset), offset);
          if (count < 1) throw Error('restore_file_short_read');
          hash.update(buffer.subarray(0, count));
          buffer.fill(0);
          offset += count;
        }
        same(node.stat, fs.fstatSync(fd), false);
        same(node.stat, fs.lstatSync(pathname), false);
        if (hash.digest('hex') !== node.sha256) throw Error('restore_file_content_changed');
      } finally {
        buffer.fill(0);
        fs.closeSync(fd);
      }
    };
    // Verify the complete graph before removing any node. Unknown children,
    // changed files and replacement parents hold the whole isolated destination.
    current();
    for (const [name, node] of nodes)
      parents(name, false, (parent, basename) => {
        same(node.stat, fs.lstatSync(path.join(pinned(parent), basename)), node.directory);
        checkContent(parent, basename, node);
      });
    const directories = ['', ...[...nodes].filter(([, node]) => node.directory).map(([name]) => name)];
    for (const directoryName of directories) {
      const check = (fd: number) => {
        const expected = [...nodes.keys()]
          .filter((name) => path.posix.dirname(name) === (directoryName || '.'))
          .map((name) => path.posix.basename(name))
          .sort();
        if (fs.readdirSync(pinned(fd)).sort().join('\0') !== expected.join('\0')) throw Error('restore_graph_unowned');
      };
      if (!directoryName) check(rootFd);
      else parents(directoryName + '/placeholder', false, (parent) => check(parent));
    }
    for (const [name, node] of [...nodes].sort(([a], [b]) => b.split('/').length - a.split('/').length)) {
      current();
      parents(name, false, (parent, basename) => {
        const pathname = path.join(pinned(parent), basename);
        same(node.stat, fs.lstatSync(pathname), node.directory);
        checkContent(parent, basename, node);
        if (node.directory) fs.rmdirSync(pathname);
        else fs.unlinkSync(pathname);
        fs.fsyncSync(parent);
      });
    }
    current();
    fs.rmdirSync(rootPath);
    fs.fsyncSync(stageFd);
    stageCurrent();
    active = false;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Scope, paths and filesystem failures are private; residue is never adopted or broadly removed.
  } catch {
    failed = true;
  } finally {
    active = false;
    for (const close of [...closeFiles]) {
      try {
        close();
        // eslint-disable-next-line no-catch-all/no-catch-all -- A failed private descriptor close invalidates completion without exposing filesystem diagnostics.
      } catch {
        failed = true;
      }
    }
    for (const fd of [rootFd, stageFd]) {
      try {
        if (fd !== undefined) fs.closeSync(fd);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Close every remaining scope and preserve the fixed public failure category.
      } catch {
        failed = true;
      }
    }
  }
  if (failed) throw Error('backup_restore_workspace_unavailable');
  return result as T;
}
