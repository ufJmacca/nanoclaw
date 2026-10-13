import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const operationId = '9f99d9b4-4dac-423a-956c-afd953993c2d';
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-archive-'));
  roots.push(root);
  const area = path.join(root, 'vault');
  fs.mkdirSync(area, { mode: 0o700 });
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
  const longName = 'artifacts/' + 'a'.repeat(64) + '-' + 'b'.repeat(64) + '.blob';
  await queue.capture(
    'state',
    operationId,
    async (sink) => {
      sink.write('coordinated/remote.json', Buffer.from('synthetic-state'));
      sink.write(longName, Buffer.alloc(150000, 0x41));
      sink.write('empty', Buffer.alloc(0));
    },
    262144,
  );
  return { root, area, queue, longName };
}
it('streams a bounded standard PAX archive with long names, empty files and a recovery receipt', async () => {
  const f = await fixture();
  const chunks: Buffer[] = [],
    sizes: number[] = [];
  await f.queue.withPending('state', operationId, async (directory, receipt) => {
    await streamBackupArchive(directory, receipt, async (bytes) => {
      chunks.push(Buffer.from(bytes));
      sizes.push(bytes.length);
    });
  });
  expect(Math.max(...sizes)).toBeLessThanOrEqual(65536);
  const archive = Buffer.concat(chunks);
  expect(archive.length % 512).toBe(0);
  const listing = execFileSync('/usr/bin/tar', ['--list', '--file=-'], { input: archive, encoding: 'utf8' })
    .trim()
    .split('\n');
  expect(listing.sort()).toEqual(
    ['cos-backup-receipt.json', 'payload/coordinated/remote.json', 'payload/' + f.longName, 'payload/empty'].sort(),
  );
  expect(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'payload/' + f.longName], { input: archive }),
  ).toEqual(Buffer.alloc(150000, 0x41));
  const receipt = JSON.parse(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'cos-backup-receipt.json'], {
      input: archive,
      encoding: 'utf8',
    }),
  );
  expect(receipt).toMatchObject({ format: 'cos-backup-queue/v1', operationId, state: 'pending' });
  expect(fs.readdirSync(f.root)).toEqual(['vault']);
});
it('honours stream backpressure and wipes borrowed plaintext chunks after use', async () => {
  const f = await fixture();
  let busy = false,
    fileChunks = 0;
  const borrowed: Buffer[] = [];
  await f.queue.withPending('state', operationId, async (directory, receipt) => {
    await streamBackupArchive(directory, receipt, async (bytes) => {
      expect(busy).toBe(false);
      busy = true;
      if (bytes.length > 512 && bytes[0] === 0x41) {
        fileChunks++;
        borrowed.push(bytes);
      }
      await new Promise((resolve) => setImmediate(resolve));
      busy = false;
    });
  });
  expect(fileChunks).toBeGreaterThan(1);
  expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it('rejects a file changed after validation instead of completing an archive', async () => {
  const f = await fixture();
  let changed = false;
  await expect(
    f.queue.withPending('state', operationId, async (directory, receipt) => {
      await streamBackupArchive(directory, receipt, async (bytes) => {
        if (!changed && bytes.length > 512 && bytes[0] === 0x41) {
          changed = true;
          fs.writeFileSync(path.join(directory, f.longName), Buffer.alloc(150000, 0x42));
        }
      });
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(changed).toBe(true);
});
it('rejects invalid receipt paths and hashes before emitting bytes', async () => {
  const f = await fixture();
  await f.queue.withPending('state', operationId, async (directory, receipt) => {
    for (const invalid of [
      { ...receipt, files: [{ ...receipt.files[0], name: '../escape' }] },
      { ...receipt, files: [{ ...receipt.files[0], sha256: 'not-a-hash' }] },
      { ...receipt, state: 'failed' as const },
    ]) {
      let called = false;
      await expect(
        streamBackupArchive(directory, invalid, async () => {
          called = true;
        }),
      ).rejects.toThrow(/^backup_archive_unavailable$/);
      expect(called).toBe(false);
    }
  });
});
it('redacts failed stream diagnostics and leaves the pending snapshot available', async () => {
  const f = await fixture();
  await expect(
    f.queue.withPending('state', operationId, async (directory, receipt) => {
      await streamBackupArchive(directory, receipt, async () => {
        throw Error('private transport diagnostic');
      });
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect((await f.queue.pending('state'))[0].state).toBe('pending');
});
