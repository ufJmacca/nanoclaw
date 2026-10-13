import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue } from './backup-queue.js';
const f = vi.hoisted(() => ({ factory: vi.fn() }));
vi.mock('./backup-queue.js', async (original) => ({
  ...(await original<typeof import('./backup-queue.js')>()),
  createVaultBackupQueue: f.factory,
}));
import { backupArchiveProducerCommand } from './backup-archive-producer.js';
const temporary: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const operationId = '2a47ff04-606c-4ec4-9134-a99a8b20ab55';
const roots = { targetRoot: '/synthetic/state', installationRoot: '/synthetic/install', dataRoot: '/synthetic/data' };
const args = [roots.targetRoot, roots.installationRoot, roots.dataRoot, 'state', operationId];
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-producer-'));
  temporary.push(root);
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(root));
  await queue.capture(
    'state',
    operationId,
    async (sink) => {
      sink.write('coordinated/remote.json', Buffer.from('synthetic checkpoint'));
      sink.write('history/large.json', Buffer.alloc(150000, 0x41));
    },
    262144,
  );
  f.factory.mockReturnValue(queue);
  return { root, queue };
}
it('streams the verified pending queue through the installed vault factory without staging another archive', async () => {
  const s = await fixture(),
    chunks: Buffer[] = [];
  const result = await backupArchiveProducerCommand(args, async (bytes) => {
    chunks.push(Buffer.from(bytes));
  });
  expect(f.factory).toHaveBeenCalledExactlyOnceWith(roots);
  const archive = Buffer.concat(chunks);
  expect(result.bytes).toBe(archive.length);
  expect(
    execFileSync('/usr/bin/tar', ['--extract', '--to-stdout', '--file=-', 'payload/coordinated/remote.json'], {
      input: archive,
      encoding: 'utf8',
    }),
  ).toBe('synthetic checkpoint');
  expect((await s.queue.pending('state'))[0]).toMatchObject({ operationId, state: 'pending' });
  expect(fs.readdirSync(s.root)).toEqual(['backup-queue']);
});
it('fails before emitting bytes when the vault or memory admission is unavailable', async () => {
  f.factory.mockImplementation(() => {
    throw Error('private vault diagnostic');
  });
  const emit = vi.fn();
  await expect(backupArchiveProducerCommand(args, emit)).rejects.toThrow(/^backup_producer_unavailable$/);
  expect(emit).not.toHaveBeenCalled();
});
it('refuses changed published files and keeps the pending checkpoint for reconciliation', async () => {
  const s = await fixture();
  let changed = false;
  await expect(
    backupArchiveProducerCommand(args, async (bytes) => {
      if (!changed && bytes.length > 512 && bytes[0] === 0x41) {
        changed = true;
        fs.writeFileSync(path.join(s.root, 'backup-queue/full/data/history/large.json'), Buffer.alloc(150000, 0x42));
      }
    }),
  ).rejects.toThrow(/^backup_producer_unavailable$/);
  expect(changed).toBe(true);
  expect((await s.queue.pending('state'))[0].state).toBe('pending');
});
it.each(
  [
    args.slice(0, 4),
    [...args, 'extra'],
    [...args.slice(0, 3), 'other', operationId],
    [...args.slice(0, 4), '../escape'],
    ['/', ...args.slice(1)],
    ['/synthetic/../state', ...args.slice(1)],
    ['/synthetic/state\nsecret', ...args.slice(1)],
  ].map((invalid) => ({ invalid })),
)('rejects invalid command input before selecting any vault queue', async ({ invalid }) => {
  const emit = vi.fn();
  await expect(backupArchiveProducerCommand(invalid, emit)).rejects.toThrow(/^backup_producer_unavailable$/);
  expect(f.factory).not.toHaveBeenCalled();
  expect(emit).not.toHaveBeenCalled();
});
