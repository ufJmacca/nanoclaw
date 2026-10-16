import { createHash } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { makeCredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { credentialRootMarker } from '../calendar/credential-core.js';
import { readCredentialRecoveryArchive } from './credential-recovery-archive.js';
import {
  makeCredentialCapture,
  credentialCaptureArchiveBytes,
  streamCredentialCapture,
  readCredentialCaptureArchive,
} from './credential-capture.js';
const owner = 'a'.repeat(64),
  cycle = '2026-10-16T00:00:00.000Z';
function fixture() {
  const token = Buffer.from('SYNTHETIC_COMPLETE_TOKEN'),
    reference = '10000000-0000-4000-8000-000000000001';
  const config = [
    {
      name: 'oauth-client.json',
      destination: 'google/calendar/mail-reader/oauth-client.json',
      bytes: Buffer.from('SYNTHETIC_CLIENT'),
    },
    {
      name: 'credential-profile.json',
      destination: 'google/calendar/mail-reader/credentials/' + credentialRootMarker('mail_reader').name,
      bytes: Buffer.from('SYNTHETIC_PROFILE'),
    },
    {
      name: 'denial-profile.txt',
      destination: 'google/calendar/mail-reader/access-denials/.cos-calendar-fences',
      bytes: Buffer.from('SYNTHETIC_FENCES'),
    },
    {
      name: 'profile-proof.json',
      destination: 'google/calendar/mail-reader/.cos-mail-reader',
      bytes: Buffer.from('SYNTHETIC_PROOF'),
    },
  ];
  const sources = [
    {
      event: makeCredentialEvent(
        {
          sourceKind: 'mail_reader',
          sourceKey: 'b'.repeat(64),
          generation: 1,
          phase: 'ready',
          files: [{ name: 'credential.json', bytes: token }],
        },
        owner,
      ),
      files: [
        {
          name: 'credential.json',
          destination: 'google/calendar/mail-reader/credentials/' + reference + '.json',
          bytes: token,
        },
      ],
    },
    {
      event: makeCredentialEvent(
        { sourceKind: 'mail_reader', sourceKey: 'c'.repeat(64), generation: 1, phase: 'ready', files: config },
        owner,
      ),
      files: config,
    },
  ];
  const set = makeRoutedCredentialRecoveryManifest(owner, sources),
    capture = makeCredentialCapture(owner, cycle, set),
    guard = vi.fn();
  return { token, sources, set, capture, guard, snapshot: { ownerDigest: owner, sources, assertCurrent: guard } };
}
async function archive() {
  const f = fixture(),
    chunks: Buffer[] = [];
  const measured = await streamCredentialCapture(f.snapshot, f.capture, async (bytes) => {
    chunks.push(Buffer.from(bytes));
  });
  return { ...f, bytes: Buffer.concat(chunks), measured };
}
function source(bytes: Buffer) {
  return (async function* () {
    for (let offset = 0; offset < bytes.length; offset += 71) yield Buffer.from(bytes.subarray(offset, offset + 71));
  })();
}
it('binds canonical source content and an explicit hourly cycle into a stable capture identity', () => {
  const f = fixture();
  expect(makeCredentialCapture(owner, cycle, structuredClone(f.set))).toEqual(f.capture);
  expect(makeCredentialCapture(owner, '2026-10-16T01:00:00.000Z', f.set).operationId).not.toBe(f.capture.operationId);
  expect(JSON.stringify(f.capture)).not.toContain('SYNTHETIC_COMPLETE_TOKEN');
  expect(JSON.stringify(f.capture)).not.toContain('cos-backup-queue/v1');
});
for (const invalid of ['2026-10-16T00:01:00.000Z', '2026-02-30T00:00:00.000Z', '2026-10-16T00:00:00Z', 'invalid'])
  it(`refuses noncanonical capture cycle ${invalid}`, () => {
    const f = fixture();
    expect(() => makeCredentialCapture(owner, invalid, f.set)).toThrow('credential_capture_unavailable');
  });
it('streams and reads a full capture with every payload checked and no queue receipt or staging copy', async () => {
  const f = await archive(),
    restored = new Map<string, Buffer[]>();
  const result = await readCredentialCaptureArchive(
    source(f.bytes),
    { ownerDigest: owner, operationId: f.capture.operationId },
    f.guard,
    {
      open: async (name) => {
        restored.set(name, []);
        return {
          write: async (bytes) => {
            restored.get(name)!.push(Buffer.from(bytes));
          },
          close: async () => {},
        };
      },
    },
  );
  expect(result.capture).toEqual(f.capture);
  expect(result.archiveBytes).toBe(f.bytes.length);
  expect(result.archiveSha256).toBe(createHash('sha256').update(f.bytes).digest('hex'));
  expect(f.measured).toEqual({ bytes: f.bytes.length, sha256: result.archiveSha256 });
  expect(credentialCaptureArchiveBytes(f.capture, owner)).toBe(f.bytes.length);
  expect(restored.size).toBe(5);
  expect([...restored.values()].some((chunks) => Buffer.concat(chunks).equals(f.token))).toBe(true);
  expect(f.token.toString('utf8')).toBe('SYNTHETIC_COMPLETE_TOKEN');
  expect('receipt' in result).toBe(false);
});
for (const problem of ['missing-source', 'changed-bytes', 'foreign-owner', 'invented-field', 'scope'] as const)
  it(`refuses ${problem} before emitting private capture bytes`, async () => {
    const f = fixture(),
      emit = vi.fn(async () => {});
    if (problem === 'missing-source') f.snapshot.sources.pop();
    if (problem === 'changed-bytes') f.token[0] ^= 1;
    if (problem === 'foreign-owner') f.snapshot.ownerDigest = 'd'.repeat(64);
    if (problem === 'invented-field') Object.assign(f.capture, { authority: true });
    if (problem === 'scope')
      f.guard.mockImplementation(() => {
        throw Error('PRIVATE_SCOPE');
      });
    await expect(streamCredentialCapture(f.snapshot, f.capture, emit)).rejects.toThrow(
      'credential_capture_unavailable',
    );
    expect(emit).not.toHaveBeenCalled();
  });
it('checks current protection after awaited output and clears every borrowed output chunk', async () => {
  const f = fixture(),
    borrowed: Buffer[] = [];
  await expect(
    streamCredentialCapture(f.snapshot, f.capture, async (bytes) => {
      borrowed.push(bytes);
      f.guard.mockImplementation(() => {
        throw Error('PRIVATE_SCOPE');
      });
    }),
  ).rejects.toThrow('credential_capture_unavailable');
  expect(borrowed.length).toBe(1);
  expect(borrowed.every((bytes) => bytes.every((byte) => byte === 0))).toBe(true);
});
it('does not claim success if borrowed source bytes change during awaited streaming', async () => {
  const f = fixture();
  let changed = false;
  await expect(
    streamCredentialCapture(f.snapshot, f.capture, async () => {
      if (!changed) {
        changed = true;
        f.token[0] ^= 1;
      }
    }),
  ).rejects.toThrow('credential_capture_unavailable');
});
it('recognizes the complete transport through the retained-archive reader without treating it as a queue receipt', async () => {
  const f = await archive();
  const result = await readCredentialRecoveryArchive(
    source(f.bytes),
    { ownerDigest: owner, operationId: f.capture.operationId },
    f.guard,
  );
  expect(result.contract).toBe('cos-credential-capture-read/v1');
  expect(result.contents).toEqual({ kind: 'set-v2', manifest: f.capture.set });
  expect('receipt' in result).toBe(false);
});
it('rejects a failed input close and wipes the consumed bytes when dispatching a complete capture', async () => {
  const f = await archive(),
    chunk = Buffer.from(f.bytes);
  let delivered = false,
    returned = 0;
  const input = {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        delivered
          ? { done: true as const, value: undefined }
          : ((delivered = true), { done: false as const, value: chunk }),
      return: async () => {
        returned++;
        throw Error('PRIVATE_CLOSE');
      },
    }),
  };
  await expect(
    readCredentialRecoveryArchive(input, { ownerDigest: owner, operationId: f.capture.operationId }, f.guard),
  ).rejects.toThrow('credential_recovery_archive_unavailable');
  expect(returned).toBe(1);
  expect(chunk.every((byte) => byte === 0)).toBe(true);
});
for (const problem of ['owner', 'operation', 'body', 'header', 'truncated', 'trailing', 'scope'] as const)
  it(`refuses ${problem} capture readback without returning credential material`, async () => {
    const f = await archive();
    let bytes = Buffer.from(f.bytes);
    if (problem === 'body') bytes[bytes.indexOf('SYNTHETIC_COMPLETE_TOKEN')] ^= 1;
    if (problem === 'header') bytes[0] ^= 1;
    if (problem === 'truncated') bytes = bytes.subarray(0, bytes.length - 1024);
    if (problem === 'trailing') bytes = Buffer.concat([bytes, Buffer.from('PRIVATE_TRAILING')]);
    if (problem === 'scope')
      f.guard.mockImplementation(() => {
        throw Error('PRIVATE_SCOPE');
      });
    await expect(
      readCredentialCaptureArchive(
        source(bytes),
        {
          ownerDigest: problem === 'owner' ? 'd'.repeat(64) : owner,
          operationId: problem === 'operation' ? '10000000-0000-4000-8000-000000000001' : f.capture.operationId,
        },
        f.guard,
      ),
    ).rejects.toThrow('credential_capture_unavailable');
  });
