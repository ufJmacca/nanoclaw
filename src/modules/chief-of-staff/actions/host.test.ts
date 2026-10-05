import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ recovery: vi.fn(), inspect: vi.fn(), token: vi.fn(), verify: vi.fn(), owner: vi.fn() }));
vi.mock('../ops/target-identity.js', () => ({
  localTarget: (root: string) => JSON.parse(fs.readFileSync(path.join(root, 'state.json'), 'utf8')),
}));
vi.mock('./profile.js', async (original) => ({
  ...(await original<typeof import('./profile.js')>()),
  verifyActionGrantRecovery: f.recovery,
}));
vi.mock('./config.js', async (original) => ({
  ...(await original<typeof import('./config.js')>()),
  openWriterCredentials: f.owner,
}));
import { openActionHost } from './host.js';
import { initializeTargetActionWitness } from './host-ownership.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from '../ops/target-state.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE } from './writer.js';
import { writerAccountFingerprint } from './google-writer.js';
import type { ActionHostProfile } from './profile.js';
import { createActionIntent } from './intent.js';
import type { CalendarActionRequest } from '../contracts/action-protocol.js';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-host-'));
  roots.push(targetRoot);
  const storage = { targetRoot, installationRoot: targetRoot + '-app', dataRoot: targetRoot + '-data' },
    target = {
      ...storage,
      hostFingerprint: digest('fixture host'),
      databaseFingerprint: digest('verified runtime DB'),
      service: 'nano.service',
    };
  const { targetRoot: _targetRoot, ...binding } = target;
  writeAtomic(targetRoot, 'state.json', { binding });
  const witness = initializeTargetActionWitness(targetRoot, digest(binding)),
    reference = randomUUID(),
    context = { scopeId: 'scope', ownerId: 'owner', sessionId: 'main', agentGroupId: 'main', ingressId: 'owner-event' },
    authority = {
      bindingDigest: digest('retained private main'),
      contextGeneration: randomUUID(),
      actionProfileDigest: digest('cos-calendar-action/v1'),
      provider: {
        profile: 'codex-subscription/coordinator-v1',
        model: 'fixture',
        policyDigest: digest('current policy'),
      },
    },
    resolve = vi.fn(() => authority),
    admitted = vi.fn(() => true),
    backup = { fixture: 'target backup' },
    proof = { fixture: 'separate recovery proof' };
  const grant = {
    scopeId: context.scopeId,
    ownerId: context.ownerId,
    sessionId: context.sessionId,
    agentGroupId: context.agentGroupId,
    id: randomUUID(),
    credentialReference: reference,
    backupOperationId: 'release-fixture-actions',
    targetBackupDigest: digest(backup),
    writeEnabled: true,
    binding: {
      format: 'cos-calendar-writer/v1' as const,
      provider: 'google' as const,
      calendarId: 'operator@example.test',
      accountFingerprint: writerAccountFingerprint('operator@example.test'),
      credentialGeneration: reference,
      instanceId: 'fixture',
      channelId: 'private',
      bindingDigest: authority.bindingDigest,
      processingProvider: 'codex' as const,
      restoreProofDigest: digest(proof),
      scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
    },
  };
  const profile: ActionHostProfile = {
    format: 'cos-action-host/v1',
    installationDigest: witness.installationDigest,
    journalGeneration: witness.generation,
    grants: [grant],
  };
  writeAtomic(path.join(targetRoot, 'actions'), 'writer-profile.json', profile);
  fs.mkdirSync(path.join(targetRoot, 'actions', 'restore-proofs'), { mode: 0o700 });
  writeAtomic(path.join(targetRoot, 'actions', 'restore-proofs'), digest(proof) + '.json', proof);
  const receipt = path.join(targetRoot, 'releases', grant.backupOperationId, 'action-state');
  fs.mkdirSync(receipt, { recursive: true, mode: 0o700 });
  writeAtomic(receipt, 'action-backup.json', backup);
  f.recovery.mockResolvedValue(proof);
  f.verify.mockImplementation(() => {});
  f.inspect.mockResolvedValue({ auth: 'ready', scopes: grant.binding.scopes, generation: 37 });
  f.token.mockResolvedValue('FIXTURE_HOST_TOKEN');
  f.owner.mockReturnValue({ credentials: { inspect: f.inspect, token: f.token }, verify: f.verify });
  const fetch = vi.fn(
    async (url: string, _init: RequestInit) =>
      new Response(
        JSON.stringify(
          url.includes('/calendarList/')
            ? {
                id: grant.binding.calendarId,
                primary: true,
                accessRole: 'owner',
                timeZone: 'UTC',
                etag: 'fixture-owner-1',
              }
            : { items: [], timeZone: 'UTC', accessRole: 'owner' },
        ),
      ),
  );
  const request: CalendarActionRequest = {
    kind: 'calendar_block',
    binding_id: grant.id,
    calendar_id: grant.binding.calendarId,
    start: '2026-10-05T22:00:00Z',
    end: '2026-10-05T23:00:00Z',
    time_zone: 'UTC',
    title: 'Focus work',
    description: '',
    project_id: null,
    mission_id: null,
    attendees: [],
  };
  return { storage, witness, context, authority, resolve, admitted, grant, profile, fetch, request };
}
it('S09 opens the current retained host writer without provider calls and keeps OAuth rotations distinct from consent identity', async () => {
  const s = fixture(),
    dependencies = await openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve, {
      fetch: s.fetch,
      now: () => Date.parse('2026-10-05T21:00:00Z'),
    });
  expect(f.recovery).toHaveBeenCalledOnce();
  expect(s.fetch).not.toHaveBeenCalled();
  expect(f.token).not.toHaveBeenCalled();
  const writer = dependencies!.writer(s.context, s.grant.id, s.grant.binding)!;
  expect(await writer.access()).toMatchObject({
    generation: s.grant.credentialReference,
    writeEnabled: true,
    auth: 'ready',
  });
  expect(f.inspect).toHaveBeenCalledWith('scope', s.grant.id, s.grant.credentialReference);
  expect((await writer.inspect(s.request)).calendarId).toBe(s.grant.binding.calendarId);
  expect(s.fetch.mock.calls.every(([url]) => url.startsWith('https://www.googleapis.com/calendar/v3/'))).toBe(true);
  expect(dependencies!.authority(s.context)).toEqual(s.authority);
});
it('S09 disabling new writes retains same-event GET reconciliation without a new context or model call', async () => {
  const s = fixture(),
    dependencies = await openActionHost({}, s.storage, s.admitted, s.resolve, {
      fetch: s.fetch,
      now: () => Date.parse('2026-10-05T21:00:00Z'),
    }),
    writer = dependencies!.writer(s.context, s.grant.id, s.grant.binding)!;
  expect((await writer.access()).writeEnabled).toBe(false);
  expect(dependencies!.writerEnabled!(s.context, s.grant.id, s.grant.binding)).toBe(false);
  const now = Date.parse('2026-10-05T21:00:00Z'),
    intent = createActionIntent({
      request: s.request,
      context: s.context,
      requestId: randomUUID(),
      destination: { instanceId: 'fixture', channelId: 'private' },
      now,
      resources: [
        {
          kind: 'writer_binding',
          id: s.grant.id,
          version: 1,
          digest: digest(s.grant.binding),
          observed_at: '2026-10-05T21:00:00Z',
        },
        {
          kind: 'availability',
          id: 'availability-' + digest('available'),
          version: 1,
          digest: digest('slot'),
          observed_at: '2026-10-05T21:00:00Z',
        },
      ],
    });
  const initial = s.fetch.getMockImplementation()!;
  s.fetch.mockImplementation(async (url, init) =>
    url.includes('/events/') ? new Response('{}', { status: 404 }) : initial(url, init),
  );
  await expect(writer.get(intent, digest(intent))).resolves.toBeNull();
  expect(s.fetch).toHaveBeenCalled();
  expect(s.fetch.mock.calls.every(([, init]) => init.method === 'GET')).toBe(true);
  expect(s.fetch.mock.calls.some(([url]) => url.includes('/events/' + intent.eventId))).toBe(true);
});
it('S09 a disabled unconfigured writer opens no vault and never initializes a host profile', async () => {
  const s = fixture();
  fs.unlinkSync(path.join(s.storage.targetRoot, 'actions', 'writer-profile.json'));
  await expect(openActionHost({}, s.storage, s.admitted, s.resolve)).resolves.toBeUndefined();
  expect(f.owner).not.toHaveBeenCalled();
  await expect(openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve)).rejects.toThrow(
    'action_host_unavailable',
  );
  expect(fs.existsSync(path.join(s.storage.targetRoot, 'actions', 'writer-profile.json'))).toBe(false);
});
it.each(['owner', 'session', 'group', 'binding', 'id', 'origin', 'pause', 'profile', 'proof'])(
  'S09 fences %s mismatches before touching a provider or token',
  async (kind) => {
    const s = fixture(),
      dependencies = await openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve, {
        fetch: s.fetch,
      });
    const context = { ...s.context },
      body = structuredClone(s.grant.binding);
    if (kind === 'owner') context.ownerId = 'foreign';
    if (kind === 'session') context.sessionId = 'foreign';
    if (kind === 'group') context.agentGroupId = 'foreign';
    if (kind === 'binding') body.calendarId = 'foreign@example.test';
    if (kind === 'origin') Object.assign(context, { origin: { kind: 'schedule', runId: 'foreign', generation: 1 } });
    if (kind === 'pause') s.admitted.mockReturnValue(false);
    if (kind === 'profile')
      writeAtomic(path.join(s.storage.targetRoot, 'actions'), 'writer-profile.json', { ...s.profile, grants: [] });
    if (kind === 'proof')
      fs.unlinkSync(path.join(s.storage.targetRoot, 'actions', 'restore-proofs', body.restoreProofDigest + '.json'));
    expect(dependencies!.writer(context, kind === 'id' ? randomUUID() : s.grant.id, body)).toBeNull();
    expect(f.token).not.toHaveBeenCalled();
    expect(s.fetch).not.toHaveBeenCalled();
  },
);
it('S09 loses admission when protected storage changes while credentials are awaited', async () => {
  const s = fixture(),
    dependencies = await openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve, {
      fetch: s.fetch,
    }),
    writer = dependencies!.writer(s.context, s.grant.id, s.grant.binding)!;
  f.inspect.mockImplementation(async () => {
    f.verify.mockImplementation(() => {
      throw Error('PRIVATE_STORAGE_CANARY');
    });
    return { auth: 'ready', scopes: s.grant.binding.scopes, generation: 38 };
  });
  await expect(writer.access()).rejects.toThrow('writer_credentials_unavailable');
  expect(f.token).not.toHaveBeenCalled();
  expect(s.fetch).not.toHaveBeenCalled();
});
it('S09 rejects an unproved recovery before opening the credential vault', async () => {
  const s = fixture();
  f.recovery.mockRejectedValueOnce(new Error('PRIVATE_RECOVERY_CANARY'));
  await expect(openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve)).rejects.toThrow(
    'action_host_unavailable',
  );
  expect(f.owner).not.toHaveBeenCalled();
  expect(f.token).not.toHaveBeenCalled();
  expect(s.fetch).not.toHaveBeenCalled();
});
it('S09 closes provider admission if the retained owner changes while a token is awaited', async () => {
  const s = fixture(),
    dependencies = await openActionHost({ COS_ACTIONS_ENABLED: 'true' }, s.storage, s.admitted, s.resolve, {
      fetch: s.fetch,
      now: () => Date.parse('2026-10-05T21:00:00Z'),
    }),
    writer = dependencies!.writer(s.context, s.grant.id, s.grant.binding)!;
  f.token.mockImplementation(async () => {
    s.resolve.mockReturnValue({ ...s.authority, bindingDigest: digest('changed private owner') });
    return 'PRIVATE_TOKEN_CANARY';
  });
  await expect(writer.inspect(s.request)).rejects.toThrow('writer_credentials_unavailable');
  expect(f.token).toHaveBeenCalledOnce();
  expect(s.fetch).not.toHaveBeenCalled();
});
