import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
/** Linux flock belongs to the shared open-file description, retained here until the entire operation finishes. */
export async function withDeploymentLock<T>(file: string, operation: () => Promise<T>): Promise<T> {
  if (
    process.platform !== 'linux' ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    fs.realpathSync(path.dirname(file)) !== path.dirname(file)
  )
    throw new Error('unsafe_deployment_lock');
  const parent = fs.statSync(path.dirname(file));
  if (!parent.isDirectory() || parent.uid !== process.getuid?.() || parent.mode & 0o022)
    throw new Error('unsafe_deployment_lock');
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1)
      throw new Error('unsafe_deployment_lock');
    await new Promise<void>((resolve, reject) => {
      const child = spawn('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], {
        stdio: ['ignore', 'ignore', 'ignore', fd],
        env: { PATH: '/usr/bin:/bin' },
        timeout: 5000,
      });
      child.once('error', (error) => reject(new Error('deployment_lock_unavailable', { cause: error })));
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('target_deployment_locked'))));
    });
    return await operation();
  } finally {
    fs.closeSync(fd);
  }
}
