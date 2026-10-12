import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});
const keys = [
  'COS_TEST_PGHOST',
  'COS_TEST_PGPORT',
  'COS_TEST_PGDATABASE',
  'COS_TEST_PGUSER',
  'COS_TEST_PGPASSWORD',
  'COS_TEST_PGSSLMODE',
  'COS_TEST_PGSSLROOTCERT',
  'COS_TEST_TARGET_ID',
  'COS_TEST_PG_MIGRATION_USER',
  'COS_TEST_PG_MIGRATION_PASSWORD',
];
function guard(selected: string[]) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-capture-keys-'));
  folders.push(directory);
  fs.chmodSync(directory, 0o700);
  const file = directory + '/test.env';
  fs.writeFileSync(file, selected.map((key) => key + '=SYNTHETIC_PRIVATE_VALUE\n').join(''), { mode: 0o600 });
  const source = fs.readFileSync(new URL('../../../../scripts/cos-vault-fixture.sh', import.meta.url), 'utf8');
  const begin = source.indexOf('  keys=$(cut -d= -f1 "$4"'),
    end = source.indexOf('\n  fixture_network=bridge', begin);
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  // Exercise the actual driver guard in Linux; no Docker, Keychain, credential
  // reading, networking or privileged fixture effect runs in this source test.
  const result = spawnSync(
    '/bin/bash',
    ['-c', 'set -euo pipefail\n' + source.slice(begin, end), 'capture-key-guard', 'mode', 'image', 'keychain', file],
    { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stdout.length).toBe(0);
  expect(result.stderr.length).toBe(0);
  return result.status;
}
it('the encrypted capture driver accepts every required test-profile key in arbitrary file order', () => {
  expect(guard(keys)).toBe(0);
  expect(guard([...keys].reverse())).toBe(0);
});
it.each(['missing', 'duplicate', 'runtime', 'override', 'wrong-migration-key'] as const)(
  'the encrypted capture driver refuses %s input fields',
  (reason) => {
    let selected = [...keys];
    if (reason === 'missing') selected = selected.filter((key) => key !== 'COS_TEST_PG_MIGRATION_PASSWORD');
    if (reason === 'duplicate') selected.push('COS_TEST_PGHOST');
    if (reason === 'runtime') selected.push('COS_PGPASSWORD');
    if (reason === 'override') selected.push('DOCKER_HOST');
    if (reason === 'wrong-migration-key')
      selected = selected.map((key) => (key === 'COS_TEST_PG_MIGRATION_USER' ? 'COS_TEST_PGMIGRATION_USER' : key));
    expect(guard(selected)).toBe(1);
  },
);
