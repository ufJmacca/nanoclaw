import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { backupNativeDatabase, installServiceOverride, restoreServiceOverride } from './native-installation.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-native-'));
  roots.push(root);
  return root;
}
it('backs up committed WAL contents consistently without changing the live database', async () => {
  const root = fixture(),
    source = path.join(root, 'v2.db'),
    destination = path.join(root, 'backup');
  fs.mkdirSync(destination, { mode: 0o700 });
  const live = new Database(source);
  live.pragma('journal_mode=WAL');
  live.pragma('wal_autocheckpoint=0');
  live.exec("CREATE TABLE messages(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO messages VALUES(1,'preserved');");
  try {
    const wal = fs.readFileSync(source + '-wal');
    const result = await backupNativeDatabase(source, destination);
    const copy = new Database(result.file, { readonly: true });
    try {
      expect(copy.prepare('SELECT body FROM messages').get()).toEqual({ body: 'preserved' });
    } finally {
      copy.close();
    }
    expect(fs.readdirSync(destination).sort()).toEqual(['native-backup.json', 'native.sqlite']);
    expect(live.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(fs.readFileSync(source + '-wal')).toEqual(wal);
    live.exec("INSERT INTO messages VALUES(2,'new arrival')");
    expect(live.prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 2 });
    expect(fs.statSync(result.file).mode & 0o777).toBe(0o600);
    await expect(backupNativeDatabase(source, destination)).resolves.toEqual(result);
    fs.appendFileSync(result.file, 'corrupt');
    await expect(backupNativeDatabase(source, destination)).rejects.toThrow('native_backup_conflict');
  } finally {
    live.close();
  }
});
it('atomically changes only its service override, preserves cwd and restores the previous bytes', () => {
  const root = fixture(),
    config = path.join(root, 'systemd'),
    receipt = path.join(root, 'receipt');
  fs.mkdirSync(config, { mode: 0o700 });
  fs.mkdirSync(receipt, { mode: 0o700 });
  const service = 'nanoclaw.service',
    folder = path.join(config, service + '.d');
  fs.mkdirSync(folder);
  fs.writeFileSync(path.join(folder, '20-existing.conf'), '[Service]\nRestart=always\n');
  const request = {
    configurationRoot: config,
    receiptRoot: receipt,
    service,
    installationRoot: '/home/pi/nanoclaw-v2',
    payloadRoot: '/home/pi/releases/release-test/payload',
    manifest: '/home/pi/releases/release-test/release.json',
    stateRoot: '/home/pi/state',
    runtimeEnvironment: '/home/pi/.config/cos/runtime.env',
  };
  const installed = installServiceOverride(request);
  const content = fs.readFileSync(installed.file, 'utf8');
  expect(content).toContain('WorkingDirectory=/home/pi/nanoclaw-v2');
  expect(content).toContain('ExecStart=\nExecStart=/home/pi/releases/release-test/payload/node/bin/node');
  expect(content).toContain('EnvironmentFile=/home/pi/.config/cos/runtime.env');
  expect(installServiceOverride(request)).toEqual(installed);
  restoreServiceOverride(request);
  expect(fs.existsSync(installed.file)).toBe(false);
  expect(fs.readFileSync(path.join(folder, '20-existing.conf'), 'utf8')).toContain('Restart=always');
  restoreServiceOverride(request);
});
it('refuses changed service configuration and symlinked backup targets', async () => {
  const root = fixture(),
    source = path.join(root, 'v2.db'),
    outside = path.join(root, 'outside');
  const db = new Database(source);
  db.exec('CREATE TABLE keep(id)');
  db.close();
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, 'link'));
  await expect(backupNativeDatabase(source, path.join(root, 'link'))).rejects.toThrow();
  const receipt = path.join(root, 'receipt'),
    config = path.join(root, 'systemd');
  fs.mkdirSync(receipt);
  fs.mkdirSync(config);
  const request = {
    configurationRoot: config,
    receiptRoot: receipt,
    service: 'nano.service',
    installationRoot: '/home/pi/nano',
    payloadRoot: '/home/pi/payload',
    manifest: '/home/pi/release.json',
    stateRoot: '/home/pi/state',
    runtimeEnvironment: '/home/pi/.config/runtime.env',
  };
  const installed = installServiceOverride(request);
  fs.writeFileSync(installed.file, 'foreign changes');
  expect(() => restoreServiceOverride(request)).toThrow('service_override_conflict');
  expect(() => installServiceOverride(request)).toThrow('service_override_conflict');
  expect(fs.readFileSync(installed.file, 'utf8')).toBe('foreign changes');
});
