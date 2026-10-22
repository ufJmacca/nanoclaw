import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { GOOGLE_MAIL_READ_SCOPE, GOOGLE_MAIL_DRAFT_SCOPE } from '../calendar/oauth-core.js';
import { initializeTargetDraftJournal, openTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { readMailDraftHostProfile, type MailDraftHostGrant } from '../mail-drafts/profile.js';
import type { MailDraftRecoveryProof } from '../mail-drafts/recovery.js';
import { initializeTarget, protectTarget, writeAtomic } from './target-state.js';
import { machineFingerprint } from './target-identity.js';
import { recoveryReleaseForManifest } from './recovery-manifest.js';
import { checkpointSchema } from './checkpoint-schema.js';
import { parseMailDraftAdminArguments } from './mail-draft-admin-arguments.js';
import { runMailDraftAdmin } from './mail-draft-admin.js';
import { parseAdminArguments, adminEnvironment } from './admin.js';
const ports = vi.hoisted(() => ({
  connect: vi.fn(),
  fingerprint: vi.fn(),
  schema: vi.fn(),
  reader: vi.fn(),
  writer: vi.fn(),
  recovery: vi.fn(),
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
vi.mock('../mail-drafts/recovery.js', async (original) => ({
  ...(await original<typeof import('../mail-drafts/recovery.js')>()),
  readMailDraftRecoveryProof: ports.recovery,
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: vi.fn() }));
const cleanup: string[] = [];
afterEach(() => {
  vi.resetAllMocks();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-draft-policy-');
  fs.chmodSync(root, 0o700);
  cleanup.push(root);
  const roots = { targetRoot: root + '/target', installationRoot: root + '/app', dataRoot: root + '/app/data' },
    targetBinding = {
      hostFingerprint: machineFingerprint(),
      databaseFingerprint: digest('protected database'),
      service: 'fixture.service',
      installationRoot: roots.installationRoot,
      dataRoot: roots.dataRoot,
    },
    release = fixtureVaultRelease('G05');
  initializeTarget(roots.targetRoot, targetBinding);
  const protectedState = protectTarget(roots.targetRoot, targetBinding);
  writeAtomic(roots.targetRoot, 'state.json', { ...protectedState, releaseId: release.releaseId });
  const installation = digest(targetBinding),
    journal = initializeTargetDraftJournal(roots.targetRoot, installation),
    generation = journal.generation;
  journal.close();
  const binding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'main',
    messagingGroupId: 'messages',
    sessionId: 'retained',
    instanceId: 'instance',
    channelId: 'private',
    botId: 'bot',
    provider: 'codex',
  } as CosBinding;
  const writerId = randomUUID(),
    readerId = randomUUID(),
    readerReference = randomUUID(),
    readerClient = 'reader-fixture.apps.googleusercontent.com',
    writerClient = 'writer-fixture.apps.googleusercontent.com';
  const readerRow = {
    id: readerId,
    provider: 'google',
    mailbox_email: 'owner@example.invalid',
    permission_scopes: [GOOGLE_MAIL_READ_SCOPE],
    credential_ref: readerReference,
    processing_providers: ['codex'],
    auth: 'ready',
    version: 1,
  };
  const connection = {
    status: 'ok',
    binding: {
      id: readerRow.id,
      provider: readerRow.provider,
      mailboxEmail: readerRow.mailbox_email,
      scopes: readerRow.permission_scopes,
      credentialRef: readerRow.credential_ref,
      processingProviders: readerRow.processing_providers,
      auth: readerRow.auth,
      version: readerRow.version,
    },
  };
  const selection = {
    scopeId: binding.scopeId,
    readerBindingId: readerId,
    writerBindingId: writerId,
    readerReference,
    writerReference: writerId,
    mailboxDigest: digest(readerRow.mailbox_email),
    readerClientDigest: digest(readerClient),
    writerClientDigest: digest(writerClient),
  };
  const consent = {
    format: 'cos-mail-draft-account-consent/v1',
    installationDigest: installation,
    nativeBindingDigest: digest(binding),
    journalGeneration: generation,
    requestId: randomUUID(),
    readerConnectionDigest: digest(connection),
    selection,
  };
  const consentRoot = roots.targetRoot + '/mail-draft-admin';
  fs.mkdirSync(consentRoot, { mode: 0o700 });
  fs.mkdirSync(consentRoot + '/' + writerId, { mode: 0o700 });
  writeAtomic(consentRoot + '/' + writerId, 'consent.json', consent);
  const queue = randomUUID(),
    proof: MailDraftRecoveryProof = {
      format: 'cos-mail-draft-recovery/v1',
      installationDigest: installation,
      nativeBindingDigest: digest(binding),
      contextDigest: digest({
        scopeId: binding.scopeId,
        ownerId: binding.ownerId,
        agentGroupId: binding.agentGroupId,
        sessionId: binding.sessionId,
      }),
      journalGeneration: generation,
      selection,
      backupOperationId: 'release-action-' + queue,
      release: recoveryReleaseForManifest(release),
      state: {
        repositoryId: digest('repository'),
        snapshotId: digest('state remote'),
        archiveSha256: digest('state archive'),
        archiveBytes: 32768,
        queueOperationId: queue,
        requestId: randomUUID(),
        snapshotDigest: digest('snapshot'),
        checkpointDigest: digest('checkpoint'),
        sourceDatabaseFingerprint: targetBinding.databaseFingerprint,
        sandboxDatabaseFingerprint: digest('separate test'),
        restoredStateDigest: digest('restored rows'),
        inserted: true,
        schemaVersion: 20,
        schemaDigest: checkpointSchema(20).digest,
        admissionRestored: false,
        eventJournalRestored: false,
        credentialsActivated: false,
        writerActivated: false,
      },
      credentials: {
        format: 'cos-mail-draft-credential-restore/v1',
        ownerDigest: digest('vault'),
        selectionDigest: digest(selection),
        captureOperationId: randomUUID(),
        requestId: randomUUID(),
        setDigest: digest('entire set'),
        sourceCount: 14,
        fileCount: 31,
        snapshotId: digest('credential remote'),
        archiveSha256: digest('credential archive'),
        archiveBytes: 40960,
        verifiedAt: new Date().toISOString(),
        credentialsActivated: false,
        admissionRestored: false,
        draftJournalRestored: false,
        writerActivated: false,
      },
      verifiedAt: new Date().toISOString(),
      admissionRestored: false,
      draftJournalRestored: false,
      writerActivated: false,
    };
  const grant: MailDraftHostGrant = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    id: writerId,
    version: 1,
    backupOperationId: proof.backupOperationId,
    targetBackupDigest: proof.state.snapshotDigest,
    writeEnabled: true,
    binding: {
      format: 'cos-mail-draft-binding/v1',
      provider: 'google',
      readerBindingId: readerId,
      mailboxDigest: selection.mailboxDigest,
      writerClientDigest: selection.writerClientDigest,
      readerClientDigest: selection.readerClientDigest,
      credentialReference: writerId,
      nativeBindingDigest: digest(binding),
      journalGeneration: generation,
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      recoveryProofDigest: digest(proof),
    },
  };
  const resource = (clientId: string, scope: string) => ({
    clientId,
    credentials: { inspect: vi.fn(async () => ({ auth: 'ready', scopes: [scope], generation: 1 })), token: vi.fn() },
    fences: { assertOpen: vi.fn() },
    verifyStorage: vi.fn(),
    close: vi.fn(async () => {}),
    closed: () => false,
  });
  const reader = resource(readerClient, GOOGLE_MAIL_READ_SCOPE),
    writer = resource(writerClient, GOOGLE_MAIL_DRAFT_SCOPE),
    installed: Record<string, unknown>[] = [],
    flags = { scope: true, commitUncertain: false };
  const client = {
    query: vi.fn(
      async (sql: string, values: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number }> => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
        if (sql.includes('FROM cos.scopes'))
          return { rows: flags.scope ? [{ id: binding.scopeId }] : [], rowCount: flags.scope ? 1 : 0 };
        if (sql.includes('FROM cos.mail_bindings')) return { rows: [structuredClone(readerRow)], rowCount: 1 };
        if (sql.includes('FROM cos.mail_draft_writer_bindings'))
          return { rows: structuredClone(installed), rowCount: installed.length };
        if (sql.startsWith('INSERT INTO cos.mail_draft_writer_bindings'))
          installed.push({
            owner_id: binding.ownerId,
            session_id: binding.sessionId,
            reader_binding_id: readerId,
            version: 1,
            state: 'enabled',
          });
        if (sql.startsWith('INSERT INTO cos.mail_draft_writer_revisions'))
          Object.assign(installed[0], {
            body: JSON.parse(String(values[2])),
            digest: values[3],
            consent_ref: values[4],
          });
        if (sql === 'COMMIT' && flags.commitUncertain) throw Error('PRIVATE_COMMIT_ACK_LOST');
        return { rows: [], rowCount: 1 };
      },
    ),
    end: vi.fn(async () => {}),
  };
  ports.reader.mockResolvedValue(reader);
  ports.writer.mockResolvedValue(writer);
  ports.recovery.mockReturnValue(proof);
  ports.connect.mockResolvedValue(client);
  ports.schema.mockResolvedValue(20);
  ports.fingerprint.mockResolvedValue(targetBinding.databaseFingerprint);
  const args = {
      command: 'mail-draft-configure' as const,
      scopeId: binding.scopeId,
      requestId: randomUUID(),
      manifestFile: root + '/grant.json',
    },
    options = { args, roots, env: {}, binding, release, check: vi.fn(async () => {}), assertAuthority: vi.fn() };
  const invoke = () => {
    writeAtomic(root, 'grant.json', grant);
    return runMailDraftAdmin(options);
  };
  const file = roots.targetRoot + '/mail-drafts/writer-profile.json';
  return {
    root,
    roots,
    targetBinding,
    installation,
    generation,
    binding,
    consent,
    proof,
    grant,
    args,
    options,
    readerRow,
    reader,
    writer,
    installed,
    flags,
    client,
    file,
    invoke,
  };
}
it('parses only scoped owner policy configuration and disable, with no token, endpoint or capacity overrides', () => {
  const id = randomUUID(),
    writer = randomUUID();
  expect(
    parseMailDraftAdminArguments([
      'mail-draft-configure',
      '--scope',
      'scope',
      '--request-id',
      id,
      '--manifest',
      '/private/grant.json',
    ]),
  ).toMatchObject({ command: 'mail-draft-configure', manifestFile: '/private/grant.json' });
  expect(
    parseAdminArguments([
      'mail-draft-configure',
      '--scope',
      'scope',
      '--request-id',
      id,
      '--manifest',
      '/private/grant.json',
    ]),
  ).toEqual(
    parseMailDraftAdminArguments([
      'mail-draft-configure',
      '--scope',
      'scope',
      '--request-id',
      id,
      '--manifest',
      '/private/grant.json',
    ]),
  );
  expect(
    adminEnvironment('mail-draft-configure', {
      COS_PG_MIGRATION_USER: 'selected-migrator',
      COS_PG_MIGRATION_PASSWORD: 'FIXTURE_PRIVATE_MIGRATOR',
      UNRELATED_KEY: 'DROP',
    }).COS_PG_MIGRATION_USER,
  ).toBe('selected-migrator');
  expect(
    parseMailDraftAdminArguments(['mail-draft-disable', '--scope', 'scope', '--request-id', id, '--binding', writer]),
  ).toMatchObject({ command: 'mail-draft-disable', bindingId: writer });
  for (const args of [
    ['mail-draft-configure', '--scope', 'scope', '--request-id', id, '--manifest', '../grant.json'],
    ['mail-draft-disable', '--scope', 'scope', '--request-id', id, '--binding', writer, '--limit', '99'],
  ])
    expect(() => parseMailDraftAdminArguments(args)).toThrow('invalid_admin_arguments');
});
it('installs only the recovered immutable policy through the migration role, then publishes its host grant while paused', async () => {
  const f = fixture();
  expect(await f.invoke()).toMatchObject({
    status: 'configured_paused',
    binding_id: f.grant.id,
    writer_enabled: true,
    live_model: 'not_invoked',
  });
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(readMailDraftHostProfile(f.roots.targetRoot, f.installation, journal).grants).toEqual([f.grant]);
  } finally {
    journal.close();
  }
  expect(ports.connect).toHaveBeenCalledWith(f.options.env, 'runtime', 'migration');
  expect(f.client.query.mock.calls.some(([sql]) => sql === 'COMMIT')).toBe(true);
  expect(f.installed).toHaveLength(1);
  expect(f.installed[0]).toMatchObject({ digest: digest(f.grant.binding), consent_ref: digest(f.consent) });
  expect(f.reader.close).toHaveBeenCalledOnce();
  expect(f.writer.close).toHaveBeenCalledOnce();
  expect(f.client.end).toHaveBeenCalledOnce();
  expect(f.reader.credentials.token).not.toHaveBeenCalled();
  expect(f.writer.credentials.token).not.toHaveBeenCalled();
  expect(await f.invoke()).toMatchObject({ status: 'configured_paused' });
  expect(f.installed).toHaveLength(1);
});
it('leaves an unknown database commit without a host grant and reconciles identical metadata on a later known commit', async () => {
  const f = fixture();
  f.flags.commitUncertain = true;
  await expect(f.invoke()).rejects.toThrow('mail_draft_configuration_unavailable');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.installed).toHaveLength(1);
  f.flags.commitUncertain = false;
  expect(await f.invoke()).toMatchObject({ writer_enabled: true });
  expect(f.installed).toHaveLength(1);
});
it.each([
  'old-release',
  'schema',
  'database',
  'scope',
  'owner',
  'daily-cap',
  'reader-client',
  'writer-client',
  'reader-revoked',
  'writer-revoked',
  'reader-changed',
  'proof',
  'authority',
] as const)('refuses %s policy admission without publishing a host grant', async (reason) => {
  const f = fixture();
  if (reason === 'old-release') f.options.release = fixtureVaultRelease('G04');
  if (reason === 'schema') ports.schema.mockResolvedValue(19);
  if (reason === 'database') ports.fingerprint.mockResolvedValue(digest('foreign database'));
  if (reason === 'scope') f.flags.scope = false;
  if (reason === 'owner') f.grant.ownerId = 'foreign';
  if (reason === 'daily-cap') Object.assign(f.grant.binding, { maxPerDay: 6 });
  if (reason === 'reader-client') f.reader.clientId = 'foreign.apps.googleusercontent.com';
  if (reason === 'writer-client') f.writer.clientId = f.reader.clientId;
  if (reason === 'reader-revoked') f.reader.credentials.inspect.mockRejectedValue(Error('PRIVATE_DENIAL'));
  if (reason === 'writer-revoked') f.writer.credentials.inspect.mockRejectedValue(Error('PRIVATE_DENIAL'));
  if (reason === 'reader-changed') f.readerRow.version = 2;
  if (reason === 'proof')
    ports.recovery.mockImplementation(() => {
      throw Error('PRIVATE_PROOF_FAILURE');
    });
  if (reason === 'authority')
    f.options.assertAuthority.mockImplementation(() => {
      throw Error('PRIVATE_OWNER_LOST');
    });
  await expect(f.invoke()).rejects.toThrow('mail_draft_configuration_unavailable');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.installed).toHaveLength(0);
});
it('disables the local host grant even when database, credentials and recovery are unavailable', async () => {
  const f = fixture();
  writeAtomic(f.roots.targetRoot + '/mail-drafts', 'writer-profile.json', {
    format: 'cos-mail-draft-host/v1',
    installationDigest: f.installation,
    journalGeneration: f.generation,
    grants: [f.grant],
  });
  ports.connect.mockRejectedValue(Error('PRIVATE_OFFLINE'));
  ports.reader.mockRejectedValue(Error('PRIVATE_OFFLINE'));
  ports.writer.mockRejectedValue(Error('PRIVATE_OFFLINE'));
  ports.recovery.mockImplementation(() => {
    throw Error('PRIVATE_OFFLINE');
  });
  expect(
    await runMailDraftAdmin({
      ...f.options,
      args: { command: 'mail-draft-disable', scopeId: 'scope', requestId: randomUUID(), bindingId: f.grant.id },
    }),
  ).toMatchObject({ status: 'disabled_paused', writer_enabled: false });
  expect(ports.connect).not.toHaveBeenCalled();
  expect(ports.reader).not.toHaveBeenCalled();
  expect(ports.writer).not.toHaveBeenCalled();
  expect(ports.recovery).not.toHaveBeenCalled();
  const journal = openTargetDraftJournal(f.roots.targetRoot, f.installation);
  try {
    expect(readMailDraftHostProfile(f.roots.targetRoot, f.installation, journal).grants[0].writeEnabled).toBe(false);
  } finally {
    journal.close();
  }
});
it.each(['reader-denial', 'consent-change'] as const)(
  'does not publish a new host grant after %s during the final credential await',
  async (reason) => {
    const f = fixture();
    let checks = 0;
    f.writer.credentials.inspect.mockImplementation(async () => {
      if (++checks === 4) {
        if (reason === 'reader-denial')
          f.reader.fences.assertOpen.mockImplementation(() => {
            throw Error('PRIVATE_REVOKED');
          });
        else
          writeAtomic(f.roots.targetRoot + '/mail-draft-admin/' + f.grant.id, 'consent.json', {
            ...f.consent,
            readerConnectionDigest: digest('changed selection'),
          });
      }
      return { auth: 'ready', scopes: [GOOGLE_MAIL_DRAFT_SCOPE], generation: 1 };
    });
    await expect(f.invoke()).rejects.toThrow('mail_draft_configuration_unavailable');
    expect(fs.existsSync(f.file)).toBe(false);
    expect(f.installed).toHaveLength(1);
  },
);
