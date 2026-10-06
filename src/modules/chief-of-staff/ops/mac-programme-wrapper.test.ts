import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function invoke(mode: 'pending' | 'verified' | 'ancestry-failed' | 'review-failed' | 'remote-failed') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-programme-wrapper-'));
  roots.push(root);
  const id = 'release-0123456789ab-20261006000000',
    state = path.join(root, '.cos-plan-state');
  const archive = path.join(state, 'releases', id),
    closure = path.join(state, 'programme-protection', id);
  for (const directory of [path.join(root, 'bin'), path.join(root, 'scripts'), archive, closure])
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.copyFileSync('scripts/cos-protect-programme.sh', path.join(root, 'scripts/cos-protect-programme.sh'));
  fs.writeFileSync(path.join(archive, 'release.json'), '{}', { mode: 0o600 });
  const stub = (name: string, text: string) =>
    fs.writeFileSync(path.join(root, 'bin', name), '#!/bin/bash\nset -eu\n' + text, { mode: 0o700 });
  stub('uname', 'echo Darwin\n');
  stub(
    'git',
    `case "$*" in
    'rev-parse --show-toplevel') echo "$COS_TEST_ROOT" ;;
    'remote get-url origin') echo https://github.com/ufJmacca/nanoclaw.git ;;
    'merge-base --is-ancestor '*) echo ancestry >> "$COS_TEST_LOG"; [[ "$COS_TEST_MODE" != ancestry-failed ]] ;;
    *) exit 31 ;;
  esac\n`,
  );
  stub(
    'docker',
    `[[ "$1" == exec ]]
    operation=$9; shift 9
    case "$operation" in
      references) [[ "$COS_TEST_MODE" != pending ]] || exit 0; printf '0\\thttps://github.com/ufJmacca/nanoclaw/pull/54\\t%040d\\n' 1 ;;
      verify-protection) echo artifact-check >> "$COS_TEST_LOG" ;;
      field) printf '%040d\\n' 2 ;;
      alias) echo fixture-pi ;;
      make) echo review-check >> "$COS_TEST_LOG"; [[ "$COS_TEST_MODE" != review-failed ]] || exit 32; printf '{}\\n' > "$COS_TEST_CLOSURE/proof.json"; echo verified ;;
      command) echo seal-programme ;;
      verify) echo verified-receipt >> "$COS_TEST_LOG"; echo protected ;;
      *) exit 33 ;;
    esac\n`,
  );
  stub('gh', `echo "gh:$1" >> "$COS_TEST_LOG"; if [[ "$1" == pr ]]; then echo '{"state":"MERGED"}'; fi\n`);
  stub(
    'ssh',
    `echo ssh >> "$COS_TEST_LOG"; cat > "$COS_TEST_CLOSURE/transferred-proof.json"; [[ "$COS_TEST_MODE" != remote-failed ]] || exit 34; echo '{"status":"protected"}'\n`,
  );
  const result = spawnSync(
    'bash',
    [path.join(root, 'scripts/cos-protect-programme.sh'), '--release-manifest', path.join(archive, 'release.json')],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: path.join(root, 'bin') + ':' + process.env.PATH,
        COS_DEVCONTAINER_ID: 'fixture',
        COS_TEST_ROOT: root,
        COS_TEST_MODE: mode,
        COS_TEST_LOG: path.join(root, 'calls'),
        COS_TEST_CLOSURE: closure,
      },
    },
  );
  return {
    root,
    closure,
    result,
    calls: fs.existsSync(path.join(root, 'calls'))
      ? fs.readFileSync(path.join(root, 'calls'), 'utf8').trim().split('\n')
      : [],
  };
}
it('pending human review performs no GitHub, ancestry or target mutation and does not claim closure', () => {
  const f = invoke('pending');
  expect(f.result.status, f.result.stderr).toBe(0);
  expect(f.calls).toEqual([]);
  expect(f.result.stdout).toContain('awaits');
  expect(f.result.stdout).not.toContain('confirmed');
});
it('eligible closure rechecks local artifacts, fresh host GH reviews and ancestry before transferring only the proof', () => {
  const f = invoke('verified');
  expect(f.result.status, f.result.stderr).toBe(0);
  expect(f.calls).toEqual([
    'artifact-check',
    'gh:auth',
    'gh:pr',
    'ancestry',
    'review-check',
    'ssh',
    'verified-receipt',
  ]);
  expect(fs.readFileSync(path.join(f.closure, 'transferred-proof.json'), 'utf8')).toBe('{}\n');
  expect(f.result.stdout).toContain('confirmed');
  expect(fs.existsSync(path.join(f.root, '.cos-plan-state/programme-protection.lock'))).toBe(false);
});
it.each(['ancestry-failed', 'review-failed'] as const)('%s does not contact the target', (mode) => {
  const f = invoke(mode);
  expect(f.result.status).not.toBe(0);
  expect(f.calls).not.toContain('ssh');
  expect(f.result.stdout).not.toContain('confirmed');
});
it('lost target contact cannot be recorded as verified protection', () => {
  const f = invoke('remote-failed');
  expect(f.result.status).not.toBe(0);
  expect(f.calls).toContain('ssh');
  expect(f.calls).not.toContain('verified-receipt');
  expect(f.result.stdout).not.toContain('confirmed');
});
