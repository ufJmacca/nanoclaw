import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { backupRepositoryHost, backupSnapshotTags } from './backup-retention.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BackupQueue } from './backup-queue.js';
import { makeCredentialEvent } from './backup-credential-event.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  type RoutedCredentialInventory,
} from './credential-recovery-routing.js';
import { streamBackupArchive } from './backup-archive.js';
const f = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: f.spawn,
}));
const { spawn: actualSpawn } = await vi.importActual<typeof import('node:child_process')>('node:child_process');
import { BackupResticTransfer } from './backup-restic-transfer.js';
afterEach(() => vi.resetAllMocks());
const owner = 'a'.repeat(64),
  repo = 'd'.repeat(64);
function fixture(options?: {
  credentials: Array<{ id: string; operationId: string; bytes: Buffer }>;
  credentialInventory?: () => Promise<{ ownerDigest: string; sources: RoutedCredentialInventory }>;
}) {
  const snapshot = (kind: 'state' | 'credentials', id: string) => ({
    id: id.repeat(64),
    hostname: backupRepositoryHost(owner),
    paths: ['/checkpoint.tar'],
    tags: backupSnapshotTags(owner, kind, '9f99d9b4-4dac-423a-956c-afd953993c2d'),
    time: '2026-10-11T03:30:00+11:00',
  });
  let inventory = [snapshot('state', 'b'), snapshot('state', 'c'), snapshot('credentials', 'e')];
  if (options)
    inventory = [
      snapshot('state', 'b'),
      snapshot('state', 'c'),
      ...options.credentials.map((value) => ({
        ...snapshot('credentials', value.id),
        tags: backupSnapshotTags(owner, 'credentials', value.operationId),
      })),
    ];
  const events: string[][] = [],
    scope = vi.fn(),
    admit = vi.fn(async () => {});
  let response: ((args: string[]) => unknown) | undefined;
  f.spawn.mockImplementation((_file, args) => {
    const command = args.slice(7) as string[];
    events.push(command);
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      pid: undefined,
    });
    queueMicrotask(() => {
      let value: unknown = response?.(command);
      if (value === undefined) {
        if (command[0] === 'cat') value = { version: 2, id: repo, chunker_polynomial: '3da3358b4dc173' };
        if (command[0] === 'snapshots') value = inventory;
        if (command[0] === 'dump')
          value = options?.credentials.find((value) => value.id.repeat(64) === command[1])?.bytes;
        if (command[0] === 'forget' && command.includes('--dry-run')) {
          const kind = command.at(command.indexOf('--tag') + 1)!.endsWith('state') ? 'state' : 'credentials';
          const selected = inventory.filter((s) => s.tags.includes('cos-kind=' + kind));
          value = selected.length
            ? [
                {
                  tags: null,
                  host: backupRepositoryHost(owner),
                  paths: ['/checkpoint.tar'],
                  keep: selected.slice(0, 1),
                  remove: selected.slice(1),
                  reasons: [],
                },
              ]
            : undefined;
        } else if (command[0] === 'forget') inventory = inventory.filter((s) => !command.includes(s.id));
      }
      child.stdout.end(Buffer.isBuffer(value) ? Buffer.from(value) : value === undefined ? '' : JSON.stringify(value));
      child.stderr.end();
      child.emit('close', 0, null);
    });
    return child;
  });
  const transfer = new BackupResticTransfer({
    binary: { fd: 3, assertCurrent: scope } as never,
    password: { fd: 4, assertCurrent: scope } as never,
    repository: { fd: 5, assertCurrent: scope },
    cache: { fd: 6, assertCurrent: scope },
    writer: { assertCurrent: scope },
    repositoryId: repo,
    ownerDigest: owner,
    credentialInventory: options?.credentialInventory,
    producer: () => {
      throw Error('must_not_capture');
    },
    admitUpload: async () => {
      throw Error('must_not_upload');
    },
  });
  return {
    transfer,
    events,
    admit,
    scope,
    respond: (fn: (args: string[]) => unknown) => {
      response = fn;
    },
  };
}
it('checks all data, deletes only validated preview IDs, prunes with a fixed budget, then verifies integrity', async () => {
  const x = fixture();
  expect(await x.transfer.maintain(x.admit)).toMatchObject({
    status: 'backup_repository_maintained',
    repositoryId: repo,
    state: { retained: 1, removed: 1 },
    credentials: { retained: 1, removed: 0 },
    integrity: 'verified',
  });
  expect(x.events.filter((args) => args[0] === 'check')).toEqual([
    ['check', '--read-data', '--with-cache'],
    ['check', '--read-data', '--with-cache'],
  ]);
  expect(x.events.find((args) => args[0] === 'forget' && !args.includes('--dry-run'))).toEqual([
    'forget',
    'c'.repeat(64),
  ]);
  expect(x.events.find((args) => args[0] === 'prune')).toEqual(['prune', '--max-repack-size', '16M']);
  expect(x.admit).toHaveBeenCalled();
});
async function credentialArchives(
  variant: 'full' | 'delta-only' | 'missing-config' | 'new-primary' | 'unknown-old' | 'corrupt-old' = 'full',
) {
  f.spawn.mockImplementation(actualSpawn);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-retention-archives-'));
  fs.chmodSync(root, 0o700);
  try {
    const queue = new BackupQueue(owner, async (_kind, operation) => operation(root));
    const token = (generation: number, key = '1'.repeat(64)) => {
      const bytes = Buffer.from('SYNTHETIC_RETENTION_TOKEN_' + generation);
      const event = makeCredentialEvent(
        {
          sourceKind: 'mail_reader',
          sourceKey: key,
          generation,
          phase: 'ready',
          files: [{ name: 'credential.json', bytes }],
        },
        owner,
      );
      return {
        event,
        files: [
          {
            name: 'credential.json',
            destination: 'google/calendar/mail-reader/credentials/10000000-0000-4000-8000-000000000001.json',
            bytes,
          },
        ],
      };
    };
    const configBytes = Buffer.from('SYNTHETIC_RETENTION_REPOSITORY');
    const configuration = {
      event: makeCredentialEvent(
        {
          sourceKind: 'backup_repository',
          sourceKey: '2'.repeat(64),
          generation: 1,
          phase: 'ready',
          files: [{ name: 'repository.json', bytes: configBytes }],
        },
        owner,
      ),
      files: [
        { name: 'repository.json', destination: 'backup-credentials/backup-repository.json', bytes: configBytes },
      ],
    };
    const old = token(1, variant === 'unknown-old' ? '3'.repeat(64) : '1'.repeat(64)),
      next = token(2);
    await queue.recordCredential(
      {
        sourceKind: old.event.sourceKind,
        sourceKey: old.event.sourceKey,
        generation: 1,
        phase: 'ready',
        files: old.files,
      },
      () => {},
    );
    let operationId: string;
    if (variant === 'delta-only') {
      await queue.recordCredential(
        {
          sourceKind: next.event.sourceKind,
          sourceKey: next.event.sourceKey,
          generation: 2,
          phase: 'ready',
          files: next.files,
        },
        () => {},
      );
      operationId = next.event.operationId;
    } else {
      const sources = variant === 'missing-config' ? [next] : [configuration, next],
        manifest = makeRoutedCredentialRecoveryManifest(owner, sources);
      operationId = manifest.operationId;
      await queue.capture('credentials', operationId, async (sink) => {
        const metadata = Buffer.from(JSON.stringify(manifest) + '\n');
        try {
          for (const file of routedCredentialRecoveryFiles(manifest, owner))
            sink.write(
              file.name,
              file.name === 'credential-set.json'
                ? metadata
                : file.name.endsWith('repository.json')
                  ? configBytes
                  : next.files[0].bytes,
            );
        } finally {
          metadata.fill(0);
        }
      });
    }
    const credentials = [];
    for (const [id, selected] of [
      ['e', operationId],
      ['f', old.event.operationId],
    ]) {
      const parts: Buffer[] = [];
      await queue.withPending('credentials', selected, async (directory, receipt) =>
        streamBackupArchive(directory, receipt, async (bytes) => {
          parts.push(Buffer.from(bytes));
        }),
      );
      const bytes = Buffer.concat(parts);
      if (variant === 'corrupt-old' && id === 'f') bytes[bytes.indexOf('SYNTHETIC_RETENTION_TOKEN_1')] ^= 1;
      credentials.push({ id, operationId: selected, bytes });
    }
    const current = [configuration, variant === 'new-primary' ? token(3) : next];
    return { credentials, credentialInventory: vi.fn(async () => ({ ownerDigest: owner, sources: current })) };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}
it('refuses credential deletion without an independent current primary inventory', async () => {
  const archives = await credentialArchives(),
    x = fixture({ credentials: archives.credentials });
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
it('reads actual retained complete-set payloads and removed delta payloads before allowing cleanup', async () => {
  const archives = await credentialArchives(),
    x = fixture(archives);
  expect(await x.transfer.maintain(x.admit)).toMatchObject({ credentials: { retained: 1, removed: 1 } });
  const firstDelete = x.events.findIndex((args) => args[0] === 'forget' && !args.includes('--dry-run'));
  expect(
    x.events
      .slice(0, firstDelete)
      .filter((args) => args[0] === 'dump')
      .map((args) => args[1])
      .sort(),
  ).toEqual(['e'.repeat(64), 'f'.repeat(64)]);
  expect(archives.credentialInventory.mock.calls.length).toBeGreaterThan(1);
});
for (const variant of ['delta-only', 'missing-config', 'new-primary', 'unknown-old', 'corrupt-old'] as const)
  it(`holds every deletion for ${variant} credential coverage`, async () => {
    const x = fixture(await credentialArchives(variant));
    await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
    expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
      false,
    );
  });
it('rejects a corrupt retained full set before deleting any snapshot', async () => {
  const archives = await credentialArchives(),
    kept = archives.credentials[0].bytes;
  kept[kept.indexOf('SYNTHETIC_RETENTION_TOKEN_2')] ^= 1;
  const x = fixture(archives);
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
it('rechecks current primary coverage after awaited archive reads and before any deletion', async () => {
  const archives = await credentialArchives(),
    newer = await credentialArchives('new-primary'),
    initial = await archives.credentialInventory(),
    changed = await newer.credentialInventory();
  archives.credentialInventory.mockReset().mockResolvedValue(changed).mockResolvedValueOnce(initial);
  const x = fixture(archives);
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'dump')).toBe(true);
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
it('rechecks primary coverage before the credential deletion batch after other retention work', async () => {
  const archives = await credentialArchives(),
    newer = await credentialArchives('new-primary'),
    initial = await archives.credentialInventory(),
    changed = await newer.credentialInventory();
  archives.credentialInventory
    .mockReset()
    .mockResolvedValue(changed)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(initial)
    .mockResolvedValueOnce(initial);
  const x = fixture(archives);
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'forget' && args.includes('c'.repeat(64)))).toBe(true);
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && args.includes('f'.repeat(64))))).toBe(
    false,
  );
});
it('does not delete anything when the preview cannot be authenticated against the fresh inventory', async () => {
  const x = fixture();
  x.respond((args) => (args.includes('--dry-run') ? [] : undefined));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
it('withdrawn caller capacity or permission stops before any repository mutation', async () => {
  const x = fixture();
  x.admit.mockRejectedValueOnce(Error('PRIVATE_PERMISSION_WITHDRAWN'));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(x.events).toEqual([]);
});
it('checks capacity again after the awaited repository identity command and before checking or changing data', async () => {
  const x = fixture();
  x.admit.mockResolvedValueOnce(undefined).mockRejectedValueOnce(Error('PRIVATE_CAPACITY_WITHDRAWN'));
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow(/^backup_maintenance_unavailable$/);
  expect(x.events).toEqual([['cat', 'config']]);
});
it('detects a repository change before deleting the next batch or pruning', async () => {
  const x = fixture();
  let lists = 0;
  x.respond((args) => {
    if (args[0] === 'snapshots' && ++lists === 2) return [];
  });
  await expect(x.transfer.maintain(x.admit)).rejects.toThrow('backup_maintenance_unavailable');
  expect(x.events.some((args) => args[0] === 'prune' || (args[0] === 'forget' && !args.includes('--dry-run')))).toBe(
    false,
  );
});
