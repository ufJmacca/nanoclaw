import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { parseAdminArguments } from './admin.js';
import { writeAtomic } from './target-state.js';
import { runActionAccountAdmin, parseActionSelection, readActionAccountConsent } from './action-account-admin.js';
import { openWriterCredentials } from '../actions/config.js';
import { GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE } from '../actions/writer.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
const directories: string[] = [];
const inspect: StorageInspection = (command, args) =>
  JSON.stringify(
    command.endsWith('/findmnt')
      ? {
          filesystems: [
            {
              target: args[args.indexOf('--target') + 1],
              source: '/dev/mapper/fixture',
              fstype: 'ext4',
              'maj:min': '253:0',
              uuid: 'fixture-encrypted-storage',
            },
          ],
        }
      : {
          blockdevices: [
            { name: '/dev/mapper/fixture', type: 'crypt', 'maj:min': '253:0', uuid: 'fixture-encrypted-storage' },
          ],
        },
  );
afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-account-'));
  directories.push(base);
  const roots = { targetRoot: base + '/state', installationRoot: base + '/app', dataRoot: base + '/data' },
    backupRoot = base + '/backups';
  for (const root of [...Object.values(roots), backupRoot, roots.targetRoot + '/calendar'])
    fs.mkdirSync(root, { mode: 0o700 });
  const client = { clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'CLIENT_SECRET_CANARY' };
  writeAtomic(roots.targetRoot + '/calendar', 'writer-oauth-client.json', client);
  const binding: CosBinding = {
    scopeId: 'fixture',
    ownerId: 'owner',
    botId: 'bot',
    instanceId: 'instance',
    channelId: 'private',
    agentGroupId: 'group',
    messagingGroupId: 'messaging',
    sessionId: 'main',
    provider: 'codex',
  };
  const options = { env: {}, roots, binding, check: vi.fn(async () => {}), assertAuthority: vi.fn() };
  const setup = { command: 'action-setup' as const, scopeId: binding.scopeId, requestId: randomUUID(), backupRoot };
  const selection = {
    calendarId: 'operator@example.test',
    primaryCalendarId: 'operator@example.test',
    processingProvider: 'codex',
  };
  writeAtomic(roots.targetRoot, 'selection.json', selection);
  const link = {
    command: 'action-link' as const,
    scopeId: binding.scopeId,
    requestId: randomUUID(),
    bindingId: randomUUID(),
    manifestFile: roots.targetRoot + '/selection.json',
  };
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(init.method).toBe('POST');
    return new Response(
      JSON.stringify({
        access_token: 'ACCESS_TOKEN_CANARY',
        refresh_token: 'REFRESH_TOKEN_CANARY',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE].join(' '),
      }),
    );
  });
  const display = vi.fn(async (url: string) => {
    const auth = new URL(url);
    expect(new Set(auth.searchParams.get('scope')!.split(' '))).toEqual(
      new Set([GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE]),
    );
    const callback = new URL(auth.searchParams.get('redirect_uri')!);
    callback.searchParams.set('code', 'FIXTURE_CODE');
    callback.searchParams.set('state', auth.searchParams.get('state')!);
    const response = await globalThis.fetch(callback);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain('CANARY');
  });
  return {
    base,
    roots,
    backupRoot,
    options,
    setup,
    selection,
    link,
    client,
    dependencies: { inspect, fetch, display },
    fetch,
    display,
  };
}
it('S09 exposes explicit owner setup/link with stable IDs and rejects token, scope and URL overrides', () => {
  const s = fixture();
  expect(
    parseAdminArguments([
      'action-setup',
      '--scope',
      'fixture',
      '--request-id',
      s.setup.requestId,
      '--backup-root',
      s.backupRoot,
    ]),
  ).toEqual(s.setup);
  expect(
    parseAdminArguments([
      'action-link',
      '--scope',
      'fixture',
      '--request-id',
      s.link.requestId,
      '--binding',
      s.link.bindingId,
      '--manifest',
      s.link.manifestFile,
    ]),
  ).toEqual(s.link);
  expect(parseActionSelection(s.selection)).toEqual(s.selection);
  for (const value of [
    null,
    {},
    { ...s.selection, processingProvider: 'claude' },
    { ...s.selection, calendarId: 'primary' },
    { ...s.selection, primaryCalendarId: 'primary' },
    { ...s.selection, scopes: ['all'] },
    { ...s.selection, token: 'CANARY' },
  ])
    expect(() => parseActionSelection(value)).toThrow('invalid_action_manifest');
  expect(() =>
    parseAdminArguments([
      'action-link',
      '--scope',
      'fixture',
      '--request-id',
      s.link.requestId,
      '--binding',
      s.link.bindingId,
      '--manifest',
      s.link.manifestFile,
      '--url',
      'https://evil.test',
    ]),
  ).toThrow('invalid_admin_arguments');
});
it('S09 explicitly initializes only a separate protected writer vault and preserves the reader', async () => {
  const s = fixture();
  const result = await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  expect(result).toMatchObject({ status: 'configured_paused', paused: true, writer_enabled: false });
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.display).not.toHaveBeenCalled();
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/credentials')).toBe(false);
  expect(fs.existsSync(s.roots.targetRoot + '/actions/writer-profile.json')).toBe(false);
  openWriterCredentials(s.roots, inspect);
  expect(fs.readdirSync(s.backupRoot).filter((name) => name.startsWith('calendar-'))).toHaveLength(2);
  await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  fs.unlinkSync(s.roots.targetRoot + '/calendar/writer-credentials/.cos-calendar-writer-credentials');
  await expect(runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies)).rejects.toThrow();
  expect(fs.existsSync(s.roots.targetRoot + '/calendar/writer-credentials/.cos-calendar-writer-credentials')).toBe(
    false,
  );
});
it('S09 links narrow fixture credentials once, backs them up, and cannot enable writes or replay consent', async () => {
  const s = fixture();
  await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  const result = await runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies);
  expect(result).toMatchObject({
    status: 'credentials_ready_writes_disabled',
    binding_id: s.link.bindingId,
    writer_enabled: false,
    paused: true,
  });
  expect(JSON.stringify(result)).not.toContain('CANARY');
  expect(s.fetch).toHaveBeenCalledOnce();
  expect(s.display).toHaveBeenCalledOnce();
  expect(fs.existsSync(s.roots.targetRoot + '/actions/writer-profile.json')).toBe(false);
  expect(fs.readdirSync(s.backupRoot).filter((name) => name.startsWith('calendar-'))).toHaveLength(4);
  const credential = await openWriterCredentials(s.roots, inspect).credentials.inspect(
    'fixture',
    s.link.bindingId,
    s.link.bindingId,
  );
  expect(credential.auth).toBe('ready');
  expect(readActionAccountConsent(s.roots, s.options.binding, s.link.bindingId, inspect)).toMatchObject({
    selection: s.selection,
    bindingId: s.link.bindingId,
    credentialReference: s.link.bindingId,
  });
  await runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies);
  expect(s.fetch).toHaveBeenCalledOnce();
  writeAtomic(s.roots.targetRoot, 'selection.json', { ...s.selection, calendarId: 'other@example.test' });
  await expect(runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'calendar_operation_conflict',
  );
  expect(s.fetch).toHaveBeenCalledOnce();
});
it('S09 consent cannot transfer to a different native owner or a replaced writer client', async () => {
  const s = fixture();
  await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  await runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies);
  expect(() =>
    readActionAccountConsent(s.roots, { ...s.options.binding, ownerId: 'foreign' }, s.link.bindingId, inspect),
  ).toThrow('action_configuration_conflict');
  writeAtomic(s.roots.targetRoot + '/calendar', 'writer-oauth-client.json', {
    ...s.client,
    clientSecret: 'REPLACED_CLIENT_CANARY',
  });
  expect(() => readActionAccountConsent(s.roots, s.options.binding, s.link.bindingId, inspect)).toThrow(
    'action_setup_conflict',
  );
});
it('S09 does not link with absent setup, wrong owner binding or lost maintenance checks', async () => {
  const s = fixture();
  await expect(runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow();
  await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  await expect(
    runActionAccountAdmin({ ...s.options, args: { ...s.link, scopeId: 'foreign' } }, s.dependencies),
  ).rejects.toThrow('context_binding_changed');
  s.options.check.mockRejectedValue(new Error('target_not_quiescent'));
  await expect(runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow(
    'target_not_quiescent',
  );
  expect(s.fetch).not.toHaveBeenCalled();
  expect(s.display).not.toHaveBeenCalled();
});
it('S09 never repeats an uncertain OAuth exchange or replaces malformed setup history', async () => {
  const s = fixture();
  await runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies);
  s.fetch.mockRejectedValue(new Error('PRIVATE_OAUTH_CANARY'));
  await expect(runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow();
  expect(s.fetch).toHaveBeenCalledOnce();
  await expect(runActionAccountAdmin({ ...s.options, args: s.link }, s.dependencies)).rejects.toThrow();
  expect(s.fetch).toHaveBeenCalledOnce();
  expect(s.display).toHaveBeenCalledOnce();
  writeAtomic(s.roots.targetRoot, 'action-setup.json', null);
  await expect(runActionAccountAdmin({ ...s.options, args: s.setup }, s.dependencies)).rejects.toThrow(
    'action_setup_conflict',
  );
  expect(JSON.parse(fs.readFileSync(s.roots.targetRoot + '/action-setup.json', 'utf8'))).toBeNull();
});
