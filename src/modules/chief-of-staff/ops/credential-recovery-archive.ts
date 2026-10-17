import { readBackupArchive, type BackupArchiveReadResult } from './backup-archive-reader.js';
import { credentialEventName, credentialHead, type CredentialEvent } from './backup-credential-event.js';
import { verifyCredentialRecoveryReceipt, type CredentialRecoveryManifest } from './credential-recovery-set.js';
import {
  verifyRoutedCredentialRecoveryReceipt,
  ROUTED_CREDENTIAL_MANIFEST_LIMIT,
  type RoutedCredentialRecoveryManifest,
} from './credential-recovery-routing.js';
import { credentialSource } from './backup-credential-event.js';
import {
  readCredentialCaptureArchive,
  CREDENTIAL_CAPTURE_ENTRY,
  type CredentialCaptureRead,
} from './credential-capture.js';
type LegacyCredentialRecoveryArchive = BackupArchiveReadResult & {
  contents:
    | { kind: 'change'; event: CredentialEvent }
    | { kind: 'set-v1'; manifest: CredentialRecoveryManifest }
    | { kind: 'set-v2'; manifest: RoutedCredentialRecoveryManifest };
};
export type CredentialRecoveryArchive =
  | LegacyCredentialRecoveryArchive
  | (CredentialCaptureRead & {
      contents: { kind: 'set-v2'; manifest: RoutedCredentialRecoveryManifest };
    });
/** Hashes and checks the complete canonical archive, retaining only bounded
 * credential metadata. This establishes archive contents, not that the source
 * inventory is complete/current or that a NAS snapshot will remain retained.
 * The caller supplies the actual source and its live repository/owner guard.
 * No credential bytes are written to disk or returned; old formats remain
 * readable and no parsed record grants restore, admission or cleanup authority. */
async function readLegacyCredentialArchive(
  source: AsyncIterable<Buffer>,
  expected: { ownerDigest: string; operationId: string },
  assertCurrent: () => void,
): Promise<LegacyCredentialRecoveryArchive> {
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
    let contents: LegacyCredentialRecoveryArchive['contents'];
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
/** Dispatch by a bounded canonical first entry only. Both readers verify their
 * full format and every payload byte. The consumed input remains owned and
 * wiped through failure/close, including a failed format selection. */
export async function readCredentialRecoveryArchive(
  source: AsyncIterable<Buffer>,
  expected: { ownerDigest: string; operationId: string },
  assertCurrent: () => void,
): Promise<CredentialRecoveryArchive> {
  const first = Buffer.alloc(512),
    buffered: Buffer[] = [];
  let iterator: AsyncIterator<Buffer> | undefined,
    replay: AsyncGenerator<Buffer> | undefined,
    returned = false,
    result: CredentialRecoveryArchive | undefined,
    failed = false;
  const close = async () => {
    if (!iterator || returned) return;
    returned = true;
    const end = await iterator.return?.();
    if (Buffer.isBuffer(end?.value)) end.value.fill(0);
  };
  try {
    if (typeof assertCurrent !== 'function') throw Error('archive_scope_required');
    assertCurrent();
    iterator = source[Symbol.asyncIterator]();
    let offset = 0;
    while (offset < first.length) {
      const next = await iterator.next();
      if (Buffer.isBuffer(next.value)) buffered.push(next.value);
      assertCurrent();
      if (next.done || !Buffer.isBuffer(next.value) || next.value.length < 1 || next.value.length > 65536)
        throw Error('archive_first_entry');
      const count = Math.min(first.length - offset, next.value.length);
      next.value.copy(first, offset, 0, count);
      offset += count;
    }
    replay = (async function* () {
      try {
        for (const bytes of buffered) {
          assertCurrent();
          yield bytes;
        }
        while (true) {
          const next = await iterator!.next();
          try {
            assertCurrent();
            if (next.done) return;
            if (!Buffer.isBuffer(next.value) || next.value.length < 1 || next.value.length > 65536)
              throw Error('archive_chunk_bounds');
            yield next.value;
          } finally {
            if (Buffer.isBuffer(next.value)) next.value.fill(0);
          }
        }
      } finally {
        for (const bytes of buffered) bytes.fill(0);
        await close();
      }
    })();
    const name = first.subarray(0, 100).toString('ascii').replace(/\0.*$/, '');
    if (name === CREDENTIAL_CAPTURE_ENTRY) {
      const read = await readCredentialCaptureArchive(replay, expected, assertCurrent);
      result = { ...read, contents: { kind: 'set-v2', manifest: read.capture.set } };
    } else result = await readLegacyCredentialArchive(replay, expected, assertCurrent);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Clear and close all input before returning a fixed diagnostic.
  } catch {
    failed = true;
  } finally {
    first.fill(0);
    for (const bytes of buffered) bytes.fill(0);
    try {
      await replay?.return(undefined);
      await close();
      if (!failed) assertCurrent();
      // eslint-disable-next-line no-catch-all/no-catch-all -- A failed source close invalidates completed readback.
    } catch {
      failed = true;
    }
  }
  if (failed || !result) throw Error('credential_recovery_archive_unavailable');
  return result;
}
