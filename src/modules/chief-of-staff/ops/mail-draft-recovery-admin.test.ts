import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { recoveryReleaseForManifest } from './recovery-manifest.js';
import { checkpointSchema } from './checkpoint-schema.js';
import { targetBinding } from './target-host.js';
import { writeAtomic, readPrivate } from './target-state.js';
import { initializeTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import type { DeploymentSettings } from './deployment-settings.js';
import type { RecoveredTargetVaultIdentity } from './backup-recovered-state.js';
import { parseBackupOwnerRestoreArguments } from './backup-owner-restore-arguments.js';
import { restoreOwnerMailDraftBaseline } from './mail-draft-recovery-admin.js';
const backend = vi.hoisted(() => ({ state: vi.fn(), credentials: vi.fn() }));
vi.mock('./backup-target-restore.js', () => ({ restoreTargetVaultBackupTestScope: backend.state }));
vi.mock('../mail-drafts/credential-recovery.js', async (original) => ({
  ...(await original<typeof import('../mail-drafts/credential-recovery.js')>()),
  restoreMailDraftCredentialBaseline: backend.credentials,
}));
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close();
  vi.resetAllMocks();
});
function fixture(slice: 'G05' | 'G06' = 'G05') {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-draft-recovery-owner-');
  fs.chmodSync(root, 0o700);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const settings: DeploymentSettings = {
    version: 1,
    target: 'pi',
    sshAlias: 'fixture',
    userHome: root,
    installationRoot: root + '/app',
    dataRoot: root + '/app/data',
    stateRoot: root + '/state',
    releaseRoot: root + '/releases',
    stagingRoot: root + '/staging',
    sourceRoot: root + '/sources',
    runtimeEnvironment: root + '/.config/runtime',
    migrationEnvironment: root + '/.config/migration',
    service: 'fixture.service',
    hostFingerprint: digest('host'),
    databaseFingerprint: digest('protected runtime'),
  };
  fs.mkdirSync(settings.stateRoot, { mode: 0o700 });
  const installation = digest(targetBinding(settings)),
    journal = initializeTargetDraftJournal(settings.stateRoot, installation),
    generation = journal.generation;
  journal.close();
  const binding = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    messagingGroupId: 'messaging',
    sessionId: 'retained-session',
    instanceId: 'instance',
    channelId: 'private',
    botId: 'bot',
    provider: 'codex' as const,
  };
  const writerBindingId = randomUUID(),
    selection = {
      scopeId: binding.scopeId,
      readerBindingId: randomUUID(),
      writerBindingId,
      readerReference: randomUUID(),
      writerReference: writerBindingId,
      mailboxDigest: digest('owner@example.invalid'),
      readerClientDigest: digest('reader'),
      writerClientDigest: digest('writer'),
    };
  const parent = settings.stateRoot + '/mail-draft-admin',
    dir = parent + '/' + writerBindingId;
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });
  writeAtomic(dir, 'consent.json', {
    format: 'cos-mail-draft-account-consent/v1',
    installationDigest: installation,
    nativeBindingDigest: digest(binding),
    journalGeneration: generation,
    requestId: randomUUID(),
    readerConnectionDigest: digest('current reader'),
    selection,
  });
  const target: RecoveredTargetVaultIdentity = {
    settings,
    binding,
    witness: {} as RecoveredTargetVaultIdentity['witness'],
    queueOperationId: randomUUID(),
    recovery: recoveryReleaseForManifest(fixtureVaultRelease(slice)),
    expectedSnapshotDigest: digest('current snapshot'),
    current: vi.fn(),
  };
  const args = {
    command: 'mail-draft-restore-check' as const,
    scopeId: binding.scopeId,
    requestId: randomUUID(),
    queueOperationId: target.queueOperationId,
    backupReleaseId: target.recovery.releaseId,
    snapshotDigest: digest('current snapshot'),
    writerBindingId,
    captureOperationId: randomUUID(),
    credentialRequestId: randomUUID(),
  };
  const state = {
    format: 'cos-sandbox-scope-restore/v1',
    snapshotDigest: args.snapshotDigest,
    checkpointDigest: digest('checkpoint'),
    sandboxDatabaseFingerprint: digest('different marked test database'),
    restoredStateDigest: digest('restored rows'),
    inserted: true,
    admissionRestored: false,
    eventJournalRestored: false,
    credentialsActivated: false,
    writerActivated: false,
  };
  const credentials = {
    format: 'cos-mail-draft-credential-restore/v1',
    ownerDigest: digest('vault'),
    selectionDigest: digest(selection),
    captureOperationId: args.captureOperationId,
    requestId: args.credentialRequestId,
    setDigest: digest('entire current credential set'),
    sourceCount: 14,
    fileCount: 31,
    snapshotId: digest('credential remote snapshot'),
    archiveSha256: digest('credential archive'),
    archiveBytes: 40960,
    verifiedAt: new Date().toISOString(),
    credentialsActivated: false,
    admissionRestored: false,
    draftJournalRestored: false,
    writerActivated: false,
  };
  const sandbox = { client: {} as never, config: { database: 'separate_test' }, testTargetId: 'marked-test' },
    checkDatabase = vi.fn(async () => {});
  backend.state.mockImplementation(async (_target, _request, _sandbox, check) => {
    await check();
    return {
      remote: {
        contract: 'cos-backup-remote-restore/v1',
        kind: 'state',
        operationId: args.queueOperationId,
        repositoryId: digest('repository'),
        snapshotId: digest('remote snapshot'),
        archiveSha256: digest('state archive'),
        archiveBytes: 32768,
      },
      validation: state,
    };
  });
  backend.credentials.mockImplementation(async (_roots, input) => {
    input.assertAuthority();
    return credentials;
  });
  const input = { target, args, sandbox, checkDatabase },
    invoke = () => restoreOwnerMailDraftBaseline(input);
  return {
    root,
    settings,
    installation,
    generation,
    binding,
    selection,
    target,
    args,
    state,
    credentials,
    input,
    dir,
    checkDatabase,
    invoke,
  };
}
it('admits only fixed G05 restore identities through the separate test profile command', () => {
  const f = fixture(),
    a = f.args,
    command = [
      a.command,
      '--scope',
      a.scopeId,
      '--request-id',
      a.requestId,
      '--backup-operation-id',
      a.queueOperationId,
      '--backup-release',
      a.backupReleaseId,
      '--snapshot-digest',
      a.snapshotDigest,
      '--writer-binding',
      a.writerBindingId,
      '--capture-operation-id',
      a.captureOperationId,
      '--credential-request-id',
      a.credentialRequestId,
    ];
  expect(parseBackupOwnerRestoreArguments(command)).toEqual(a);
  for (const changed of [
    command.slice(0, -2),
    [...command, '--runtime', 'true'],
    command.map((v) => (v === a.credentialRequestId ? a.requestId : v)),
    command.map((v) => (v === a.writerBindingId ? '../foreign' : v)),
  ])
    expect(() => parseBackupOwnerRestoreArguments(changed)).toThrow('invalid_owner_admin_arguments');
});
it.each(['G05', 'G06'] as const)(
  '%s persists an offline proof from both recoveries without publishing a writer profile',
  async (slice) => {
    const f = fixture(slice),
      result = await f.invoke();
    expect(result).toMatchObject({
      status: 'mail_draft_restore_verified',
      writer_binding_id: f.args.writerBindingId,
      credentials_activated: false,
      admission_restored: false,
      draft_journal_restored: false,
      writer_activated: false,
    });
    const file = f.settings.stateRoot + '/mail-drafts/restore-proofs/' + result.recovery_proof_digest + '.json',
      proof = readPrivate<Record<string, unknown>>(file);
    expect(digest(proof)).toBe(result.recovery_proof_digest);
    expect(proof).toMatchObject({
      selection: f.selection,
      journalGeneration: f.generation,
      state: {
        schemaVersion: slice === 'G06' ? 21 : 20,
        schemaDigest: checkpointSchema(slice === 'G06' ? 21 : 20).digest,
      },
      writerActivated: false,
    });
    expect(backend.state).toHaveBeenCalledOnce();
    expect(backend.credentials).toHaveBeenCalledOnce();
    expect(fs.existsSync(f.settings.stateRoot + '/mail-drafts/writer-profile.json')).toBe(false);
    expect(f.checkDatabase).toHaveBeenCalled();
  },
);
it.each([
  'missing-consent',
  'wrong-request',
  'state-failure',
  'credential-failure',
  'wrong-credential-set',
  'restored-authority',
  'lost-owner',
  'lost-history',
] as const)('publishes no proof after %s', async (reason) => {
  const f = fixture();
  if (reason === 'missing-consent') fs.unlinkSync(f.dir + '/consent.json');
  if (reason === 'wrong-request') f.args.snapshotDigest = digest('different snapshot');
  if (reason === 'state-failure') backend.state.mockRejectedValue(Error('PRIVATE_STATE_FAILURE'));
  if (reason === 'credential-failure') backend.credentials.mockRejectedValue(Error('PRIVATE_CREDENTIAL_FAILURE'));
  if (reason === 'wrong-credential-set') f.credentials.selectionDigest = digest('different selection');
  if (reason === 'restored-authority') f.state.writerActivated = true;
  if (reason === 'lost-owner')
    backend.credentials.mockImplementation(async () => {
      f.binding.ownerId = 'foreign';
      return f.credentials;
    });
  if (reason === 'lost-history')
    backend.credentials.mockImplementation(async () => {
      fs.unlinkSync(f.settings.stateRoot + '/mail-drafts/effects/effects.sqlite');
      return f.credentials;
    });
  await expect(f.invoke()).rejects.toThrow('mail_draft_owner_restore_unavailable');
  expect(backend.state).toHaveBeenCalledTimes(['missing-consent', 'wrong-request'].includes(reason) ? 0 : 1);
  expect(backend.credentials).toHaveBeenCalledTimes(
    ['missing-consent', 'wrong-request', 'state-failure', 'restored-authority'].includes(reason) ? 0 : 1,
  );
  const directory = f.settings.stateRoot + '/mail-drafts/restore-proofs';
  expect(fs.existsSync(directory) ? fs.readdirSync(directory) : []).toEqual([]);
});
