import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { backupCalendarState } from '../calendar/backup.js';
import { GOOGLE_MAIL_READ_SCOPE, GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { initializeMailProfile } from '../mail/setup.js';
import { openMailCredentials } from '../mail/config.js';
import { openMailDraftCredentials } from '../mail-drafts/config.js';
import { openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { configureVaultStorage, VAULT_DIRECTORIES } from './vault-storage.js';
import { initializeTarget, protectTarget, writeAtomic } from './target-state.js';
import { machineFingerprint } from './target-identity.js';
import { runMailDraftAccountAdmin } from './mail-draft-account-admin.js';

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
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

async function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-account-'));
  cleanup.push(base);
  const roots = { targetRoot: base + '/target', installationRoot: base + '/app', dataRoot: base + '/data' },
    vault = base + '/vault';
  const targetBinding = {
    hostFingerprint: machineFingerprint(),
    databaseFingerprint: 'a'.repeat(64),
    service: 'fixture.service',
    installationRoot: roots.installationRoot,
    dataRoot: roots.dataRoot,
  };
  initializeTarget(roots.targetRoot, targetBinding);
  const target = protectTarget(roots.targetRoot, targetBinding),
    release = fixtureVaultRelease('G05');
  writeAtomic(roots.targetRoot, 'state.json', { ...target, lifecycle: 'protected', releaseId: release.releaseId });
  for (const p of [
    roots.installationRoot,
    roots.dataRoot,
    vault,
    ...VAULT_DIRECTORIES.map((v) => vault + '/' + v),
    roots.targetRoot + '/calendar',
  ])
    fs.mkdirSync(p, { mode: 0o700 });
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
  });
  const readerClient = { clientId: 'reader-fixture.apps.googleusercontent.com' },
    client = { clientId: 'draft-fixture.apps.googleusercontent.com', clientSecret: 'PRIVATE_DRAFT_CLIENT_CANARY' };
  const memory = vi.fn(),
    assertAuthority = vi.fn(),
    check = vi.fn(async () => {});
  const journal = vi.fn(async (_change, guard) => guard());
  await initializeMailProfile(roots, readerClient, { operationId: randomUUID(), assertAuthority }, inspect, memory);
  const readerBindingId = randomUUID(),
    writerBindingId = randomUUID(),
    reference = randomUUID();
  const reader = await openMailCredentials(roots, inspect, memory, journal);
  try {
    await reader.credentials.install('fixture', readerBindingId, reference, {
      accessToken: 'PRIVATE_READER_ACCESS',
      refreshToken: 'PRIVATE_READER_REFRESH',
      expiresAt: Date.now() + 3600000,
      refreshExpiresAt: null,
      scopes: [GOOGLE_MAIL_READ_SCOPE],
    });
  } finally {
    await reader.close();
  }
  const binding = {
    scopeId: 'fixture',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    provider: 'codex',
  } as CosBinding;
  const options = { roots, binding, env: {}, release, check, assertAuthority };
  const setup = { command: 'mail-draft-setup' as const, scopeId: 'fixture', requestId: randomUUID() };
  const selection = { mailboxEmail: 'owner@example.invalid', processingProviders: ['codex'] };
  writeAtomic(roots.targetRoot, 'selection.json', selection);
  const link = {
    command: 'mail-draft-link' as const,
    scopeId: 'fixture',
    requestId: randomUUID(),
    readerBindingId,
    writerBindingId,
    manifestFile: roots.targetRoot + '/selection.json',
  };
  const selected = {
    id: readerBindingId,
    provider: 'google',
    mailboxEmail: selection.mailboxEmail,
    scopes: [GOOGLE_MAIL_READ_SCOPE],
    credentialRef: reference,
    processingProviders: ['codex'],
    auth: 'ready',
    version: 1,
  };
  const store = {
    connection: vi.fn(async () => ({ status: 'ok', binding: structuredClone(selected) })),
    database: { pool: { end: vi.fn(async () => {}) } },
  };
  const connect = vi.fn(async () => store);
  const provider = vi.fn(async (url: string, init: RequestInit) => {
    if (url === 'https://oauth2.googleapis.com/token') {
      expect(String(init.body)).toContain('client_id=' + client.clientId);
      return new Response(
        JSON.stringify({
          access_token: 'PRIVATE_DRAFT_ACCESS',
          refresh_token: 'PRIVATE_DRAFT_REFRESH',
          expires_in: 3600,
          token_type: 'Bearer',
          scope: GOOGLE_MAIL_DRAFT_SCOPE,
        }),
      );
    }
    expect(new URL(url).origin + new URL(url).pathname).toBe('https://gmail.googleapis.com/gmail/v1/users/me/profile');
    expect(init.method).toBe('GET');
    const draft = new Headers(init.headers).get('Authorization') === 'Bearer PRIVATE_DRAFT_ACCESS';
    return new Response(
      JSON.stringify({ emailAddress: selected.mailboxEmail, ...(draft ? {} : { historyId: '123' }) }),
    );
  });
  const display = vi.fn(async (url: string) => {
    const authorization = new URL(url);
    expect(authorization.searchParams.get('scope')).toBe(GOOGLE_MAIL_DRAFT_SCOPE);
    expect(authorization.searchParams.get('client_id')).toBe(client.clientId);
    const callback = new URL(authorization.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'fixture-code');
    callback.searchParams.set('state', authorization.searchParams.get('state')!);
    expect((await fetch(callback)).status).toBe(200);
  });
  const dependencies = {
    inspect,
    memory,
    credentialJournal: journal,
    connect: connect as never,
    fetch: provider,
    display,
  };
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
  const configure = () => runMailDraftAccountAdmin({ ...options, args: setup }, { ...dependencies, stream: stream() });
  const writerRoot = vault + '/google/calendar/mail-draft-writer',
    readerRoot = vault + '/google/calendar/mail-reader';
  journal.mockClear();
  return {
    roots,
    targetBinding,
    options,
    setup,
    link,
    selected,
    selection,
    client,
    reference,
    dependencies,
    configure,
    stream,
    writerRoot,
    readerRoot,
    store,
    connect,
    provider,
    display,
    journal,
    check,
    assertAuthority,
  };
}
it('configures the separate encrypted writer and independent witness without granting account or draft policy', async () => {
  const f = await fixture(),
    readerBefore = fs.readFileSync(f.readerRoot + '/credentials/' + f.reference + '.json');
  expect(await f.configure()).toEqual({
    status: 'configured_paused',
    scope_id: 'fixture',
    paused: true,
    live_model: 'not_invoked',
    write_enabled: false,
  });
  const witness = openTargetDraftJournal(f.roots.targetRoot, digest(f.targetBinding)),
    generation = witness.generation;
  witness.close();
  expect(await f.configure()).toMatchObject({ status: 'configured_paused', write_enabled: false });
  const reopened = openTargetDraftJournal(f.roots.targetRoot, digest(f.targetBinding));
  expect(reopened.generation).toBe(generation);
  reopened.close();
  expect(fs.readFileSync(f.readerRoot + '/credentials/' + f.reference + '.json')).toEqual(readerBefore);
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.provider).not.toHaveBeenCalled();
  expect(f.display).not.toHaveBeenCalled();
  expect(fs.existsSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json')).toBe(false);
  expect(backupCalendarState).toHaveBeenCalledTimes(4);
});
it('links only the exact compose grant for the existing ready reader mailbox, journals it and remains write-disabled on retry', async () => {
  const f = await fixture();
  await f.configure();
  const result = {
    status: 'linked_paused',
    scope_id: 'fixture',
    reader_binding_id: f.link.readerBindingId,
    writer_binding_id: f.link.writerBindingId,
    paused: true,
    live_model: 'not_invoked',
    write_enabled: false,
  };
  expect(await runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).toEqual(result);
  const host = await openMailDraftCredentials(f.roots, f.dependencies.inspect, f.dependencies.memory, f.journal);
  try {
    expect(await host.credentials.inspect('fixture', f.link.writerBindingId, f.link.writerBindingId)).toMatchObject({
      scopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      auth: 'ready',
    });
  } finally {
    await host.close();
  }
  expect(f.journal).toHaveBeenCalledWith(
    expect.objectContaining({ sourceKind: 'mail_draft_writer', generation: 1, phase: 'ready' }),
    expect.any(Function),
  );
  expect(await runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).toEqual(result);
  expect(f.display).toHaveBeenCalledOnce();
  expect(f.provider.mock.calls.filter(([u]) => u === 'https://oauth2.googleapis.com/token')).toHaveLength(1);
  expect(
    f.provider.mock.calls.every(
      ([u]) => u === 'https://oauth2.googleapis.com/token' || new URL(u).pathname.endsWith('/profile'),
    ),
  ).toBe(true);
  expect(f.store.database.pool.end).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json')).toBe(false);
});
it.each(['old-release', 'wrong-schema', 'wrong-owner', 'authority', 'backup'] as const)(
  'rejects %s before profile setup',
  async (reason) => {
    const f = await fixture();
    if (reason === 'old-release') f.options.release = fixtureVaultRelease('G04');
    if (reason === 'wrong-schema') f.options.release.postgres.maximum = 21;
    if (reason === 'wrong-owner') f.options.binding = { ...f.options.binding, provider: 'claude' };
    if (reason === 'authority')
      f.assertAuthority.mockImplementation(() => {
        throw Error('private authority');
      });
    if (reason === 'backup') vi.mocked(backupCalendarState).mockRejectedValueOnce(Error('private backup'));
    await expect(f.configure()).rejects.toThrow('mail_draft_account_operation_unavailable');
    expect(fs.existsSync(f.writerRoot)).toBe(false);
    expect(fs.existsSync(f.roots.targetRoot + '/mail-drafts')).toBe(false);
    expect(f.provider).not.toHaveBeenCalled();
  },
);
it.each(['revoked', 'fixture', 'foreign-mailbox', 'scope', 'processing', 'reference', 'selection'] as const)(
  'denies an unqualified %s reader before presenting writer consent',
  async (reason) => {
    const f = await fixture();
    await f.configure();
    if (reason === 'revoked') f.selected.auth = 'revoked';
    if (reason === 'fixture') f.selected.provider = 'fixture';
    if (reason === 'foreign-mailbox') f.selected.mailboxEmail = 'foreign@example.invalid';
    if (reason === 'scope') f.selected.scopes = [GOOGLE_MAIL_DRAFT_SCOPE];
    if (reason === 'processing') f.selected.processingProviders = ['claude'];
    if (reason === 'reference') f.selected.credentialRef = randomUUID();
    if (reason === 'selection')
      writeAtomic(f.roots.targetRoot, 'selection.json', { ...f.selection, processingProviders: ['claude'] });
    await expect(runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow();
    expect(f.display).not.toHaveBeenCalled();
    expect(fs.existsSync(f.writerRoot + '/credentials/' + f.link.writerBindingId + '.json')).toBe(false);
  },
);
it('never installs a compose token belonging to another mailbox or retries an uncertain consent', async () => {
  const f = await fixture();
  await f.configure();
  const original = f.provider.getMockImplementation()!;
  f.provider.mockImplementation(async (url, init) =>
    new Headers(init.headers).get('Authorization') === 'Bearer PRIVATE_DRAFT_ACCESS'
      ? new Response(JSON.stringify({ emailAddress: 'foreign@example.invalid' }))
      : original(url, init),
  );
  await expect(runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    'mail_draft_account_operation_unavailable',
  );
  expect(fs.existsSync(f.writerRoot + '/credentials/' + f.link.writerBindingId + '.json')).toBe(false);
  await expect(runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow(
    'mail_draft_link_uncertain',
  );
  expect(f.display).toHaveBeenCalledOnce();
});
it('withholds success when reader selection changes during consent and does not install credentials', async () => {
  const f = await fixture();
  await f.configure();
  const original = f.display.getMockImplementation()!;
  f.display.mockImplementation(async (url) => {
    await original(url);
    f.selected.version = 2;
  });
  await expect(runMailDraftAccountAdmin({ ...f.options, args: f.link }, f.dependencies)).rejects.toThrow();
  expect(fs.existsSync(f.writerRoot + '/credentials/' + f.link.writerBindingId + '.json')).toBe(false);
});
it('does not reconstruct a deleted independent history during a repeated setup', async () => {
  const f = await fixture();
  await f.configure();
  fs.unlinkSync(f.roots.targetRoot + '/mail-drafts/effects/effects.sqlite');
  await expect(f.configure()).rejects.toThrow('mail_draft_account_operation_unavailable');
  expect(fs.existsSync(f.roots.targetRoot + '/mail-drafts/effects/effects.sqlite')).toBe(false);
});
it('cannot use a fresh setup request to adopt an empty history after the whole independent root is lost', async () => {
  const f = await fixture();
  await f.configure();
  fs.rmSync(f.roots.targetRoot + '/mail-drafts', { recursive: true });
  await expect(
    runMailDraftAccountAdmin(
      { ...f.options, args: { ...f.setup, requestId: randomUUID() } },
      { ...f.dependencies, stream: f.stream() },
    ),
  ).rejects.toThrow();
  expect(fs.existsSync(f.roots.targetRoot + '/mail-drafts')).toBe(false);
});
