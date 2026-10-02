import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { backupMissionState, verifyMissionBackup } from './mission-backup.js';

const roots: string[] = [];
const attempt = '11111111-1111-4111-8111-111111111111';
const delegation = 'mission-delegation-' + 'a'.repeat(64) + '.json';
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mission-backup-'));
  roots.push(root);
  const source = path.join(root, 'state'),
    receipt = path.join(source, 'releases', 'candidate');
  fs.mkdirSync(receipt, { recursive: true, mode: 0o700 });
  const child = path.join(source, 'missions', attempt);
  for (const name of ['provider/sessions', 'context', 'control'])
    fs.mkdirSync(path.join(child, name), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(child, 'provider/sessions/history.jsonl'), 'SPECIALIST_HISTORY');
  fs.writeFileSync(path.join(child, 'provider/state.sqlite-wal'), 'QUIESCED_WAL');
  fs.writeFileSync(path.join(child, 'provider/auth.json'), 'ACCESS_SECRET');
  fs.writeFileSync(path.join(child, 'provider/.auth-interrupted'), 'ACCESS_SECRET');
  fs.writeFileSync(path.join(child, 'context/context.json'), 'ADMITTED_CONTEXT');
  fs.writeFileSync(path.join(child, 'control/capability'), 'VOLATILE_AUTHORITY');
  fs.mkdirSync(path.join(source, 'mission-purges'), { mode: 0o700 });
  fs.writeFileSync(path.join(source, 'mission-purges', attempt + '.json'), 'PURGE_RECEIPT');
  fs.writeFileSync(path.join(source, delegation), 'DELEGATION_RECORD');
  fs.writeFileSync(path.join(source, 'credentials.json'), 'MASTER_SECRET');
  return { source, receipt, child, copied: path.join(receipt, 'mission-backup/history') };
}
it('preserves specialist history, context, cleanup and delegation records without credentials or launch capabilities', async () => {
  const f = fixture();
  const result = await backupMissionState(f.source, f.receipt);
  expect(result.files).toBe(5);
  expect(fs.readdirSync(f.copied).sort()).toEqual([delegation, 'mission-purges', 'missions'].sort());
  const copied = path.join(f.copied, 'missions', attempt);
  expect(fs.readFileSync(path.join(copied, 'provider/sessions/history.jsonl'), 'utf8')).toBe('SPECIALIST_HISTORY');
  expect(fs.readFileSync(path.join(copied, 'provider/state.sqlite-wal'), 'utf8')).toBe('QUIESCED_WAL');
  expect(fs.readFileSync(path.join(copied, 'context/context.json'), 'utf8')).toBe('ADMITTED_CONTEXT');
  expect(fs.readFileSync(path.join(f.copied, 'mission-purges', attempt + '.json'), 'utf8')).toBe('PURGE_RECEIPT');
  expect(fs.readFileSync(path.join(f.copied, delegation), 'utf8')).toBe('DELEGATION_RECORD');
  expect(fs.readdirSync(path.join(copied, 'provider')).sort()).toEqual(['sessions', 'state.sqlite-wal']);
  expect(fs.existsSync(path.join(copied, 'control'))).toBe(false);
  expect(fs.statSync(path.join(copied, 'provider/sessions/history.jsonl')).mode & 0o777).toBe(0o600);
  expect(fs.statSync(path.join(copied, 'provider/sessions')).mode & 0o777).toBe(0o700);
  fs.appendFileSync(path.join(f.child, 'provider/sessions/history.jsonl'), 'LATER');
  await expect(backupMissionState(f.source, f.receipt)).resolves.toEqual(result);
  expect(fs.readFileSync(path.join(f.child, 'provider/auth.json'), 'utf8')).toBe('ACCESS_SECRET');
  fs.appendFileSync(path.join(copied, 'context/context.json'), 'CORRUPT');
  await expect(verifyMissionBackup(f.source, f.receipt)).rejects.toThrow('mission_backup_conflict');
});
it('accepts a first-installation baseline and partial allocation trees without inventing history', async () => {
  const f = fixture();
  fs.rmSync(path.join(f.source, 'missions'), { recursive: true });
  fs.rmSync(path.join(f.source, 'mission-purges'), { recursive: true });
  fs.unlinkSync(path.join(f.source, delegation));
  const result = await backupMissionState(f.source, f.receipt);
  expect(result.files).toBe(0);
  fs.mkdirSync(path.join(f.source, 'missions', attempt), { recursive: true, mode: 0o700 });
  await expect(backupMissionState(f.source, f.receipt)).resolves.toEqual(result);
  const next = path.join(f.source, 'releases', 'next');
  fs.mkdirSync(next, { mode: 0o700 });
  await expect(backupMissionState(f.source, next)).resolves.toMatchObject({ files: 0 });
});
it.each(['symlink', 'hardlink', 'writable', 'invalid-attempt', 'invalid-purge', 'foreign-child', 'credential-link'])(
  'refuses unsafe mission state before publishing a backup: %s',
  async (kind) => {
    const f = fixture();
    if (kind === 'symlink') fs.symlinkSync(f.receipt, path.join(f.child, 'provider/escape'));
    if (kind === 'hardlink')
      fs.linkSync(path.join(f.child, 'provider/auth.json'), path.join(f.child, 'provider/alias'));
    if (kind === 'writable') fs.chmodSync(path.join(f.child, 'context'), 0o777);
    if (kind === 'invalid-attempt') fs.mkdirSync(path.join(f.source, 'missions', 'foreign'));
    if (kind === 'invalid-purge') fs.writeFileSync(path.join(f.source, 'mission-purges', 'foreign'), 'bad');
    if (kind === 'foreign-child') fs.mkdirSync(path.join(f.child, 'unexpected'));
    if (kind === 'credential-link') {
      fs.unlinkSync(path.join(f.child, 'provider/auth.json'));
      fs.symlinkSync(path.join(f.source, 'credentials.json'), path.join(f.child, 'provider/auth.json'));
    }
    await expect(backupMissionState(f.source, f.receipt)).rejects.toThrow('unsafe_mission_backup');
    expect(fs.existsSync(path.join(f.receipt, 'mission-backup'))).toBe(false);
  },
);
it.each(['missions/' + attempt + '/provider/auth.json', 'credentials.json', 'missions/' + attempt + '/control'])(
  'rejects excluded material added to a published snapshot: %s',
  async (relative) => {
    const f = fixture();
    await backupMissionState(f.source, f.receipt);
    fs.writeFileSync(path.join(f.copied, relative), 'INJECTED', { mode: 0o600 });
    await expect(verifyMissionBackup(f.source, f.receipt)).rejects.toThrow();
  },
);
