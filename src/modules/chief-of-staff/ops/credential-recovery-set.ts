import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import {
  credentialOrder,
  credentialSource,
  validateCredentialEvent,
  type CredentialEvent,
} from './backup-credential-event.js';
import { backupArchiveReceiptPrefix, validateBackupArchiveReceipt } from './backup-archive.js';
import type { BackupQueueReceipt } from './backup-queue.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type CredentialRecoveryManifest = {
  contract: 'cos-credential-recovery-set/v1';
  ownerDigest: string;
  operationId: string;
  sources: CredentialEvent[];
};
const manifestName = 'credential-set.json';
function protectedResult<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private source identities and receipt diagnostics are not recovery or administrative output.
    throw Error('credential_recovery_set_unavailable');
  }
}
function events(owner: string, value: CredentialEvent[]): CredentialEvent[] {
  if (!/^[a-f0-9]{64}$/.test(owner) || !Array.isArray(value) || !value.length || value.length > 1024)
    throw Error('source_inventory_bounds');
  const selected = value
    .map((event) => {
      validateCredentialEvent(event, owner);
      return {
        contract: event.contract,
        ownerDigest: event.ownerDigest,
        sourceKind: event.sourceKind,
        sourceKey: event.sourceKey,
        generation: event.generation,
        phase: event.phase,
        files: event.files.map((file) => ({ name: file.name, bytes: file.bytes, sha256: file.sha256 })),
        operationId: event.operationId,
      };
    })
    .sort((a, b) => credentialSource(a).localeCompare(credentialSource(b)));
  if (
    new Set(selected.map(credentialSource)).size !== selected.length ||
    selected.reduce((total, event) => total + event.files.length, 1) > 4096
  )
    throw Error('duplicate_or_unbounded_sources');
  return selected;
}
function operationId(value: unknown): string {
  const bytes = Buffer.from(digest(value), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const id = bytes.toString('hex');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
function assemble(owner: string, sourceEvents: CredentialEvent[]): CredentialRecoveryManifest {
  const identity = {
    contract: 'cos-credential-recovery-set/v1' as const,
    ownerDigest: owner,
    sources: events(owner, sourceEvents),
  };
  const manifest = {
    contract: identity.contract,
    ownerDigest: owner,
    operationId: operationId(identity),
    sources: identity.sources,
  };
  const bytes = Buffer.byteLength(JSON.stringify(manifest) + '\n');
  if (
    bytes > 1024 ** 2 ||
    bytes +
      manifest.sources.reduce((total, event) => total + event.files.reduce((sum, file) => sum + file.bytes, 0), 0) >
      BACKUP_LIMITS.credentials
  )
    throw Error('credential_set_capacity');
  const prefix = backupArchiveReceiptPrefix({
    format: 'cos-backup-queue/v1',
    ownerDigest: owner,
    kind: 'credentials',
    operationId: manifest.operationId,
    state: 'pending',
    createdAt: '+010000-01-01T00:00:00.000Z',
    maximumBytes: BACKUP_LIMITS.credentials,
    bytes: BACKUP_LIMITS.credentials,
    files: payloadFiles(manifest),
  });
  prefix.fill(0);
  return manifest;
}
function payloadFiles(manifest: CredentialRecoveryManifest): BackupQueueReceipt['files'] {
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  try {
    return [
      { name: manifestName, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
      ...manifest.sources.flatMap((event) =>
        event.files.map((file) => ({
          ...file,
          name: 'credential-sources/' + credentialSource(event) + '/' + file.name,
        })),
      ),
    ].sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    bytes.fill(0);
  }
}
function checked(value: CredentialRecoveryManifest, owner: string): CredentialRecoveryManifest {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'contract,operationId,ownerDigest,sources' ||
    value.contract !== 'cos-credential-recovery-set/v1' ||
    value.ownerDigest !== owner
  )
    throw Error('credential_set_identity');
  const manifest = assemble(owner, value.sources);
  if (digest(manifest) !== digest(value)) throw Error('credential_set_identity');
  return manifest;
}
/** A bounded declaration of captured sources, not an attestation that an
 * inventory is complete. Capture must use an independent current primary
 * inventory and validate the resulting archive bytes before remote retirement. */
export function makeCredentialRecoveryManifest(
  owner: string,
  sourceEvents: CredentialEvent[],
): CredentialRecoveryManifest {
  return protectedResult(() => assemble(owner, sourceEvents));
}
export function credentialRecoveryFiles(value: CredentialRecoveryManifest, owner: string): BackupQueueReceipt['files'] {
  return protectedResult(() => payloadFiles(checked(value, owner)));
}
/** Metadata consistency only. This grants neither restore nor prune authority.
 * The independent primary inventory must still be current, and the existing
 * transport must verify all payload bytes and the remote repository/receipt. */
export function verifyCredentialRecoveryReceipt(
  value: CredentialRecoveryManifest,
  owner: string,
  receipt: BackupQueueReceipt,
  currentInventory: CredentialEvent[],
): void {
  protectedResult(() => {
    const manifest = checked(value, owner);
    validateBackupArchiveReceipt(receipt);
    if (
      Object.keys(receipt).sort().join(',') !==
        'bytes,createdAt,files,format,kind,maximumBytes,operationId,ownerDigest,state' ||
      receipt.ownerDigest !== owner ||
      receipt.kind !== 'credentials' ||
      receipt.operationId !== manifest.operationId ||
      digest(events(owner, currentInventory)) !== digest(manifest.sources)
    )
      throw Error('credential_capture_changed');
    const expected = credentialRecoveryFiles(manifest, owner);
    if (
      digest([...receipt.files].sort((a, b) => a.name.localeCompare(b.name))) !== digest(expected) ||
      expected.reduce((sum, file) => sum + file.bytes, 0) > receipt.bytes
    )
      throw Error('credential_set_payload_mismatch');
  });
}
/** Older event content is covered only by the same source's later ordered
 * state, or an identical equal-order event. This is one input to a live,
 * independently verified retained-set check; a manifest alone grants nothing. */
export function credentialRecoveryCovers(
  value: CredentialRecoveryManifest,
  owner: string,
  required: CredentialEvent[],
): boolean {
  return protectedResult(() => {
    const manifest = checked(value, owner),
      current = new Map(manifest.sources.map((event) => [credentialSource(event), event]));
    return events(owner, required).every((event) => {
      const retained = current.get(credentialSource(event));
      return (
        !!retained &&
        (credentialOrder(retained) > credentialOrder(event) ||
          (credentialOrder(retained) === credentialOrder(event) && retained.operationId === event.operationId))
      );
    });
  });
}
