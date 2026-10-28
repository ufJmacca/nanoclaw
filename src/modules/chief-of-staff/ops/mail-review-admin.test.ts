import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_READ_SCOPE, GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
import { initializeTargetDraftJournal, openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import {
  mailReviewProfileName,
  readMailReviewHostProfile,
  type MailReviewHostProfile,
} from '../automation/mail-review-profile.js';
import type { MailDraftHostProfile } from '../mail-drafts/profile.js';
import { initializeTarget, protectTarget, writeAtomic } from './target-state.js';
import { machineFingerprint } from './target-identity.js';
import { runMailReviewAdmin } from './mail-review-admin.js';
import { parseAdminArguments, adminEnvironment } from './admin.js';
import type { MailReviewAdminArguments } from './mail-review-admin-arguments.js';
const ports = vi.hoisted(() => ({
  connect: vi.fn(),
  fingerprint: vi.fn(),
  schema: vi.fn(),
  reader: vi.fn(),
  writer: vi.fn(),
  recovery: vi.fn(),
  sql: vi.fn(),
  rebindSql: vi.fn(),
}));
vi.mock('../store/preflight.js', async (original) => ({
  ...(await original<typeof import('../store/preflight.js')>()),
  connectChecked: ports.connect,
}));
vi.mock('./target-identity.js', async (original) => ({
  ...(await original<typeof import('./target-identity.js')>()),
  databaseFingerprint: ports.fingerprint,
}));
vi.mock('../store/config.js', async (original) => ({
  ...(await original<typeof import('../store/config.js')>()),
  parseDatabaseConfig: () => ({}),
}));
vi.mock('../store/migrations.js', async (original) => ({
  ...(await original<typeof import('../store/migrations.js')>()),
  migrationStatus: ports.schema,
}));
vi.mock('../mail/config.js', async (original) => ({
  ...(await original<typeof import('../mail/config.js')>()),
  openMailCredentials: ports.reader,
}));
vi.mock('../mail-drafts/config.js', async (original) => ({
  ...(await original<typeof import('../mail-drafts/config.js')>()),
  openMailDraftCredentials: ports.writer,
}));
vi.mock('../mail-drafts/recovery.js', () => ({ readMailDraftRecoveryProof: ports.recovery }));
vi.mock('./mail-review-policy-store.js', () => ({ writeMailReviewStandingPolicy: ports.sql }));
vi.mock('./mail-review-rebind-store.js', () => ({ writeMailReviewReboundPolicy: ports.rebindSql }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
const cleanup: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-review-admin-');
  cleanup.push(root);
  const roots = { targetRoot: root + '/target', installationRoot: root + '/app', dataRoot: root + '/app/data' },
    release = fixtureVaultRelease('G06');
  const targetBinding = {
    hostFingerprint: machineFingerprint(),
    databaseFingerprint: digest('fixture database'),
    service: 'fixture.service',
    installationRoot: roots.installationRoot,
    dataRoot: roots.dataRoot,
  };
  initializeTarget(roots.targetRoot, targetBinding);
  const state = protectTarget(roots.targetRoot, targetBinding);
  writeAtomic(roots.targetRoot, 'state.json', { ...state, releaseId: release.releaseId });
  const installation = digest(targetBinding),
    journal = initializeTargetDraftJournal(roots.targetRoot, installation),
    generation = journal.generation;
  journal.close();
  const binding = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'main',
    messagingGroupId: 'messages',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  } as CosBinding;
  const readerId = randomUUID(),
    writerId = randomUUID(),
    readerReference = randomUUID(),
    writerReference = writerId,
    mainGeneration = randomUUID();
  const readerClient = 'reader.apps.googleusercontent.com',
    writerClient = 'writer.apps.googleusercontent.com';
  const selection = {
    scopeId: binding.scopeId,
    readerBindingId: readerId,
    writerBindingId: writerId,
    readerReference,
    writerReference,
    mailboxDigest: digest('owner@example.test'),
    readerClientDigest: digest(readerClient),
    writerClientDigest: digest(writerClient),
  };
  const consent = {
    format: 'cos-mail-draft-account-consent/v1',
    installationDigest: installation,
    nativeBindingDigest: digest(binding),
    journalGeneration: generation,
    requestId: randomUUID(),
    readerConnectionDigest: digest('fixture linked reader'),
    selection,
  };
  fs.mkdirSync(roots.targetRoot + '/mail-draft-admin', { mode: 0o700 });
  fs.mkdirSync(roots.targetRoot + '/mail-draft-admin/' + writerId, { mode: 0o700 });
  writeAtomic(roots.targetRoot + '/mail-draft-admin/' + writerId, 'consent.json', consent);
  // Recovery/vault validators supply admitted metadata here; their actual storage/recovery contracts are separate fixtures.
  const recovery = { selection, format: 'fixture validated recovery' };
  const writerBinding = {
    format: 'cos-mail-draft-binding/v1' as const,
    provider: 'google' as const,
    readerBindingId: readerId,
    mailboxDigest: selection.mailboxDigest,
    writerClientDigest: selection.writerClientDigest,
    readerClientDigest: selection.readerClientDigest,
    credentialReference: writerReference,
    nativeBindingDigest: digest(binding),
    journalGeneration: generation,
    maxPerDay: 5 as const,
    timeZone: 'Australia/Sydney' as const,
    replyMode: 'plain_text_reply' as const,
    permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    recoveryProofDigest: digest(recovery),
  };
  const draftProfile: MailDraftHostProfile = {
    format: 'cos-mail-draft-host/v1',
    installationDigest: installation,
    journalGeneration: generation,
    grants: [
      {
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        sessionId: binding.sessionId,
        agentGroupId: binding.agentGroupId,
        id: writerId,
        version: 1,
        backupOperationId: 'release-fixture-backup',
        targetBackupDigest: digest('fixture checkpoint'),
        writeEnabled: true,
        binding: writerBinding,
      },
    ],
  };
  writeAtomic(roots.targetRoot + '/mail-drafts', 'writer-profile.json', draftProfile);
  const profile: MailReviewHostProfile = {
    format: 'cos-mail-review-host/v1',
    installationDigest: installation,
    journalGeneration: generation,
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    agentGroupId: binding.agentGroupId,
    id: randomUUID(),
    version: 1,
    binding: {
      format: 'cos-mail-review-binding/v1',
      provider: 'google',
      readerBindingId: readerId,
      writerBindingId: writerId,
      writerVersion: 1,
      writerDigest: digest(writerBinding),
      writerConsentRef: digest(consent),
      nativeBindingDigest: digest(binding),
      mailboxDigest: selection.mailboxDigest,
      contextGeneration: mainGeneration,
      morningScheduleId: randomUUID(),
      afternoonScheduleId: randomUUID(),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    },
  };
  const manifest = root + '/review.json';
  writeAtomic(root, 'review.json', profile);
  const resource = (clientId: string, scopes: string[]) => ({
    clientId,
    verifyStorage: vi.fn(),
    close: vi.fn(async () => {}),
    closed: () => false,
    fences: { assertOpen: vi.fn() },
    credentials: { inspect: vi.fn(async () => ({ auth: 'ready', scopes })), token: vi.fn() },
  });
  const reader = resource(readerClient, [GOOGLE_MAIL_READ_SCOPE]),
    writer = resource(writerClient, [GOOGLE_MAIL_DRAFT_SCOPE]),
    client = { end: vi.fn(async () => {}) };
  ports.reader.mockResolvedValue(reader);
  ports.writer.mockResolvedValue(writer);
  ports.connect.mockResolvedValue(client);
  ports.fingerprint.mockResolvedValue(targetBinding.databaseFingerprint);
  ports.schema.mockResolvedValue(21);
  ports.recovery.mockImplementation(() => structuredClone(recovery));
  ports.sql.mockImplementation(async (_client, _binding, _profile, ready) => {
    await ready();
  });
  const options = {
    args: {
      command: 'mail-review-configure' as MailReviewAdminArguments['command'],
      scopeId: binding.scopeId,
      requestId: randomUUID(),
      manifestFile: manifest,
    },
    env: {},
    roots,
    binding,
    release,
    check: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
    contextCurrent: vi.fn((g: string) => g === mainGeneration),
    contextRecoveryCurrent: vi.fn(
      (previous: string, current: string) => previous !== current && current === mainGeneration,
    ),
  };
  return {
    root,
    roots,
    installation,
    binding,
    profile,
    draftProfile,
    manifest,
    recovery,
    reader,
    writer,
    client,
    options,
    run: () => runMailReviewAdmin(options),
  };
}
function rebindFixture(enabled = true) {
  const f = fixture(),
    previous = structuredClone(f.profile);
  Object.assign(previous.binding, {
    readerBindingId: randomUUID(),
    writerBindingId: randomUUID(),
    writerDigest: digest('old writer'),
    writerConsentRef: digest('old consent'),
    contextGeneration: randomUUID(),
  });
  f.profile.version = 2;
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  let head;
  try {
    head = journal.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision: 0,
        enabled,
        pin: { scopeId: previous.scopeId, policyId: previous.id, policyVersion: 1, profileDigest: digest(previous) },
      },
      () => {},
    );
  } finally {
    journal.close();
  }
  writeAtomic(f.roots.targetRoot + '/mail-drafts', mailReviewProfileName(f.binding.scopeId), previous);
  const manifest = {
    format: 'cos-mail-review-rebind/v1',
    expectedRevision: head.revision,
    expectedPinDigest: digest(head),
    previousProfileDigest: digest(previous),
    profile: f.profile,
  };
  writeAtomic(f.root, 'review.json', manifest);
  f.options.args.command = 'mail-review-rebind';
  ports.rebindSql.mockImplementation(async (_client, _binding, _previous, _manifest, _head, _requestId, ready) => {
    await ready();
  });
  return { ...f, previous, head, rebindManifest: manifest };
}
it.each([true, false])(
  'rebinds only with current reader/writer consent and retained context, preserving enabled=%s',
  async (enabled) => {
    const f = rebindFixture(enabled);
    const writerBefore = fs.readFileSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json');
    expect(await f.run()).toMatchObject({
      status: 'rebound_paused',
      paused: true,
      live_model: 'not_invoked',
      main_context_preserved: true,
      policy_id: f.profile.id,
      policy_version: 2,
      review_enabled: enabled,
    });
    expect(ports.sql).not.toHaveBeenCalled();
    expect(ports.rebindSql).toHaveBeenCalledWith(
      f.client,
      f.binding,
      f.previous,
      f.rebindManifest,
      f.head,
      f.options.args.requestId,
      expect.any(Function),
    );
    const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
    try {
      expect(journal.reviewPolicyPin(f.binding.scopeId)).toMatchObject({ revision: 2, policyVersion: 2, enabled });
      expect(readMailReviewHostProfile(f.roots.targetRoot, f.installation, journal, f.binding.scopeId)).toEqual(
        enabled ? f.profile : null,
      );
    } finally {
      journal.close();
    }
    expect(fs.readFileSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json')).toEqual(writerBefore);
    expect(f.reader.credentials.token).not.toHaveBeenCalled();
    expect(f.writer.credentials.token).not.toHaveBeenCalled();
    expect(await f.run()).toMatchObject({ status: 'rebound_paused', policy_version: 2, review_enabled: enabled });
  },
);
it.each([
  'context',
  'reader-auth',
  'writer-auth',
  'reader-scope',
  'writer-scope',
  'recovery',
  'foreign-database',
  'old-schema',
  'old-release',
  'disabled-writer',
  'reader-fence',
  'writer-fence',
])('refuses consent rebind after current %s authority changes', async (failure) => {
  const f = rebindFixture();
  if (failure === 'context') f.options.contextCurrent.mockReturnValue(false);
  if (failure === 'reader-auth')
    f.reader.credentials.inspect.mockResolvedValue({ auth: 'revoked', scopes: [GOOGLE_MAIL_READ_SCOPE] });
  if (failure === 'writer-auth')
    f.writer.credentials.inspect.mockResolvedValue({ auth: 'revoked', scopes: [GOOGLE_MAIL_DRAFT_SCOPE] });
  if (failure === 'reader-scope')
    f.reader.credentials.inspect.mockResolvedValue({ auth: 'ready', scopes: [GOOGLE_MAIL_DRAFT_SCOPE] });
  if (failure === 'writer-scope')
    f.writer.credentials.inspect.mockResolvedValue({ auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE] });
  if (failure === 'recovery') ports.recovery.mockReturnValue({ ...f.recovery, changed: true });
  if (failure === 'foreign-database') ports.fingerprint.mockResolvedValue(digest('another database'));
  if (failure === 'old-schema') ports.schema.mockResolvedValue(20);
  if (failure === 'old-release') f.options.release.slice = 'G05';
  if (failure === 'disabled-writer') {
    f.draftProfile.grants[0].writeEnabled = false;
    writeAtomic(f.roots.targetRoot + '/mail-drafts', 'writer-profile.json', f.draftProfile);
  }
  if (failure === 'reader-fence')
    f.reader.fences.assertOpen.mockImplementation(() => {
      throw Error('fixture_pending_check');
    });
  if (failure === 'writer-fence')
    f.writer.fences.assertOpen.mockImplementation(() => {
      throw Error('fixture_pending_check');
    });
  await expect(f.run()).rejects.toThrow('mail_review_configuration_unavailable');
  expect(ports.rebindSql).not.toHaveBeenCalled();
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
  } finally {
    journal.close();
  }
});
it('selects migration credentials and strict owner routing for consent rebind', () => {
  const f = rebindFixture(),
    args = f.options.args;
  expect(
    parseAdminArguments([
      args.command,
      '--scope',
      args.scopeId,
      '--request-id',
      args.requestId,
      '--manifest',
      args.manifestFile,
    ]),
  ).toEqual(args);
  const env = adminEnvironment('mail-review-rebind' as MailReviewAdminArguments['command'], {
    COS_PG_MIGRATION_USER: 'selected',
    COS_PG_MIGRATION_PASSWORD: 'synthetic',
    COS_TEST_PGPASSWORD: 'excluded',
  });
  expect(env.COS_PG_MIGRATION_USER).toBe('selected');
  expect(env.COS_PG_MIGRATION_PASSWORD).toBe('synthetic');
  expect(env.COS_TEST_PGPASSWORD).toBeUndefined();
});
it.each(['before-sql', 'after-sql'])(
  'requires current predecessor recovery %s before publishing rebind authority',
  async (stage) => {
    const f = rebindFixture();
    if (stage === 'before-sql') f.options.contextRecoveryCurrent.mockReturnValue(false);
    else
      ports.rebindSql.mockImplementation(async (_client, _binding, _previous, _manifest, _head, _requestId, ready) => {
        await ready();
        f.options.contextRecoveryCurrent.mockReturnValue(false);
      });
    await expect(f.run()).rejects.toThrow('mail_review_configuration_unavailable');
    if (stage === 'before-sql') expect(ports.rebindSql).not.toHaveBeenCalled();
    const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
    try {
      expect(journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
    } finally {
      journal.close();
    }
  },
);
it('publishes only the initial review policy while paused, reusing existing consent, recovery and credential metadata', async () => {
  const f = fixture(),
    before = fs.readFileSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json');
  expect(await f.run()).toMatchObject({
    status: 'configured_paused',
    paused: true,
    live_model: 'not_invoked',
    policy_id: f.profile.id,
  });
  expect(ports.sql).toHaveBeenCalledWith(f.client, f.binding, f.profile, expect.any(Function));
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(readMailReviewHostProfile(f.roots.targetRoot, f.installation, journal, f.binding.scopeId)).toEqual(
      f.profile,
    );
  } finally {
    journal.close();
  }
  expect(fs.readFileSync(f.roots.targetRoot + '/mail-drafts/writer-profile.json')).toEqual(before);
  expect(f.options.contextCurrent).toHaveBeenCalledWith(f.profile.binding.contextGeneration);
  expect(f.reader.credentials.token).not.toHaveBeenCalled();
  expect(f.writer.credentials.token).not.toHaveBeenCalled();
  expect(f.reader.close).toHaveBeenCalledOnce();
  expect(f.writer.close).toHaveBeenCalledOnce();
  expect(f.client.end).toHaveBeenCalledOnce();
});
it('routes explicit initial configuration and selects only its migration credential profile', () => {
  const f = fixture(),
    args = f.options.args;
  expect(
    parseAdminArguments([
      args.command,
      '--scope',
      args.scopeId,
      '--request-id',
      args.requestId,
      '--manifest',
      args.manifestFile,
    ]),
  ).toEqual(args);
  const env = adminEnvironment('mail-review-configure', {
    COS_PG_MIGRATION_USER: 'fixture-migrator',
    COS_PG_MIGRATION_PASSWORD: 'fixture-not-private',
    COS_TEST_PGPASSWORD: 'excluded-fixture-value',
  });
  expect(env.COS_PG_MIGRATION_USER).toBe('fixture-migrator');
  expect(env.COS_PG_MIGRATION_PASSWORD).toBe('fixture-not-private');
  expect(env.COS_TEST_PGPASSWORD).toBeUndefined();
  expect(ports.reader).not.toHaveBeenCalled();
});
it('losing the retained context after SQL returns prevents independent profile admission', async () => {
  const f = fixture();
  ports.sql.mockImplementation(async (_client, _binding, _profile, ready) => {
    await ready();
    f.options.contextCurrent.mockReturnValue(false);
  });
  await expect(f.run()).rejects.toThrow('mail_review_configuration_unavailable');
  expect(ports.sql).toHaveBeenCalledOnce();
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
  } finally {
    journal.close();
  }
  expect(f.client.end).toHaveBeenCalledOnce();
  expect(f.reader.close).toHaveBeenCalledOnce();
  expect(f.writer.close).toHaveBeenCalledOnce();
});
it.each([
  'context',
  'reader-auth',
  'writer-auth',
  'reader-scope',
  'writer-scope',
  'recovery',
  'foreign-database',
  'old-schema',
  'old-release',
  'disabled-writer',
])('withholds initial review publication after %s changes', async (failure) => {
  const f = fixture();
  if (failure === 'context') f.options.contextCurrent.mockReturnValue(false);
  if (failure === 'reader-auth')
    f.reader.credentials.inspect.mockResolvedValue({ auth: 'revoked', scopes: [GOOGLE_MAIL_READ_SCOPE] });
  if (failure === 'writer-auth')
    f.writer.credentials.inspect.mockResolvedValue({ auth: 'revoked', scopes: [GOOGLE_MAIL_DRAFT_SCOPE] });
  if (failure === 'reader-scope')
    f.reader.credentials.inspect.mockResolvedValue({ auth: 'ready', scopes: [GOOGLE_MAIL_DRAFT_SCOPE] });
  if (failure === 'writer-scope')
    f.writer.credentials.inspect.mockResolvedValue({ auth: 'ready', scopes: [GOOGLE_MAIL_READ_SCOPE] });
  if (failure === 'recovery') ports.recovery.mockReturnValue({ ...f.recovery, changed: true });
  if (failure === 'foreign-database') ports.fingerprint.mockResolvedValue(digest('another database'));
  if (failure === 'old-schema') ports.schema.mockResolvedValue(20);
  if (failure === 'old-release') f.options.release.slice = 'G05';
  if (failure === 'disabled-writer') {
    f.draftProfile.grants[0].writeEnabled = false;
    writeAtomic(f.roots.targetRoot + '/mail-drafts', 'writer-profile.json', f.draftProfile);
  }
  await expect(f.run()).rejects.toThrow('mail_review_configuration_unavailable');
  expect(ports.sql).not.toHaveBeenCalled();
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
  } finally {
    journal.close();
  }
});
