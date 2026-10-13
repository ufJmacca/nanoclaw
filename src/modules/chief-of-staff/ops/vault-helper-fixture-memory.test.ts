import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, expect, it } from 'vitest';

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) fs.rmSync(folder, { recursive: true, force: true });
});

function invocation(mode: 'helper' | 'units') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-helper-memory-'));
  folders.push(directory);
  fs.writeFileSync(directory + '/docker', '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o700 });
  const source = fs.readFileSync(new URL('../../../../scripts/cos-vault-fixture.sh', import.meta.url), 'utf8');
  const begin = source.indexOf('if [[ "$mode" == helper || "$mode" == units ]]; then'),
    end = source.indexOf('\nfi\n', begin) + 4;
  expect(begin).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(begin);
  // Exercise the actual shell invocation without starting Docker or reading credentials.
  const result = spawnSync(
    '/bin/bash',
    [
      '-c',
      'set -euo pipefail\nmode=$1 image=$2\n' + source.slice(begin, end),
      'helper-budget',
      mode,
      'sha256:' + 'a'.repeat(64),
    ],
    { env: { PATH: directory + ':/usr/bin:/bin' }, timeout: 2000, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  expect(result.stderr.length).toBe(0);
  return result.stdout.toString().trim().split('\n');
}

it('bounds the sealed installer fixture at 512 MiB with no additional swap for its concurrent processes and runtime copies', () => {
  const args = invocation('helper');
  expect(args[args.indexOf('--memory') + 1]).toBe('512m');
  expect(args[args.indexOf('--memory-swap') + 1]).toBe('512m');
  expect(args).toContain('--network=none');
  expect(args[args.indexOf('--ulimit') + 1]).toBe('core=0');
  expect(args.at(-1)).toBe('/probe/probe-artifact.mjs');
});

it('keeps the unit-only fixture at its original 256 MiB without swap or core dumps', () => {
  const args = invocation('units');
  expect(args[args.indexOf('--memory') + 1]).toBe('256m');
  expect(args[args.indexOf('--memory-swap') + 1]).toBe('256m');
  expect(args).toContain('--network=none');
  expect(args[args.indexOf('--ulimit') + 1]).toBe('core=0');
  expect(args.at(-1)).toBe('/probe/verify-units.mjs');
});
