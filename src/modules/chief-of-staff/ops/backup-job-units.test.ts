import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { DeploymentSettings } from './deployment-settings.js';
import { backupJobUnits } from './backup-job-units.js';
const settings: DeploymentSettings = {
  version: 1,
  target: 'pi',
  sshAlias: 'fixture',
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  userHome: '/home/pi',
  installationRoot: '/home/pi/app',
  dataRoot: '/home/pi/app/data',
  stateRoot: '/home/pi/state',
  releaseRoot: '/home/pi/releases',
  stagingRoot: '/home/pi/staging',
  sourceRoot: '/home/pi/sources',
  runtimeEnvironment: '/home/pi/.config/runtime',
  migrationEnvironment: '/home/pi/.config/migration',
};
const input = { settings, settingsPath: '/home/pi/.config/nanoclaw-cos/target.json', releaseId: 'release-fixture' };
it('the actual Linux unit compiler accepts all four fixed user units', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-unit-'));
  try {
    const files = backupJobUnits(input).map((unit) => {
      const file = path.join(directory, unit.name);
      fs.writeFileSync(file, unit.contents, { mode: 0o600 });
      return file;
    });
    expect(() =>
      execFileSync('/usr/bin/systemd-analyze', ['--user', 'verify', '--man=no', ...files], {
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', HOME: directory, XDG_RUNTIME_DIR: directory },
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 10000,
      }),
    ).not.toThrow();
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
it('defines only independent fixed user jobs with private output, no swap or core dumps, bounded lifetime and persistent timers', () => {
  const units = backupJobUnits(input);
  expect(units.map((unit) => unit.name).sort()).toEqual([
    'nanoclaw-cos-backup-capture.service',
    'nanoclaw-cos-backup-capture.timer',
    'nanoclaw-cos-backup-upload.service',
    'nanoclaw-cos-backup-upload.timer',
  ]);
  for (const unit of units.filter((item) => item.name.endsWith('.service'))) {
    expect(unit.contents).toContain('LimitCORE=0');
    expect(unit.contents).toContain('MemorySwapMax=0');
    expect(unit.contents).toContain('UMask=0077');
    expect(unit.contents).toContain('KillMode=control-group');
    expect(unit.contents).toContain('StandardOutput=null');
    expect(unit.contents).toContain('StandardError=null');
    expect(unit.contents).toContain('/usr/bin/env -i');
    expect(unit.contents).toContain('/home/pi/releases/release-fixture/payload/node/bin/node');
    expect(unit.contents).toContain(
      '/home/pi/releases/release-fixture/payload/dist/modules/chief-of-staff/ops/backup-schedule.js',
    );
    expect(unit.contents).not.toMatch(/EnvironmentFile|Password|COS_PG|Requires=|BindsTo=|fixture.service|sudo/);
  }
  for (const unit of units.filter((item) => item.name.endsWith('.timer'))) {
    expect(unit.contents).toContain('Persistent=true');
    expect(unit.contents).toContain('WantedBy=timers.target');
  }
});
it.each([
  ['capture', '2026-04-04 00:00:00 UTC', 'Sat 2026-04-04 17:30:00 UTC'],
  ['capture', '2026-10-03 00:00:00 UTC', 'Sat 2026-10-03 16:30:00 UTC'],
  ['upload', '2026-10-03 00:01:00 UTC', 'Sat 2026-10-03 01:00:00 UTC'],
])('the actual Linux scheduler resolves %s correctly at base time %s', (job, base, expected) => {
  const unit = backupJobUnits(input).find((item) => item.name === `nanoclaw-cos-backup-${job}.timer`)!;
  const expression = unit.contents.match(/^OnCalendar=(.+)$/m)![1];
  const output = execFileSync(
    '/usr/bin/systemd-analyze',
    ['calendar', '--base-time=' + base, '--iterations=2', expression],
    { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', TZ: 'UTC' }, timeout: 5000 },
  );
  expect(output).toContain(expected);
});
it('refuses unit injection, foreign settings paths and mutable release aliases', () => {
  for (const changed of [
    { ...input, settingsPath: '/mnt/foreign/settings.json' },
    { ...input, settingsPath: input.settingsPath + '%n' },
    { ...input, releaseId: 'latest' },
    { ...input, releaseId: 'release-x\nExecStart=/bin/sh' },
    { ...input, command: '/bin/sh' },
  ])
    expect(() => backupJobUnits(changed)).toThrow('backup_job_units_unavailable');
});
