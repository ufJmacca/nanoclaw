import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { digest } from '../domain/contracts.js';
import { targetBinding } from '../ops/target-host.js';
import type { DeploymentSettings } from '../ops/deployment-settings.js';
import type { RecoveredTargetVaultIdentity } from '../ops/backup-recovered-state.js';
import type { BackupRemoteRestore } from '../ops/backup-restic-transfer.js';
import { recoveryReleaseForManifest } from '../ops/recovery-manifest.js';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { initializeTargetDraftJournal } from './host-ownership.js';
import type { DraftJournal } from './journal.js';
import type { MailDraftHostGrant } from './profile.js';
import type { MailDraftCredentialRecoveryIdentity } from './credential-recovery.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import { writeAtomic } from '../ops/target-state.js';
import { produceMailDraftRecoveryProof, readMailDraftRecoveryProof } from './recovery.js';
const backend = vi.hoisted(() => ({
  state: vi.fn<typeof import('../ops/backup-target-restore.js').restoreTargetVaultBackupTestScope>(),
  credentials: vi.fn<typeof import('./credential-recovery.js').restoreMailDraftCredentialBaseline>(),
}));
vi.mock('../ops/backup-target-restore.js', () => ({ restoreTargetVaultBackupTestScope: backend.state }));
vi.mock('./credential-recovery.js', async (original) => ({
  ...(await original<typeof import('./credential-recovery.js')>()),
  restoreMailDraftCredentialBaseline: backend.credentials,
}));
const cleanup: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-recovery-'));
  cleanup.push(root);
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
    databaseFingerprint: digest('runtime database'),
  };
  fs.mkdirSync(settings.stateRoot, { mode: 0o700 });
  const installation = digest(targetBinding(settings)),
    journal = initializeTargetDraftJournal(settings.stateRoot, installation);
  journals.push(journal);
  const binding = {
      scopeId: 'scope',
      ownerId: 'owner',
      botId: 'bot',
      instanceId: 'instance',
      channelId: 'channel',
      agentGroupId: 'group',
      messagingGroupId: 'messaging',
      provider: 'codex' as const,
      sessionId: 'retained-session',
    },
    selection: MailDraftCredentialRecoveryIdentity = {
      scopeId: binding.scopeId,
      readerBindingId: randomUUID(),
      writerBindingId: randomUUID(),
      readerReference: randomUUID(),
      writerReference: randomUUID(),
      mailboxDigest: digest('owner@example.test'),
      readerClientDigest: digest('reader'),
      writerClientDigest: digest('writer'),
    },
    target = {
      settings,
      binding,
      queueOperationId: randomUUID(),
      recovery: recoveryReleaseForManifest(fixtureVaultRelease('G05')),
      expectedSnapshotDigest: digest('actual encrypted state snapshot'),
      witness: {} as RecoveredTargetVaultIdentity['witness'],
      current: vi.fn(),
    };
  const state = {
      format: 'cos-sandbox-scope-restore/v1',
      checkpointDigest: digest('actual checkpoint'),
      sandboxDatabaseFingerprint: digest('different marked restore database'),
      restoredStateDigest: digest('restored rows'),
      inserted: true,
      admissionRestored: false,
      eventJournalRestored: false,
      snapshotDigest: target.expectedSnapshotDigest,
      credentialsActivated: false as const,
      writerActivated: false as const,
    },
    credentials = {
      format: 'cos-mail-draft-credential-restore/v1',
      ownerDigest: digest('actual vault'),
      selectionDigest: digest(selection),
      captureOperationId: randomUUID(),
      requestId: randomUUID(),
      setDigest: digest('complete current set'),
      sourceCount: 4,
      fileCount: 10,
      snapshotId: digest('credential remote snapshot'),
      archiveSha256: digest('encrypted credential archive'),
      archiveBytes: 40960,
      verifiedAt: new Date().toISOString(),
      credentialsActivated: false,
      admissionRestored: false,
      draftJournalRestored: false,
      writerActivated: false,
    } satisfies Awaited<ReturnType<typeof import('./credential-recovery.js').restoreMailDraftCredentialBaseline>>;
  const remote: BackupRemoteRestore = {
    contract: 'cos-backup-remote-restore/v1',
    repositoryId: digest('repository'),
    ownerDigest: digest('repository owner'),
    kind: 'state',
    operationId: target.queueOperationId,
    snapshotId: digest('state remote snapshot'),
    snapshotAt: new Date().toISOString(),
    verifiedAt: new Date().toISOString(),
    archiveSha256: digest('encrypted state archive'),
    archiveBytes: 32768,
    receipt: {
      format: 'cos-backup-queue/v1',
      ownerDigest: digest('queue owner'),
      kind: 'state',
      operationId: target.queueOperationId,
      state: 'pending',
      createdAt: new Date().toISOString(),
      maximumBytes: 65536,
      bytes: 42,
      files: [],
    },
  };
  const input = {
    target,
    journal,
    selection,
    stateRequestId: randomUUID(),
    credentialCaptureOperationId: credentials.captureOperationId,
    credentialRequestId: credentials.requestId,
    sandbox: { client: {} as pg.Client, config: {}, testTargetId: 'marked-separated-target' },
    checkDatabase: vi.fn().mockResolvedValue(undefined),
  };
  backend.state.mockReset().mockImplementation(async (options, _request, _sandbox, check) => {
    options.current();
    await check();
    return { remote: structuredClone(remote), validation: structuredClone(state) };
  });
  backend.credentials.mockReset().mockImplementation(async (_roots, options) => {
    options.assertAuthority();
    return structuredClone(credentials);
  });
  const grantFor = (proof: Awaited<ReturnType<typeof produceMailDraftRecoveryProof>>): MailDraftHostGrant => ({
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    id: selection.writerBindingId,
    version: 1,
    backupOperationId: proof.backupOperationId,
    targetBackupDigest: proof.state.snapshotDigest,
    writeEnabled: true,
    binding: {
      format: 'cos-mail-draft-binding/v1',
      provider: 'google',
      readerBindingId: selection.readerBindingId,
      mailboxDigest: selection.mailboxDigest,
      writerClientDigest: selection.writerClientDigest,
      readerClientDigest: selection.readerClientDigest,
      credentialReference: selection.writerReference,
      nativeBindingDigest: digest(binding),
      journalGeneration: journal.generation,
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      recoveryProofDigest: digest(proof),
    },
  });
  const save = (proof: Awaited<ReturnType<typeof produceMailDraftRecoveryProof>>) => {
    const directory = settings.stateRoot + '/mail-drafts/restore-proofs';
    fs.mkdirSync(directory, { mode: 0o700 });
    writeAtomic(directory, digest(proof) + '.json', proof);
  };
  return {
    root,
    settings,
    installation,
    journal,
    input,
    target,
    state,
    credentials,
    remote,
    selection,
    grantFor,
    save,
  };
}
it('requires both real recovery compositions and pins an offline owner/journal-bound metadata proof without activating anything', async () => {
  const f = fixture(),
    proof = await produceMailDraftRecoveryProof(f.input),
    grant = f.grantFor(proof);
  expect(backend.state).toHaveBeenCalledTimes(1);
  expect(backend.credentials).toHaveBeenCalledTimes(1);
  expect(proof).toMatchObject({
    format: 'cos-mail-draft-recovery/v1',
    installationDigest: f.installation,
    nativeBindingDigest: digest(f.target.binding),
    journalGeneration: f.journal.generation,
    backupOperationId: 'release-action-' + f.target.queueOperationId,
    admissionRestored: false,
    draftJournalRestored: false,
    writerActivated: false,
  });
  expect(proof.state.schemaVersion).toBe(20);
  f.save(proof);
  expect(readMailDraftRecoveryProof(f.settings.stateRoot, f.installation, f.journal, grant)).toEqual(proof);
  expect(JSON.stringify(proof)).not.toMatch(/runtimeEnvironment|password|\/tmp\/|\/state\//);
});
it.each([
  'wrong_snapshot',
  'same_database',
  'restored_admission',
  'wrong_credentials',
  'wrong_capture',
  'wrong_schema',
  'different_journal',
  'state_failure',
  'credential_failure',
  'remote_operation',
  'remote_kind',
  'remote_archive',
])('refuses combined recovery proof after %s', async (failure) => {
  const f = fixture();
  if (failure === 'wrong_snapshot') f.state.snapshotDigest = digest('other');
  if (failure === 'same_database') f.state.sandboxDatabaseFingerprint = f.settings.databaseFingerprint;
  if (failure === 'restored_admission') f.state.admissionRestored = true;
  if (failure === 'wrong_credentials') f.credentials.selectionDigest = digest('other selected account');
  if (failure === 'wrong_capture') f.credentials.captureOperationId = randomUUID();
  if (failure === 'wrong_schema') f.target.recovery.software.schemaVersion = 19;
  if (failure === 'different_journal') f.selection.scopeId = 'foreign';
  if (failure === 'state_failure') backend.state.mockRejectedValue(Error('PRIVATE_SQL_DIAGNOSTIC'));
  if (failure === 'credential_failure') backend.credentials.mockRejectedValue(Error('PRIVATE_NAS_DIAGNOSTIC'));
  if (failure === 'remote_operation') f.remote.operationId = randomUUID();
  if (failure === 'remote_kind') f.remote.kind = 'credentials';
  if (failure === 'remote_archive') f.remote.archiveSha256 = 'invalid';
  await expect(produceMailDraftRecoveryProof(f.input)).rejects.toThrow('mail_draft_recovery_unavailable');
});
it('rejects replaced caller authority during the database await', async () => {
  const f = fixture();
  backend.state.mockImplementationOnce(async () => {
    f.target.current = vi.fn();
    return { remote: f.remote, validation: f.state };
  });
  await expect(produceMailDraftRecoveryProof(f.input)).rejects.toThrow('mail_draft_recovery_unavailable');
  expect(backend.credentials).not.toHaveBeenCalled();
});
it.each(['owner', 'mailbox', 'client', 'reference', 'snapshot', 'native', 'journal'])(
  'a sealed proof cannot grant a different %s identity',
  async (boundary) => {
    const f = fixture(),
      proof = await produceMailDraftRecoveryProof(f.input),
      grant = f.grantFor(proof);
    f.save(proof);
    if (boundary === 'owner') grant.ownerId = 'foreign';
    if (boundary === 'mailbox') grant.binding.mailboxDigest = digest('foreign');
    if (boundary === 'client') grant.binding.writerClientDigest = digest('foreign');
    if (boundary === 'reference') grant.binding.credentialReference = randomUUID();
    if (boundary === 'snapshot') grant.targetBackupDigest = digest('foreign');
    if (boundary === 'native') grant.binding.nativeBindingDigest = digest('foreign');
    if (boundary === 'journal') grant.binding.journalGeneration = randomUUID();
    expect(() => readMailDraftRecoveryProof(f.settings.stateRoot, f.installation, f.journal, grant)).toThrow(
      'mail_draft_recovery_unavailable',
    );
  },
);
it('never repairs a missing proof or accepts a symlinked/replaced independent journal', async () => {
  const f = fixture(),
    proof = await produceMailDraftRecoveryProof(f.input),
    grant = f.grantFor(proof);
  expect(() => readMailDraftRecoveryProof(f.settings.stateRoot, f.installation, f.journal, grant)).toThrow();
  f.save(proof);
  const file = f.settings.stateRoot + '/mail-drafts/restore-proofs/' + digest(proof) + '.json';
  fs.renameSync(file, file + '.held');
  fs.symlinkSync(file + '.held', file);
  expect(() => readMailDraftRecoveryProof(f.settings.stateRoot, f.installation, f.journal, grant)).toThrow();
  fs.unlinkSync(file);
  fs.renameSync(file + '.held', file);
  fs.unlinkSync(f.settings.stateRoot + '/mail-drafts/effects/owner.json');
  expect(() => readMailDraftRecoveryProof(f.settings.stateRoot, f.installation, f.journal, grant)).toThrow();
});
