import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { readPrivate, readTarget, type TargetBinding } from './target-state.js';
import { payloadDigest } from './payload.js';
/** Shared byte/receipt verification. Callers still select their bounded lifecycle capability. */
export async function verifyRetainedReleaseHelper(
  settings: { releaseRoot: string; stateRoot: string },
  binding: TargetBinding,
  invoked: string,
): Promise<ReleaseManifest> {
  try {
    const payload = path.resolve(path.dirname(invoked), '../../../..'),
      archive = path.dirname(payload);
    if (
      path.dirname(archive) !== settings.releaseRoot ||
      invoked !== path.join(payload, 'dist/modules/chief-of-staff/ops/target-helper.js') ||
      fs.realpathSync(invoked) !== invoked
    )
      throw Error('helper_path_conflict');
    const manifest = validateReleaseManifest(readPrivate(path.join(archive, 'release.json')));
    if (manifest.releaseId !== path.basename(archive)) throw Error('helper_release_conflict');
    const record = readPrivate<Record<string, unknown>>(
      path.join(settings.stateRoot, 'releases', manifest.releaseId, 'deployment.json'),
    );
    const phases = ['source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health'];
    if (
      record.version !== 1 ||
      record.releaseId !== manifest.releaseId ||
      record.manifestDigest !== digest(manifest) ||
      record.bindingDigest !== digest(binding) ||
      record.status !== 'healthy' ||
      record.pending !== null ||
      digest(record.completed) !== digest(phases) ||
      (await payloadDigest(payload)) !== manifest.hostPayloadDigest
    )
      throw Error('helper_receipt_conflict');
    return manifest;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Retained payload paths and private deployment diagnostics must stay private.
    throw Error('retained_admin_helper_unverified');
  }
}
/** Extension administration uses a sealed, healthy G01 payload only on the already protected target. */
export async function verifyRetainedAdminHelper(
  settings: { releaseRoot: string; stateRoot: string },
  binding: TargetBinding,
  invoked: string,
): Promise<ReleaseManifest> {
  try {
    const manifest = await verifyRetainedReleaseHelper(settings, binding, invoked);
    if (manifest.slice === 'S11') return manifest;
    if (manifest.slice !== 'G01' || readTarget(settings.stateRoot, binding).lifecycle !== 'protected')
      throw Error('helper_scope_conflict');
    return manifest;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Lifecycle and helper diagnostics are not owner administration receipts.
    throw Error('retained_admin_helper_unverified');
  }
}
