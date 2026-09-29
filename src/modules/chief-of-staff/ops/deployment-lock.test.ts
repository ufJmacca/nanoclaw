import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { withDeploymentLock } from './deployment-lock.js';
it('keeps the OS lock after the locking subprocess exits and releases it after success or failure', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-flock-')),
    file = path.join(root, 'operation.lock');
  try {
    await withDeploymentLock(file, async () => {
      await expect(withDeploymentLock(file, async () => {})).rejects.toThrow('target_deployment_locked');
    });
    await expect(
      withDeploymentLock(file, async () => {
        throw new Error('injected');
      }),
    ).rejects.toThrow('injected');
    await expect(withDeploymentLock(file, async () => 42)).resolves.toBe(42);
    fs.renameSync(file, path.join(root, 'original'));
    fs.symlinkSync(path.join(root, 'original'), file);
    await expect(withDeploymentLock(file, async () => {})).rejects.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
