import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from './vault-storage.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { backupCalendarState } from '../calendar/backup.js';
import { openMailCredentials } from '../mail/config.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../mail/oauth.js';
import { writeAtomic } from './target-state.js';
import { parseAdminArguments } from './admin.js';
import { parseMailSelection, runMailAccountAdmin } from './mail-account-admin.js';

vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
vi.mock('../calendar/backup.js', () => ({
  backupCalendarState: vi.fn(async (o) => {
    await o.check();
  }),
}));
const cleanup: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-mail-account-'));
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
  writeAtomic(vault + '/google/calendar', 'oauth-client.json', {
    clientId: 'calendar-fixture.apps.googleusercontent.com',
    clientSecret: 'PRIVATE_CALENDAR_CANARY',
  });
  const client = { clientId: 'mail-fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_CLIENT_CANARY' };
  const stream = () =>
    Readable.from([
      Buffer.from(
        JSON.stringify({
          installed: {
            client_id: client.clientId,
            client_secret: client.clientSecret,
            project_id: 'fixture-project',
            auth_uri: 'https://accounts.google.com/o/oauth2/auth',
            token_uri: 'https://oauth2.googleapis.com/token',
            auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
            redirect_uris: ['http://localhost'],
          },
        }),
      ),
    ]);
  const binding = {
    scopeId: 'fixture',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    provider: 'codex',
  } as CosBinding;
  const options = {
    roots,
    env: {},
    binding,
    release: fixtureVaultRelease('G04'),
    check: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
  };
  const setup = { command: 'mail-setup' as const, scopeId: binding.scopeId, requestId: randomUUID() };
  const selection = { mailboxEmail: 'owner@example.invalid', processingProviders: ['codex'] };
  writeAtomic(roots.targetRoot, 'selection.json', selection);
  const link = {
    command: 'mail-link' as const,
    scopeId: binding.scopeId,
    requestId: randomUUID(),
    bindingId: randomUUID(),
    manifestFile: roots.targetRoot + '/selection.json',
  };
  const store = {
    coverage: vi.fn(async () => ({ status: 'ok', items: [] })),
    bind: vi.fn(async () => ({ status: 'ok' })),
    database: { pool: { end: vi.fn(async () => {}) } },
  };
  const connect = vi.fn(async () => store);
  const journal = vi.fn(async (_change, guard) => guard());
  const provider = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      expect(init.method).toBe('POST');
      expect(String(init.body)).toContain('client_id=' + client.clientId);
      return new Response(
        JSON.stringify({
          access_token: 'PRIVATE_ACCESS_CANARY',
          refresh_token: 'PRIVATE_REFRESH_CANARY',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: GOOGLE_MAIL_READ_SCOPE,
        }),
      );
    }
    const endpoint = new URL(url);
    expect(endpoint.origin + endpoint.pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(init.method).toBe('GET');
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer PRIVATE_ACCESS_CANARY');
    return new Response(JSON.stringify({ emailAddress: selection.mailboxEmail, historyId: '123' }));
  });
  const display = vi.fn(async (url: string) => {
    const authorization = new URL(url);
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_MAIL_READ_SCOPE);
    expect(authorization.searchParams.get('client_id')).toBe(client.clientId);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
  });
  const dependencies = {
    inspect,
    memory: vi.fn(),
    credentialJournal: journal,
    connect: connect as never,
    fetch: provider,
    display,
  };
  const configure = () => runMailAccountAdmin({ ...options, args: setup }, { ...dependencies, stream: stream() });
  const root = vault + '/google/calendar/mail-reader';
  return {
    base,
    roots,
    root,
    options,
    setup,
    link,
    selection,
    client,
    stream,
    store,
    connect,
    journal,
    provider,
    display,
    dependencies,
    configure,
  };
}
it('admits only scoped setup/private mailbox selection; credentials, transports and destinations are not command arguments', () => {
  const id = randomUUID(),
    bindingId = randomUUID();
  expect(parseAdminArguments(['mail-setup', '--scope', 'fixture', '--request-id', id])).toEqual({
    command: 'mail-setup',
    scopeId: 'fixture',
    requestId: id,
  });
  const link = [
    'mail-link',
    '--scope',
    'fixture',
    '--request-id',
    id,
    '--binding',
    bindingId,
    '--manifest',
    '/private/selection.json',
  ];
  expect(parseAdminArguments(link)).toMatchObject({
    command: 'mail-link',
    bindingId,
    manifestFile: '/private/selection.json',
  });
  for (const args of [
    link.slice(0, -2),
    [...link, '--token', 'PRIVATE'],
    [...link, '--callback', 'http://foreign.invalid/'],
    link.map((v) => (v === '/private/selection.json' ? '../relative' : v)),
    ['mail-setup', '--scope', 'fixture', '--request-id', id, '--client', '/private/client.json'],
  ])
    expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
  expect(parseMailSelection({ mailboxEmail: 'Owner@Example.invalid', processingProviders: ['codex'] })).toEqual({
    mailboxEmail: 'owner@example.invalid',
    processingProviders: ['codex'],
  });
  for (const value of [
    null,
    { mailboxEmail: 'owner@example.invalid' },
    { mailboxEmail: ' owner@example.invalid', processingProviders: ['codex'] },
    { mailboxEmail: 'owner@example.invalid', processingProviders: ['claude'] },
    { mailboxEmail: 'owner@example.invalid', processingProviders: ['codex'], scope: 'write' },
  ])
    expect(() => parseMailSelection(value)).toThrow('invalid_mail_manifest');
});
it('configures only the dedicated protected profile and leaves Calendar, runtime and model authority untouched on retry', async () => {
  const f = fixture();
  expect(await f.configure()).toEqual({
    status: 'configured_paused',
    scope_id: 'fixture',
    paused: true,
    live_model: 'not_invoked',
  });
  const before = fs.readFileSync(f.root + '/oauth-client.json'),
    inode = fs.statSync(f.root).ino;
  expect(await f.configure()).toMatchObject({ status: 'configured_paused' });
  expect(fs.readFileSync(f.root + '/oauth-client.json')).toEqual(before);
  expect(fs.statSync(f.root).ino).toBe(inode);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.display).not.toHaveBeenCalled();
  expect(backupCalendarState).toHaveBeenCalledTimes(4);
  expect(fs.readFileSync(path.dirname(f.root) + '/oauth-client.json', 'utf8')).toContain('PRIVATE_CALENDAR_CANARY');
});
it('verifies the intended provider mailbox before persisting tokens, backs up and binds only read access while paused', async () => {
  const f = fixture();
  await f.configure();
  expect(await runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).toEqual({
    status: 'ok',
    scope_id: 'fixture',
    binding_id: f.link.bindingId,
    paused: true,
    live_model: 'not_invoked',
  });
  expect(f.display).toHaveBeenCalledOnce();
  expect(f.provider).toHaveBeenCalledTimes(2);
  expect(f.journal).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKind: 'mail_reader', generation: 1, phase: 'ready' }),
    expect.any(Function),
  );
  expect(f.store.bind).toHaveBeenCalledWith(expect.objectContaining({ ownerId: 'owner', scopeId: 'fixture' }), {
    id: f.link.bindingId,
    provider: 'google',
    mailboxEmail: f.selection.mailboxEmail,
    processingProviders: ['codex'],
    credentialRef: f.link.bindingId,
    scopes: [GOOGLE_MAIL_READ_SCOPE],
  });
  expect(backupCalendarState).toHaveBeenCalledTimes(4);
  expect(f.store.database.pool.end).toHaveBeenCalledOnce();
  const host = await openMailCredentials(f.roots, f.dependencies.inspect, f.dependencies.memory, f.journal);
  try {
    expect(await host.credentials.inspect('fixture', f.link.bindingId, f.link.bindingId)).toMatchObject({
      scopes: [GOOGLE_MAIL_READ_SCOPE],
    });
  } finally {
    await host.close();
  }
});
it('reconciles an interrupted bind without replaying OAuth and preserves a later independent denial', async () => {
  const f = fixture();
  await f.configure();
  f.store.bind.mockImplementationOnce(async () => {
    throw Error('PRIVATE_LOST_ACK_CANARY');
  });
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    /^mail_account_operation_unavailable$/,
  );
  expect(await runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).toMatchObject({ status: 'ok' });
  expect(f.display).toHaveBeenCalledOnce();
  expect(f.provider.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
  const host = await openMailCredentials(f.roots, f.dependencies.inspect, f.dependencies.memory, f.journal);
  try {
    host.fences.deny('fixture', f.link.bindingId, 'disconnected');
  } finally {
    await host.close();
  }
  const calls = f.provider.mock.calls.length;
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow();
  expect(f.provider).toHaveBeenCalledTimes(calls);
});
it('refuses a different Google mailbox before credential persistence and never silently replays the spent attempt', async () => {
  const f = fixture();
  await f.configure();
  const transport = f.provider.getMockImplementation()!;
  f.provider.mockImplementation(async (url, init) =>
    url.startsWith('https://gmail.googleapis.com/')
      ? new Response(JSON.stringify({ emailAddress: 'foreign@example.invalid', historyId: '123' }))
      : transport(url, init),
  );
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    /^mail_account_operation_unavailable$/,
  );
  expect(fs.existsSync(f.root + '/credentials/' + f.link.bindingId + '.json')).toBe(false);
  expect(f.store.bind).not.toHaveBeenCalled();
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    /^mail_link_uncertain$/,
  );
  expect(f.display).toHaveBeenCalledOnce();
});
it.each(['scope', 'provider', 'release', 'authority', 'backup', 'mount'])(
  'rejects changed %s authority before setup or any provider request',
  async (reason) => {
    const f = fixture();
    if (reason === 'scope') f.options.binding.scopeId = 'foreign';
    if (reason === 'provider') f.options.binding.provider = 'claude';
    if (reason === 'release') f.options.release = fixtureVaultRelease('G03');
    if (reason === 'authority')
      f.options.assertAuthority.mockImplementation(() => {
        throw Error('PRIVATE_AUTHORITY_CANARY');
      });
    if (reason === 'backup') vi.mocked(backupCalendarState).mockRejectedValueOnce(Error('PRIVATE_BACKUP_CANARY'));
    if (reason === 'mount')
      f.dependencies.inspect = () => {
        throw Error('PRIVATE_MOUNT_CANARY');
      };
    await expect(f.configure()).rejects.toThrow();
    expect(f.provider).not.toHaveBeenCalled();
    expect(f.display).not.toHaveBeenCalled();
    expect(f.connect).not.toHaveBeenCalled();
    expect(fs.existsSync(f.root)).toBe(false);
  },
);
it('rechecks authority after consent and closes the listener/database without persisting or binding on lost authority', async () => {
  const f = fixture();
  await f.configure();
  const display = f.display.getMockImplementation()!;
  f.display.mockImplementation(async (url) => {
    await display(url);
    f.options.check.mockRejectedValue(Error('PRIVATE_LEASE_CANARY'));
  });
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    /^mail_account_operation_unavailable$/,
  );
  expect(fs.existsSync(f.root + '/credentials/' + f.link.bindingId + '.json')).toBe(false);
  expect(f.store.bind).not.toHaveBeenCalled();
  expect(f.store.database.pool.end).toHaveBeenCalledOnce();
});
it('refuses changed selection/request for an existing binding before displaying another authorization URL', async () => {
  const f = fixture();
  await f.configure();
  await runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies);
  writeAtomic(f.roots.targetRoot, 'selection.json', { ...f.selection, mailboxEmail: 'foreign@example.invalid' });
  await expect(runMailAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    /^mail_operation_conflict$/,
  );
  expect(f.display).toHaveBeenCalledOnce();
  expect(f.provider.mock.calls.filter(([url]) => url === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
});
