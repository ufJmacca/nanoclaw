import fs from 'node:fs';
import { spawn } from 'node:child_process';
import type { Writable } from 'node:stream';

/** Owns a newly spawned Linux process group; never accepts a caller-supplied PID. */
export function startFixtureProcess(args: string[], env: NodeJS.ProcessEnv, output: Writable = process.stderr) {
  if (process.platform !== 'linux') throw new Error('container_fixture_required');
  const child = spawn(process.execPath, args, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
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
