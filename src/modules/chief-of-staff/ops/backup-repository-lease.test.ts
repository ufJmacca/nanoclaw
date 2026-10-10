import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { BackupRepositoryWriter } from './backup-repository-lease.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-repository-lock-'));
  roots.push(root);
  const access = async <T>(operation: (directory: string) => Promise<T>) => operation(root);
  return { root, writer: new BackupRepositoryWriter('a'.repeat(64), access), access };
}
it('uses a kernel writer lease to refuse a competing uploader or retention job', async () => {
  const f = fixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    done = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const first = f.writer.exclusive(async (lease) => {
    lease.assertCurrent();
    entered();
    await done;
    lease.assertCurrent();
    return 'finished';
  });
  await started;
  try {
    const other = new BackupRepositoryWriter('a'.repeat(64), f.access);
    await expect(other.exclusive(async () => 'must not run')).rejects.toThrow(/^backup_repository_busy$/);
  } finally {
    finish();
  }
  expect(await first).toBe('finished');
  expect(
    await f.writer.exclusive(async (lease) => {
      lease.assertCurrent();
      return 'next';
    }),
  ).toBe('next');
  expect(fs.statSync(path.join(f.root, 'repository.lock')).mode & 0o777).toBe(0o600);
});
it('invalidates a released lease and redacts private callback failures while releasing the kernel lock', async () => {
  const f = fixture();
  let current!: () => void;
  await expect(
    f.writer.exclusive(async (lease) => {
      current = lease.assertCurrent;
      throw Error('private repository diagnostic');
    }),
  ).rejects.toThrow(/^backup_repository_unavailable$/);
  expect(() => current()).toThrow(/^backup_repository_unavailable$/);
  await expect(
    f.writer.exclusive(async (lease) => {
      lease.assertCurrent();
    }),
  ).resolves.toBeUndefined();
});
it('refuses a foreign owner seal without adopting or overwriting it', async () => {
  const f = fixture();
  await f.writer.exclusive(async () => {});
  const file = path.join(f.root, 'repository.lock'),
    before = fs.readFileSync(file);
  const foreign = new BackupRepositoryWriter('b'.repeat(64), f.access);
  await expect(
    foreign.exclusive(async () => {
      throw Error('must not run');
    }),
  ).rejects.toThrow(/^backup_repository_unavailable$/);
  expect(fs.readFileSync(file)).toEqual(before);
});
it('detects owner-seal tampering before acknowledging the writer result', async () => {
  const f = fixture();
  await expect(
    f.writer.exclusive(async (lease) => {
      fs.writeFileSync(path.join(f.root, 'repository.lock'), 'changed');
      lease.assertCurrent();
      return 'must not acknowledge';
    }),
  ).rejects.toThrow(/^backup_repository_unavailable$/);
});
it('refuses a linked lease file without following or changing its target', async () => {
  const f = fixture(),
    target = path.join(f.root, 'unrelated');
  fs.writeFileSync(target, 'unrelated fixture', { mode: 0o600 });
  fs.symlinkSync(target, path.join(f.root, 'repository.lock'));
  await expect(f.writer.exclusive(async () => {})).rejects.toThrow(/^backup_repository_unavailable$/);
  expect(fs.readFileSync(target, 'utf8')).toBe('unrelated fixture');
});
it('releases the kernel lease after its owning process is killed without needing a stale-lock override', async () => {
  const f = fixture();
  const moduleUrl = new URL('./backup-repository-lease.ts', import.meta.url).href;
  const code = `import { BackupRepositoryWriter } from ${JSON.stringify(moduleUrl)};
    const writer = new BackupRepositoryWriter('a'.repeat(64), operation => operation(${JSON.stringify(f.root)}));
    await writer.exclusive(async lease => { lease.assertCurrent(); process.stdout.write('READY\\n');
      process.stdin.resume(); await new Promise(() => {}); });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      child.stdout.once('data', (bytes) =>
        bytes.toString() === 'READY\n' ? resolve() : reject(Error('fixture_start_failed')),
      );
      child.once('close', () => reject(Error('fixture_start_failed')));
      child.once('error', reject);
    });
    await expect(f.writer.exclusive(async () => {})).rejects.toThrow(/^backup_repository_busy$/);
    expect(child.kill('SIGKILL')).toBe(true);
    await closed;
    await expect(
      f.writer.exclusive(async (lease) => {
        lease.assertCurrent();
      }),
    ).resolves.toBeUndefined();
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});
