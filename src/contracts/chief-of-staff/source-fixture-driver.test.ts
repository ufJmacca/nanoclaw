import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const image = 'sha256:' + 'a'.repeat(64);
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-fixture-driver-'));
  roots.push(root);
  const source = root + '/context',
    input = root + '/backup-artifact-input',
    log = root + '/docker.jsonl';
  fs.mkdirSync(source, { mode: 0o700 });
  fs.writeFileSync(source + '/build-info.json', '{}');
  fs.mkdirSync(input, { mode: 0o700 });
  fs.writeFileSync(input + '/restic', 'public test executable', { mode: 0o555 });
  fs.writeFileSync(input + '/artifact.json', '{}', { mode: 0o444 });
  fs.writeFileSync(root + '/private-credentials', 'NEVER_MOUNT_THIS_PARENT');
  fs.mkdirSync(root + '/bin');
  fs.writeFileSync(
    root + '/bin/docker',
    `#!${process.execPath}
const fs=require('node:fs'), a=process.argv.slice(2);
fs.appendFileSync(process.env.DRIVER_TEST_LOG,JSON.stringify(a)+'\\n');
if(a[0]==='inspect') console.log(a[2].includes('.Image')?'${image}':'fixture-dependencies');
else if(a[0]==='volume'&&a[1]==='inspect') console.log(a[3].includes('.Mountpoint')?'/var/lib/docker/volumes/synthetic/_data':'fixture-owner');
`,
    { mode: 0o755 },
  );
  const run = (slice?: string) =>
    spawnSync(
      '/bin/bash',
      [
        '-euc',
        'source "$1"; shift; prepare_source_fixture "$@" || exit; printf "%s\\0" "${source_fixture_driver[@]}"',
        'fixture',
        path.resolve('scripts/cos-source-fixture.sh'),
        'fixture-dev',
        'fixture-owner',
        source,
        image,
        'fixture-runner',
        ...(slice === undefined ? [] : [slice]),
      ],
      {
        encoding: 'utf8',
        env: { PATH: root + '/bin:/usr/bin:/bin', DRIVER_TEST_LOG: log, PRIVATE_TEST_CANARY: 'never-forward' },
      },
    );
  return { root, source, input, log, run };
}
it('adds only the fixed public backup input as a read-only mount for G02 source tests', () => {
  const f = fixture(),
    result = f.run('G02');
  expect(result.status).toBe(0);
  const args = result.stdout.split('\0').filter(Boolean);
  expect(args).toContain(`type=bind,src=${f.input},dst=/backup-artifact,readonly`);
  expect(args).toContain('COS_BACKUP_FIXTURE_BINARY=/backup-artifact/restic');
  expect(args.some((value) => value.includes('private-credentials') || value.includes('PRIVATE_TEST_CANARY'))).toBe(
    false,
  );
  expect(args).not.toContain(`type=bind,src=${f.root},dst=/backup-artifact,readonly`);
});
it('preserves ordinary source fixtures without mounting any backup input', () => {
  const result = fixture().run();
  expect(result.status).toBe(0);
  expect(result.stdout).not.toContain('backup-artifact');
  expect(result.stdout).not.toContain('COS_BACKUP_FIXTURE_BINARY');
});
it.each(['missing', 'directory-alias', 'binary-alias', 'seal-alias', 'future-slice'])(
  'refuses %s backup selections before creating Docker resources',
  (reason) => {
    const f = fixture();
    if (reason === 'missing') fs.rmSync(f.input, { recursive: true });
    if (reason === 'directory-alias') {
      fs.renameSync(f.input, f.root + '/retained');
      fs.symlinkSync(f.root + '/retained', f.input);
    }
    for (const [condition, name] of [
      ['binary-alias', 'restic'],
      ['seal-alias', 'artifact.json'],
    ])
      if (reason === condition) {
        fs.renameSync(f.input + '/' + name, f.root + '/retained');
        fs.symlinkSync(f.root + '/retained', f.input + '/' + name);
      }
    const result = f.run(reason === 'future-slice' ? 'G03' : 'G02');
    expect(result.status).toBe(1);
    expect(fs.existsSync(f.log)).toBe(false);
    expect(fs.readFileSync(f.root + '/private-credentials', 'utf8')).toBe('NEVER_MOUNT_THIS_PARENT');
  },
);
