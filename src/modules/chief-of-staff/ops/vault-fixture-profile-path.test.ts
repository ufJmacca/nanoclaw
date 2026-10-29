import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const driverSource = fs.readFileSync(new URL('../../../../scripts/cos-vault-fixture.sh', import.meta.url));
const keychainSource = fs.readFileSync(new URL('../../../../scripts/cos-vault-keychain.swift', import.meta.url));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-profile-path-'));
  cleanup.push(base);
  const primary = base + '/primary',
    secondary = base + '/worktree',
    bin = base + '/bin';
  for (const root of [primary, bin, primary + '/scripts']) fs.mkdirSync(root, { mode: 0o700 });
  fs.writeFileSync(primary + '/scripts/cos-vault-fixture.sh', driverSource);
  fs.writeFileSync(primary + '/scripts/cos-vault-keychain.swift', keychainSource);
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: primary, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git('add', 'scripts');
  git(
    '-c',
    'core.hooksPath=/dev/null',
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '-qm',
    'Synthetic fixture driver',
  );
  const commit = git('rev-parse', 'HEAD');
  git('worktree', 'add', '--detach', secondary, commit);
  const state = primary + '/.cos-plan-state',
    release = 'release-' + commit.slice(0, 12) + '-20261029000000',
    selected = state + '/release-tests/' + release;
  fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  fs.symlinkSync(state, secondary + '/.cos-plan-state', 'dir');
  const profile = selected + '/test.env',
    ca = selected + '/ca.pem',
    log = base + '/docker-arguments',
    streamed = base + '/keychain-called';
  fs.writeFileSync(
    profile,
    [
      'COS_TEST_PGDATABASE=synthetic',
      'COS_TEST_PGHOST=synthetic',
      'COS_TEST_PGPASSWORD=SYNTHETIC_PASSWORD',
      'COS_TEST_PGPORT=5432',
      'COS_TEST_PGSSLMODE=verify-full',
      'COS_TEST_PGSSLROOTCERT=/selected-ca.pem',
      'COS_TEST_PGUSER=synthetic',
      'COS_TEST_PG_MIGRATION_PASSWORD=SYNTHETIC_MIGRATION',
      'COS_TEST_PG_MIGRATION_USER=synthetic',
      'COS_TEST_TARGET_ID=synthetic',
      '',
    ].join('\n'),
    { mode: 0o600 },
  );
  fs.writeFileSync(ca, 'SYNTHETIC_CERTIFICATE\n', { mode: 0o600 });
  const script = (name: string, body: string) =>
    fs.writeFileSync(bin + '/' + name, '#!/bin/bash\nset -euo pipefail\n' + body, { mode: 0o700 });
  script('uname', 'printf "Darwin\\n"\n');
  script(
    'stat',
    String.raw`case "$2" in
  %Lp) exec /usr/bin/stat -c %a "$3" ;;
  %u) exec /usr/bin/stat -c %u "$3" ;;
  %l) exec /usr/bin/stat -c %h "$3" ;;
  %z) exec /usr/bin/stat -c %s "$3" ;;
  *) exit 1 ;;
esac
`,
  );
  script('swift', 'touch "$SYNTHETIC_KEYCHAIN_CALLED"\nprintf synthetic_key_stream\n');
  script(
    'docker',
    String.raw`if [[ "$1" == image && "$2" == inspect ]]; then
  if [[ "$4" == *release-role* ]]; then printf 'vault-fixture\n'
  elif [[ "$4" == *image.revision* ]]; then printf '%s\n' "$SYNTHETIC_SOURCE_COMMIT"
  elif [[ "$4" == *Architecture* ]]; then printf 'linux/arm64\n'
  else exit 1; fi
elif [[ "$1" == run && "$*" == *device-mapper* ]]; then
  printf '252\n'
elif [[ "$1" == run ]]; then
  printf '%s\n' "$@" > "$SYNTHETIC_DOCKER_ARGUMENTS"
  cat >/dev/null
  printf '{"syntheticFixture":"passed"}\n'
else exit 1; fi
`,
  );
  const run = (cwd: string, selectedProfile = profile, selectedCa = ca) =>
    spawnSync(
      'bash',
      [
        primary + '/scripts/cos-vault-fixture.sh',
        'backup-capture-kernel',
        'sha256:' + 'b'.repeat(64),
        primary + '/scripts/cos-vault-keychain.swift',
        selectedProfile,
        selectedCa,
      ],
      {
        cwd,
        encoding: 'utf8',
        timeout: 10000,
        env: {
          PATH: bin + ':' + process.env.PATH,
          HOME: process.env.HOME,
          HUSKY: '0',
          SYNTHETIC_SOURCE_COMMIT: commit,
          SYNTHETIC_DOCKER_ARGUMENTS: log,
          SYNTHETIC_KEYCHAIN_CALLED: streamed,
        },
      },
    );
  return { base, primary, secondary, profile, ca, log, streamed, run, selected, release };
}
it('accepts a canonical selected profile in the primary repository', () => {
  const f = fixture(),
    result = f.run(f.primary);
  expect(result.status).toBe(0);
  expect(fs.existsSync(f.streamed)).toBe(true);
  expect(fs.readFileSync(f.log, 'utf8')).toContain(f.profile);
  expect(result.stdout + result.stderr).not.toContain('SYNTHETIC_PASSWORD');
});
it('accepts that same physical profile from an isolated worktree sharing the private state root', () => {
  const f = fixture(),
    result = f.run(f.secondary);
  expect(result.status).toBe(0);
  expect(fs.existsSync(f.streamed)).toBe(true);
  expect(fs.readFileSync(f.log, 'utf8')).toContain(f.profile);
});
it('keeps an alias profile path closed even when it resolves to the selected file', () => {
  const f = fixture(),
    profile = f.secondary + '/.cos-plan-state/release-tests/' + f.release + '/test.env';
  expect(f.run(f.secondary, profile, path.dirname(profile) + '/ca.pem').status).toBe(1);
  expect(fs.existsSync(f.streamed)).toBe(false);
});
it.each(['symlink', 'hardlink', 'permissions', 'foreign-directory', 'wrong-certificate', 'retargeted-state'] as const)(
  'rejects an unsafe selected profile before streaming a key: %s',
  (kind) => {
    const f = fixture();
    let profile = f.profile,
      ca = f.ca;
    if (kind === 'symlink') {
      fs.renameSync(profile, profile + '.held');
      fs.symlinkSync(profile + '.held', profile);
    }
    if (kind === 'hardlink') fs.linkSync(profile, profile + '.held');
    if (kind === 'permissions') fs.chmodSync(profile, 0o644);
    if (kind === 'foreign-directory') {
      const foreign = f.base + '/foreign';
      fs.mkdirSync(foreign, { mode: 0o700 });
      fs.copyFileSync(profile, foreign + '/test.env');
      fs.copyFileSync(ca, foreign + '/ca.pem');
      profile = foreign + '/test.env';
      ca = foreign + '/ca.pem';
    }
    if (kind === 'wrong-certificate') ca = f.base + '/other.pem';
    if (kind === 'retargeted-state') {
      const other = f.base + '/other';
      fs.mkdirSync(other + '/release-tests', { recursive: true, mode: 0o700 });
      fs.unlinkSync(f.secondary + '/.cos-plan-state');
      fs.symlinkSync(other, f.secondary + '/.cos-plan-state', 'dir');
    }
    expect(f.run(f.secondary, profile, ca).status).toBe(1);
    expect(fs.existsSync(f.streamed)).toBe(false);
  },
);
