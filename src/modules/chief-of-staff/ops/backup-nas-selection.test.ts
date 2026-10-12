import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { publishBackupNasSelection, type BackupNasSelection } from './backup-nas-selection.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-selection-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const selection: BackupNasSelection = {
    contract: 'cos-backup-nas-selection/v1',
    targetDigest: 'a'.repeat(64),
    nas: {
      contract: 'cos-backup-nas-root-config/v1',
      host: '192.168.56.12',
      credentialReference: randomUUID(),
      vaultStateDigest: 'b'.repeat(64),
    },
  };
  return { root, selection, operationId: randomUUID(), check: vi.fn(async () => {}) };
}
it('publishes private destination metadata and preserves its original inode on replay', async () => {
  const f = fixture();
  await publishBackupNasSelection(f.root, f.selection, f.operationId, f.check);
  const file = path.join(f.root, 'backup-nas-selection.json'),
    before = fs.statSync(file);
  expect(before.mode & 0o777).toBe(0o600);
  expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(f.selection);
  await publishBackupNasSelection(f.root, f.selection, randomUUID(), f.check);
  expect(fs.statSync(file).ino).toBe(before.ino);
  expect(fs.readdirSync(f.root)).toEqual(['backup-nas-selection.json']);
});
it.each(['before-link', 'after-link'] as const)(
  'reconciles a lost %s acknowledgement without replacing the selected inode',
  async (point) => {
    const f = fixture(),
      link = fs.linkSync;
    const fault = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
      if (point === 'after-link') link(from, to);
      throw Error('SYNTHETIC_PUBLICATION_FAILURE');
    });
    await expect(publishBackupNasSelection(f.root, f.selection, f.operationId, f.check)).rejects.toThrow(
      'backup_nas_selection_unavailable',
    );
    fault.mockRestore();
    const stage = path.join(f.root, 'backup-nas-selection.' + f.operationId + '.partial'),
      inode = fs.statSync(stage).ino;
    await publishBackupNasSelection(f.root, f.selection, f.operationId, f.check);
    expect(fs.statSync(path.join(f.root, 'backup-nas-selection.json')).ino).toBe(inode);
    expect(fs.existsSync(stage)).toBe(false);
  },
);
it('preserves another destination and unrelated files rather than overwriting them', async () => {
  const f = fixture();
  await publishBackupNasSelection(f.root, f.selection, f.operationId, f.check);
  const before = fs.readFileSync(path.join(f.root, 'backup-nas-selection.json'));
  fs.writeFileSync(path.join(f.root, 'unrelated'), 'keep');
  await expect(
    publishBackupNasSelection(
      f.root,
      { ...f.selection, nas: { ...f.selection.nas, host: '192.168.56.13' } },
      randomUUID(),
      f.check,
    ),
  ).rejects.toThrow('backup_nas_selection_unavailable');
  expect(fs.readFileSync(path.join(f.root, 'backup-nas-selection.json'))).toEqual(before);
  expect(fs.readFileSync(path.join(f.root, 'unrelated'), 'utf8')).toBe('keep');
});
it('refuses linked, exposed or changed selection files', async () => {
  const f = fixture();
  await publishBackupNasSelection(f.root, f.selection, f.operationId, f.check);
  const file = path.join(f.root, 'backup-nas-selection.json');
  fs.chmodSync(file, 0o644);
  await expect(publishBackupNasSelection(f.root, f.selection, f.operationId, f.check)).rejects.toThrow(
    'backup_nas_selection_unavailable',
  );
  fs.chmodSync(file, 0o600);
  fs.linkSync(file, path.join(f.root, 'foreign-alias'));
  await expect(publishBackupNasSelection(f.root, f.selection, f.operationId, f.check)).rejects.toThrow(
    'backup_nas_selection_unavailable',
  );
  expect(fs.existsSync(path.join(f.root, 'foreign-alias'))).toBe(true);
});
it('withdrawn owner permission cannot publish or acknowledge configuration', async () => {
  const f = fixture();
  f.check.mockRejectedValue(Error('SYNTHETIC_PERMISSION_WITHDRAWN'));
  await expect(publishBackupNasSelection(f.root, f.selection, f.operationId, f.check)).rejects.toThrow(
    'backup_nas_selection_unavailable',
  );
  expect(fs.readdirSync(f.root)).toEqual([]);
});
it.each(['extra', 'secret', 'public-host', 'invalid-reference', 'invalid-digest'])(
  'rejects %s metadata before creating a file',
  async (reason) => {
    const f = fixture();
    const value = structuredClone(f.selection) as unknown as Record<string, unknown>;
    const nas = value.nas as Record<string, unknown>;
    if (reason === 'extra') value.path = '/mnt/foreign';
    if (reason === 'secret') nas.password = 'SYNTHETIC_SECRET';
    if (reason === 'public-host') nas.host = '8.8.8.8';
    if (reason === 'invalid-reference') nas.credentialReference = 'not-a-reference';
    if (reason === 'invalid-digest') value.targetDigest = 'not-a-digest';
    await expect(
      publishBackupNasSelection(f.root, value as unknown as BackupNasSelection, f.operationId, f.check),
    ).rejects.toThrow('backup_nas_selection_unavailable');
    expect(fs.readdirSync(f.root)).toEqual([]);
  },
);
