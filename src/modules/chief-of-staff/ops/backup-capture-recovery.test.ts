import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue } from './backup-queue.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-capture-recovery-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(root)),
    operationId = randomUUID();
  const failed = () =>
    queue.capture(
      'state',
      operationId,
      async (sink) => {
        sink.write('first.json', Buffer.from('SYNTHETIC_FIRST'));
        sink.write('nested/second.json', Buffer.from('SYNTHETIC_SECOND'));
        throw Error('capture interrupted');
      },
      65536,
    );
  return { root, queue, operationId, failed, slot: root + '/backup-queue/full', guard: vi.fn(() => {}) };
}
it('automatic recovery does not initialize an absent queue or remove a pending snapshot', async () => {
  const f = fixture();
  await expect(f.queue.reconcileIncompleteCapture('state', f.guard)).resolves.toMatchObject({
    status: 'capture_recovery_idle',
  });
  expect(fs.existsSync(f.root + '/backup-queue')).toBe(false);
  await f.queue.capture('state', f.operationId, async (sink) => sink.write('ready.json', Buffer.from('READY')), 65536);
  await expect(f.queue.reconcileIncompleteCapture('state', f.guard)).resolves.toMatchObject({
    status: 'capture_recovery_idle',
  });
  expect(fs.readFileSync(f.slot + '/data/ready.json', 'utf8')).toBe('READY');
});
it('automatic recovery resumes known partial deletion without relying on the delivery observation', async () => {
  const f = fixture();
  await expect(f.failed()).rejects.toThrow('backup_queue_unavailable');
  const remove = fs.rmdirSync;
  const fault = vi.spyOn(fs, 'rmdirSync').mockImplementation((file, ...args) => {
    remove(file, ...args);
    if (String(file).endsWith('/data')) throw Error('lost directory removal result');
  });
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow('backup_queue_unavailable');
  fault.mockRestore();
  expect((await f.queue.inspectDelivery('state')).items).toMatchObject([{ disposition: 'held' }]);
  await expect(f.queue.reconcileIncompleteCapture('state', f.guard)).resolves.toMatchObject({
    status: 'capture_retired',
  });
  expect((await f.queue.inspectDelivery('state')).items).toEqual([]);
});
it('retires only an owned incomplete capture under fresh caller authority and permits a later capture', async () => {
  const f = fixture();
  await expect(f.failed()).rejects.toThrow('backup_queue_unavailable');
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).resolves.toMatchObject({
    status: 'capture_retired',
    operationId: f.operationId,
  });
  expect(f.guard).toHaveBeenCalled();
  expect(fs.existsSync(f.slot)).toBe(false);
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).resolves.toMatchObject({
    status: 'capture_retired',
  });
  const next = randomUUID();
  await f.queue.capture('state', next, async (sink) => sink.write('later.json', Buffer.from('NEWER')), 65536);
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow('backup_queue_unavailable');
  expect(fs.readFileSync(f.slot + '/data/later.json', 'utf8')).toBe('NEWER');
});
it('never retires a completed pending snapshot', async () => {
  const f = fixture();
  await f.queue.capture('state', f.operationId, async (sink) => sink.write('ready.json', Buffer.from('READY')), 65536);
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).resolves.toMatchObject({
    status: 'capture_pending',
  });
  expect(fs.readFileSync(f.slot + '/data/ready.json', 'utf8')).toBe('READY');
});
it.each(['changed', 'replaced', 'directory', 'linked', 'symlink', 'unknown', 'unclaimed', 'withdrawn'] as const)(
  'preserves %s capture conflicts before any deletion',
  async (reason) => {
    const f = fixture();
    await expect(f.failed()).rejects.toThrow('backup_queue_unavailable');
    const first = f.slot + '/data/first.json',
      second = f.slot + '/data/nested/second.json';
    if (reason === 'changed') fs.writeFileSync(second, 'DIFFERENT');
    if (reason === 'replaced') {
      fs.renameSync(second, second + '-original');
      fs.copyFileSync(second + '-original', second);
      fs.chmodSync(second, 0o600);
      fs.unlinkSync(second + '-original');
    }
    if (reason === 'directory') {
      fs.renameSync(f.slot, f.slot + '-original');
      fs.cpSync(f.slot + '-original', f.slot, { recursive: true });
    }
    if (reason === 'linked') fs.linkSync(second, f.root + '/alias');
    if (reason === 'symlink') {
      fs.renameSync(second, second + '-original');
      fs.symlinkSync(second + '-original', second);
    }
    if (reason === 'unknown') fs.writeFileSync(f.slot + '/data/foreign.json', 'UNEXPLAINED', { mode: 0o600 });
    if (reason === 'unclaimed') fs.unlinkSync(f.root + '/backup-queue/.cos-capture.json');
    if (reason === 'withdrawn')
      f.guard.mockImplementation(() => {
        throw Error('scope closed');
      });
    await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow('backup_queue_unavailable');
    expect(fs.readFileSync(first, 'utf8')).toBe('SYNTHETIC_FIRST');
  },
);
it('resumes interrupted deletion without adopting replacements', async () => {
  const f = fixture();
  await expect(f.failed()).rejects.toThrow('backup_queue_unavailable');
  const unlink = fs.unlinkSync;
  let removed = false;
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    unlink(file);
    if (!removed && String(file).endsWith('/first.json')) {
      removed = true;
      throw Error('lost unlink result');
    }
  });
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow('backup_queue_unavailable');
  fault.mockRestore();
  expect(removed).toBe(true);
  await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).resolves.toMatchObject({
    status: 'capture_retired',
  });
});
it('never steals a live capture writer lock', async () => {
  const f = fixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => (entered = resolve)),
    done = new Promise<void>((resolve) => (finish = resolve));
  const capture = f.queue.capture(
    'state',
    f.operationId,
    async (sink) => {
      sink.write('first.json', Buffer.from('FIRST'));
      entered();
      await done;
    },
    65536,
  );
  await started;
  try {
    await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow('backup_queue_unavailable');
  } finally {
    finish();
    await capture;
  }
});
it.each(['initial_receipt', 'partial_payload', 'before_pending_rename', 'after_pending_rename'] as const)(
  'reconciles the original capture after actual SIGKILL at %s',
  async (scenario) => {
    const f = fixture(),
      extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js',
      module = new URL('./backup-queue.' + extension, import.meta.url).href;
    const code = `import fs from 'node:fs';import {BackupQueue} from ${JSON.stringify(module)};
      const scenario=${JSON.stringify(scenario)},pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      const write=fs.writeFileSync,rename=fs.renameSync;
      fs.writeFileSync=(file,bytes,...args)=>{if(scenario==='initial_receipt'&&typeof file==='number'&&String(bytes).startsWith('{"format":"cos-backup-queue/v1"'))pause();return write(file,bytes,...args);};
      fs.renameSync=(from,to)=>{const pending=String(to).endsWith('/receipt.json')&&JSON.parse(fs.readFileSync(from,'utf8')).state==='pending';if(pending&&scenario==='before_pending_rename')pause();const result=rename(from,to);if(pending&&scenario==='after_pending_rename')pause();return result;};
      const queue=new BackupQueue('a'.repeat(64),(_,operation)=>operation(${JSON.stringify(f.root)}));
      await queue.capture('state',${JSON.stringify(f.operationId)},async sink=>{sink.write('first.json',Buffer.from('SYNTHETIC_FIRST'));if(scenario==='partial_payload')pause();sink.write('nested/second.json',Buffer.from('SYNTHETIC_SECOND'));},65536);`;
    const child = spawn(
      process.execPath,
      [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', code],
      {
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const closed = new Promise<NodeJS.Signals | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, signal) => resolve(signal));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('capture_fixture_timeout')), 5000);
        child.stdout.once('data', (bytes) => {
          clearTimeout(timer);
          if (bytes.toString() === 'READY\n') resolve();
          else reject(Error('capture_fixture_start_failed'));
        });
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('close', () => {
          clearTimeout(timer);
          reject(Error('capture_fixture_terminated'));
        });
      });
      await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).rejects.toThrow(
        'backup_queue_unavailable',
      );
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toBe('SIGKILL');
      expect((await f.queue.inspectDelivery('state')).items).toHaveLength(1);
      const complete = scenario.includes('pending_rename');
      await expect(f.queue.reconcileCapture('state', f.operationId, f.guard)).resolves.toMatchObject({
        status: complete ? 'capture_pending' : 'capture_retired',
      });
      if (complete)
        await f.queue.withPending('state', f.operationId, async (directory) =>
          expect(fs.readFileSync(directory + '/nested/second.json', 'utf8')).toBe('SYNTHETIC_SECOND'),
        );
      else expect(fs.existsSync(f.slot)).toBe(false);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  },
);
