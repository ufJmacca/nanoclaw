import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
import { readPrivate } from './target-state.js';
import { createBackupJobInstaller } from './backup-job-install.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-job-install-'));
  roots.push(home);
  fs.chmodSync(home, 0o700);
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    userHome: home,
    installationRoot: home + '/app',
    dataRoot: home + '/app/data',
    stateRoot: home + '/state',
    releaseRoot: home + '/releases',
    stagingRoot: home + '/staging',
    sourceRoot: home + '/sources',
    runtimeEnvironment: home + '/.config/runtime',
    migrationEnvironment: home + '/.config/migration',
  };
  const config = home + '/.config/nanoclaw-cos',
    units = home + '/.config/systemd/user';
  for (const root of [config, units, settings.stateRoot]) fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const manifest = fixtureVaultRelease('G02'),
    events: string[] = [];
  const manager = { owned: true, jobsIdle: true, timersActive: false, timersRunning: false, definitionsLoaded: true };
  const controls = {
    assertCurrent: vi.fn(async () => {}),
    inspectManager: vi.fn(async () => ({ ...manager })),
    compile: vi.fn(async (_files: readonly string[]) => {
      events.push('compile');
    }),
    stopTimers: vi.fn(async () => {
      events.push('stop-timers');
      manager.timersActive = manager.timersRunning = false;
    }),
    reload: vi.fn(async () => {
      events.push('reload');
    }),
    enableTimers: vi.fn(async () => {
      events.push('enable');
    }),
    startTimers: vi.fn(async () => {
      events.push('start-timers');
      manager.timersActive = manager.timersRunning = true;
    }),
  };
  const installer = createBackupJobInstaller(settings, manifest, controls);
  return { home, settings, config, units, manifest, controls, installer, events, manager };
}
it('publishes only the private settings and four fixed units before compile/reload/enable, then activates separately', async () => {
  const f = fixture();
  fs.writeFileSync(f.units + '/unrelated.service', 'unrelated');
  const installed = await f.installer.install();
  expect(installed).toMatchObject({ status: 'backup_jobs_enabled', releaseId: f.manifest.releaseId });
  expect(f.events).toEqual(['compile', 'reload', 'enable']);
  expect(f.controls.startTimers).not.toHaveBeenCalled();
  expect(fs.readFileSync(f.units + '/unrelated.service', 'utf8')).toBe('unrelated');
  const profile = f.config + '/backup-jobs-target.json';
  expect(readPrivate(profile)).toEqual(f.settings);
  expect(fs.statSync(profile).mode & 0o777).toBe(0o600);
  for (const file of fs.readdirSync(f.units).filter((name) => name.startsWith('nanoclaw-cos-backup-'))) {
    expect(fs.statSync(f.units + '/' + file).mode & 0o777).toBe(0o600);
    if (file.endsWith('.service')) expect(fs.readFileSync(f.units + '/' + file, 'utf8')).toContain(profile);
  }
  await expect(f.installer.activate()).resolves.toMatchObject({ status: 'backup_jobs_active' });
  expect(f.events.at(-1)).toBe('start-timers');
});
it('reuses matching files and can finish a failed manager reload without rewriting them', async () => {
  const f = fixture();
  f.controls.reload.mockRejectedValueOnce(Error('PRIVATE_MANAGER_ERROR'));
  await expect(f.installer.install()).rejects.toThrow(/^backup_job_installation_unavailable$/);
  const file = f.units + '/nanoclaw-cos-backup-upload.service',
    inode = fs.statSync(file).ino;
  await f.installer.install();
  expect(fs.statSync(file).ino).toBe(inode);
  expect(f.controls.enableTimers).toHaveBeenCalledOnce();
});
it('upgrades only its recorded files after stopping its owned idle timers', async () => {
  const f = fixture();
  await f.installer.install();
  f.manager.timersActive = f.manager.timersRunning = true;
  const next = { ...f.manifest, releaseId: 'release-next' };
  await createBackupJobInstaller(f.settings, next, f.controls).install();
  expect(f.controls.stopTimers).toHaveBeenCalledOnce();
  expect(fs.readFileSync(f.units + '/nanoclaw-cos-backup-upload.service', 'utf8')).toContain('/release-next/payload/');
});
it.each(['unit', 'settings', 'changed', 'linked', 'directory', 'dropin', 'manager', 'running'] as const)(
  'refuses %s conflicts without replacing their bytes or enabling timers',
  async (reason) => {
    const f = fixture(),
      unit = f.units + '/nanoclaw-cos-backup-upload.service',
      profile = f.config + '/backup-jobs-target.json';
    if (reason === 'unit' || reason === 'settings')
      fs.writeFileSync(reason === 'unit' ? unit : profile, 'foreign', { mode: 0o600 });
    if (['changed', 'linked'].includes(reason)) {
      await f.installer.install();
      f.controls.enableTimers.mockClear();
      if (reason === 'changed') fs.writeFileSync(unit, 'changed');
      else fs.linkSync(unit, f.home + '/alias');
    }
    if (reason === 'directory') {
      fs.renameSync(f.units, f.units + '-original');
      fs.symlinkSync(f.units + '-original', f.units);
    }
    if (reason === 'dropin') fs.mkdirSync(unit + '.d');
    if (reason === 'manager') f.manager.owned = false;
    if (reason === 'running') f.manager.jobsIdle = false;
    const before = fs.existsSync(unit) ? fs.readFileSync(unit) : null;
    await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
    if (before) expect(fs.readFileSync(unit).equals(before)).toBe(true);
    expect(f.controls.enableTimers).not.toHaveBeenCalled();
  },
);
it('requires live authority again after an awaited compiler and preserves the prepared installation on failure', async () => {
  const f = fixture();
  let current = true;
  f.controls.assertCurrent.mockImplementation(async () => {
    if (!current) throw Error('closed');
  });
  f.controls.compile.mockImplementation(async () => {
    current = false;
  });
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  expect(f.controls.reload).not.toHaveBeenCalled();
  expect(f.controls.enableTimers).not.toHaveBeenCalled();
  expect(readPrivate(f.settings.stateRoot + '/backup-job-installation.json')).toMatchObject({ phase: 'published' });
});
it('stops a partially active timer set and verifies it is stopped before replacing definitions', async () => {
  const f = fixture();
  await f.installer.install();
  f.manager.timersRunning = true;
  await createBackupJobInstaller(f.settings, { ...f.manifest, releaseId: 'release-next' }, f.controls).install();
  expect(f.controls.stopTimers).toHaveBeenCalledOnce();
  f.manager.timersRunning = true;
  f.controls.stopTimers.mockImplementation(async () => {});
  const file = f.units + '/nanoclaw-cos-backup-upload.service',
    before = fs.readFileSync(file);
  await expect(
    createBackupJobInstaller(f.settings, { ...f.manifest, releaseId: 'release-third' }, f.controls).install(),
  ).rejects.toThrow('backup_job_installation_unavailable');
  expect(fs.readFileSync(file).equals(before)).toBe(true);
});
it('requires loaded manager definitions before enabling or activating', async () => {
  const f = fixture();
  f.manager.definitionsLoaded = false;
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  expect(f.controls.enableTimers).not.toHaveBeenCalled();
  f.manager.definitionsLoaded = true;
  await f.installer.install();
  f.manager.definitionsLoaded = false;
  await expect(f.installer.activate()).rejects.toThrow('backup_job_installation_unavailable');
  expect(f.controls.startTimers).not.toHaveBeenCalled();
});
it('preserves unclaimed enablement links and rejects changed destinations on an owned installation', async () => {
  const f = fixture(),
    wants = f.units + '/timers.target.wants',
    name = 'nanoclaw-cos-backup-upload.timer';
  fs.mkdirSync(wants, { mode: 0o700 });
  fs.symlinkSync('../' + name, wants + '/' + name);
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  expect(fs.readlinkSync(wants + '/' + name)).toBe('../' + name);
  fs.unlinkSync(wants + '/' + name);
  await f.installer.install();
  fs.symlinkSync('../' + name, wants + '/' + name);
  await f.installer.install();
  fs.unlinkSync(wants + '/' + name);
  fs.symlinkSync('/tmp/foreign.timer', wants + '/' + name);
  f.controls.enableTimers.mockClear();
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  expect(f.controls.enableTimers).not.toHaveBeenCalled();
  expect(fs.readlinkSync(wants + '/' + name)).toBe('/tmp/foreign.timer');
});
it('resumes a recorded file publication after rename without adopting a different inode with matching bytes', async () => {
  const f = fixture(),
    rename = fs.renameSync;
  let failed = false;
  const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    rename(from, to);
    if (!failed && String(to).endsWith('/nanoclaw-cos-backup-upload.service')) {
      failed = true;
      throw Error('lost publication result');
    }
  });
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  fault.mockRestore();
  const file = f.units + '/nanoclaw-cos-backup-upload.service',
    inode = fs.statSync(file).ino;
  await f.installer.install();
  expect(fs.statSync(file).ino).toBe(inode);
  fs.renameSync(file, file + '-previous');
  fs.copyFileSync(file + '-previous', file);
  fs.chmodSync(file, 0o600);
  await expect(f.installer.install()).rejects.toThrow('backup_job_installation_unavailable');
  expect(fs.statSync(file).ino).not.toBe(inode);
});
