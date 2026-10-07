import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { vaultUnits } from '/code/modules/chief-of-staff/ops/vault-units.js';
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  const root = '/unit-fixture';
  assert.equal(fs.existsSync(root), false);
  fs.mkdirSync(root, { mode: 0o700 });
  const units = vaultUnits({
    userId: 1000,
    service: 'nanoclaw-fixture.service',
    calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
  });
  const files = [];
  for (const [name, text] of Object.entries(units)) {
    if (name === 'owner-service.conf') continue;
    fs.writeFileSync(root + '/' + name, text, { flag: 'wx', mode: 0o644 });
    files.push(root + '/' + name);
  }
  const result = spawnSync('/usr/bin/systemd-analyze', ['verify', '--man=no', ...files], {
    cwd: '/',
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 15000,
    maxBuffer: 65536,
  });
  if (result.error || result.signal || result.status !== 0) {
    // These files contain only synthetic paths and fixed OS commands; no credentials or live configuration.
    process.stderr.write(result.stderr ?? '');
    throw Error('unit fixture unavailable');
  }
  console.log('{"systemdUnitVerification":"passed","scope":"static_generated_units"}');
} catch {
  console.error('{"code":"vault_unit_fixture_unavailable"}');
  process.exitCode = 1;
}
