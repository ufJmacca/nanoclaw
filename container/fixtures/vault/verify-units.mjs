import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { vaultUnits } from '/code/modules/chief-of-staff/ops/vault-units.js';
import { createVaultUnitInstaller } from '/code/modules/chief-of-staff/ops/vault-unit-install.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { randomUUID } from 'node:crypto';
try {
  assert.equal(process.getuid(), 0);
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  const root = '/unit-fixture';
  assert.equal(fs.existsSync(root), false);
  fs.mkdirSync(root, { mode: 0o711 });
  const paths = { stateRoot: root + '/control', systemUnits: root + '/system', ownerUnits: root + '/owner' };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { mode: 0o700 });
  fs.chownSync(paths.ownerUnits, 1000, 1000);
  const input = {
    userId: 1000,
    service: 'nanoclaw-fixture.service',
    calendarRoot: '/home/fixture/.config/nanoclaw-cos/state/calendar',
  };
  const units = vaultUnits(input),
    names = Object.keys(units).filter((name) => name !== 'owner-service.conf');
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'f'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  let enabled = false;
  const installer = createVaultUnitInstaller(paths, input, identity, {
    assertAuthority: async () => {},
    assertMemory: verifyVaultMemory,
    run(tool, args) {
      // This fixture has no systemd manager. File effects and compilation are real; activation remains a target gate.
      if (tool === '/usr/bin/systemctl') {
        if (args[0] === 'is-enabled')
          return { status: enabled ? 0 : 1, output: names.map(() => (enabled ? 'enabled\n' : 'disabled\n')).join('') };
        if (args[0] === 'daemon-reload') return { status: 0, output: '' };
        assert.deepEqual(args, ['enable', '--no-reload', ...names]);
        const wants = paths.systemUnits + '/multi-user.target.wants';
        fs.mkdirSync(wants, { mode: 0o755 });
        for (const name of names) fs.symlinkSync('../' + name, wants + '/' + name);
        enabled = true;
        return { status: 0, output: '' };
      }
      assert.equal(tool, '/usr/bin/systemd-analyze');
      const result = spawnSync(tool, args, {
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
      return { status: result.status, output: result.stdout ?? '' };
    },
  });
  await installer.install();
  assert.equal(installer.inspect(), 'matching');
  const inode = fs.statSync(paths.systemUnits + '/nanoclaw-cos-vault.service').ino;
  await installer.install();
  assert.equal(fs.statSync(paths.systemUnits + '/nanoclaw-cos-vault.service').ino, inode);
  for (const name of names) {
    const file = paths.systemUnits + '/' + name,
      stat = fs.statSync(file);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o777, 0o644);
    assert.equal(fs.readFileSync(file, 'utf8'), units[name]);
  }
  console.log(
    '{"systemdUnitVerification":"passed","scope":"static_generated_units_and_owned_files","activation":"not_exercised"}',
  );
} catch {
  console.error('{"code":"vault_unit_fixture_unavailable"}');
  process.exitCode = 1;
}
