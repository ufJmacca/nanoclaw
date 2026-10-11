import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { packageResticReleaseArtifact, verifyResticReleaseArtifactInput } from './restic-release-package.js';
import { RESTIC_ARTIFACT } from './restic-artifact.js';
import * as resticArtifact from './restic-artifact.js';

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

it.each([
  'extra-file',
  'directory-mode',
  'symlink',
  'seal-link',
  'seal-mode',
  'seal-fields',
  'binary-mode',
  'binary-bytes',
])('refuses a prepared release input with %s before exposing it to another fixture', (reason) => {
  const f = fixture();
  fs.mkdirSync(f.output, { mode: 0o700 });
  const seal = f.output + '/artifact.json',
    binary = f.output + '/restic';
  fs.writeFileSync(seal, JSON.stringify(RESTIC_ARTIFACT), { mode: 0o444 });
  fs.writeFileSync(binary, 'unverified binary', { mode: 0o555 });
  let directory = f.output;
  if (reason === 'extra-file') fs.writeFileSync(f.output + '/private-configuration', 'must-not-be-mounted');
  if (reason === 'directory-mode') fs.chmodSync(f.output, 0o755);
  if (reason === 'symlink') {
    directory = f.root + '/alias';
    fs.symlinkSync(f.output, directory);
  }
  if (reason === 'seal-link') fs.linkSync(seal, f.root + '/linked-seal');
  if (reason === 'seal-mode') fs.chmodSync(seal, 0o644);
  if (reason === 'seal-fields') {
    fs.chmodSync(seal, 0o644);
    fs.writeFileSync(seal, JSON.stringify({ ...RESTIC_ARTIFACT, path: '/untrusted' }));
    fs.chmodSync(seal, 0o444);
  }
  if (reason === 'binary-mode') fs.chmodSync(binary, 0o755);
  const verify =
    reason === 'binary-bytes'
      ? undefined
      : vi.spyOn(resticArtifact, 'verifyResticBinary').mockReturnValue(RESTIC_ARTIFACT);
  expect(() => verifyResticReleaseArtifactInput(directory)).toThrow('restic_release_input_unavailable');
  if (verify) expect(verify).not.toHaveBeenCalled();
  expect(fs.readFileSync(binary, 'utf8')).toBe('unverified binary');
});

it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'reverifies the exact packaged binary and seal before sharing the public release input',
  () => {
    const f = fixture();
    packageResticReleaseArtifact({ binary: process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY!, output: f.output });
    expect(verifyResticReleaseArtifactInput(f.output)).toEqual(RESTIC_ARTIFACT);
    fs.chmodSync(f.output + '/restic', 0o755);
    expect(() => verifyResticReleaseArtifactInput(f.output)).toThrow('restic_release_input_unavailable');
  },
);
it.each(['directory-replacement', 'seal-replacement', 'seal-permission', 'new-file'])(
  'refuses %s while the executable is being verified',
  (reason) => {
    const f = fixture();
    fs.mkdirSync(f.output, { mode: 0o700 });
    fs.writeFileSync(f.output + '/artifact.json', JSON.stringify(RESTIC_ARTIFACT), { mode: 0o444 });
    fs.writeFileSync(f.output + '/restic', 'synthetic metadata fixture', { mode: 0o555 });
    const verify = vi.spyOn(resticArtifact, 'verifyResticBinary').mockImplementation(() => {
      if (reason === 'directory-replacement') {
        fs.renameSync(f.output, f.root + '/retained');
        fs.mkdirSync(f.output, { mode: 0o700 });
      }
      if (reason === 'seal-replacement') {
        fs.renameSync(f.output + '/artifact.json', f.root + '/retained');
        fs.copyFileSync(f.root + '/retained', f.output + '/artifact.json');
      }
      if (reason === 'seal-permission') fs.chmodSync(f.output + '/artifact.json', 0o644);
      if (reason === 'new-file') fs.writeFileSync(f.output + '/private-config', 'never mount');
      return RESTIC_ARTIFACT;
    });
    expect(() => verifyResticReleaseArtifactInput(f.output)).toThrow('restic_release_input_unavailable');
    expect(verify).toHaveBeenCalledOnce();
  },
);
