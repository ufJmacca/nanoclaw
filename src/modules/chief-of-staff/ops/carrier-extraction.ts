import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

type CopySource = { output: Readable; completed: Promise<void>; close(): void };
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' };
/** Only the bootstrap's authenticated, private partial payload may be reset. Never follow links. */
function resetPartial(directory: string): void {
  const directories: string[] = [];
  const visit = (current: string) => {
    const stat = fs.lstatSync(current);
    if (stat.uid !== process.getuid?.()) throw Error('carrier_extraction_failed');
    if (!stat.isDirectory()) return;
    directories.push(current);
    for (const name of fs.readdirSync(current)) visit(path.join(current, name));
  };
  visit(directory);
  for (const current of directories) {
    const fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      if (fs.fstatSync(fd).uid !== process.getuid?.()) throw Error('carrier_extraction_failed');
      fs.fchmodSync(fd, 0o700);
    } finally {
      fs.closeSync(fd);
    }
  }
  for (const name of fs.readdirSync(directory)) fs.rmSync(path.join(directory, name), { recursive: true });
}
function completed(child: ChildProcess): Promise<void> {
  const result = new Promise<void>((resolve, reject) => {
    child.once('error', () => reject(Error('carrier_extraction_failed')));
    child.once('close', (code, signal) =>
      code === 0 && !signal ? resolve() : reject(Error('carrier_extraction_failed')),
    );
  });
  void result.catch(() => {});
  return result;
}
function copySource(id: string): CopySource {
  const child = spawn('/usr/bin/docker', ['--host=unix:///var/run/docker.sock', 'cp', id + ':/release/.', '-'], {
    cwd: '/',
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000,
  });
  child.stderr.on('data', () => {});
  return {
    output: child.stdout,
    completed: completed(child),
    close() {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    },
  };
}

/** The caller has verified a stopped, mount-free immutable carrier. GNU tar defers readonly directory modes until their files exist. */
export async function extractCarrierPayload(
  id: string,
  destination: string,
  source: (id: string) => CopySource = copySource,
): Promise<void> {
  let fd: number | undefined, input: CopySource | undefined, tar: ChildProcess | undefined;
  let tarCompletion: Promise<void> | undefined;
  try {
    if (
      !/^[a-f0-9]{64}$/.test(id) ||
      process.platform !== 'linux' ||
      !process.getuid?.() ||
      !path.isAbsolute(destination) ||
      path.resolve(destination) !== destination ||
      fs.realpathSync(destination) !== destination
    )
      throw Error('carrier_extraction_failed');
    const before = fs.lstatSync(destination);
    if (!before.isDirectory() || before.uid !== process.getuid() || (before.mode & 0o777) !== 0o700)
      throw Error('carrier_extraction_failed');
    fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    const pinned = fs.fstatSync(fd);
    if (pinned.dev !== before.dev || pinned.ino !== before.ino) throw Error('carrier_extraction_failed');
    resetPartial(destination);
    input = source(id);
    void input.completed.catch(() => {});
    tar = spawn(
      '/usr/bin/tar',
      [
        '--extract',
        '--file=-',
        '--directory=/proc/self/fd/3',
        '--no-same-owner',
        '--same-permissions',
        '--delay-directory-restore',
      ],
      { cwd: '/', env, stdio: ['pipe', 'ignore', 'pipe', fd], timeout: 600000 },
    );
    tar.stderr?.on('data', () => {});
    tarCompletion = completed(tar);
    await Promise.all([pipeline(input.output, tar.stdin!), input.completed, tarCompletion]);
    const after = fs.lstatSync(destination);
    if (after.dev !== pinned.dev || after.ino !== pinned.ino || after.uid !== process.getuid())
      throw Error('carrier_extraction_failed');
    fs.fchmodSync(fd, 0o700);
    fs.fsyncSync(fd);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Docker/tar diagnostics contain private staging paths; no unsuccessful copy is acknowledged.
    throw Error('carrier_extraction_failed');
  } finally {
    input?.close();
    input?.output.destroy();
    if (tar && tar.exitCode === null && tar.signalCode === null) tar.kill();
    if (tarCompletion) await Promise.allSettled([tarCompletion]);
    if (fd !== undefined) {
      try {
        fs.fchmodSync(fd, 0o700);
      } catch {
        /* Failed copies stay unacknowledged. */
      }
      fs.closeSync(fd);
    }
  }
}
