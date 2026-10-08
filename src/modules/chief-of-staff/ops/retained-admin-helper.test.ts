import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { requiredReleaseChecks, type ReleaseManifest } from './release-manifest.js';
import { initializeTarget, protectTarget, readPrivate, writeAtomic } from './target-state.js';
import { payloadDigest } from './payload.js';
import { verifyProtectionHelper } from './programme-protection.js';
import { verifyRetainedAdminHelper } from './retained-admin-helper.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(slice: 'S11' | 'G01' = 'G01') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-admin-'));
  roots.push(root);
  const binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: '/home/fixture/app',
      dataRoot: '/home/fixture/app/data',
    },
    settings = { releaseRoot: root + '/releases', stateRoot: root + '/state' };
  initializeTarget(settings.stateRoot, binding);
  protectTarget(settings.stateRoot, binding);
  const manifest = fixtureRelease(slice);
  manifest.releaseId = 'release-aaaaaaaaaaaa-20261008011204';
  if (slice === 'G01') {
    const seal = {
      contract: 'cos-vault-root-artifact/v1' as const,
      sourceCommit: manifest.source.commit,
      sourceTree: manifest.source.tree,
      runtime: { name: 'node' as const, version: '22.23.2', architecture: 'arm64' as const },
      files: {
        'gateway.mjs': { bytes: 100, sha256: '4'.repeat(64) },
        node: { bytes: 122159120, sha256: '5'.repeat(64) },
      },
    };
    manifest.vaultArtifact = { digest: digest(seal), seal };
    manifest.previousReleaseIds = ['release-reviewed-s11'];
    manifest.checks = Object.fromEntries(
      requiredReleaseChecks(slice).map((name) => [
        name,
        {
          status: 'passed',
          at: '2026-10-08T00:00:00Z',
          sourceCommit: manifest.source.commit,
          imageIds:
            name === 'protected_state' || name.includes('image')
              ? manifest.images.map(({ id }) => id)
              : name.startsWith('vault_')
                ? [manifest.images[0]!.id]
                : [],
        },
      ]),
    ) as ReleaseManifest['checks'];
  }
  const archive = settings.releaseRoot + '/' + manifest.releaseId,
    payload = archive + '/payload',
    helper = payload + '/dist/modules/chief-of-staff/ops/target-helper.js';
  fs.mkdirSync(path.dirname(helper), { recursive: true, mode: 0o700 });
  fs.writeFileSync(helper, 'synthetic prebuilt helper');
  manifest.hostPayloadDigest = await payloadDigest(payload);
  writeAtomic(archive, 'release.json', manifest);
  const receiptRoot = settings.stateRoot + '/releases/' + manifest.releaseId;
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  const record = {
    version: 1,
    releaseId: manifest.releaseId,
    manifestDigest: digest(manifest),
    bindingDigest: digest(binding),
    status: 'healthy',
    pending: null,
    completed: ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'],
  };
  writeAtomic(receiptRoot, 'deployment.json', record);
  return { settings, binding, manifest, helper, record, receiptRoot, archive };
}
it('admits the healthy sealed G01 admin payload while original programme closure stays S11-only', async () => {
  const f = await fixture();
  await expect(verifyRetainedAdminHelper(f.settings, f.binding, f.helper)).resolves.toEqual(f.manifest);
  await expect(verifyProtectionHelper(f.settings, f.binding, f.helper)).rejects.toThrow(
    'programme_completion_unverified',
  );
});
it('preserves retained S11 repair compatibility', async () => {
  const f = await fixture('S11');
  await expect(verifyRetainedAdminHelper(f.settings, f.binding, f.helper)).resolves.toEqual(f.manifest);
  await expect(verifyProtectionHelper(f.settings, f.binding, f.helper)).resolves.toEqual(f.manifest);
});
it.each(['unprotected', 'seal', 'incomplete', 'binding', 'payload', 'future-slice'])(
  'denies %s G01 helper evidence before owner administration',
  async (reason) => {
    const f = await fixture();
    if (reason === 'unprotected') {
      fs.unlinkSync(f.settings.stateRoot + '/protected.json');
      const state = readPrivate<Record<string, unknown>>(f.settings.stateRoot + '/state.json');
      writeAtomic(f.settings.stateRoot, 'state.json', { ...state, lifecycle: 'implementation_disposable' });
    }
    if (reason === 'seal') writeAtomic(f.archive, 'release.json', { ...f.manifest, vaultArtifact: undefined });
    if (reason === 'incomplete') writeAtomic(f.receiptRoot, 'deployment.json', { ...f.record, status: 'in_progress' });
    if (reason === 'binding')
      writeAtomic(f.receiptRoot, 'deployment.json', { ...f.record, bindingDigest: '9'.repeat(64) });
    if (reason === 'payload') fs.appendFileSync(f.helper, ' changed');
    if (reason === 'future-slice') writeAtomic(f.archive, 'release.json', { ...f.manifest, slice: 'G02' });
    await expect(verifyRetainedAdminHelper(f.settings, f.binding, f.helper)).rejects.toThrow(
      'retained_admin_helper_unverified',
    );
  },
);
