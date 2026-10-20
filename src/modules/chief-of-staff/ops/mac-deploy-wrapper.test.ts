import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { beginStageTiming } from './stage-timing.js';

const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function invoke(recovery: boolean, failCommand = 0, slice = 'S11', withTimingHelper = true) {
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
  if (withTimingHelper) fs.copyFileSync('scripts/cos-stage-timing.sh', path.join(root, 'scripts/cos-stage-timing.sh'));
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
 timing)
  printf '%s\\n' "$*" >> "$COS_TEST_TIMING_LOG"
  if [[ "$2" == start ]]; then echo 11111111-1111-4111-8111-111111111111
  elif [[ "$COS_TEST_FAIL" == 6 ]]; then exit 26; fi ;;
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
  const logTransport = `
{ printf '%s' "$(basename "$0")"; printf '\\t%s' "$@"; printf '\\n'; } >> "$COS_TEST_TRANSPORT_LOG"
`;
  script(
    path.join(bin, 'ssh'),
    logTransport + 'printf \'%s\\n\' "${!#}" >> "$COS_TEST_SSH_LOG"\necho \'{"status":"healthy"}\'\n',
  );
  script(path.join(bin, 'scp'), logTransport);
  script(path.join(bin, 'gh'), 'exit 0\n');
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
        COS_TEST_TRANSPORT_LOG: path.join(root, 'transport.log'),
        COS_TEST_TIMING_LOG: path.join(root, 'timing.log'),
        COS_TEST_FAIL: String(failCommand),
        COS_TEST_SLICE: slice,
      },
    },
  );
  return {
    result,
    id,
    timings: fs.existsSync(path.join(root, 'timing.log'))
      ? fs.readFileSync(path.join(root, 'timing.log'), 'utf8').trimEnd().split('\n')
      : [],
    args: fs.existsSync(path.join(root, 'args')) ? fs.readFileSync(path.join(root, 'args'), 'utf8').trim() : '',
    remote: fs.existsSync(path.join(root, 'ssh.log'))
      ? fs.readFileSync(path.join(root, 'ssh.log'), 'utf8').trimEnd().split('\n')
      : [],
    transport: fs.existsSync(path.join(root, 'transport.log'))
      ? fs
          .readFileSync(path.join(root, 'transport.log'), 'utf8')
          .trimEnd()
          .split('\n')
          .map((line) => line.split('\t'))
      : [],
  };
}
it.each(['G01', 'G02', 'G03', 'G04'])(
  '%s uses the already protected target without rerunning original programme closure',
  (slice) => {
    const { result, remote } = invoke(false, 0, slice);
    expect(result.status, result.stderr).toBe(0);
    expect(remote[0]).toBe('inspect');
    expect(remote).not.toContain('protection');
  },
);
it.each(['G01', 'G02', 'G03', 'G04'])(
  '%s stops before staging when its protected target observation is denied',
  (slice) => {
    const { result, remote } = invoke(false, 5, slice);
    expect(result.status).not.toBe(0);
    expect(remote).toEqual(['inspect']);
  },
);

it('uses the working IPv4 route and bounded verified connections for every G02 command and artifact transfer', () => {
  const { result, transport } = invoke(false, 0, 'G02');
  expect(result.status, result.stderr).toBe(0);
  expect(transport.filter(([command]) => command === 'scp')).toHaveLength(5);
  expect(transport.some(([command]) => command === 'ssh')).toBe(true);
  for (const args of transport)
    expect(args.slice(1, 12)).toEqual([
      '-4',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ServerAliveInterval=15',
      '-o',
      'ServerAliveCountMax=3',
    ]);
});

it('runs ordinary delivery with no recovery argument', () => {
  const { result, id, args, remote } = invoke(false);
  expect(result.status, result.stderr).toBe(0);
  expect(args).toBe('1:' + id);
  expect(remote.at(-1)).toBe('activate ' + id);
  expect(remote[0]).toBe('protection');
});
it.each([
  ['G01', false],
  ['G01', true],
  ['G02', false],
  ['G02', true],
  ['G03', false],
  ['G03', true],
  ['G04', false],
  ['G04', true],
] as const)('%s protects the actual deployment process for recovery=%s', (slice, recovery) => {
  const { result, id, remote } = invoke(recovery, 0, slice);
  expect(result.status, result.stderr).toBe(0);
  expect(remote.at(-1)).toBe(
    'systemd-run --user --quiet --pipe --wait --collect ' +
      '--unit=nanoclaw-cos-deploy-' +
      id +
      '.service ' +
      '--property=LimitCORE=0 --property=MemorySwapMax=0 --property=RuntimeMaxSec=1900 -- ' +
      '/usr/bin/env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin LANG=C LC_ALL=C ' +
      'activate ' +
      id +
      (recovery ? ' release-failed' : ''),
  );
});
it.each(['G01', 'G02', 'G03', 'G04'])('%s refuses an empty command before starting a protected unit', (slice) => {
  const { result, remote } = invoke(false, 2, slice);
  expect(result.status).not.toBe(0);
  expect(remote.at(-1)).toBe('bootstrap prepare');
});
it('measures actual G04 transfer, preparation and activation without changing recovery or transport arguments', () => {
  const { result, timings, args, id } = invoke(false, 0, 'G04');
  expect(result.status, result.stderr).toBe(0);
  expect(args).toBe('1:' + id);
  const stages = timings.filter((line) => line.includes(' start ')).map((line) => line.split(' ')[2]);
  for (const line of timings.filter((line) => line.includes(' start '))) {
    const [, , stage, evidence] = line.split(' ');
    expect(() =>
      beginStageTiming(
        undefined,
        { releaseId: id, sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), buildInputDigest: 'c'.repeat(64) },
        { id: randomUUID(), stage, evidence, at: '2026-10-20T07:00:00.000Z' },
      ),
    ).not.toThrow();
  }
  expect(stages).toEqual([
    'source_push',
    'transfer_release_json',
    'seal_release_json',
    'transfer_sha256sums',
    'seal_sha256sums',
    'transfer_bootstrap_mjs',
    'seal_bootstrap_mjs',
    'transfer_target_json',
    'seal_target_json',
    'source_verify',
    'transfer_images_tar_gz',
    'seal_images_tar_gz',
    'prepare_import',
    'activation',
  ]);
  expect(timings.filter((line) => line.includes(' end '))).toHaveLength(stages.length);
  expect(timings.filter((line) => line.includes(' end ')).every((line) => line.endsWith(' 0'))).toBe(true);
});
it('denies a missing timing helper before staging and releases its delivery lock', () => {
  const { result, remote } = invoke(false, 0, 'G04', false);
  expect(result.status).not.toBe(0);
  expect(remote).toEqual([]);
});
it('cannot promote delivery after a failed timing write', () => {
  const { result, remote, args, timings } = invoke(false, 6, 'G04');
  expect(result.status).toBe(26);
  expect(remote).toEqual(['inspect']);
  expect(args).toBe('');
  expect(timings).toHaveLength(2);
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
