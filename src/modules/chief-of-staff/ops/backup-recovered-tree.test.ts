import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { withIsolatedBackupRestore } from './backup-restore-workspace.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import {
  verifyRecoveredCalendarState,
  verifyRecoveredForensicTree,
  type ForensicCaptureReceipt,
} from './backup-recovered-tree.js';
const roots: string[] = [];
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-recovered-tree-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  fs.writeFileSync(root + '/live', 'LATER_TOKENS_DENIALS_JOURNALS_COUNTERS', { mode: 0o600 });
  const operationId = 'release-backup-' + randomUUID();
  const guard = vi.fn();
  const invoke = async <T>(
    files: Record<string, Buffer>,
    operation: (
      scope: Parameters<Parameters<typeof withIsolatedBackupRestore<T>>[4]>[0],
      entries: BackupQueueReceipt['files'],
    ) => Promise<T>,
    maximumBytes = 1024 ** 2,
  ) => {
    const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    try {
      return await withIsolatedBackupRestore(
        '/proc/self/fd/' + fd,
        randomUUID(),
        maximumBytes,
        guard,
        async (scope) => {
          const entries: BackupQueueReceipt['files'] = [];
          for (const [name, bytes] of Object.entries(files)) {
            const file = await scope.sink.open(name, bytes.length);
            await file.write(Buffer.from(bytes));
            await file.close();
            entries.push({ name, bytes: bytes.length, sha256: hash(bytes) });
          }
          return operation(scope, entries);
        },
      );
    } finally {
      fs.closeSync(fd);
      expect(fs.readFileSync(root + '/live', 'utf8')).toBe('LATER_TOKENS_DENIALS_JOURNALS_COUNTERS');
    }
  };
  return { root, operationId, guard, invoke };
}
function forensic(prefix: ForensicCaptureReceipt['prefix'] = 'vault-journals') {
  const body = Buffer.from('SYNTHETIC_FORENSIC_BYTES');
  const receipt: ForensicCaptureReceipt = {
    contract: 'cos-private-tree-capture/v1',
    prefix,
    bytes: body.length,
    files: [{ name: 'events/event.json', bytes: body.length, sha256: hash(body) }],
    directories: ['empty', 'events'],
    excluded:
      prefix === 'vault-journals'
        ? [{ name: '.vault-canary', reason: 'host_bound_vault_proof', metadataDigest: 'a'.repeat(64) }]
        : [],
  };
  const files = () => ({
    [prefix + '/events/event.json']: body,
    [prefix + '.capture.json']: Buffer.from(JSON.stringify(receipt) + '\n'),
  });
  return { prefix, receipt, files };
}
function calendar(f: ReturnType<typeof fixture>, present = true) {
  const body = Buffer.from('SYNTHETIC_ARCHIVED_TOKEN');
  const receipt = {
    contract: 'cos-calendar-capture/v1',
    operationId: f.operationId,
    targetDigest: digest(f.root),
    present,
    storageDigest: present ? 'b'.repeat(64) : null,
    sha256: present
      ? hash(
          JSON.stringify(['credentials', 'directory']) +
            '\n' +
            JSON.stringify(['credentials/token.json', 'file', body.length, hash(body)]) +
            '\n' +
            JSON.stringify(['empty', 'directory']) +
            '\n',
        )
      : hash(''),
    files: present ? 1 : 0,
    bytes: present ? body.length : 0,
    directories: present ? ['credentials', 'empty'] : [],
  };
  const files = (): Record<string, Buffer> => ({
    ...(present ? { 'calendar-state/credentials/token.json': body } : {}),
    'calendar-capture-receipt.json': Buffer.from(JSON.stringify(receipt) + '\n'),
  });
  return { receipt, files };
}
it.each(['effects', 'vault-backup-credentials', 'vault-journals'] as const)(
  'verifies the exact %s forensic graph without restoring authority or the vault canary',
  async (prefix) => {
    const f = fixture(),
      t = forensic(prefix);
    await f.invoke(t.files(), async (scope, entries) => {
      expect(verifyRecoveredForensicTree(scope, entries, prefix)).toEqual(t.receipt);
      expect(fs.existsSync(scope.directory + '/' + prefix + '/empty')).toBe(true);
      expect(fs.existsSync(scope.directory + '/' + prefix + '/.vault-canary')).toBe(false);
    });
    expect(fs.readdirSync(f.root)).toEqual(['live']);
  },
);
it('verifies the original Calendar checksum and recreates only charged isolated empty directories', async () => {
  const f = fixture(),
    t = calendar(f);
  await f.invoke(t.files(), async (scope, entries) => {
    expect(verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId })).toEqual(
      t.receipt,
    );
    expect(fs.existsSync(scope.directory + '/calendar-state/empty')).toBe(true);
  });
  expect(fs.readdirSync(f.root)).toEqual(['live']);
});
it('accepts an absent Calendar without creating a Calendar state root', async () => {
  const f = fixture(),
    t = calendar(f, false);
  await f.invoke(t.files(), async (scope, entries) => {
    expect(verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId })).toEqual(
      t.receipt,
    );
    expect(fs.existsSync(scope.directory + '/calendar-state')).toBe(false);
  });
});
it('accepts the Calendar capture limit of 4096 directories alongside its selected file', async () => {
  const f = fixture(),
    t = calendar(f),
    directories = ['credentials', ...Array.from({ length: 4095 }, (_, i) => 'd' + String(i).padStart(4, '0'))];
  t.receipt.directories = directories;
  const body = t.files()['calendar-state/credentials/token.json'];
  t.receipt.sha256 = hash(
    JSON.stringify(['credentials', 'directory']) +
      '\n' +
      JSON.stringify(['credentials/token.json', 'file', body.length, hash(body)]) +
      '\n' +
      directories
        .slice(1)
        .map((name) => JSON.stringify([name, 'directory']) + '\n')
        .join(''),
  );
  await f.invoke(
    t.files(),
    async (scope, entries) => {
      expect(verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId })).toEqual(
        t.receipt,
      );
      expect(fs.readdirSync(scope.directory + '/calendar-state')).toHaveLength(4096);
    },
    48 * 1024 ** 2,
  );
  expect(fs.readdirSync(f.root)).toEqual(['live']);
}, 30000);
it.each([
  'digest',
  'bytes',
  'prefix',
  'ancestor',
  'overlap',
  'duplicate',
  'excluded-name',
  'excluded-reason',
  'excluded-digest',
  'unknown',
  'file-bounds',
])('refuses a malformed forensic receipt (%s) before recreating empty directories', async (kind) => {
  const f = fixture(),
    t = forensic(),
    r = t.receipt;
  if (kind === 'digest') r.files[0].sha256 = 'c'.repeat(64);
  if (kind === 'bytes') r.bytes++;
  if (kind === 'prefix') r.prefix = 'effects';
  if (kind === 'ancestor') r.directories = ['empty'];
  if (kind === 'overlap') r.directories.push(r.files[0].name);
  if (kind === 'duplicate') r.files.push({ ...r.files[0] });
  if (kind === 'excluded-name') Object.assign(r.excluded[0], { name: 'owner.json' });
  if (kind === 'excluded-reason') Object.assign(r.excluded[0], { reason: 'restore_permission' });
  if (kind === 'excluded-digest') r.excluded[0].metadataDigest = 'malformed';
  if (kind === 'unknown') Object.assign(r, { admissionRestored: true });
  if (kind === 'file-bounds') r.files[0].bytes = 128 * 1024 ** 2 + 1;
  await f.invoke(t.files(), async (scope, entries) => {
    expect(() => verifyRecoveredForensicTree(scope, entries, t.prefix)).toThrow(
      /^forensic_tree_recovery_check_unavailable$/,
    );
    expect(fs.existsSync(scope.directory + '/' + t.prefix + '/empty')).toBe(false);
  });
});
it.each(['operation', 'target', 'checksum', 'storage', 'absent', 'ancestor', 'duplicate', 'unknown'])(
  'refuses malformed Calendar metadata (%s) before directory mutation',
  async (kind) => {
    const f = fixture(),
      t = calendar(f),
      r = t.receipt;
    if (kind === 'operation') r.operationId = 'other';
    if (kind === 'target') r.targetDigest = 'c'.repeat(64);
    if (kind === 'checksum') r.sha256 = 'c'.repeat(64);
    if (kind === 'storage') r.storageDigest = null;
    if (kind === 'absent') r.present = false;
    if (kind === 'ancestor') r.directories = ['empty'];
    if (kind === 'duplicate') r.directories.push('empty');
    if (kind === 'unknown') Object.assign(r, { snapshot: 'live' });
    await f.invoke(t.files(), async (scope, entries) => {
      expect(() =>
        verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId }),
      ).toThrow(/^calendar_recovery_check_unavailable$/);
      expect(fs.existsSync(scope.directory + '/calendar-state/empty')).toBe(false);
    });
  },
);
it.each(['forensic', 'calendar'])('refuses unlisted or changed %s payloads', async (kind) => {
  const f = fixture(),
    t = kind === 'forensic' ? forensic() : calendar(f);
  const prefix = kind === 'forensic' ? 'vault-journals' : 'calendar-state';
  await f.invoke({ ...t.files(), [prefix + '/foreign']: Buffer.from('UNSELECTED') }, async (scope, entries) => {
    const verify = () =>
      kind === 'forensic'
        ? verifyRecoveredForensicTree(scope, entries, 'vault-journals')
        : verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId });
    expect(verify).toThrow();
    entries.pop();
    entries[0].sha256 = 'c'.repeat(64);
    expect(verify).toThrow();
  });
});
it('refuses caller withdrawal and leaves current state untouched', async () => {
  const f = fixture(),
    t = calendar(f);
  await expect(
    f.invoke(t.files(), async (scope, entries) => {
      f.guard.mockImplementation(() => {
        throw Error('withdrawn');
      });
      expect(() =>
        verifyRecoveredCalendarState(scope, entries, { targetRoot: f.root, operationId: f.operationId }),
      ).toThrow(/^calendar_recovery_check_unavailable$/);
    }),
  ).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
});
