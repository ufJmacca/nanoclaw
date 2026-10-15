import { readBackupArchive, type BackupArchiveReadResult } from './backup-archive-reader.js';
import { credentialEventName, credentialHead, type CredentialEvent } from './backup-credential-event.js';
import { verifyCredentialRecoveryReceipt, type CredentialRecoveryManifest } from './credential-recovery-set.js';
import {
  verifyRoutedCredentialRecoveryReceipt,
  ROUTED_CREDENTIAL_MANIFEST_LIMIT,
  type RoutedCredentialRecoveryManifest,
} from './credential-recovery-routing.js';
import { credentialSource } from './backup-credential-event.js';
export type CredentialRecoveryArchive = BackupArchiveReadResult & {
  contents:
    | { kind: 'change'; event: CredentialEvent }
    | { kind: 'set-v1'; manifest: CredentialRecoveryManifest }
    | { kind: 'set-v2'; manifest: RoutedCredentialRecoveryManifest };
};
/** Hashes and checks the complete canonical archive, retaining only bounded
 * credential metadata. This establishes archive contents, not that the source
 * inventory is complete/current or that a NAS snapshot will remain retained.
 * The caller supplies the actual source and its live repository/owner guard.
 * No credential bytes are written to disk or returned; old formats remain
 * readable and no parsed record grants restore, admission or cleanup authority. */
export async function readCredentialRecoveryArchive(
  source: AsyncIterable<Buffer>,
  expected: { ownerDigest: string; operationId: string },
  assertCurrent: () => void,
): Promise<CredentialRecoveryArchive> {
  const metadata = new Map<string, Buffer>();
  try {
    expected = Object.freeze({ ...expected });
    if (Object.keys(expected).sort().join(',') !== 'operationId,ownerDigest' || typeof assertCurrent !== 'function')
      throw Error('archive_scope_required');
    assertCurrent();
    const result = await readBackupArchive(
      source,
      { ...expected, kind: 'credentials' },
      {
        open: async (name, size) => {
          assertCurrent();
          const selected = name === 'credential-set.json' || name === credentialEventName;
          const maximum = name === 'credential-set.json' ? ROUTED_CREDENTIAL_MANIFEST_LIMIT : 16384;
          if (selected && (size < 1 || size > maximum || metadata.size || metadata.has(name)))
            throw Error('credential_metadata_conflict');
          const bytes = selected ? Buffer.alloc(size) : undefined;
          if (bytes) metadata.set(name, bytes);
          let offset = 0,
            closed = false;
          return {
            write: async (chunk) => {
              assertCurrent();
              if (closed || offset + chunk.length > size) throw Error('credential_metadata_changed');
              if (bytes) chunk.copy(bytes, offset);
              offset += chunk.length;
              assertCurrent();
            },
            close: async () => {
              assertCurrent();
              if (closed || offset !== size) throw Error('credential_metadata_incomplete');
              closed = true;
            },
          };
        },
      },
      assertCurrent,
    );
    assertCurrent();
    const decode = (bytes: Buffer) => JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const change = metadata.get(credentialEventName),
      set = metadata.get('credential-set.json');
    let contents: CredentialRecoveryArchive['contents'];
    if (change && !set) {
      const event = decode(change) as CredentialEvent;
      credentialHead(event, result.receipt);
      contents = { kind: 'change', event };
    } else if (set && !change) {
      const value = decode(set) as CredentialRecoveryManifest | RoutedCredentialRecoveryManifest;
      if (value.contract === 'cos-credential-recovery-set/v1') {
        verifyCredentialRecoveryReceipt(value, expected.ownerDigest, result.receipt, value.sources);
        contents = { kind: 'set-v1', manifest: value };
      } else if (value.contract === 'cos-credential-recovery-set/v2') {
        verifyRoutedCredentialRecoveryReceipt(
          value,
          expected.ownerDigest,
          result.receipt,
          value.contents.sources.map((event) => ({
            event,
            files: value.origins.find((origin) => origin.source === credentialSource(event))?.files ?? [],
          })),
        );
        contents = { kind: 'set-v2', manifest: value };
      } else throw Error('credential_set_contract');
    } else throw Error('credential_metadata_missing');
    assertCurrent();
    return { ...result, contents };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Raw archive, credential and nested repository diagnostics must stay private.
    throw Error('credential_recovery_archive_unavailable');
  } finally {
    for (const bytes of metadata.values()) bytes.fill(0);
  }
}
