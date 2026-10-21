import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { makeCredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { makeCredentialCapture, streamCredentialCapture } from './credential-capture.js';
import { backupRepositoryHost, backupSnapshotTags } from './backup-retention.js';
const f = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: f.spawn,
}));
import { BackupResticTransfer } from './backup-restic-transfer.js';
afterEach(() => vi.resetAllMocks());
async function fixture() {
  const owner = 'a'.repeat(64),
    queueOwner = 'b'.repeat(64),
    repositoryId = 'd'.repeat(64),
    raw = Buffer.from('SYNTHETIC_CAPTURE_REPOSITORY');
  const event = makeCredentialEvent(
    {
      sourceKind: 'backup_repository',
      sourceKey: 'c'.repeat(64),
      generation: 1,
      phase: 'ready',
      files: [{ name: 'repository.json', bytes: raw }],
    },
    queueOwner,
  );
  const sources = [
    {
      event,
      files: [{ name: 'repository.json', destination: 'backup-credentials/backup-repository.json', bytes: raw }],
    },
  ];
  const capture = makeCredentialCapture(
    queueOwner,
    '2026-10-16T00:00:00.000Z',
    makeRoutedCredentialRecoveryManifest(queueOwner, sources),
  );
  const parts: Buffer[] = [],
    archive = await streamCredentialCapture(
      { ownerDigest: queueOwner, sources, assertCurrent: () => {} },
      capture,
      async (bytes) => {
        parts.push(Buffer.from(bytes));
      },
    );
  let bytes: Buffer = Buffer.concat(parts);
  let uploaded = false;
  const events: string[][] = [],
    scope = vi.fn(),
    admitUpload = vi.fn(async () => {}),
    producer = vi.fn(() => ['/fixed/node', '/fixed/credential-producer', capture.operationId]);
  f.spawn.mockImplementation((_binary, args) => {
    const command = args.slice(7) as string[];
    events.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      let output: unknown = {};
      if (command[0] === 'cat') output = { version: 2, id: repositoryId, chunker_polynomial: '3da3358b4dc173' };
      if (command[0] === 'backup') uploaded = true;
      if (command[0] === 'snapshots')
        output = uploaded
          ? [
              {
                id: 'e'.repeat(64),
                time: '2026-10-16T00:30:00.000Z',
                hostname: backupRepositoryHost(owner),
                paths: ['/checkpoint.tar'],
                tags: backupSnapshotTags(owner, 'credentials', capture.operationId),
              },
            ]
          : [];
      if (command[0] === 'dump') output = Buffer.from(bytes);
      child.stdout.end(Buffer.isBuffer(output) ? output : JSON.stringify(output));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  });
  const options = {
    binary: { fd: 3, assertCurrent: scope } as never,
    password: { fd: 4, assertCurrent: scope } as never,
    repository: { fd: 5, assertCurrent: scope },
    cache: { fd: 6, assertCurrent: scope },
    writer: { assertCurrent: scope },
    repositoryId,
    ownerDigest: owner,
    producer: () => {
      throw Error('queue_producer_must_not_run');
    },
    credentialProducer: producer,
    admitUpload,
  };
  return {
    capture,
    archive,
    producer,
    admitUpload,
    events,
    options,
    scope,
    replace: (value: Buffer) => {
      bytes = value;
    },
    bytes,
  };
}
it('uploads through only the fixed complete producer and verifies canonical readback under distinct queue/repository owners', async () => {
  const x = await fixture(),
    transfer = new BackupResticTransfer(x.options);
  const result = await transfer.uploadCredentialCapture(x.capture, x.archive);
  expect(result).toMatchObject({
    ownerDigest: x.options.ownerDigest,
    operationId: x.capture.operationId,
    archiveSha256: x.archive.sha256,
    reconciled: false,
  });
  expect(x.producer).toHaveBeenCalledWith(x.capture);
  expect(x.admitUpload).toHaveBeenCalledOnce();
  expect(x.events.filter((args) => args[0] === 'backup')).toHaveLength(1);
  expect(x.events.filter((args) => args[0] === 'dump').length).toBeGreaterThanOrEqual(2);
  const recovered: Buffer[] = [];
  const restore = await transfer.restoreCredentialCapture(
    x.capture.operationId,
    x.capture.ownerDigest,
    {
      open: async () => ({
        write: async (bytes) => {
          recovered.push(Buffer.from(bytes));
        },
        close: async () => {},
      }),
    },
    async () => {},
  );
  expect(restore.capture).toEqual(x.capture);
  expect('receipt' in restore).toBe(false);
  expect(Buffer.concat(recovered).toString('utf8')).toBe('SYNTHETIC_CAPTURE_REPOSITORY');
  const retry = await transfer.uploadCredentialCapture(x.capture, x.archive);
  expect(retry.reconciled).toBe(true);
  expect(x.producer).toHaveBeenCalledOnce();
  expect(x.admitUpload).toHaveBeenCalledOnce();
});
for (const problem of ['missing-producer', 'byte-count', 'invented-field'] as const)
  it(`rejects ${problem} before issuing any repository command`, async () => {
    const x = await fixture();
    const transfer = new BackupResticTransfer(
      problem === 'missing-producer' ? { ...x.options, credentialProducer: undefined } : x.options,
    );
    if (problem === 'byte-count') x.archive.bytes++;
    if (problem === 'invented-field') Object.assign(x.capture, { retiredLocalQueue: true });
    await expect(transfer.uploadCredentialCapture(x.capture, x.archive)).rejects.toThrow('backup_transfer_unavailable');
    expect(x.events).toEqual([]);
  });
it('rejects matching transport hashes for a structurally corrupt complete archive', async () => {
  const x = await fixture(),
    changed = Buffer.from(x.bytes);
  changed[0] ^= 1;
  x.replace(changed);
  const archive = { bytes: changed.length, sha256: createHash('sha256').update(changed).digest('hex') };
  await expect(new BackupResticTransfer(x.options).uploadCredentialCapture(x.capture, archive)).rejects.toThrow(
    'backup_transfer_unavailable',
  );
});
it('does not report success when current repository protection is lost during readback', async () => {
  const x = await fixture();
  x.scope.mockImplementation(() => {
    if (x.events.some((args) => args[0] === 'dump')) throw Error('PRIVATE_SCOPE');
  });
  await expect(new BackupResticTransfer(x.options).uploadCredentialCapture(x.capture, x.archive)).rejects.toThrow(
    'backup_transfer_unavailable',
  );
});
