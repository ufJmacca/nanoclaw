import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { RESTIC_ARTIFACT } from './restic-artifact.js';
import { packageResticReleaseArtifact } from './restic-release-package.js';
import { installResticRuntimeArtifact } from './restic-runtime-install.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'restic-runtime-install-'));
  roots.push(root);
  const installationRoot = root + '/app',
    payload = root + '/payload';
  for (const p of [installationRoot, payload]) fs.mkdirSync(p, { mode: 0o700 });
  return { root, installationRoot, payload, manifest: fixtureVaultRelease('G02'), check: vi.fn() };
}
function officialFixture() {
  const f = fixture();
  packageResticReleaseArtifact({
    binary: process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY!,
    output: f.payload + '/libexec',
  });
  return f;
}
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'copies the sealed public binary to the fixed runtime location and idempotently verifies its unchanged inode',
  async () => {
    const f = officialFixture(),
      file = f.installationRoot + '/libexec/restic';
    const first = await installResticRuntimeArtifact(f);
    expect(first).toEqual({ status: 'installed', bytes: RESTIC_ARTIFACT.bytes, sha256: RESTIC_ARTIFACT.sha256 });
    expect(createHash('sha256').update(fs.readFileSync(file)).digest('hex')).toBe(RESTIC_ARTIFACT.sha256);
    expect(fs.statSync(file).size).toBe(RESTIC_ARTIFACT.bytes);
    expect(fs.statSync(file).mode & 0o7777).toBe(0o555);
    expect(fs.statSync(f.installationRoot + '/libexec').mode & 0o7777).toBe(0o700);
    const inode = fs.statSync(file).ino;
    expect(await installResticRuntimeArtifact(f)).toEqual({ ...first, status: 'already_installed' });
    expect(fs.statSync(file).ino).toBe(inode);
  },
);
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY).each(['G03', 'G04'] as const)(
  '%s verifies the same pinned utility at its fixed runtime location without replacing it',
  async (slice) => {
    const f = officialFixture();
    f.manifest = fixtureVaultRelease(slice);
    const first = await installResticRuntimeArtifact(f),
      file = f.installationRoot + '/libexec/restic';
    const before = fs.statSync(file);
    expect(first.status).toBe('installed');
    expect(first.sha256).toBe(RESTIC_ARTIFACT.sha256);
    expect(await installResticRuntimeArtifact(f)).toEqual({ ...first, status: 'already_installed' });
    expect(fs.statSync(file).ino).toBe(before.ino);
  },
);
it.each(['absent-payload', 'wrong-slice', 'unverified-binary', 'closed-caller'])(
  'refuses %s before creating a runtime utility or changing existing application files',
  async (reason) => {
    const f = fixture();
    fs.writeFileSync(f.installationRoot + '/keep', 'existing', { mode: 0o600 });
    if (reason === 'wrong-slice') f.manifest = fixtureVaultRelease('G01');
    if (reason === 'unverified-binary') {
      fs.mkdirSync(f.payload + '/libexec');
      fs.writeFileSync(f.payload + '/libexec/restic', 'unverified', { mode: 0o555 });
      fs.writeFileSync(f.payload + '/libexec/artifact.json', JSON.stringify(RESTIC_ARTIFACT), { mode: 0o444 });
    }
    if (reason === 'closed-caller')
      f.check.mockImplementation(() => {
        throw Error('closed');
      });
    await expect(installResticRuntimeArtifact(f)).rejects.toThrow('backup_runtime_artifact_unavailable');
    expect(fs.existsSync(f.installationRoot + '/libexec')).toBe(false);
    expect(fs.readFileSync(f.installationRoot + '/keep', 'utf8')).toBe('existing');
  },
);
it
  .skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)
  .each(['existing-partial', 'directory-link', 'directory-mode', 'installation-link'])(
  'refuses %s without adopting, replacing or deleting the existing path',
  async (reason) => {
    const f = officialFixture(),
      folder = f.installationRoot + '/libexec';
    const unrelated = f.root + '/unrelated';
    fs.mkdirSync(unrelated, { mode: 0o700 });
    fs.writeFileSync(unrelated + '/restic', 'PRESERVE', { mode: 0o600 });
    if (reason === 'existing-partial') {
      fs.mkdirSync(folder, { mode: 0o700 });
      fs.writeFileSync(folder + '/restic', 'partial', { mode: 0o600 });
    }
    if (reason === 'directory-link') fs.symlinkSync(unrelated, folder);
    if (reason === 'directory-mode') fs.mkdirSync(folder, { mode: 0o755 });
    if (reason === 'installation-link') {
      fs.rmdirSync(f.installationRoot);
      fs.symlinkSync(unrelated, f.installationRoot);
    }
    await expect(installResticRuntimeArtifact(f)).rejects.toThrow('backup_runtime_artifact_unavailable');
    expect(fs.readFileSync(unrelated + '/restic', 'utf8')).toBe('PRESERVE');
    if (reason === 'existing-partial') expect(fs.readFileSync(folder + '/restic', 'utf8')).toBe('partial');
  },
);

it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'withdrawn admission during copying retires only the unchanged new output inode',
  async () => {
    const f = officialFixture();
    f.check.mockImplementation(() => {
      if ((fs.lstatSync(f.installationRoot + '/libexec/restic', { throwIfNoEntry: false })?.size ?? 0) > 0)
        throw Error('withdrawn');
    });
    await expect(installResticRuntimeArtifact(f)).rejects.toThrow('backup_runtime_artifact_unavailable');
    expect(fs.existsSync(f.installationRoot + '/libexec/restic')).toBe(false);
  },
);
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'an unexplained replacement survives a failed copy and is never adopted',
  async () => {
    const f = officialFixture(),
      file = f.installationRoot + '/libexec/restic';
    f.check.mockImplementation(() => {
      if ((fs.lstatSync(file, { throwIfNoEntry: false })?.size ?? 0) > 0) {
        fs.unlinkSync(file);
        fs.writeFileSync(file, 'PRESERVE', { mode: 0o600 });
        throw Error('withdrawn');
      }
    });
    await expect(installResticRuntimeArtifact(f)).rejects.toThrow('backup_runtime_artifact_unavailable');
    expect(fs.readFileSync(file, 'utf8')).toBe('PRESERVE');
  },
);
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'a failed cleanup exposes only the fixed delivery error',
  async () => {
    const f = officialFixture();
    f.check.mockImplementation(() => {
      if ((fs.lstatSync(f.installationRoot + '/libexec/restic', { throwIfNoEntry: false })?.size ?? 0) > 0)
        throw Error('withdrawn');
    });
    vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      throw Error('PRIVATE_STORAGE_PATH');
    });
    await expect(installResticRuntimeArtifact(f)).rejects.toThrow(/^backup_runtime_artifact_unavailable$/);
  },
);
