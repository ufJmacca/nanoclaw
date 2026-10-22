import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { initializeMailProfile } from './setup.js';
import { openMailCredentials } from './config.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from '../ops/vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-setup-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault';
  for (const root of [
    ...Object.values(roots),
    vault,
    ...VAULT_DIRECTORIES.map((area) => vault + '/' + area),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(root, { mode: 0o700 });
  const inspect: StorageInspection = (command, args) =>
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
                uuid: 'fixture-volume-uuid',
              },
            ],
          }
        : { blockdevices: [{ type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-volume-uuid' }] },
    );
  configureVaultStorage(roots, vault, inspect);
  fs.writeFileSync(
    vault + '/google/calendar/oauth-client.json',
    JSON.stringify({
      clientId: 'calendar-setup-fixture.apps.googleusercontent.com',
      clientSecret: 'PRIVATE_CALENDAR_SETUP_CANARY',
    }),
    { mode: 0o600 },
  );
  const client = {
    clientId: 'mail-setup-fixture.apps.googleusercontent.com',
    clientSecret: 'PRIVATE_MAIL_SETUP_CANARY',
  };
  const authority = { operationId: randomUUID(), assertAuthority: vi.fn() };
  return {
    base,
    roots,
    vault,
    root: vault + '/google/calendar/mail-reader',
    client,
    authority,
    inspect,
    memory: vi.fn(),
  };
}
it('initializes only the dedicated encrypted profile and an exact retry preserves its inode and client bytes', async () => {
  const f = fixture();
  expect(await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({ status: 'ready' });
  const identity = fs.statSync(f.root),
    client = fs.statSync(f.root + '/oauth-client.json');
  const host = await openMailCredentials(f.roots, f.inspect, f.memory, async () => {});
  expect(host.clientId).toBe(f.client.clientId);
  await host.close();
  expect(await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({ status: 'ready' });
  expect(fs.statSync(f.root).ino).toBe(identity.ino);
  expect(fs.statSync(f.root + '/oauth-client.json').mtimeMs).toBe(client.mtimeMs);
  expect(fs.readdirSync(f.root).sort()).toEqual([
    '.cos-mail-reader',
    'access-denials',
    'credentials',
    'oauth-client.json',
  ]);
  expect(fs.readdirSync(f.root + '/credentials')).toEqual(['.cos-mail-reader-credentials']);
  expect(f.authority.assertAuthority).toHaveBeenCalled();
});
it('never resets installed credentials or independent denials on a completed-profile retry', async () => {
  const f = fixture();
  await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  const host = await openMailCredentials(f.roots, f.inspect, f.memory, async () => {});
  const binding = randomUUID();
  try {
    await host.credentials.install('scope', binding, randomUUID(), {
      accessToken: 'PRIVATE_INSTALLED_ACCESS',
      refreshToken: 'PRIVATE_INSTALLED_REFRESH',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: null,
      scopes: [GOOGLE_MAIL_READ_SCOPE],
    });
    host.fences.deny('scope', binding, 'revoked');
  } finally {
    await host.close();
  }
  const snapshot = () =>
    ['credentials', 'access-denials'].flatMap((child) =>
      fs
        .readdirSync(f.root + '/' + child)
        .sort()
        .map((name) => ({
          child,
          name,
          bytes: fs.readFileSync(f.root + '/' + child + '/' + name),
          modified: fs.statSync(f.root + '/' + child + '/' + name).mtimeMs,
        })),
    );
  const before = snapshot();
  await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  expect(snapshot()).toEqual(before);
});
for (const step of ['intent', 'directories', 'client', 'markers', 'proof'] as const)
  it(`reconciles the same interrupted ${step} setup without publishing an incomplete runtime profile`, async () => {
    const f = fixture();
    await expect(
      initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
        afterStep: async (current) => {
          if (current === step) throw Error('PRIVATE_INTERRUPTION');
        },
      }),
    ).rejects.toThrow('mail_profile_initialization_unavailable');
    await expect(openMailCredentials(f.roots, f.inspect, f.memory, async () => {})).rejects.toThrow(
      'mail_configuration_unavailable',
    );
    await expect(
      initializeMailProfile(f.roots, f.client, { ...f.authority, operationId: randomUUID() }, f.inspect, f.memory),
    ).rejects.toThrow('mail_profile_initialization_unavailable');
    expect(await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({
      status: 'ready',
    });
    const host = await openMailCredentials(f.roots, f.inspect, f.memory, async () => {});
    await host.close();
  });
it('refuses changed clients, foreign populated roots and unknown files without rewriting them', async () => {
  const f = fixture();
  fs.mkdirSync(f.root, { mode: 0o700 });
  fs.writeFileSync(f.root + '/valuable', 'PRIVATE_EXISTING_CANARY', { mode: 0o600 });
  await expect(initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).rejects.toThrow(
    'mail_profile_initialization_unavailable',
  );
  expect(fs.readdirSync(f.root)).toEqual(['valuable']);
  fs.unlinkSync(f.root + '/valuable');
  await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
  const before = fs.readFileSync(f.root + '/oauth-client.json');
  await expect(
    initializeMailProfile(
      f.roots,
      { ...f.client, clientId: 'different.apps.googleusercontent.com' },
      f.authority,
      f.inspect,
      f.memory,
    ),
  ).rejects.toThrow('mail_profile_initialization_unavailable');
  expect(fs.readFileSync(f.root + '/oauth-client.json')).toEqual(before);
});
for (const changed of ['authority', 'memory', 'profile', 'parent'] as const)
  it(`denies an awaited ${changed} loss and never redirects setup secrets to replacement folders`, async () => {
    const f = fixture();
    await expect(
      initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
        afterStep: async (step) => {
          if (step !== 'intent') return;
          if (changed === 'authority')
            f.authority.assertAuthority.mockImplementation(() => {
              throw Error('PRIVATE_AUTHORITY_LOSS');
            });
          else if (changed === 'memory')
            f.memory.mockImplementation(() => {
              throw Error('PRIVATE_MEMORY_LOSS');
            });
          else {
            const root = changed === 'profile' ? f.root : path.dirname(f.root);
            fs.renameSync(root, root + '-held');
            fs.mkdirSync(root, { mode: 0o700 });
          }
        },
      }),
    ).rejects.toThrow('mail_profile_initialization_unavailable');
    if (changed === 'profile' || changed === 'parent')
      expect(fs.readdirSync(changed === 'profile' ? f.root : path.dirname(f.root))).toEqual([]);
  });
it('keeps a directory lock through awaited setup and allows a retry after the real owner settles', async () => {
  const f = fixture();
  let settle!: () => void, entered!: () => void;
  const ready = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
    afterStep: async (step) => {
      if (step === 'intent') {
        entered();
        await new Promise<void>((resolve) => {
          settle = resolve;
        });
      }
    },
  });
  await ready;
  try {
    await expect(initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).rejects.toThrow(
      'mail_profile_initialization_unavailable',
    );
  } finally {
    settle();
  }
  await pending;
  expect(await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({ status: 'ready' });
});
for (const child of ['credentials/.cos-mail-reader-credentials', 'access-denials/.cos-calendar-fences'])
  it(`refuses a completed profile with a changed ${child} marker without repairing it`, async () => {
    const f = fixture();
    await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory);
    fs.writeFileSync(f.root + '/' + child, 'PRIVATE_FOREIGN_MARKER');
    await expect(initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).rejects.toThrow(
      'mail_profile_initialization_unavailable',
    );
    expect(fs.readFileSync(f.root + '/' + child, 'utf8')).toBe('PRIVATE_FOREIGN_MARKER');
  });
it('recovers only a corroborated partial client prefix during its own interrupted setup', async () => {
  const f = fixture();
  await expect(
    initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
      afterStep: async (step) => {
        if (step === 'client') throw Error('interrupted');
      },
    }),
  ).rejects.toThrow();
  fs.truncateSync(f.root + '/oauth-client.json', 17);
  expect(await initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).toEqual({ status: 'ready' });
  const host = await openMailCredentials(f.roots, f.inspect, f.memory, async () => {});
  await host.close();
});
it('does not reseal a replaced child directory when reconstructing an interrupted setup', async () => {
  const f = fixture();
  await expect(
    initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
      afterStep: async (step) => {
        if (step === 'directories') throw Error('interrupted');
      },
    }),
  ).rejects.toThrow();
  fs.renameSync(f.root + '/credentials', f.base + '/held-credentials');
  fs.mkdirSync(f.root + '/credentials', { mode: 0o700 });
  await expect(initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory)).rejects.toThrow(
    'mail_profile_initialization_unavailable',
  );
  expect(fs.existsSync(f.root + '/oauth-client.json')).toBe(false);
});
it('requires its own OAuth client and never reuses Calendar client authority', async () => {
  const f = fixture();
  await expect(
    initializeMailProfile(
      f.roots,
      { clientId: 'calendar-setup-fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_CALENDAR_SETUP_CANARY' },
      f.authority,
      f.inspect,
      f.memory,
    ),
  ).rejects.toThrow('mail_profile_initialization_unavailable');
  expect(fs.existsSync(f.root)).toBe(false);
});
it('keeps the Calendar client identity pinned while mail setup awaits', async () => {
  const f = fixture();
  await expect(
    initializeMailProfile(f.roots, f.client, f.authority, f.inspect, f.memory, {
      afterStep: async (step) => {
        if (step === 'intent')
          fs.writeFileSync(f.vault + '/google/calendar/oauth-client.json', JSON.stringify(f.client));
      },
    }),
  ).rejects.toThrow('mail_profile_initialization_unavailable');
  expect(fs.existsSync(f.root + '/oauth-client.json')).toBe(false);
});
