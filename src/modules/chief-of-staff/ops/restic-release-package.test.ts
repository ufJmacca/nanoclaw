import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageResticReleaseArtifact } from './restic-release-package.js';
import { RESTIC_ARTIFACT } from './restic-artifact.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restic-release-package-'));
  roots.push(root);
  const binary = path.join(root, 'input-restic'),
    output = path.join(root, 'output');
  fs.writeFileSync(binary, 'unverified input', { mode: 0o700 });
  return { root, binary, output };
}
it.each(['bytes', 'hash', 'symlink', 'hardlink', 'parent', 'relative', 'existing-output'])(
  'refuses %s inputs without replacing existing files or publishing an artifact',
  (reason) => {
    const f = fixture();
    let binary = f.binary;
    if (reason === 'hash') fs.truncateSync(binary, RESTIC_ARTIFACT.bytes);
    if (reason === 'symlink') {
      fs.renameSync(binary, f.root + '/retained');
      fs.symlinkSync(f.root + '/retained', binary);
    }
    if (reason === 'hardlink') fs.linkSync(binary, f.root + '/linked');
    if (reason === 'parent') fs.chmodSync(f.root, 0o755);
    if (reason === 'relative') binary = 'relative-restic';
    if (reason === 'existing-output') {
      fs.mkdirSync(f.output, { mode: 0o700 });
      fs.writeFileSync(f.output + '/existing', 'preserve', { mode: 0o600 });
    }
    const bytes = fs.readFileSync(f.binary);
    expect(() => packageResticReleaseArtifact({ binary, output: f.output })).toThrow(
      'restic_release_package_unavailable',
    );
    expect(fs.readFileSync(f.binary).equals(bytes)).toBe(true);
    expect(fs.readdirSync(f.root).some((name) => name.startsWith('.restic-release-'))).toBe(false);
    if (reason === 'existing-output') expect(fs.readFileSync(f.output + '/existing', 'utf8')).toBe('preserve');
    else expect(fs.existsSync(f.output)).toBe(false);
  },
);
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY).each(['truncate', 'append', 'mode', 'hardlink', 'replace'])(
  'refuses source %s during packaging without publishing partial bytes',
  (reason) => {
    const f = fixture();
    fs.copyFileSync(process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY!, f.binary);
    fs.chmodSync(f.binary, 0o700);
    const actualRead = fs.readSync;
    let changed = false;
    vi.spyOn(fs, 'readSync').mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      const count = Reflect.apply(actualRead, fs, args);
      if (!changed && count > 0 && fs.fstatSync(args[0]).size === RESTIC_ARTIFACT.bytes) {
        changed = true;
        if (reason === 'truncate') fs.truncateSync(f.binary, RESTIC_ARTIFACT.bytes - 1);
        if (reason === 'append') fs.appendFileSync(f.binary, ' ');
        if (reason === 'mode') fs.chmodSync(f.binary, 0o755);
        if (reason === 'hardlink') fs.linkSync(f.binary, f.root + '/linked');
        if (reason === 'replace') {
          fs.renameSync(f.binary, f.root + '/retained');
          fs.copyFileSync(f.root + '/retained', f.binary);
        }
      }
      return count;
    }) as typeof fs.readSync);
    expect(() => packageResticReleaseArtifact({ binary: f.binary, output: f.output })).toThrow(
      'restic_release_package_unavailable',
    );
    expect(changed).toBe(true);
    expect(fs.existsSync(f.output)).toBe(false);
    expect(fs.readdirSync(f.root).some((name) => name.startsWith('.restic-release-'))).toBe(false);
  },
);
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'packages only the exact official ARM64 executable and immutable seal',
  () => {
    const binary = process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY;
    if (!binary) throw Error('explicit_pinned_package_fixture_required');
    const f = fixture(),
      result = packageResticReleaseArtifact({ binary, output: f.output });
    expect(result).toEqual(RESTIC_ARTIFACT);
    expect(fs.readdirSync(f.output).sort()).toEqual(['artifact.json', 'restic']);
    const executable = fs.lstatSync(f.output + '/restic'),
      seal = fs.lstatSync(f.output + '/artifact.json');
    expect(executable.size).toBe(RESTIC_ARTIFACT.bytes);
    expect(executable.nlink).toBe(1);
    expect(executable.mode & 0o777).toBe(0o555);
    expect(seal.mode & 0o777).toBe(0o444);
    expect(JSON.parse(fs.readFileSync(f.output + '/artifact.json', 'utf8'))).toEqual(RESTIC_ARTIFACT);
    expect(() => packageResticReleaseArtifact({ binary, output: f.output })).toThrow(
      'restic_release_package_unavailable',
    );
  },
);
