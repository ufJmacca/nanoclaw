import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { makeCredentialEvent } from './backup-credential-event.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import { credentialRootMarker } from '../calendar/credential-core.js';
import {
  makeRoutedCredentialRecoveryManifest,
  routedCredentialRecoveryFiles,
  verifyRoutedCredentialRecoveryReceipt,
  routedCredentialRecoveryCovers,
} from './credential-recovery-routing.js';
const owner = 'a'.repeat(64),
  roots: string[] = [],
  reference = '10000000-0000-4000-8000-000000000001';
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function token(generation = 1, destination = 'google/calendar/mail-reader/credentials/' + reference + '.json') {
  const bytes = Buffer.from('SYNTHETIC_TOKEN_' + generation);
  const event = makeCredentialEvent(
    {
      sourceKind: 'mail_reader',
      sourceKey: 'b'.repeat(64),
      generation,
      phase: 'ready',
      files: [{ name: 'credential.json', bytes }],
    },
    owner,
  );
  return { event, files: [{ name: 'credential.json', destination }], bytes };
}
async function capture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-routed-recovery-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  const source = token(),
    manifest = makeRoutedCredentialRecoveryManifest(owner, [source]);
  const queue = new BackupQueue(owner, async (_kind, operation) => operation(root));
  await queue.capture('credentials', manifest.operationId, async (sink) => {
    for (const file of routedCredentialRecoveryFiles(manifest, owner))
      sink.write(
        file.name,
        file.name === 'credential-set.json' ? Buffer.from(JSON.stringify(manifest) + '\n') : source.bytes,
      );
  });
  return { source, manifest, queue, receipt: (await queue.pending('credentials'))[0] };
}
it('binds checked recovery destinations into the archive identity and verifies an independently selected inventory', async () => {
  const f = await capture();
  expect(() => verifyRoutedCredentialRecoveryReceipt(f.manifest, owner, f.receipt, [f.source])).not.toThrow();
  expect(f.manifest.origins[0].files[0].destination).toBe(token().files[0].destination);
  const moved = token(1, 'google/calendar/mail-reader/credentials/10000000-0000-4000-8000-000000000002.json');
  expect(makeRoutedCredentialRecoveryManifest(owner, [moved]).operationId).not.toBe(f.manifest.operationId);
  expect(() => verifyRoutedCredentialRecoveryReceipt(f.manifest, owner, f.receipt, [moved])).toThrow(
    'credential_recovery_routing_unavailable',
  );
});
for (const destination of [
  '/etc/passwd',
  '../outside',
  'google/calendar/credentials/' + reference + '.json',
  'backup-credentials/restic-password',
  'google/calendar/mail-reader/credentials/../../outside',
  null,
])
  it(`rejects a foreign, unsafe or missing token destination ${String(destination)}`, () => {
    const source = token();
    Object.assign(source.files[0], { destination });
    expect(() => makeRoutedCredentialRecoveryManifest(owner, [source])).toThrow(
      'credential_recovery_routing_unavailable',
    );
  });
it('rejects duplicate physical destinations and missing declared file mappings', () => {
  const first = token(),
    second = token();
  second.event = makeCredentialEvent(
    {
      sourceKind: 'mail_reader',
      sourceKey: 'c'.repeat(64),
      generation: 1,
      phase: 'ready',
      files: [{ name: 'credential.json', bytes: second.bytes }],
    },
    owner,
  );
  expect(() => makeRoutedCredentialRecoveryManifest(owner, [first, second])).toThrow(
    'credential_recovery_routing_unavailable',
  );
  expect(() => makeRoutedCredentialRecoveryManifest(owner, [{ ...first, files: [] }])).toThrow(
    'credential_recovery_routing_unavailable',
  );
});
it('covers an older state only when its recovery destination also remains the same', () => {
  const older = makeRoutedCredentialRecoveryManifest(owner, [token()]);
  const next = makeRoutedCredentialRecoveryManifest(owner, [token(2)]);
  expect(routedCredentialRecoveryCovers(next, owner, older)).toBe(true);
  const moved = makeRoutedCredentialRecoveryManifest(owner, [
    token(2, 'google/calendar/mail-reader/credentials/10000000-0000-4000-8000-000000000002.json'),
  ]);
  expect(routedCredentialRecoveryCovers(moved, owner, older)).toBe(false);
});
it('round-trips routing and source bytes through the real archive format without writing to a live credential path', async () => {
  const f = await capture(),
    parts: Buffer[] = [];
  await f.queue.withPending('credentials', f.manifest.operationId, async (directory, receipt) => {
    await streamBackupArchive(directory, receipt, async (bytes) => {
      parts.push(Buffer.from(bytes));
    });
  });
  const recovered = new Map<string, Buffer[]>();
  async function* chunks() {
    for (const part of parts) yield Buffer.from(part);
  }
  const result = await readBackupArchive(
    chunks(),
    { ownerDigest: owner, kind: 'credentials', operationId: f.manifest.operationId },
    {
      open: async (name) => {
        recovered.set(name, []);
        return {
          write: async (bytes) => {
            recovered.get(name)!.push(Buffer.from(bytes));
          },
          close: async () => {},
        };
      },
    },
    () => {},
  );
  const manifest = JSON.parse(Buffer.concat(recovered.get('credential-set.json')!).toString('utf8'));
  expect(() => verifyRoutedCredentialRecoveryReceipt(manifest, owner, result.receipt, [f.source])).not.toThrow();
  expect(
    [...recovered.keys()].every((name) => name === 'credential-set.json' || name.startsWith('credential-sources/')),
  ).toBe(true);
});
it('allows only explicit derived denial metadata to have no physical recovery destination', () => {
  const data = Buffer.from('SYNTHETIC_DENIAL'),
    identity = Buffer.from('SYNTHETIC_IDENTITY');
  const event = makeCredentialEvent(
    {
      sourceKind: 'mail_reader',
      sourceKey: createHash('sha256').update('denial').digest('hex'),
      generation: 1,
      phase: 'revoked',
      files: [
        { name: 'access-denial.json', bytes: data },
        { name: 'denial-identity.json', bytes: identity },
      ],
    },
    owner,
  );
  const source = {
    event,
    files: [
      {
        name: 'access-denial.json',
        destination: 'google/calendar/mail-reader/access-denials/' + 'a'.repeat(64) + '.json',
      },
      { name: 'denial-identity.json', destination: null },
    ],
  };
  expect(() => makeRoutedCredentialRecoveryManifest(owner, [source])).not.toThrow();
});
it.each(['calendar_reader', 'calendar_owned_event_writer', 'mail_reader', 'mail_draft_writer'] as const)(
  'maps complete %s configuration only to its fixed profile',
  (kind) => {
    const mail = kind === 'mail_reader' || kind === 'mail_draft_writer',
      writer = kind === 'calendar_owned_event_writer';
    const base = mail
      ? 'google/calendar/' + (kind === 'mail_draft_writer' ? 'mail-draft-writer' : 'mail-reader')
      : 'google/calendar';
    const files = [
      {
        name: 'oauth-client.json',
        destination: base + '/' + (writer ? 'writer-oauth-client.json' : 'oauth-client.json'),
      },
      {
        name: 'credential-profile.json',
        destination:
          base +
          '/' +
          (writer ? 'writer-credentials' : 'credentials') +
          '/' +
          credentialRootMarker(
            kind === 'mail_draft_writer'
              ? 'mail_draft_writer'
              : mail
                ? 'mail_reader'
                : writer
                  ? 'owned_event_writer'
                  : 'reader',
          ).name,
      },
      {
        name: 'denial-profile.txt',
        destination: base + '/' + (writer ? 'writer-access-denials' : 'access-denials') + '/.cos-calendar-fences',
      },
      {
        name: 'profile-proof.json',
        destination: mail
          ? base + (kind === 'mail_draft_writer' ? '/.cos-mail-draft-writer' : '/.cos-mail-reader')
          : null,
      },
    ];
    const event = makeCredentialEvent(
      {
        sourceKind: kind,
        sourceKey: 'd'.repeat(64),
        generation: 1,
        phase: 'ready',
        files: files.map((file) => ({ name: file.name, bytes: Buffer.from('SYNTHETIC_' + file.name) })),
      },
      owner,
    );
    expect(() => makeRoutedCredentialRecoveryManifest(owner, [{ event, files }])).not.toThrow();
  },
);
it('maps the full backup credential installation separately from repository configuration', () => {
  const files = ['smb-credentials', 'restic-password', 'backup-credential-installation.json'];
  const event = makeCredentialEvent(
    {
      sourceKind: 'backup_repository',
      sourceKey: 'e'.repeat(64),
      generation: 1,
      phase: 'ready',
      files: files.map((name) => ({ name, bytes: Buffer.from('SYNTHETIC_' + name) })),
    },
    owner,
  );
  expect(() =>
    makeRoutedCredentialRecoveryManifest(owner, [
      { event, files: files.map((name) => ({ name, destination: 'backup-credentials/' + name })) },
    ]),
  ).not.toThrow();
});
for (const problem of ['omitted', 'digest', 'failed', 'extra-origin-field', 'invalid-time'] as const)
  it(`refuses ${problem} routed-set evidence`, async () => {
    const f = await capture(),
      receipt = structuredClone(f.receipt),
      manifest = structuredClone(f.manifest);
    if (problem === 'omitted') receipt.files.pop();
    if (problem === 'digest') receipt.files[0].sha256 = '0'.repeat(64);
    if (problem === 'failed') receipt.state = 'failed';
    if (problem === 'invalid-time') receipt.createdAt = 'invalid';
    if (problem === 'extra-origin-field') Object.assign(manifest.origins[0], { overwriteLive: true });
    expect(() => verifyRoutedCredentialRecoveryReceipt(manifest, owner, receipt, [f.source])).toThrow(
      'credential_recovery_routing_unavailable',
    );
  });
