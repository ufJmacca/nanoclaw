import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RESTIC_ARTIFACT } from './restic-artifact.js';
import { packageResticReleaseArtifact } from './restic-release-package.js';
import { verifyResticReleasePayload } from './restic-release-payload.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'restic-release-payload-'));
  roots.push(parent);
  const root = parent + '/libexec';
  fs.mkdirSync(root, { mode: 0o755 });
  fs.writeFileSync(root + '/restic', 'unverified', { mode: 0o555 });
  fs.writeFileSync(root + '/artifact.json', JSON.stringify(RESTIC_ARTIFACT), { mode: 0o444 });
  return { parent, root };
}
it.each([
  'absent',
  'wrong-binary',
  'seal-version',
  'seal-hash',
  'seal-extra',
  'seal-mode',
  'seal-link',
  'seal-hardlink',
  'extra-child',
  'directory-mode',
])('refuses a release payload with %s evidence', (reason) => {
  const f = fixture();
  if (reason === 'absent') fs.unlinkSync(f.root + '/restic');
  if (reason === 'seal-version' || reason === 'seal-hash' || reason === 'seal-extra') {
    fs.chmodSync(f.root + '/artifact.json', 0o600);
    fs.writeFileSync(
      f.root + '/artifact.json',
      JSON.stringify({
        ...RESTIC_ARTIFACT,
        ...(reason === 'seal-version'
          ? { version: 'unverified' }
          : reason === 'seal-hash'
            ? { sha256: 'a'.repeat(64) }
            : { path: '/arbitrary' }),
      }),
    );
    fs.chmodSync(f.root + '/artifact.json', 0o444);
  }
  if (reason === 'seal-mode') fs.chmodSync(f.root + '/artifact.json', 0o644);
  if (reason === 'seal-hardlink') fs.linkSync(f.root + '/artifact.json', f.parent + '/linked');
  if (reason === 'seal-link') {
    fs.renameSync(f.root + '/artifact.json', f.parent + '/retained');
    fs.symlinkSync(f.parent + '/retained', f.root + '/artifact.json');
  }
  if (reason === 'extra-child') fs.writeFileSync(f.root + '/unadmitted', 'preserve', { mode: 0o600 });
  if (reason === 'directory-mode') fs.chmodSync(f.root, 0o777);
  expect(() => verifyResticReleasePayload(f.root)).toThrow('restic_release_payload_unverified');
  if (reason === 'extra-child') expect(fs.readFileSync(f.root + '/unadmitted', 'utf8')).toBe('preserve');
});
it.skipIf(!process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY)(
  'accepts only the packaged official executable and its complete read-only seal',
  () => {
    const f = fixture();
    fs.rmSync(f.root, { recursive: true });
    packageResticReleaseArtifact({ binary: process.env.COS_BACKUP_PACKAGE_FIXTURE_BINARY!, output: f.root });
    expect(verifyResticReleasePayload(f.root)).toEqual(RESTIC_ARTIFACT);
  },
);
