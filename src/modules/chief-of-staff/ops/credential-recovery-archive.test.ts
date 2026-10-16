import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { makeCredentialEvent, credentialEventName } from './backup-credential-event.js';
import { makeCredentialRecoveryManifest, credentialRecoveryFiles } from './credential-recovery-set.js';
import { makeRoutedCredentialRecoveryManifest, routedCredentialRecoveryFiles } from './credential-recovery-routing.js';
import { readCredentialRecoveryArchive } from './credential-recovery-archive.js';
const owner = 'a'.repeat(64),
  roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function archive(format: 'change' | 'set-v1' | 'set-v2' | 'unknown' = 'set-v2', problem?: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-credential-readback-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const bytes = Buffer.from('SYNTHETIC_ARCHIVE_TOKEN'),
    event = makeCredentialEvent(
      {
        sourceKind: 'mail_reader',
        sourceKey: 'b'.repeat(64),
        generation: 1,
        phase: 'ready',
        files: [{ name: 'credential.json', bytes }],
      },
      owner,
    ),
    inventory = [
      {
        event,
        files: [
          {
            name: 'credential.json',
            destination: 'google/calendar/mail-reader/credentials/10000000-0000-4000-8000-000000000001.json',
          },
        ],
      },
    ];
  const manifest =
    format === 'set-v1'
      ? makeCredentialRecoveryManifest(owner, [event])
      : makeRoutedCredentialRecoveryManifest(owner, inventory);
  const operationId =
    format === 'change' ? event.operationId : format === 'unknown' ? randomUUID() : manifest.operationId;
  const queue = new BackupQueue(owner, async (_kind, operation) => operation(root));
  if (format === 'change')
    await queue.recordCredential(
      {
        sourceKind: event.sourceKind,
        sourceKey: event.sourceKey,
        generation: 1,
        phase: 'ready',
        files: [{ name: 'credential.json', bytes }],
      },
      () => {},
    );
  else
    await queue.capture('credentials', operationId, async (sink) => {
      if (format === 'unknown') {
        sink.write('arbitrary.bin', bytes);
        return;
      }
      const declaration = structuredClone(manifest);
      if (problem === 'invented') Object.assign(declaration, { complete: true });
      const metadata =
        problem === 'oversize' ? Buffer.alloc(2 * 1024 ** 2 + 1, 65) : Buffer.from(JSON.stringify(declaration) + '\n');
      try {
        sink.write('credential-set.json', metadata);
        if (problem === 'mixed') sink.write(credentialEventName, Buffer.from(JSON.stringify(event) + '\n'));
        const files =
          format === 'set-v1'
            ? credentialRecoveryFiles(makeCredentialRecoveryManifest(owner, [event]), owner)
            : routedCredentialRecoveryFiles(makeRoutedCredentialRecoveryManifest(owner, inventory), owner);
        if (problem !== 'missing')
          for (const file of files.filter((file) => file.name !== 'credential-set.json')) sink.write(file.name, bytes);
      } finally {
        metadata.fill(0);
      }
    });
  const parts: Buffer[] = [];
  await queue.withPending('credentials', operationId, async (directory, receipt) =>
    streamBackupArchive(directory, receipt, async (chunk) => {
      parts.push(Buffer.from(chunk));
    }),
  );
  return { bytes: Buffer.concat(parts), operationId, event, manifest };
}
function stream(bytes: Buffer) {
  return (async function* () {
    for (let offset = 0; offset < bytes.length; offset += 71) yield Buffer.from(bytes.subarray(offset, offset + 71));
  })();
}
for (const format of ['change', 'set-v1', 'set-v2'] as const)
  it(`reads and verifies every payload byte of a ${format} archive while returning metadata only`, async () => {
    const f = await archive(format),
      guard = vi.fn();
    const result = await readCredentialRecoveryArchive(
      stream(f.bytes),
      { ownerDigest: owner, operationId: f.operationId },
      guard,
    );
    expect(result.contents.kind).toBe(format);
    if (result.contract !== 'cos-backup-archive-read/v1') throw Error('legacy_queue_contract_expected');
    expect(result.receipt.operationId).toBe(f.operationId);
    expect(result.archiveBytes).toBe(f.bytes.length);
    expect(JSON.stringify(result)).not.toContain('SYNTHETIC_ARCHIVE_TOKEN');
    expect(guard.mock.calls.length).toBeGreaterThan(10);
    if (result.contents.kind === 'change') expect(result.contents.event).toEqual(f.event);
    else expect(result.contents.manifest).toEqual(f.manifest);
  });
for (const problem of ['invented', 'oversize', 'mixed', 'missing'] as const)
  it(`rejects ${problem} set declarations after checking their actual archive`, async () => {
    const f = await archive('set-v2', problem);
    await expect(
      readCredentialRecoveryArchive(stream(f.bytes), { ownerDigest: owner, operationId: f.operationId }, () => {}),
    ).rejects.toThrow('credential_recovery_archive_unavailable');
  });
it('refuses an unrelated credential archive instead of assuming it is a complete recovery set', async () => {
  const f = await archive('unknown');
  await expect(
    readCredentialRecoveryArchive(stream(f.bytes), { ownerDigest: owner, operationId: f.operationId }, () => {}),
  ).rejects.toThrow('credential_recovery_archive_unavailable');
});
for (const problem of ['owner', 'operation', 'payload', 'truncated', 'scope', 'missing-guard'] as const)
  it(`refuses ${problem} readback without exposing credential content or granting cleanup authority`, async () => {
    const f = await archive();
    let bytes = f.bytes;
    if (problem === 'payload') {
      bytes = Buffer.from(bytes);
      bytes[bytes.indexOf('SYNTHETIC_ARCHIVE_TOKEN')] ^= 1;
    }
    if (problem === 'truncated') bytes = bytes.subarray(0, bytes.length - 1024);
    const guard = vi.fn(() => {
      if (problem === 'scope' && guard.mock.calls.length > 10) throw Error('PRIVATE_SCOPE');
    });
    await expect(
      readCredentialRecoveryArchive(
        stream(bytes),
        {
          ownerDigest: problem === 'owner' ? 'c'.repeat(64) : owner,
          operationId: problem === 'operation' ? randomUUID() : f.operationId,
        },
        problem === 'missing-guard' ? (undefined as unknown as () => void) : guard,
      ),
    ).rejects.toThrow('credential_recovery_archive_unavailable');
  });
