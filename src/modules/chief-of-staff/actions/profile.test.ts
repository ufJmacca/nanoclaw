import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({ paired: vi.fn(), conversations: vi.fn(), missions: vi.fn(), calendar: vi.fn() }));
vi.mock('../ops/coordinated-backup.js', async (original) => ({
  ...(await original<typeof import('../ops/coordinated-backup.js')>()),
  verifyCoordinatedBackup: f.paired,
}));
vi.mock('../ops/conversation-backup.js', () => ({ verifyConversationBackup: f.conversations }));
vi.mock('../ops/mission-backup.js', () => ({ verifyMissionBackup: f.missions }));
vi.mock('../calendar/backup.js', () => ({ verifyCalendarWriterBackup: f.calendar }));
import {
  readActionHostProfile,
  verifyActionGrantRecovery,
  type ActionHostProfile,
  type ActionHostGrant,
} from './profile.js';
import { initializeTargetActionWitness } from './host-ownership.js';
import { digest } from '../domain/contracts.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';
import { writeAtomic } from '../ops/target-state.js';
import { GOOGLE_CALENDAR_METADATA_SCOPE, GOOGLE_OWNED_EVENT_WRITE_SCOPE } from './writer.js';
import type { CoordinatedRestoreProof } from '../ops/coordinated-backup.js';
const roots: string[] = [];
afterEach(() => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-action-profile-'));
  roots.push(targetRoot);
  const storage = { targetRoot, installationRoot: targetRoot + '-app', dataRoot: targetRoot + '-data' },
    installationDigest = digest('bound fixture target'),
    witness = initializeTargetActionWitness(targetRoot, installationDigest),
    identity = { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'main', sessionId: 'main' },
    operationId = 'release-fixture-actions',
    receiptRoot = path.join(targetRoot, 'releases', operationId, 'action-state'),
    journal = { installationDigest, generation: witness.generation };
  fs.mkdirSync(receiptRoot, { recursive: true, mode: 0o700 });
  const checkpoint = {
    format: 'cos-coordinated-backup/v1',
    databaseFingerprint: digest('runtime DB'),
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: digest(MIGRATIONS.map(({ version, checksum }) => ({ version, checksum }))),
    journal,
    contextDigest: digest({ ...identity, ingressId: 'operator-backup-' + operationId }),
    sqlite: [{ file: 'sqlite/0/native.sqlite' }],
  };
  const target = {
    format: 'cos-target-action-backup/v1',
    operationId,
    targetBindingDigest: installationDigest,
    nativeBindingDigest: digest('private main binding'),
    checkpointDigest: digest(checkpoint),
    conversationBackupDigest: digest({ fixture: 'conversations' }),
    missionBackupDigest: digest({ fixture: 'missions' }),
    calendarBackupDigest: digest({ present: true }),
    journal,
    nativeDatabases: 1,
    maintenanceGeneration: 2,
    writerActivated: false,
    inputs: {
      context: { ...identity, ingressId: 'operator-backup-' + operationId },
      nativeDatabases: [storage.dataRoot + '/v2.db'],
      restrictionFiles: [targetRoot + '/state.json'],
    },
  };
  const proof: CoordinatedRestoreProof = {
    format: 'cos-coordinated-restore-proof/v1',
    checkpointDigest: digest(checkpoint),
    scopeIdentityDigest: digest(identity),
    databaseFingerprint: checkpoint.databaseFingerprint,
    sandboxDatabaseFingerprint: digest('separate test DB'),
    sandboxSeparated: true,
    testMarkerDigest: digest('protected test marker'),
    schemaVersion: SCHEMA_VERSION,
    schemaDigest: checkpoint.schemaDigest,
    restoredStateDigest: digest('restored rows'),
    sqliteCount: 1,
    journal,
    admissionRestored: false,
    eventJournalRestored: false,
    verifiedAt: new Date().toISOString(),
  };
  const reference = randomUUID(),
    grant: ActionHostGrant = {
      ...identity,
      id: randomUUID(),
      credentialReference: reference,
      backupOperationId: operationId,
      targetBackupDigest: digest(target),
      writeEnabled: true,
      binding: {
        format: 'cos-calendar-writer/v1',
        provider: 'google',
        calendarId: 'operator@example.test',
        accountFingerprint: digest('calendar account'),
        credentialGeneration: reference,
        instanceId: 'fixture',
        channelId: 'private',
        bindingDigest: target.nativeBindingDigest,
        processingProvider: 'codex',
        restoreProofDigest: digest(proof),
        scopes: [GOOGLE_OWNED_EVENT_WRITE_SCOPE, GOOGLE_CALENDAR_METADATA_SCOPE],
      },
    };
  const profile: ActionHostProfile = {
    format: 'cos-action-host/v1',
    installationDigest,
    journalGeneration: witness.generation,
    grants: [grant],
  };
  fs.mkdirSync(path.join(targetRoot, 'actions', 'restore-proofs'), { mode: 0o700 });
  writeAtomic(path.join(targetRoot, 'actions'), 'writer-profile.json', profile);
  writeAtomic(path.join(targetRoot, 'actions', 'restore-proofs'), digest(proof) + '.json', proof);
  writeAtomic(receiptRoot, 'action-backup.json', target);
  f.paired.mockResolvedValue(checkpoint);
  f.conversations.mockResolvedValue({ fixture: 'conversations' });
  f.missions.mockResolvedValue({ fixture: 'missions' });
  f.calendar.mockResolvedValue({ present: true });
  return { storage, installationDigest, witness, identity, checkpoint, target, proof, grant, profile, receiptRoot };
}
it('S09 opens only an existing exact host profile and validates every paired backup family before admission', async () => {
  const s = fixture();
  expect(readActionHostProfile(s.storage.targetRoot, s.installationDigest, s.witness.generation)).toEqual(s.profile);
  await expect(
    verifyActionGrantRecovery(s.storage, s.grant, s.witness, s.checkpoint.databaseFingerprint),
  ).resolves.toEqual(s.proof);
  expect(f.paired).toHaveBeenCalledOnce();
  expect(f.calendar).toHaveBeenCalledOnce();
  expect(f.missions).toHaveBeenCalledOnce();
  expect(f.conversations).toHaveBeenCalledOnce();
});
it.each([
  'fixture-provider',
  'changed-grant-generation',
  'extra-field',
  'duplicate-grant',
  'broad-scope',
  'foreign-target',
  'lost-file',
  'hardlink',
])('S09 denies %s host configuration without initialization or fallback', (kind) => {
  const s = fixture(),
    file = path.join(s.storage.targetRoot, 'actions', 'writer-profile.json');
  if (kind === 'fixture-provider') s.grant.binding.provider = 'fixture';
  if (kind === 'changed-grant-generation') s.grant.binding.credentialGeneration = 'rotation-counter';
  if (kind === 'extra-field') Object.assign(s.profile, { providerUrl: 'https://private.example.invalid' });
  if (kind === 'duplicate-grant') s.profile.grants.push(s.grant);
  if (kind === 'broad-scope') s.grant.binding.scopes.push('https://www.googleapis.com/auth/calendar');
  if (kind === 'foreign-target') s.profile.installationDigest = digest('other target');
  writeAtomic(path.dirname(file), 'writer-profile.json', s.profile);
  if (kind === 'lost-file') fs.unlinkSync(file);
  if (kind === 'hardlink') fs.linkSync(file, file + '.copy');
  expect(() => readActionHostProfile(s.storage.targetRoot, s.installationDigest, s.witness.generation)).toThrow(
    'action_profile_unavailable',
  );
});
it.each([
  'same-database',
  'restored-admission',
  'restored-journal',
  'foreign-scope',
  'schema',
  'journal',
  'future-proof',
  'lost-proof',
  'changed-checkpoint',
  'calendar-absent',
  'changed-history',
  'foreign-database',
])('S09 denies %s recovery evidence without admitting account writes', async (kind) => {
  const s = fixture(),
    proof = structuredClone(s.proof);
  if (kind === 'same-database') {
    proof.sandboxSeparated = false;
    proof.sandboxDatabaseFingerprint = proof.databaseFingerprint;
  }
  if (kind === 'restored-admission') Object.assign(proof, { admissionRestored: true });
  if (kind === 'restored-journal') Object.assign(proof, { eventJournalRestored: true });
  if (kind === 'foreign-scope') proof.scopeIdentityDigest = digest('foreign');
  if (kind === 'schema') proof.schemaVersion--;
  if (kind === 'journal') proof.journal.generation = randomUUID();
  if (kind === 'future-proof') proof.verifiedAt = new Date(Date.now() + 60000).toISOString();
  s.grant.binding.restoreProofDigest = digest(proof);
  const file = path.join(s.storage.targetRoot, 'actions', 'restore-proofs', digest(proof) + '.json');
  writeAtomic(path.dirname(file), path.basename(file), proof);
  if (kind === 'lost-proof') fs.unlinkSync(file);
  if (kind === 'changed-checkpoint') f.paired.mockResolvedValue({ ...s.checkpoint, contextDigest: digest('changed') });
  if (kind === 'calendar-absent') f.calendar.mockResolvedValue({ present: false });
  if (kind === 'changed-history') f.conversations.mockResolvedValue({ fixture: 'changed' });
  await expect(
    verifyActionGrantRecovery(
      s.storage,
      s.grant,
      s.witness,
      kind === 'foreign-database' ? digest('foreign database') : s.checkpoint.databaseFingerprint,
    ),
  ).rejects.toThrow('action_recovery_proof_unavailable');
});
it('withholds recovery admission after the journal owner changes during an awaited archive check', async () => {
  const s = fixture();
  f.calendar.mockImplementation(async () => {
    const root = path.join(s.storage.targetRoot, 'actions'),
      generation = randomUUID();
    writeAtomic(root, 'owner.json', {
      format: 'cos-action-host-owner/v1',
      installationDigest: s.installationDigest,
      journalGeneration: generation,
    });
    writeAtomic(path.join(root, 'effects'), 'owner.json', {
      format: 'cos-action-witness-owner/v1',
      installationDigest: s.installationDigest,
      generation,
    });
    return { present: true };
  });
  await expect(
    verifyActionGrantRecovery(s.storage, s.grant, s.witness, s.checkpoint.databaseFingerprint),
  ).rejects.toThrow('action_recovery_proof_unavailable');
});
