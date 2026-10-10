import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { capturePrivateHistory, verifyPrivateHistory } from './private-history-backup.js';
import { BackupQueue } from './backup-queue.js';

const roots: string[] = [],
  generation = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture(profile: 'conversation' | 'mission') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-history-capture-'));
  roots.push(root);
  const source = path.join(root, 'source'),
    area = path.join(root, 'synthetic-vault');
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(area, { mode: 0o700 });
  const base =
    profile === 'conversation' ? path.join(source, generation) : path.join(source, 'missions', generation, 'provider');
  fs.mkdirSync(path.join(base, 'sessions'), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(base, 'empty'), { mode: 0o700 });
  fs.writeFileSync(path.join(base, 'sessions/history.jsonl'), Buffer.alloc(150000, 0x41), { mode: 0o600 });
  fs.writeFileSync(path.join(base, 'auth.json'), 'SYNTHETIC_ACCESS_SECRET', { mode: 0o600 });
  if (profile === 'mission') {
    fs.mkdirSync(path.join(source, 'missions', generation, 'control'), { mode: 0o700 });
    fs.writeFileSync(path.join(source, 'missions', generation, 'control/capability'), 'SYNTHETIC_AUTHORITY');
    fs.writeFileSync(path.join(source, 'credentials.json'), 'SYNTHETIC_MASTER_SECRET');
  }
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
  return { root, source, area, base, queue };
}
it.each(['conversation', 'mission'] as const)(
  'streams only selected %s history and reconstructs empty directories for legacy verification',
  async (profile) => {
    const f = fixture(profile),
      operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
    let capture!: Awaited<ReturnType<typeof capturePrivateHistory>>;
    await f.queue.capture(
      'state',
      operationId,
      async (sink) => {
        capture = await capturePrivateHistory(f.source, sink, profile, 262144);
      },
      524288,
    );
    expect(capture.directories.some((name) => name.endsWith('/empty'))).toBe(true);
    const recovered = path.join(f.root, 'isolated-recovery');
    fs.mkdirSync(recovered, { mode: 0o700 });
    const history = path.join(recovered, profile + '-backup/history');
    fs.mkdirSync(history, { recursive: true, mode: 0o700 });
    for (const name of capture.directories) fs.mkdirSync(path.join(history, name), { recursive: true, mode: 0o700 });
    await f.queue.withPending('state', operationId, async (directory, receipt) => {
      expect(
        receipt.files.some(
          (file) =>
            file.name.includes('auth.json') || file.name.includes('control') || file.name.includes('credentials.json'),
        ),
      ).toBe(false);
      for (const file of receipt.files) {
        const destination = path.join(recovered, file.name);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        fs.copyFileSync(path.join(directory, file.name), destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
      }
    });
    expect(await verifyPrivateHistory(f.source, recovered, profile)).toEqual(capture);
    expect(fs.readFileSync(path.join(f.base, 'auth.json'), 'utf8')).toBe('SYNTHETIC_ACCESS_SECRET');
  },
);
it('denies over-budget history before sending any bytes to the queue sink', async () => {
  const f = fixture('conversation');
  let called = false;
  await expect(
    capturePrivateHistory(
      f.source,
      {
        write() {
          called = true;
        },
      },
      'conversation',
      16384,
    ),
  ).rejects.toThrow(/^private_history_capture_unavailable$/);
  expect(called).toBe(false);
});
it('detects history changed during streaming and never publishes a successful receipt', async () => {
  const f = fixture('conversation');
  let changed = false,
    receiptWritten = false;
  await expect(
    capturePrivateHistory(
      f.source,
      {
        write(name) {
          if (name.endsWith('/receipt.json')) receiptWritten = true;
          if (!changed && name.endsWith('history.jsonl')) {
            changed = true;
            fs.writeFileSync(path.join(f.base, 'sessions/history.jsonl'), Buffer.alloc(150000, 0x42));
          }
        },
      },
      'conversation',
      262144,
    ),
  ).rejects.toThrow(/^private_history_capture_unavailable$/);
  expect(changed).toBe(true);
  expect(receiptWritten).toBe(false);
});
it('records an absent conversation history without creating a plaintext source directory', async () => {
  const f = fixture('conversation');
  fs.rmSync(f.source, { recursive: true });
  const files = new Map<string, Buffer>();
  const receipt = await capturePrivateHistory(
    f.source,
    {
      write(name, bytes) {
        files.set(name, Buffer.from(bytes));
      },
    },
    'conversation',
    262144,
  );
  expect(receipt).toMatchObject({ present: false, files: 0, bytes: 0, directories: [] });
  expect([...files.keys()]).toEqual(['conversation-backup/receipt.json']);
  expect(fs.existsSync(f.source)).toBe(false);
});
