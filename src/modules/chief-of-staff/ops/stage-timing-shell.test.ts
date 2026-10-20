import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it.each([0, 37])('preserves release exit %i through the actual host cleanup trap', async (exitCode) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-release-cleanup-status-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), 'fixture');
  const source = fs.readFileSync('scripts/cos-release.sh', 'utf8');
  const cleanup = source.slice(source.indexOf('cleanup() {'), source.indexOf('\nstamp='));
  const script = 'set -euo pipefail\nlock=$1\ncarrier=""\n' + cleanup + '\n(exit "$2")\n';
  const run = promisify(execFile)('bash', ['-c', script, '_', lock, String(exitCode)]);
  if (exitCode) await expect(run).rejects.toMatchObject({ code: exitCode });
  else await expect(run).resolves.toBeDefined();
  expect(fs.existsSync(lock)).toBe(false);
});
it('refuses a missing pinned timing helper before loading it', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-release-missing-helper-'));
  roots.push(root);
  const lock = path.join(root, 'lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), 'fixture');
  const source = fs.readFileSync('scripts/cos-release.sh', 'utf8');
  const cleanup = source.slice(source.indexOf('cleanup() {'), source.indexOf('\nstamp='));
  const marker = 'cli init "$id" "$commit" "$branch" "$slice"\n';
  const load = source.slice(source.indexOf(marker) + marker.length, source.indexOf('\ndocker context inspect'));
  const script = 'set -euo pipefail\nlock=$1\ndirectory=$2\ncarrier=""\n' + cleanup + '\n' + load + '\n';
  await expect(promisify(execFile)('bash', ['-c', script, '_', lock, root])).rejects.toMatchObject({ code: 1 });
  expect(fs.existsSync(lock)).toBe(false);
});
it('stops the actual export function at a failed image save rather than publishing a manifest', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-timing-export-'));
  roots.push(root);
  const source = fs.readFileSync('scripts/cos-release.sh', 'utf8');
  const actualExport = source.slice(
    source.indexOf('export_bundle() {'),
    source.indexOf('\ntimed_release_stage export_bundle'),
  );
  const script =
    'set -euo pipefail\nsource "$1"\ndirectory=$2\ntrace="$directory/trace"\nid=release-fixture\nhost_image=fixture\n' +
    'cli(){ printf "%s\\n" "$*" >> "$trace"; if [[ "$1" == timing && "$3" == start ]]; then printf "%s\\n" 11111111-1111-4111-8111-111111111111; elif [[ "$1" == field ]]; then printf "%s\\n" fixture-tag; fi; }\n' +
    'docker(){ return 37; }\n' +
    actualExport +
    '\ntimed_release_stage export_bundle manifest.sha256 export_bundle\n';
  await expect(
    promisify(execFile)('bash', ['-c', script, '_', path.resolve('scripts/cos-stage-timing.sh'), root]),
  ).rejects.toMatchObject({ code: 37 });
  const trace = fs.readFileSync(path.join(root, 'trace'), 'utf8');
  expect(trace).not.toContain('finish');
  expect(trace).toContain('end 11111111-1111-4111-8111-111111111111 37');
});
it.each([
  [0, 0, 0],
  [37, 0, 37],
  [0, 52, 52],
  [37, 52, 37],
])(
  'records command exit %i and timing exit %i without losing result %i',
  async (operationStatus, endStatus, expected) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-timing-shell-'));
    roots.push(root);
    const trace = path.join(root, 'trace');
    fs.writeFileSync(trace, '');
    const script =
      'source "$1"\ntrace=$2\noperation_status=$3\nend_status=$4\nid=release-fixture\n' +
      'cli(){ printf "%s\\n" "$*" >> "$trace"; if [[ "$3" == start ]]; then printf "%s\\n" 11111111-1111-4111-8111-111111111111; else return "$end_status"; fi; }\n' +
      'operation(){ return "$operation_status"; }\ntimed_release_stage check_root root.log operation\n';
    const run = promisify(execFile)('bash', [
      '-c',
      script,
      '_',
      path.resolve('scripts/cos-stage-timing.sh'),
      trace,
      String(operationStatus),
      String(endStatus),
    ]);
    if (expected) await expect(run).rejects.toMatchObject({ code: expected });
    else await expect(run).resolves.toBeDefined();
    expect(fs.readFileSync(trace, 'utf8').trim().split('\n')).toEqual([
      'timing release-fixture start check_root root.log',
      'timing release-fixture end 11111111-1111-4111-8111-111111111111 ' + operationStatus,
    ]);
  },
);
