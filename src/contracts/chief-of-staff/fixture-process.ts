import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

/** Owns a newly spawned Linux process group; never accepts a caller-supplied PID. */
export function startFixtureProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  output: Writable = process.stderr,
  options: { cwd?: string } = {},
) {
  if (process.platform !== 'linux') throw new Error('container_fixture_required');
  if (options.cwd !== undefined) {
    const stat = fs.lstatSync(options.cwd);
    if (
      !path.isAbsolute(options.cwd) ||
      path.resolve(options.cwd) !== options.cwd ||
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(options.cwd) !== options.cwd ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o7777) !== 0o700
    )
      throw Error('private_fixture_working_directory_required');
  }
  const child = spawn(process.execPath, args, {
    env,
    cwd: options.cwd,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(output, { end: false });
  child.stderr.pipe(output, { end: false });
  const finished = new Promise<void>((resolve, reject) => {
    child.once('error', (error) => reject(new Error('fixture_process_failed', { cause: error })));
    child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('fixture_process_failed'))));
  });
  void finished.catch(() => {});
  const liveMembers = () => {
    if (!child.pid) return 0;
    if (child.pid <= 1 || child.pid === process.pid) throw new Error('fixture_process_group_invalid');
    let count = 0;
    for (const name of fs.readdirSync('/proc')) {
      if (!/^[0-9]+$/.test(name)) continue;
      try {
        if (fs.statSync('/proc/' + name).uid !== process.getuid?.()) continue;
        const raw = fs.readFileSync('/proc/' + name + '/stat', 'utf8'),
          end = raw.lastIndexOf(') ');
        if (end < 0) throw new Error('fixture_process_observation_failed');
        const fields = raw
          .slice(end + 2)
          .trim()
          .split(/\s+/);
        if (Number(fields[2]) === child.pid && !['Z', 'X'].includes(fields[0])) count++;
      } catch (error) {
        // A process can exit between listing it and reading its proc metadata.
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    return count;
  };
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  };
  const stop = async () => {
    if (!liveMembers()) return;
    signal('SIGTERM');
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!liveMembers()) return;
    }
    signal('SIGKILL');
    for (let attempt = 0; attempt < 100; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (!liveMembers()) return;
    }
    throw new Error('fixture_shutdown_unverified');
  };
  return { finished, stop };
}
