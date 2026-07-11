import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const TEST_ROOT = `/tmp/nanoclaw-host-lease-${process.pid}`;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

async function waitForAcquired(child: ChildProcess): Promise<void> {
  const stdout = child.stdout;
  if (!stdout) throw new Error('Lease worker stdout was not piped');
  let output = '';
  while (!output.includes('acquired\n')) {
    const [chunk] = (await once(stdout, 'data')) as [Buffer];
    output += chunk.toString();
  }
}

it('rejects a second live host and reclaims only after the owner process dies', async () => {
  const dbPath = path.join(TEST_ROOT, 'central.db');
  const firstMarker = path.join(TEST_ROOT, 'first-admission');
  const secondMarker = path.join(TEST_ROOT, 'second-admission');
  const tsxLoader = import.meta.resolve('tsx');
  const worker = path.resolve(process.cwd(), 'src/db/__fixtures__/host-execution-lease-worker.ts');
  const commonArgs = ['--import', tsxLoader, worker, dbPath];
  const first = spawn(process.execPath, [...commonArgs, 'hold', firstMarker], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LOG_LEVEL: 'fatal' },
  });

  try {
    await waitForAcquired(first);
    expect(fs.existsSync(firstMarker)).toBe(true);

    await expect(
      execFileAsync(process.execPath, [...commonArgs, 'once', secondMarker], {
        env: { ...process.env, LOG_LEVEL: 'fatal' },
      }),
    ).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('already held by a live process'),
    });
    expect(fs.existsSync(secondMarker)).toBe(false);

    first.kill('SIGKILL');
    await once(first, 'exit');

    await expect(
      execFileAsync(process.execPath, [...commonArgs, 'once', secondMarker], {
        env: { ...process.env, LOG_LEVEL: 'fatal' },
      }),
    ).resolves.toMatchObject({ stdout: expect.stringContaining('acquired') });
    expect(fs.existsSync(secondMarker)).toBe(true);
  } finally {
    if (first.exitCode === null && first.signalCode === null) {
      first.kill('SIGKILL');
      await once(first, 'exit');
    }
  }
});
