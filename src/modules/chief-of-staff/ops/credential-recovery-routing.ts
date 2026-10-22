import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { credentialRootMarker } from '../calendar/credential-core.js';
import { accessFenceRootMarker } from '../calendar/access-fences.js';
import { credentialSource, type CredentialEvent } from './backup-credential-event.js';
import { backupArchiveReceiptPrefix, validateBackupArchiveReceipt } from './backup-archive.js';
import {
  makeCredentialRecoveryManifest,
  credentialRecoveryFiles,
  credentialRecoveryCovers,
  type CredentialRecoveryManifest,
} from './credential-recovery-set.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type CredentialRecoveryRoute = { name: string; destination: string | null };
export type RoutedCredentialInventory = Array<{ event: CredentialEvent; files: CredentialRecoveryRoute[] }>;
export type RoutedCredentialRecoveryManifest = {
  contract: 'cos-credential-recovery-set/v2';
  ownerDigest: string;
  operationId: string;
  contents: CredentialRecoveryManifest;
  origins: Array<{ source: string; files: CredentialRecoveryRoute[] }>;
};
export const ROUTED_CREDENTIAL_MANIFEST_LIMIT = 2 * 1024 ** 2;
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}';
function protect<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovery locations and nested credential diagnostics stay private.
    throw Error('credential_recovery_routing_unavailable');
  }
}
function destinationAllowed(event: CredentialEvent, file: CredentialRecoveryRoute): boolean {
  const names = event.files
    .map((item) => item.name)
    .sort()
    .join(',');
  if (event.sourceKind === 'backup_repository') {
    if (file.name === 'repository.json')
      return names === 'repository.json' && file.destination === 'backup-credentials/backup-repository.json';
    return (
      names === 'backup-credential-installation.json,restic-password,smb-credentials' &&
      file.destination === 'backup-credentials/' + file.name
    );
  }
  if (
    !['calendar_reader', 'calendar_owned_event_writer', 'mail_reader', 'mail_draft_writer'].includes(event.sourceKind)
  )
    return false;
  const draft = event.sourceKind === 'mail_draft_writer',
    mail = event.sourceKind === 'mail_reader' || draft,
    writer = event.sourceKind === 'calendar_owned_event_writer';
  const base = mail ? 'google/calendar/' + (draft ? 'mail-draft-writer' : 'mail-reader') : 'google/calendar',
    credentials = writer ? 'writer-credentials' : 'credentials',
    fences = writer ? 'writer-access-denials' : 'access-denials';
  if (file.name === 'credential.json')
    return (
      names === 'credential.json' &&
      typeof file.destination === 'string' &&
      new RegExp('^' + base + '/' + credentials + '/' + uuid + '\\.json$').test(file.destination)
    );
  if (file.name === 'access-denial.json')
    return (
      names === 'access-denial.json,denial-identity.json' &&
      typeof file.destination === 'string' &&
      new RegExp('^' + base + '/' + fences + '/[a-f0-9]{64}\\.json$').test(file.destination)
    );
  if (file.name === 'denial-identity.json')
    return names === 'access-denial.json,denial-identity.json' && file.destination === null;
  if (names !== 'credential-profile.json,denial-profile.txt,oauth-client.json,profile-proof.json') return false;
  if (file.name === 'oauth-client.json')
    return file.destination === base + '/' + (writer ? 'writer-oauth-client.json' : 'oauth-client.json');
  if (file.name === 'credential-profile.json')
    return (
      file.destination ===
      base +
        '/' +
        credentials +
        '/' +
        credentialRootMarker(
          draft ? 'mail_draft_writer' : mail ? 'mail_reader' : writer ? 'owned_event_writer' : 'reader',
        ).name
    );
  if (file.name === 'denial-profile.txt')
    return file.destination === base + '/' + fences + '/' + accessFenceRootMarker().name;
  if (file.name === 'profile-proof.json')
    return file.destination === (mail ? base + (draft ? '/.cos-mail-draft-writer' : '/.cos-mail-reader') : null);
  return false;
}
function id(value: unknown): string {
  const bytes = Buffer.from(digest(value), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function payloadFiles(manifest: RoutedCredentialRecoveryManifest): BackupQueueReceipt['files'] {
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  try {
    return [
      { name: 'credential-set.json', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ...credentialRecoveryFiles(manifest.contents, manifest.ownerDigest).filter(
        (file) => file.name !== 'credential-set.json',
      ),
    ].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    bytes.fill(0);
  }
}
function assemble(owner: string, inventory: RoutedCredentialInventory): RoutedCredentialRecoveryManifest {
  if (!Array.isArray(inventory)) throw Error('invalid_inventory');
  const contents = makeCredentialRecoveryManifest(
    owner,
    inventory.map((item) => item.event),
  );
  const destinations = new Set<string>();
  const origins = contents.sources.map((event) => {
    const entry = inventory.find((item) => credentialSource(item.event) === credentialSource(event));
    if (
      !entry ||
      !Array.isArray(entry.files) ||
      entry.files.length !== event.files.length ||
      new Set(entry.files.map((file) => file.name)).size !== entry.files.length
    )
      throw Error('missing_origin');
    const files = event.files.map((file) => {
      const route = entry.files.find((item) => item.name === file.name);
      if (!route || !destinationAllowed(event, route)) throw Error('unsafe_origin');
      if (route.destination !== null) {
        if (destinations.has(route.destination)) throw Error('duplicate_destination');
        destinations.add(route.destination);
      }
      return { name: route.name, destination: route.destination };
    });
    return { source: credentialSource(event), files };
  });
  const identity = { contract: 'cos-credential-recovery-set/v2' as const, ownerDigest: owner, contents, origins };
  const manifest = { contract: identity.contract, ownerDigest: owner, operationId: id(identity), contents, origins };
  const files = payloadFiles(manifest);
  if (
    files.find((file) => file.name === 'credential-set.json')!.bytes > ROUTED_CREDENTIAL_MANIFEST_LIMIT ||
    files.reduce((sum, file) => sum + file.bytes, 0) > BACKUP_LIMITS.credentials
  )
    throw Error('routed_set_bounds');
  const prefix = backupArchiveReceiptPrefix({
    format: 'cos-backup-queue/v1',
    ownerDigest: owner,
    operationId: manifest.operationId,
    kind: 'credentials',
    state: 'pending',
    createdAt: '+010000-01-01T00:00:00.000Z',
    maximumBytes: BACKUP_LIMITS.credentials,
    bytes: BACKUP_LIMITS.credentials,
    files,
  });
  prefix.fill(0);
  return manifest;
}
function checked(value: RoutedCredentialRecoveryManifest, owner: string): RoutedCredentialRecoveryManifest {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'contents,contract,operationId,origins,ownerDigest' ||
    value.contract !== 'cos-credential-recovery-set/v2' ||
    value.ownerDigest !== owner ||
    !Array.isArray(value.origins)
  )
    throw Error('invalid_routed_set');
  credentialRecoveryFiles(value.contents, owner);
  if (
    value.origins.length !== value.contents.sources.length ||
    new Set(value.origins.map((origin) => origin.source)).size !== value.origins.length
  )
    throw Error('invalid_origins');
  for (const origin of value.origins)
    if (
      !origin ||
      Object.keys(origin).sort().join(',') !== 'files,source' ||
      !Array.isArray(origin.files) ||
      origin.files.some((file) => !file || Object.keys(file).sort().join(',') !== 'destination,name')
    )
      throw Error('invalid_origin_shape');
  const manifest = assemble(
    owner,
    value.contents.sources.map((event) => ({
      event,
      files: value.origins.find((origin) => origin.source === credentialSource(event))?.files ?? [],
    })),
  );
  if (digest(manifest) !== digest(value)) throw Error('routed_set_identity');
  return manifest;
}
/** Checked isolated-recovery locations are data only, never live restore paths
 * or evidence of a complete primary inventory, repository custody or admission. */
export function makeRoutedCredentialRecoveryManifest(
  owner: string,
  inventory: RoutedCredentialInventory,
): RoutedCredentialRecoveryManifest {
  return protect(() => assemble(owner, inventory));
}
export function routedCredentialRecoveryFiles(
  value: RoutedCredentialRecoveryManifest,
  owner: string,
): BackupQueueReceipt['files'] {
  return protect(() => payloadFiles(checked(value, owner)));
}
export function verifyRoutedCredentialRecoveryReceipt(
  value: RoutedCredentialRecoveryManifest,
  owner: string,
  receipt: BackupQueueReceipt,
  currentInventory: RoutedCredentialInventory,
): void {
  protect(() => {
    const manifest = checked(value, owner);
    validateBackupArchiveReceipt(receipt);
    if (
      Object.keys(receipt).sort().join(',') !==
        'bytes,createdAt,files,format,kind,maximumBytes,operationId,ownerDigest,state' ||
      receipt.ownerDigest !== owner ||
      receipt.kind !== 'credentials' ||
      receipt.operationId !== manifest.operationId ||
      digest(assemble(owner, currentInventory)) !== digest(manifest)
    )
      throw Error('routed_capture_changed');
    const expected = payloadFiles(manifest);
    if (
      digest([...receipt.files].sort((a, b) => a.name.localeCompare(b.name))) !== digest(expected) ||
      expected.reduce((sum, file) => sum + file.bytes, 0) > receipt.bytes
    )
      throw Error('routed_payload_mismatch');
  });
}
/** A necessary metadata check only. Actual remote archive verification, current
 * primary coverage and retained-snapshot selection remain separate requirements. */
export function routedCredentialRecoveryCovers(
  value: RoutedCredentialRecoveryManifest,
  owner: string,
  previous: RoutedCredentialRecoveryManifest,
): boolean {
  return protect(() => {
    const current = checked(value, owner),
      required = checked(previous, owner);
    if (!credentialRecoveryCovers(current.contents, owner, required.contents.sources)) return false;
    return required.origins.every((origin) =>
      origin.files.every((file) =>
        current.origins
          .find((item) => item.source === origin.source)
          ?.files.some((item) => item.name === file.name && item.destination === file.destination),
      ),
    );
  });
}
