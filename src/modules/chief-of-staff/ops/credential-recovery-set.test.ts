import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { makeCredentialEvent, type CredentialEvent } from './backup-credential-event.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import {
  makeCredentialRecoveryManifest,
  credentialRecoveryFiles,
  credentialRecoveryCovers,
  verifyCredentialRecoveryReceipt,
} from './credential-recovery-set.js';
const owner = 'a'.repeat(64),
  roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function source(
  key: string,
  text: string,
  generation = 1,
  phase: 'ready' | 'refreshing' | 'uncertain' | 'revoked' = 'ready',
) {
  const bytes = Buffer.from(text),
    name = key === 'configuration' ? 'oauth-client.json' : 'credential.json';
  const event = makeCredentialEvent(
    {
      sourceKind: 'mail_reader',
      sourceKey: createHash('sha256').update(key).digest('hex'),
      generation,
      phase,
      files: [{ name, bytes }],
    },
    owner,
  );
  return { event, name, bytes };
}
async function capture(sources: ReturnType<typeof source>[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-credential-set-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const queue = new BackupQueue(owner, async (_kind, operation) => operation(root));
  const manifest = makeCredentialRecoveryManifest(
    owner,
    sources.map((s) => s.event),
  );
  await queue.capture('credentials', manifest.operationId, async (sink) => {
    const files = credentialRecoveryFiles(manifest, owner);
    for (const file of files) {
      if (file.name === 'credential-set.json') sink.write(file.name, Buffer.from(JSON.stringify(manifest) + '\n'));
      else {
        const selected = sources.find((s) => file.sha256 === s.event.files[0].sha256)!;
        sink.write(file.name, selected.bytes);
      }
    }
  });
  return { manifest, queue, receipt: (await queue.pending('credentials'))[0] };
}
it('binds one actual queued credential set to all independently selected current source events', async () => {
  const config = source('configuration', 'SYNTHETIC_CLIENT'),
    token = source('token', 'SYNTHETIC_TOKEN');
  const { manifest, receipt } = await capture([config, token]);
  expect(() => verifyCredentialRecoveryReceipt(manifest, owner, receipt, [config.event, token.event])).not.toThrow();
  expect(credentialRecoveryCovers(manifest, owner, [config.event, token.event])).toBe(true);
  expect(credentialRecoveryFiles(manifest, owner)).toHaveLength(3);
  expect(JSON.stringify(manifest)).not.toContain('SYNTHETIC_CLIENT');
  expect(JSON.stringify(manifest)).not.toContain('SYNTHETIC_TOKEN');
});
it('never accepts a token-only archive as a complete configuration-and-token recovery set', async () => {
  const config = source('configuration', 'SYNTHETIC_CLIENT'),
    token = source('token', 'SYNTHETIC_TOKEN');
  const { manifest, receipt } = await capture([token]);
  expect(() => verifyCredentialRecoveryReceipt(manifest, owner, receipt, [config.event, token.event])).toThrow(
    'credential_recovery_set_unavailable',
  );
  expect(credentialRecoveryCovers(manifest, owner, [config.event, token.event])).toBe(false);
});
it('uses stable identities across inventory ordering and refuses duplicate current source generations', () => {
  const config = source('configuration', 'SYNTHETIC_CLIENT'),
    token = source('token', 'SYNTHETIC_TOKEN');
  expect(makeCredentialRecoveryManifest(owner, [token.event, config.event])).toEqual(
    makeCredentialRecoveryManifest(owner, [config.event, token.event]),
  );
  expect(() => makeCredentialRecoveryManifest(owner, [token.event, source('token', 'NEXT', 2).event])).toThrow(
    'credential_recovery_set_unavailable',
  );
  expect(() => makeCredentialRecoveryManifest(owner, [])).toThrow('credential_recovery_set_unavailable');
});
it('requires exact current inventory at capture completion, including a concurrently rotated token', async () => {
  const token = source('token', 'OLD');
  const { manifest, receipt } = await capture([token]);
  expect(() => verifyCredentialRecoveryReceipt(manifest, owner, receipt, [source('token', 'NEW', 2).event])).toThrow(
    'credential_recovery_set_unavailable',
  );
});
it('covers prior source generations but never treats changed equal-order bytes or a missing denial as covered', () => {
  const old = source('token', 'OLD'),
    newer = source('token', 'NEW', 2);
  const manifest = makeCredentialRecoveryManifest(owner, [newer.event]);
  expect(credentialRecoveryCovers(manifest, owner, [old.event])).toBe(true);
  expect(credentialRecoveryCovers(manifest, owner, [source('token', 'CONFLICT', 2).event])).toBe(false);
  expect(credentialRecoveryCovers(manifest, owner, [source('denial', 'CLOSED', 1, 'revoked').event])).toBe(false);
  const uncertain = source('token', 'UNKNOWN', 2, 'uncertain'),
    revoked = source('token', 'REVOKED', 2, 'revoked');
  expect(
    credentialRecoveryCovers(makeCredentialRecoveryManifest(owner, [uncertain.event]), owner, [revoked.event]),
  ).toBe(false);
});
for (const changed of [
  'owner',
  'operation',
  'omitted-file',
  'extra-file',
  'digest',
  'failed',
  'invalid-time',
  'invented-manifest',
] as const)
  it(`refuses ${changed} receipt or manifest metadata without deriving any restore/prune authority`, async () => {
    const token = source('token', 'SYNTHETIC_TOKEN');
    const { manifest, receipt } = await capture([token]);
    const changedReceipt = structuredClone(receipt),
      changedManifest = structuredClone(manifest);
    if (changed === 'owner') changedReceipt.ownerDigest = 'b'.repeat(64);
    if (changed === 'operation') changedReceipt.operationId = '00000000-0000-4000-8000-000000000000';
    if (changed === 'omitted-file') changedReceipt.files.pop();
    if (changed === 'extra-file')
      changedReceipt.files.push({ name: 'unexpected.json', bytes: 1, sha256: '0'.repeat(64) });
    if (changed === 'digest') changedReceipt.files[0].sha256 = '0'.repeat(64);
    if (changed === 'failed') changedReceipt.state = 'failed';
    if (changed === 'invalid-time') changedReceipt.createdAt = 'invalid';
    if (changed === 'invented-manifest') Object.assign(changedManifest, { complete: true });
    expect(() => verifyCredentialRecoveryReceipt(changedManifest, owner, changedReceipt, [token.event])).toThrow(
      'credential_recovery_set_unavailable',
    );
  });
it('bounds source count and encoded metadata while preserving original single-event receipt compatibility', () => {
  const token = source('token', 'SYNTHETIC_TOKEN');
  expect(() =>
    makeCredentialRecoveryManifest(
      owner,
      Array.from({ length: 1025 }, () => token.event),
    ),
  ).toThrow('credential_recovery_set_unavailable');
  const malformed = {
    ...token.event,
    files: [{ name: '../outside', bytes: 1, sha256: '0'.repeat(64) }],
  } as CredentialEvent;
  expect(() => makeCredentialRecoveryManifest(owner, [malformed])).toThrow('credential_recovery_set_unavailable');
});
it('round-trips the complete set through the real nested archive transport and rejects corrupted payload bytes', async () => {
  const config = source('configuration', 'SYNTHETIC_CLIENT'),
    token = source('token', 'SYNTHETIC_TOKEN');
  const f = await capture([config, token]),
    parts: Buffer[] = [];
  await f.queue.withPending('credentials', f.manifest.operationId, async (directory, receipt) => {
    await streamBackupArchive(directory, receipt, async (bytes) => {
      parts.push(Buffer.from(bytes));
    });
  });
  const archive = Buffer.concat(parts);
  const invoke = async (bytes: Buffer) => {
    const restored = new Map<string, Buffer[]>();
    async function* stream() {
      for (let offset = 0; offset < bytes.length; offset += 71) yield Buffer.from(bytes.subarray(offset, offset + 71));
    }
    const result = await readBackupArchive(
      stream(),
      { ownerDigest: owner, kind: 'credentials', operationId: f.manifest.operationId },
      {
        open: async (name) => {
          restored.set(name, []);
          return {
            write: async (data) => {
              restored.get(name)!.push(Buffer.from(data));
            },
            close: async () => {},
          };
        },
      },
      () => {},
    );
    return { result, restored };
  };
  const { result, restored } = await invoke(archive);
  const manifest = JSON.parse(Buffer.concat(restored.get('credential-set.json')!).toString('utf8'));
  expect(() =>
    verifyCredentialRecoveryReceipt(manifest, owner, result.receipt, [config.event, token.event]),
  ).not.toThrow();
  const corrupted = Buffer.from(archive),
    index = corrupted.indexOf('SYNTHETIC_TOKEN');
  expect(index).toBeGreaterThan(0);
  corrupted[index] ^= 1;
  await expect(invoke(corrupted)).rejects.toThrow('backup_archive_read_unavailable');
});
it('normalizes object key ordering so one operation cannot serialize into two different manifests', () => {
  const token = source('token', 'SYNTHETIC_TOKEN');
  const reorder = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(reorder)
      : value && typeof value === 'object'
        ? Object.fromEntries(
            Object.entries(value)
              .reverse()
              .map(([key, item]) => [key, reorder(item)]),
          )
        : value;
  const first = makeCredentialRecoveryManifest(owner, [token.event]);
  const next = makeCredentialRecoveryManifest(owner, [reorder(token.event) as CredentialEvent]);
  expect(first.operationId).toBe(next.operationId);
  expect(JSON.stringify(first)).toBe(JSON.stringify(next));
});
it('rejects an otherwise valid source inventory whose combined bytes exceed the credential queue bound', () => {
  const bytes = Buffer.alloc(128 * 1024, 65);
  const sources = Array.from({ length: 129 }, (_, index) =>
    makeCredentialEvent(
      {
        sourceKind: 'mail_reader',
        sourceKey: createHash('sha256')
          .update('bounded-' + index)
          .digest('hex'),
        generation: 1,
        phase: 'ready',
        files: Array.from({ length: 8 }, (_, file) => ({ name: 'part-' + file + '.bin', bytes })),
      },
      owner,
    ),
  );
  expect(() => makeCredentialRecoveryManifest(owner, sources)).toThrow('credential_recovery_set_unavailable');
});
