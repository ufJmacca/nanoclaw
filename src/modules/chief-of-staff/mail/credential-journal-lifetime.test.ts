import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeAtomic } from '../ops/target-state.js';
import { afterEach, expect, it, vi } from 'vitest';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from '../ops/vault-storage.js';
import { createVaultBackupQueue } from '../ops/backup-queue.js';
import { initializeMailProfile } from './setup.js';
import { initializeMailDraftProfile } from '../mail-drafts/setup.js';
import { openMailCredentials } from './config.js';
import { openMailDraftCredentials } from '../mail-drafts/config.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../mail-drafts/oauth.js';

// Real credential owners and queue records, with synthetic encrypted-mount and memory inspections only.
const inspection = vi.hoisted(() => ({ current: undefined as StorageInspection | undefined }));
vi.mock('../ops/vault-storage.js', async (original) => {
  const actual = await original<typeof import('../ops/vault-storage.js')>();
  return {
    ...actual,
    verifyVaultStorage: (roots: Parameters<typeof actual.verifyVaultStorage>[0], inspect?: StorageInspection) =>
      actual.verifyVaultStorage(roots, inspect ?? inspection.current),
    withVaultDirectory: <T>(
      roots: Parameters<typeof actual.withVaultDirectory>[0],
      area: Parameters<typeof actual.withVaultDirectory>[1],
      operation: (directory: string, current: () => void) => Promise<T>,
      inspect?: StorageInspection,
      memory: () => void = () => {},
    ) => actual.withVaultDirectory(roots, area, operation, inspect ?? inspection.current, memory),
  };
});
const cleanup: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  inspection.current = undefined;
});
async function fixture(draft: boolean, expired = false) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-journal-lifetime-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault',
    filesystemUuid = randomUUID();
  for (const directory of [
    ...Object.values(roots),
    vault,
    ...VAULT_DIRECTORIES.map((p) => vault + '/' + p),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(directory, { mode: 0o700 });
  const inspect = vi.fn<StorageInspection>((command, args) =>
    JSON.stringify(
      command.endsWith('/findmnt')
        ? {
            filesystems: [
              {
                target: args[2] === roots.targetRoot + '/calendar' ? args[2] : vault,
                fsroot: '/google/calendar',
                source: '/dev/mapper/fixture',
                fstype: 'ext4',
                'maj:min': '253:0',
                uuid: filesystemUuid,
              },
            ],
          }
        : { blockdevices: [{ type: 'crypt', 'maj:min': '253:0', uuid: filesystemUuid }] },
    ),
  );
  inspection.current = inspect;
  configureVaultStorage(roots, vault, inspect);
  writeAtomic(vault + '/google/calendar', 'oauth-client.json', {
    clientId: 'calendar-fixture.apps.googleusercontent.com',
  });
  await initializeMailProfile(
    roots,
    { clientId: 'reader-fixture.apps.googleusercontent.com' },
    { operationId: randomUUID(), assertAuthority: () => {} },
    inspect,
    () => {},
  );
  if (draft)
    await initializeMailDraftProfile(
      roots,
      { clientId: 'draft-fixture.apps.googleusercontent.com' },
      { operationId: randomUUID(), assertAuthority: () => {} },
      inspect,
      () => {},
    );
  let available = true;
  const memory = () => {
    if (!available) throw Error('SYNTHETIC_MEMORY_LOSS');
  };
  const open = draft ? openMailDraftCredentials : openMailCredentials,
    host = await open(roots, inspect, memory),
    binding = randomUUID(),
    reference = randomUUID(),
    scopes = [draft ? GOOGLE_MAIL_DRAFT_SCOPE : GOOGLE_MAIL_READ_SCOPE];
  await host.credentials.install('scope', binding, reference, {
    accessToken: 'SYNTHETIC_ACCESS',
    refreshToken: 'SYNTHETIC_REFRESH',
    expiresAt: Date.now() + (expired ? -1 : 3600000),
    refreshExpiresAt: null,
    scopes,
  });
  return {
    base,
    roots,
    vault,
    inspect,
    host,
    binding,
    reference,
    scopes,
    withdrawMemory: () => {
      available = false;
    },
  };
}

it.each([false, true])(
  'keeps the real default credential journal held across repeated ready inspections (draft=%s)',
  async (draft) => {
    const f = await fixture(draft);
    try {
      const initialInspections = f.inspect.mock.calls.length;
      for (let i = 0; i < 10; i++) {
        expect(await f.host.credentials.inspect('scope', f.binding, f.reference)).toMatchObject({
          auth: 'ready',
          generation: 1,
          scopes: f.scopes,
        });
      }
      // Publication still runs on every read; only repeated full topology setup is removed.
      expect(f.inspect.mock.calls.length).toBe(initialInspections);
      const pending = await createVaultBackupQueue(f.roots).pending('credentials');
      expect(pending).toHaveLength(1);
      expect(pending[0].files.map((file) => file.name).sort()).toEqual(['credential-event.json', 'credential.json']);
      f.host.verifyStorage();
    } finally {
      await f.host.close();
    }
  },
  60000,
);

it.each([false, true])(
  'validates the actual pending credential payload again on every ready read (draft=%s)',
  async (draft) => {
    const f = await fixture(draft);
    try {
      await f.host.credentials.inspect('scope', f.binding, f.reference);
      const [pending] = await createVaultBackupQueue(f.roots).pending('credentials');
      fs.writeFileSync(
        f.vault + '/journals/backup-queue/' + pending.operationId + '/data/credential.json',
        'SYNTHETIC_TAMPER',
      );
      await expect(f.host.credentials.inspect('scope', f.binding, f.reference)).rejects.toThrow();
    } finally {
      await f.host.close();
    }
  },
);

it.each([false, true])(
  'journals both phases of an actual synthetic token rotation without reopening the vault (draft=%s)',
  async (draft) => {
    const f = await fixture(draft, true);
    try {
      const initialInspections = f.inspect.mock.calls.length;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(
              JSON.stringify({
                access_token: 'SYNTHETIC_ROTATED_ACCESS',
                refresh_token: 'SYNTHETIC_ROTATED_REFRESH',
                expires_in: 3600,
                token_type: 'Bearer',
                scope: f.scopes.join(' '),
              }),
            ),
        ),
      );
      expect(await f.host.credentials.token('scope', f.binding, f.reference)).toBe('SYNTHETIC_ROTATED_ACCESS');
      expect(await f.host.credentials.inspect('scope', f.binding, f.reference)).toMatchObject({
        auth: 'ready',
        generation: 2,
      });
      expect(f.inspect.mock.calls.length).toBe(initialInspections);
      const pending = await createVaultBackupQueue(f.roots).pending('credentials');
      const events = pending.map((item) =>
        JSON.parse(
          fs.readFileSync(
            f.vault + '/journals/backup-queue/' + item.operationId + '/data/credential-event.json',
            'utf8',
          ),
        ),
      );
      expect(events.map(({ generation, phase }) => ({ generation, phase }))).toEqual(
        expect.arrayContaining([
          { generation: 1, phase: 'ready' },
          { generation: 1, phase: 'refreshing' },
          { generation: 2, phase: 'ready' },
        ]),
      );
      expect(events).toHaveLength(3);
    } finally {
      await f.host.close();
    }
  },
);

it.each([false, true])('retires all credential access when the held owner closes (draft=%s)', async (draft) => {
  const f = await fixture(draft);
  await f.host.close();
  await expect(f.host.credentials.inspect('scope', f.binding, f.reference)).rejects.toThrow();
  expect(f.host.closed()).toBe(true);
});

for (const changed of ['journals', 'memory'] as const)
  it.each([false, true])(
    `withdraws default credential access after awaited ${changed} loss (draft=%s)`,
    async (draft) => {
      const f = await fixture(draft);
      await Promise.resolve();
      if (changed === 'memory') f.withdrawMemory();
      else {
        fs.renameSync(f.vault + '/journals', f.vault + '/journals-old');
        fs.mkdirSync(f.vault + '/journals', { mode: 0o700 });
      }
      await expect(f.host.credentials.inspect('scope', f.binding, f.reference)).rejects.toThrow();
      await expect(f.host.close()).rejects.toThrow(/^mail_configuration_unavailable$/);
      expect(f.host.closed()).toBe(true);
    },
  );
