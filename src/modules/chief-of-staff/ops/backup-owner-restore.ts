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
import { restoreVaultCredentialCapture } from './backup-upload.js';
import { routedCredentialRecoveryFiles } from './credential-recovery-routing.js';
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
  testEnvironmentFile?: string;
  invokedHelper: string;
  args: BackupOwnerRestoreArguments;
}): Promise<Record<string, unknown>> {
  try {
    const { settingsFile, testEnvironmentFile, invokedHelper, args } = input,
      settings = deploymentSettings(readPrivate(settingsFile)),
      settingsDigest = digest(settings),
      argsDigest = digest(args),
      stateArgs = args.command === 'backup-restore-check' ? args : null;
    if (
      Object.keys(args).sort().join(',') !==
        (stateArgs
          ? 'backupReleaseId,command,queueOperationId,requestId,scopeId,snapshotDigest'
          : 'captureOperationId,command,requestId,scopeId') ||
      (!stateArgs && testEnvironmentFile !== undefined) ||
      (stateArgs && typeof testEnvironmentFile !== 'string') ||
      digest(
        parseBackupOwnerRestoreArguments([
          args.command,
          '--scope',
          args.scopeId,
          '--request-id',
          args.requestId,
          ...(stateArgs
            ? [
                '--backup-operation-id',
                stateArgs.queueOperationId,
                '--backup-release',
                stateArgs.backupReleaseId,
                '--snapshot-digest',
                stateArgs.snapshotDigest,
              ]
            : [
                '--capture-operation-id',
                args.command === 'backup-credentials-restore-check' ? args.captureOperationId : '',
              ]),
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
        recovery = stateArgs ? recordedRelease(settings, stateArgs.backupReleaseId) : null,
        recoveryDigest = digest(recovery),
        deadline = performance.now() + 45 * 60 * 1000;
      if (
        !(stateArgs ? ['G02', 'G03', 'G04'] : ['G04']).includes(manifest.slice) ||
        state.lifecycle !== 'protected' ||
        state.releaseId !== manifest.releaseId ||
        generation === null ||
        (stateArgs &&
          !['G02', 'G03', 'G04'].includes(
            validateReleaseManifest(
              readPrivate(path.join(settings.releaseRoot, stateArgs.backupReleaseId, 'release.json')),
            ).slice,
          ))
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
            (stateArgs && digest(recordedRelease(settings, stateArgs.backupReleaseId)) !== recoveryDigest)
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
        if (args.command === 'backup-credentials-restore-check') {
          await effects.mount(current);
          await healthy();
          const result = await restoreVaultCredentialCapture(
            {
              targetRoot: settings.stateRoot,
              installationRoot: settings.installationRoot,
              dataRoot: settings.dataRoot,
            },
            args.captureOperationId,
            args.requestId,
            current,
            async (workspace, remote) => {
              await healthy();
              workspace.assertPayloadCurrent();
              const files = routedCredentialRecoveryFiles(remote.capture.set, remote.capture.ownerDigest).filter(
                (file) => file.name !== 'credential-set.json',
              );
              for (const file of files) {
                current();
                const actual = workspace.inspectFile(file.name);
                if (actual.file !== file.name || actual.bytes !== file.bytes || actual.sha256 !== file.sha256)
                  throw Error('restore_credential_payload_changed');
              }
              workspace.assertPayloadCurrent();
              await healthy();
              return {
                setDigest: digest(remote.capture.set),
                sources: remote.capture.set.contents.sources.length,
                files: files.length,
              };
            },
          );
          await healthy();
          const { remote, validation } = result;
          if (
            remote.contract !== 'cos-backup-credential-capture-restore/v1' ||
            remote.kind !== 'credentials' ||
            remote.operationId !== args.captureOperationId ||
            remote.capture.operationId !== args.captureOperationId ||
            validation.setDigest !== digest(remote.capture.set) ||
            validation.sources !== remote.capture.set.contents.sources.length ||
            validation.files !==
              routedCredentialRecoveryFiles(remote.capture.set, remote.capture.ownerDigest).length - 1
          )
            throw Error('restore_credential_proof_invalid');
          return {
            status: 'backup_credentials_restore_verified',
            request_id: args.requestId,
            capture_operation_id: args.captureOperationId,
            source_count: validation.sources,
            file_count: validation.files,
            credential_set_digest: validation.setDigest,
            credentials_activated: false,
            admission_restored: false,
            event_journal_restored: false,
            writer_activated: false,
          };
        }
        if (!stateArgs || !recovery || !testEnvironmentFile) throw Error('restore_scope_required');
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
                queueOperationId: stateArgs.queueOperationId,
                recovery,
                expectedSnapshotDigest: stateArgs.snapshotDigest,
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
              result.remote.operationId !== stateArgs.queueOperationId ||
              proof.format !== 'cos-sandbox-scope-restore/v1' ||
              typeof proof.inserted !== 'boolean' ||
              proof.snapshotDigest !== stateArgs.snapshotDigest ||
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
              queue_operation_id: stateArgs.queueOperationId,
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
