import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { backupArchiveEntryPrefix } from './backup-archive.js';
import { BackupArchiveStreamReader, type BackupArchiveRestoreSink } from './backup-archive-reader.js';
import { credentialSource } from './backup-credential-event.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  ROUTED_CREDENTIAL_MANIFEST_LIMIT,
  type RoutedCredentialRecoveryManifest,
} from './credential-recovery-routing.js';
import type { VaultCredentialSnapshot } from './credential-vault-snapshot.js';
import { BACKUP_LIMITS } from './backup-policy.js';
export type CredentialCapture = {
  contract: 'cos-credential-capture/v1';
  ownerDigest: string;
  operationId: string;
  /** Scheduling identity only, never a claim about source or backup freshness. */
  cycleAt: string;
  set: RoutedCredentialRecoveryManifest;
};
export type CredentialCaptureRead = {
  contract: 'cos-credential-capture-read/v1';
  capture: CredentialCapture;
  archiveBytes: number;
  archiveSha256: string;
};
export const CREDENTIAL_CAPTURE_ENTRY = 'cos-credential-capture.json';
const maximum = BACKUP_LIMITS.credentials + 2 * 1024 ** 2,
  metadataMaximum = ROUTED_CREDENTIAL_MANIFEST_LIMIT + 4096;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function protect<T>(operation: () => T): T {
  try {
    return operation();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Capture paths, contents and nested credential diagnostics remain private.
    throw Error('credential_capture_unavailable');
  }
}
function operationId(identity: unknown) {
  const bytes = Buffer.from(digest(identity), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const value = bytes.toString('hex');
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
/** A capture cycle wraps immutable source content with its own identity. It is
 * not a queue receipt, allocated staging claim, provider grant or live lease. */
export function makeCredentialCapture(
  owner: string,
  cycleAt: string,
  set: RoutedCredentialRecoveryManifest,
): CredentialCapture {
  return protect(() => {
    if (
      typeof cycleAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(cycleAt) ||
      !Number.isFinite(Date.parse(cycleAt)) ||
      new Date(cycleAt).toISOString() !== cycleAt
    )
      throw Error('capture_cycle');
    routedCredentialRecoveryFiles(set, owner);
    const canonical = makeRoutedCredentialRecoveryManifest(
      owner,
      set.contents.sources.map((event) => ({
        event,
        files: set.origins.find((origin) => origin.source === credentialSource(event))!.files,
      })),
    );
    const identity = { contract: 'cos-credential-capture/v1' as const, ownerDigest: owner, cycleAt, set: canonical };
    return {
      contract: identity.contract,
      ownerDigest: owner,
      operationId: operationId(identity),
      cycleAt,
      set: canonical,
    };
  });
}
function checked(value: CredentialCapture, owner: string) {
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'contract,cycleAt,operationId,ownerDigest,set' ||
    value.contract !== 'cos-credential-capture/v1' ||
    value.ownerDigest !== owner
  )
    throw Error('capture_identity');
  const canonical = makeCredentialCapture(owner, value.cycleAt, value.set);
  if (digest(canonical) !== digest(value)) throw Error('capture_identity');
  return canonical;
}
const files = (capture: CredentialCapture) =>
  routedCredentialRecoveryFiles(capture.set, capture.ownerDigest).filter((file) => file.name !== 'credential-set.json');
/** Exact encoded preflight; includes canonical metadata, PAX headers and padding. */
export function credentialCaptureArchiveBytes(value: CredentialCapture, owner: string): number {
  return protect(() => {
    const capture = checked(value, owner),
      metadata = Buffer.from(JSON.stringify(capture) + '\n');
    try {
      if (metadata.length > metadataMaximum) throw Error('capture_metadata_bounds');
      let bytes = 512 + metadata.length + ((512 - (metadata.length % 512)) % 512) + 1024;
      for (const [index, file] of files(capture).entries()) {
        const prefix = backupArchiveEntryPrefix('payload/' + file.name, file.bytes, index + 1);
        bytes += prefix.length + file.bytes + ((512 - (file.bytes % 512)) % 512);
        prefix.fill(0);
      }
      if (!Number.isSafeInteger(bytes) || bytes > maximum) throw Error('capture_archive_bounds');
      return bytes;
    } finally {
      metadata.fill(0);
    }
  });
}
/** No disk staging. The caller supplies an independently checked primary
 * snapshot under real storage/memory/owner guards. Only copied output chunks
 * are borrowed by the emitter; source buffers retain their owner's lifetime. */
export async function streamCredentialCapture(
  snapshot: Pick<VaultCredentialSnapshot, 'ownerDigest' | 'sources' | 'assertCurrent'>,
  value: CredentialCapture,
  emit: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  let metadata: Buffer | undefined;
  try {
    if (typeof snapshot?.assertCurrent !== 'function' || typeof emit !== 'function') throw Error('capture_scope');
    snapshot.assertCurrent();
    const capture = checked(value, snapshot.ownerDigest),
      expectedBytes = credentialCaptureArchiveBytes(capture, snapshot.ownerDigest);
    if (digest(makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources)) !== digest(capture.set))
      throw Error('capture_source_changed');
    const payload = new Map<string, Buffer>();
    for (const source of snapshot.sources)
      for (const file of source.files) {
        const name = 'credential-sources/' + credentialSource(source.event) + '/' + file.name;
        if (!Buffer.isBuffer(file.bytes) || payload.has(name)) throw Error('capture_payload');
        payload.set(name, file.bytes);
      }
    const selected = files(capture);
    for (const file of selected) {
      const bytes = payload.get(file.name);
      if (!bytes || bytes.length !== file.bytes || hash(bytes) !== file.sha256) throw Error('capture_payload');
    }
    if (payload.size !== selected.length) throw Error('capture_payload');
    metadata = Buffer.from(JSON.stringify(capture) + '\n');
    const checksum = createHash('sha256');
    let count = 0;
    const send = async (bytes: Buffer) => {
      try {
        snapshot.assertCurrent();
        if (bytes.length < 1 || bytes.length > 65536 || count + bytes.length > expectedBytes)
          throw Error('capture_stream_bounds');
        checksum.update(bytes);
        count += bytes.length;
        await emit(bytes);
        snapshot.assertCurrent();
      } finally {
        bytes.fill(0);
      }
    };
    const body = async (bytes: Buffer) => {
      for (let offset = 0; offset < bytes.length; offset += 65536)
        await send(Buffer.from(bytes.subarray(offset, offset + 65536)));
      if (bytes.length % 512) await send(Buffer.alloc(512 - (bytes.length % 512)));
    };
    await send(backupArchiveEntryPrefix(CREDENTIAL_CAPTURE_ENTRY, metadata.length, 0));
    await body(metadata);
    for (const [index, file] of selected.entries()) {
      const bytes = payload.get(file.name)!;
      await send(backupArchiveEntryPrefix('payload/' + file.name, file.bytes, index + 1));
      if (hash(bytes) !== file.sha256) throw Error('capture_payload_changed');
      await body(bytes);
      if (hash(bytes) !== file.sha256) throw Error('capture_payload_changed');
    }
    await send(Buffer.alloc(1024));
    snapshot.assertCurrent();
    if (count !== expectedBytes) throw Error('capture_stream_bounds');
    return { bytes: count, sha256: checksum.digest('hex') };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- A failed command producer must emit only a fixed private failure, never source content in diagnostics.
    throw Error('credential_capture_unavailable');
  } finally {
    metadata?.fill(0);
  }
}
/** Validates the complete new transport and optionally writes declared payload
 * bytes to an explicitly supplied isolated sink. Parsed data never grants live
 * restoration, admission, model allowance or queue-retirement authority. */
export async function readCredentialCaptureArchive(
  source: AsyncIterable<Buffer>,
  expected: { ownerDigest: string; operationId: string },
  assertCurrent: () => void,
  sink?: BackupArchiveRestoreSink,
): Promise<CredentialCaptureRead> {
  let reader: BackupArchiveStreamReader | undefined,
    first: Buffer | undefined,
    metadata: Buffer | undefined,
    canonicalBytes: Buffer | undefined,
    result: CredentialCaptureRead | undefined,
    failed = false;
  try {
    expected = Object.freeze({ ...expected });
    if (
      Object.keys(expected).sort().join(',') !== 'operationId,ownerDigest' ||
      typeof assertCurrent !== 'function' ||
      (sink !== undefined && typeof sink.open !== 'function')
    )
      throw Error('capture_read_scope');
    assertCurrent();
    reader = new BackupArchiveStreamReader(source, maximum, assertCurrent);
    first = await reader.read(512);
    const field = first.subarray(124, 136).toString('latin1');
    if (!/^[0-7]{11}\0$/.test(field)) throw Error('capture_metadata_size');
    const size = Number.parseInt(field.slice(0, -1), 8);
    if (size < 1 || size > metadataMaximum) throw Error('capture_metadata_bounds');
    const framing = backupArchiveEntryPrefix(CREDENTIAL_CAPTURE_ENTRY, size, 0);
    try {
      if (!first.equals(framing)) throw Error('capture_header');
    } finally {
      framing.fill(0);
    }
    metadata = Buffer.alloc(size);
    let offset = 0;
    await reader.consume(size, async (bytes) => {
      bytes.copy(metadata!, offset);
      offset += bytes.length;
    });
    const capture = checked(
      JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata)),
      expected.ownerDigest,
    );
    if (capture.operationId !== expected.operationId) throw Error('capture_operation');
    const expectedBytes = credentialCaptureArchiveBytes(capture, expected.ownerDigest);
    canonicalBytes = Buffer.from(JSON.stringify(capture) + '\n');
    if (!metadata.equals(canonicalBytes)) throw Error('capture_canonical_metadata');
    await reader.padding(size);
    for (const [index, file] of files(capture).entries()) {
      const prefix = backupArchiveEntryPrefix('payload/' + file.name, file.bytes, index + 1);
      try {
        await reader.match(prefix);
      } finally {
        prefix.fill(0);
      }
      let output: Awaited<ReturnType<BackupArchiveRestoreSink['open']>> | undefined;
      try {
        assertCurrent();
        output = await sink?.open(file.name, file.bytes);
        assertCurrent();
        if (sink && (typeof output?.write !== 'function' || typeof output.close !== 'function'))
          throw Error('capture_sink');
        const checksum = createHash('sha256');
        await reader.consume(file.bytes, async (bytes) => {
          checksum.update(bytes);
          await output?.write(bytes);
        });
        if (checksum.digest('hex') !== file.sha256) throw Error('capture_payload_changed');
        await reader.padding(file.bytes);
        assertCurrent();
      } finally {
        await output?.close();
      }
    }
    await reader.match(Buffer.alloc(1024));
    const archiveSha256 = await reader.complete();
    assertCurrent();
    if (reader.bytes !== expectedBytes) throw Error('capture_stream_bounds');
    result = { contract: 'cos-credential-capture-read/v1', capture, archiveBytes: reader.bytes, archiveSha256 };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Close the private transport and clear owned buffers before reporting fixed failure.
  } catch {
    failed = true;
  } finally {
    first?.fill(0);
    metadata?.fill(0);
    canonicalBytes?.fill(0);
    try {
      await reader?.close();
      if (!failed) assertCurrent();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Failure to close the transport invalidates completion.
    } catch {
      failed = true;
    }
  }
  if (failed || !result) throw Error('credential_capture_unavailable');
  return result;
}
