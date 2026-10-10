import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function invoke(recovery: boolean, failCommand = 0, slice = 'S11') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-deploy-wrapper-'));
  temporary.push(root);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'scripts'));
  const id = 'release-0123456789ab-20260930000000';
  const directory = path.join(root, '.cos-plan-state/releases', id);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'release.json'), '{}');
  fs.copyFileSync('scripts/cos-deploy.sh', path.join(root, 'scripts/cos-deploy.sh'));
  const script = (file: string, body: string) =>
    fs.writeFileSync(file, '#!/bin/bash\nset -eu\n' + body, { mode: 0o700 });
  script(path.join(root, 'scripts/cos-push-source.sh'), 'exit 0\n');
  script(
    path.join(root, 'scripts/cos-protect-programme.sh'),
    'echo protection >> "$COS_TEST_SSH_LOG"\n[[ "$COS_TEST_FAIL" != 3 ]] || exit 24\n',
  );
  script(path.join(bin, 'uname'), 'echo Darwin\n');
  script(
    path.join(bin, 'git'),
    `
case "$*" in
 'rev-parse --show-toplevel') echo "$COS_TEST_ROOT" ;;
 'remote get-url origin') echo https://github.com/ufJmacca/nanoclaw.git ;;
 'rev-parse '*'^{tree}') printf '%040d\\n' 2 ;;
 *) exit 30 ;;
esac
`,
  );
  script(
    path.join(bin, 'docker'),
    `
if [[ "$1" == compose ]]; then echo fixture; exit 0; fi
[[ "$1" == exec && "$9" != '' ]]
operation=$9; shift 9
case "$operation" in
 alias) echo fixture-pi ;;
 verify|checkpoint|protected-release-check) exit 0 ;;
 target-check) [[ "$COS_TEST_FAIL" != 5 ]] || exit 25 ;;
 protected-release-command) [[ "$COS_TEST_FAIL" != 4 ]] || echo finish-protected-release ;;
 preflight-command) echo inspect ;;
 stage-command) echo stage ;;
 seal-command) echo seal ;;
 bootstrap-command) echo "bootstrap $2" ;;
 field)
  case "$2" in
   commit) printf '%040d\\n' 1 ;;
   tree) printf '%040d\\n' 2 ;;
   fetchRef) echo refs/heads/cos/fixture ;;
   stage) echo /fixture/stage ;;
   slice) echo "$COS_TEST_SLICE" ;;
   *) exit 31 ;;
  esac ;;
 deploy-command)
  printf '%s\\n' "$#:$*" > "$COS_TEST_ARGS"
  [[ "$COS_TEST_FAIL" != 2 ]] || exit 0
  [[ "$COS_TEST_FAIL" == 0 ]] || exit 23
  echo "activate $*" ;;
 *) exit 32 ;;
esac
`,
  );
  script(path.join(bin, 'ssh'), 'printf \'%s\\n\' "${!#}" >> "$COS_TEST_SSH_LOG"\necho \'{"status":"healthy"}\'\n');
  for (const command of ['scp', 'gh']) script(path.join(bin, command), 'exit 0\n');
  const result = spawnSync(
    'bash',
    [
      path.join(root, 'scripts/cos-deploy.sh'),
      '--target',
      'pi',
      '--release-manifest',
      path.join(directory, 'release.json'),
      ...(recovery ? ['--recover-from', 'release-failed'] : []),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: bin + ':' + process.env.PATH,
        COS_TEST_ROOT: root,
        COS_TEST_ARGS: path.join(root, 'args'),
        COS_TEST_SSH_LOG: path.join(root, 'ssh.log'),
        COS_TEST_FAIL: String(failCommand),
        COS_TEST_SLICE: slice,
      },
    },
  );
  return {
    result,
    id,
    args: fs.existsSync(path.join(root, 'args')) ? fs.readFileSync(path.join(root, 'args'), 'utf8').trim() : '',
    remote: fs.existsSync(path.join(root, 'ssh.log'))
      ? fs.readFileSync(path.join(root, 'ssh.log'), 'utf8').trimEnd().split('\n')
      : [],
  };
}
it('G01 uses the already protected target without rerunning original programme closure', () => {
  const { result, remote } = invoke(false, 0, 'G01');
  expect(result.status, result.stderr).toBe(0);
  expect(remote[0]).toBe('inspect');
  expect(remote).not.toContain('protection');
});
it('G01 stops before staging when its protected target observation is denied', () => {
  const { result, remote } = invoke(false, 5, 'G01');
  expect(result.status).not.toBe(0);
  expect(remote).toEqual(['inspect']);
});

it('runs ordinary delivery with no recovery argument', () => {
  const { result, id, args, remote } = invoke(false);
  expect(result.status, result.stderr).toBe(0);
  expect(args).toBe('1:' + id);
  expect(remote.at(-1)).toBe('activate ' + id);
  expect(remote[0]).toBe('protection');
});
it('finishes the verified protected current release without replaying normal deployment or archive preparation', () => {
  const { result, args, remote } = invoke(false, 4);
  expect(result.status, result.stderr).toBe(0);
  expect(args).toBe('');
  expect(remote).toEqual(['protection', 'inspect', 'finish-protected-release']);
});
it('protects before target/deployment repair and refuses delivery if required protection is unconfirmed', () => {
  const { result, args, remote } = invoke(false, 3);
  expect(result.status).not.toBe(0);
  expect(args).toBe('');
  expect(remote).toEqual(['protection']);
});

it('passes only the explicit failed-release identity for recovery', () => {
  const { result, id, args, remote } = invoke(true);
  expect(result.status, result.stderr).toBe(0);
  expect(args).toBe('2:' + id + ' release-failed');
  expect(remote.at(-1)).toBe('activate ' + id + ' release-failed');
});

it('does not open an empty remote shell if command generation fails', () => {
  const { result, remote } = invoke(false, 1);
  expect(result.status).not.toBe(0);
  expect(remote.at(-1)).toBe('bootstrap prepare');
});

it('refuses an empty command even if the generator exits successfully', () => {
  const { result, remote } = invoke(false, 2);
  expect(result.status).not.toBe(0);
  expect(remote.at(-1)).toBe('bootstrap prepare');
});
