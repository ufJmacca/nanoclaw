import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const driver = fs.readFileSync(new URL('../../../../scripts/cos-mail-artifact-fixture.sh', import.meta.url));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-profile-'));
  roots.push(base);
  const primary = base + '/primary',
    secondary = base + '/worktree',
    bin = base + '/bin';
  fs.mkdirSync(primary + '/scripts', { recursive: true });
  fs.mkdirSync(bin);
  fs.writeFileSync(primary + '/scripts/cos-mail-artifact-fixture.sh', driver);
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
    'Synthetic driver',
  );
  const commit = git('rev-parse', 'HEAD');
  git('worktree', 'add', '--detach', secondary, commit);
  const state = primary + '/.cos-plan-state',
    selected = state + '/release-tests/release-' + commit.slice(0, 12) + '-20261029000000';
  fs.mkdirSync(selected, { recursive: true, mode: 0o700 });
  fs.symlinkSync(state, secondary + '/.cos-plan-state', 'dir');
  const profile = selected + '/test.env',
    ca = selected + '/ca.pem',
    reached = base + '/profile-validated';
  fs.writeFileSync(
    profile,
    [
      'COS_TEST_PGDATABASE',
      'COS_TEST_PGHOST',
      'COS_TEST_PGPASSWORD',
      'COS_TEST_PGPORT',
      'COS_TEST_PGSSLMODE',
      'COS_TEST_PGSSLROOTCERT',
      'COS_TEST_PGUSER',
      'COS_TEST_PG_MIGRATION_PASSWORD',
      'COS_TEST_PG_MIGRATION_USER',
      'COS_TEST_TARGET_ID',
    ]
      .map((k) => k + '=SYNTHETIC')
      .join('\n') + '\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(ca, 'SYNTHETIC_CERTIFICATE\n', { mode: 0o600 });
  const script = (name: string, body: string) =>
    fs.writeFileSync(bin + '/' + name, '#!/bin/bash\nset -euo pipefail\n' + body, { mode: 0o700 });
  script('uname', 'printf "Darwin\n"\n');
  script(
    'stat',
    'case "$2" in %Lp) exec /usr/bin/stat -c %a "$3";; %u) exec /usr/bin/stat -c %u "$3";; %l) exec /usr/bin/stat -c %h "$3";; %z) exec /usr/bin/stat -c %s "$3";; *) exit 1;; esac\n',
  );
  script(
    'docker',
    `[[ "$1" == image && "$2" == inspect ]] || exit 1
if [[ "$4" == *Architecture* ]]; then printf 'linux/arm64\\n'
elif [[ "$4" == *release-role* ]]; then [[ "\${5}" == "sha256:$(printf 'a%.0s' {1..64})" ]] && printf 'host\\n' || printf 'agent\\n'
elif [[ "$4" == *image.revision* ]]; then printf '%s\\n' "$SYNTHETIC_COMMIT"
elif [[ "$4" == *worker-assets* ]]; then printf 'c%.0s' {1..64}; printf '\\n'
else exit 1; fi
`,
  );
  script('uuidgen', 'touch "$SYNTHETIC_REACHED"\nexit 77\n');
  const run = (cwd: string, selectedProfile = profile, selectedCa = ca) =>
    spawnSync(
      'bash',
      [
        primary + '/scripts/cos-mail-artifact-fixture.sh',
        ...['a', 'b', 'd'].map((c) => 'sha256:' + c.repeat(64)),
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
          SYNTHETIC_COMMIT: commit,
          SYNTHETIC_REACHED: reached,
        },
      },
    );
  return { base, primary, secondary, profile, ca, reached, run };
}
it.each(['primary', 'secondary'] as const)('validates the same canonical profile from the %s source root', (root) => {
  const f = fixture();
  expect(f.run(f[root]).status).toBe(77);
  expect(fs.existsSync(f.reached)).toBe(true);
});
it.each(['alias', 'symlink', 'hardlink', 'permissions', 'wrong-certificate', 'retargeted-state'] as const)(
  'rejects %s before creating an artifact fixture',
  (kind) => {
    const f = fixture();
    let profile = f.profile,
      ca = f.ca;
    if (kind === 'alias') {
      profile = profile.replace(f.primary, f.secondary);
      ca = ca.replace(f.primary, f.secondary);
    }
    if (kind === 'symlink') {
      fs.renameSync(profile, profile + '.held');
      fs.symlinkSync(profile + '.held', profile);
    }
    if (kind === 'hardlink') fs.linkSync(profile, profile + '.held');
    if (kind === 'permissions') fs.chmodSync(profile, 0o644);
    if (kind === 'wrong-certificate') ca = f.base + '/other.pem';
    if (kind === 'retargeted-state') {
      const other = f.base + '/other';
      fs.mkdirSync(other + '/release-tests', { recursive: true });
      fs.unlinkSync(f.secondary + '/.cos-plan-state');
      fs.symlinkSync(other, f.secondary + '/.cos-plan-state', 'dir');
    }
    expect(f.run(f.secondary, profile, ca).status).toBe(1);
    expect(fs.existsSync(f.reached)).toBe(false);
  },
);
