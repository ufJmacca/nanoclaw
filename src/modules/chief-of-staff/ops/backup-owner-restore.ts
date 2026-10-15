import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { openTargetActionWitness } from '../actions/host-ownership.js';
import { deploymentSettings } from './deployment-settings.js';
import { withDeploymentLock } from './deployment-lock.js';
import { targetBinding, verifyTargetPaths } from './target-host.js';
import { readPrivate, readTarget } from './target-state.js';
import { admittedGeneration } from './maintenance.js';
import { validateReleaseManifest } from './release-manifest.js';
import { recordedRelease } from './action-recovery-admin.js';
import { readBackupNativeIdentity } from './target-backup-native.js';
import { createBackupUploadJobEffects } from './backup-upload-job-effects.js';
import { withSeparateBackupTestDatabase } from './backup-test-database.js';
import { restoreTargetVaultBackupTestScope } from './backup-target-restore.js';
import {
  parseBackupOwnerRestoreArguments,
  type BackupOwnerRestoreArguments,
} from './backup-owner-restore-arguments.js';
export { parseBackupOwnerRestoreArguments } from './backup-owner-restore-arguments.js';
export type { BackupOwnerRestoreArguments } from './backup-owner-restore-arguments.js';

/** Fixed installed owner entry. Current installation/release/native owner and
 * independent journal admit a test-only drill. Historical maintenance and
 * credentials remain recovered evidence, with no native stop/start or writes. */
export async function restoreOwnerVaultBackup(input: {
  settingsFile: string;
  testEnvironmentFile: string;
  invokedHelper: string;
  args: BackupOwnerRestoreArguments;
}): Promise<Record<string, unknown>> {
  try {
    const { settingsFile, testEnvironmentFile, invokedHelper, args } = input,
      settings = deploymentSettings(readPrivate(settingsFile)),
      settingsDigest = digest(settings),
      argsDigest = digest(args);
    if (
      Object.keys(args).sort().join(',') !==
        'backupReleaseId,command,queueOperationId,requestId,scopeId,snapshotDigest' ||
      digest(
        parseBackupOwnerRestoreArguments([
          args.command,
          '--scope',
          args.scopeId,
          '--request-id',
          args.requestId,
          '--backup-operation-id',
          args.queueOperationId,
          '--backup-release',
          args.backupReleaseId,
          '--snapshot-digest',
          args.snapshotDigest,
        ]),
      ) !== argsDigest
    )
      throw Error('restore_request_invalid');
    return await withDeploymentLock(settings.stateRoot + '.operation.lock', async () => {
      let active = true;
      verifyTargetPaths(settings, 0);
      const effects = createBackupUploadJobEffects(settings, invokedHelper),
        manifest = validateReleaseManifest(await effects.verify()),
        binding = targetBinding(settings),
        state = readTarget(settings.stateRoot, binding),
        generation = admittedGeneration(settings.stateRoot, binding),
        targetDigest = digest(binding),
        witness = openTargetActionWitness(settings.stateRoot, targetDigest),
        recovery = recordedRelease(settings, args.backupReleaseId),
        recoveryDigest = digest(recovery),
        deadline = performance.now() + 45 * 60 * 1000;
      if (
        !['G02', 'G03'].includes(manifest.slice) ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== manifest.releaseId ||
        generation === null ||
        !['G02', 'G03'].includes(
          validateReleaseManifest(readPrivate(path.join(settings.releaseRoot, args.backupReleaseId, 'release.json')))
            .slice,
        )
      )
        throw Error('restore_owner_required');
      const central = path.join(settings.dataRoot, 'v2.db'),
        fd = fs.openSync(central, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
        held = fs.fstatSync(fd);
      let native: Database.Database | undefined;
      try {
        native = new Database(central, { readonly: true, fileMustExist: true });
        const nativeDb = native,
          owner = readBackupNativeIdentity(nativeDb).binding,
          ownerDigest = digest(owner);
        const current = () => {
          if (
            !active ||
            performance.now() >= deadline ||
            digest(args) !== argsDigest ||
            digest(deploymentSettings(readPrivate(settingsFile))) !== settingsDigest
          )
            throw Error('restore_owner_changed');
          verifyTargetPaths(settings, 0);
          const stat = fs.lstatSync(central),
            target = readTarget(settings.stateRoot, binding),
            journal = openTargetActionWitness(settings.stateRoot, targetDigest);
          if (
            stat.dev !== held.dev ||
            stat.ino !== held.ino ||
            stat.uid !== held.uid ||
            !stat.isFile() ||
            target.lifecycle !== 'protected' ||
            target.releaseId !== state.releaseId ||
            admittedGeneration(settings.stateRoot, binding) !== generation ||
            journal.generation !== witness.generation ||
            journal.installationDigest !== witness.installationDigest ||
            digest(readBackupNativeIdentity(nativeDb).binding) !== ownerDigest ||
            owner.scopeId !== args.scopeId ||
            digest(recordedRelease(settings, args.backupReleaseId)) !== recoveryDigest
          )
            throw Error('restore_owner_changed');
        };
        const healthy = async () => {
          current();
          if (digest(validateReleaseManifest(await effects.verify())) !== digest(manifest))
            throw Error('restore_release_changed');
          current();
          if (!(await effects.healthy())) throw Error('restore_service_unavailable');
          current();
        };
        current();
        await healthy();
        return await withSeparateBackupTestDatabase(
          settings,
          testEnvironmentFile,
          current,
          async (sandbox, checkDatabase) => {
            const check = async () => {
              await healthy();
              await checkDatabase();
              current();
            };
            await check();
            await effects.mount(current);
            await check();
            const result = await restoreTargetVaultBackupTestScope(
              {
                settings,
                binding: owner,
                witness,
                queueOperationId: args.queueOperationId,
                recovery,
                expectedSnapshotDigest: args.snapshotDigest,
                current,
              },
              args.requestId,
              sandbox,
              check,
            );
            await check();
            const proof = result.validation;
            if (
              result.remote.contract !== 'cos-backup-remote-restore/v1' ||
              result.remote.kind !== 'state' ||
              result.remote.operationId !== args.queueOperationId ||
              proof.format !== 'cos-sandbox-scope-restore/v1' ||
              typeof proof.inserted !== 'boolean' ||
              proof.snapshotDigest !== args.snapshotDigest ||
              !/^[a-f0-9]{64}$/.test(proof.checkpointDigest) ||
              !/^[a-f0-9]{64}$/.test(proof.sandboxDatabaseFingerprint) ||
              proof.admissionRestored !== false ||
              proof.eventJournalRestored !== false ||
              proof.credentialsActivated !== false ||
              proof.writerActivated !== false
            )
              throw Error('restore_proof_invalid');
            return {
              status: 'backup_test_restore_verified',
              request_id: args.requestId,
              queue_operation_id: args.queueOperationId,
              snapshot_digest: proof.snapshotDigest,
              checkpoint_digest: proof.checkpointDigest,
              inserted: proof.inserted,
              admission_restored: false,
              event_journal_restored: false,
              credentials_activated: false,
              writer_activated: false,
            };
          },
        );
      } finally {
        active = false;
        try {
          native?.close();
        } finally {
          fs.closeSync(fd);
        }
      }
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Native, vault, NAS, retained payload and selected database diagnostics remain private.
    throw Error('backup_owner_restore_unavailable');
  }
}
