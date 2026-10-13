import path from 'node:path';
import type pg from 'pg';
import type { PoolConfig } from 'pg';
import { digest } from '../domain/contracts.js';
import { deploymentSettings } from './deployment-settings.js';
import { targetBinding } from './target-host.js';
import { withVaultDirectory } from './vault-storage.js';
import { restoreVaultBackup } from './backup-upload.js';
import { verifyRecoveredTargetVaultState, type RecoveredTargetVaultIdentity } from './backup-recovered-state.js';
import {
  assertCoordinatedRecoveryIdentity,
  restoreRecoveredCoordinatedTestScope,
  type CoordinatedRecoveryIdentity,
} from './coordinated-backup.js';
import { withPinnedBackupTestRestoreReservation } from './backup-test-restore-reservation.js';
import type { BackupRestoreValidationScope } from './backup-restore-workspace.js';

/** Fixed complete recovery composition for an independently admitted owner.
 * Only the actual encrypted remote path supplies the workspace and repository;
 * only the separate test profile can receive rows. Archived credentials,
 * restrictions, journals and maintenance never become current permission. */
export async function restoreTargetVaultBackupTestScope(
  options: RecoveredTargetVaultIdentity,
  requestId: string,
  sandbox: { client: pg.Client; config: PoolConfig; testTargetId: string },
  checkDatabase: () => Promise<void>,
) {
  let active = false;
  try {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      !uuid.test(requestId) ||
      !uuid.test(options.queueOperationId) ||
      typeof options.current !== 'function' ||
      typeof checkDatabase !== 'function'
    )
      throw Error('restore_owner_required');
    const settings = Object.freeze({ ...deploymentSettings(options.settings) }),
      targetDigest = digest(targetBinding(settings)),
      caller = options.current,
      testClient = sandbox.client,
      roots = {
        targetRoot: settings.stateRoot,
        installationRoot: settings.installationRoot,
        dataRoot: settings.dataRoot,
      },
      identity: CoordinatedRecoveryIdentity = {
        context: {
          scopeId: options.binding.scopeId,
          ownerId: options.binding.ownerId,
          agentGroupId: options.binding.agentGroupId,
          sessionId: options.binding.sessionId,
          ingressId: 'operator-restore-' + requestId,
        },
        databaseFingerprint: settings.databaseFingerprint,
        operationId: 'restore-check-' + requestId,
        nativeDatabases: [path.join(settings.dataRoot, 'v2.db')],
        restrictionFiles: [],
        artifacts: { root: path.join(settings.stateRoot, 'knowledge', 'artifacts') },
        witness: options.witness,
      },
      configuration = () =>
        digest({
          settings: options.settings,
          binding: options.binding,
          queueOperationId: options.queueOperationId,
          recovery: options.recovery,
          expectedSnapshotDigest: options.expectedSnapshotDigest ?? null,
          sandbox: { config: sandbox.config, testTargetId: sandbox.testTargetId },
          witness: {
            root: options.witness.root,
            installationDigest: options.witness.installationDigest,
            generation: options.witness.generation,
          },
        }),
      initial = configuration();
    if (
      options.witness.root !== path.join(settings.stateRoot, 'actions', 'effects') ||
      options.witness.installationDigest !== targetDigest
    )
      throw Error('restore_owner_changed');
    active = true;
    const current = () => {
      if (!active || options.current !== caller || sandbox.client !== testClient || configuration() !== initial)
        throw Error('restore_owner_changed');
      caller();
      assertCoordinatedRecoveryIdentity(identity);
    };
    current();
    await checkDatabase();
    current();
    return await withVaultDirectory(roots, 'staging', async (staging, assertVault) => {
      const vaultCurrent = () => {
        current();
        assertVault();
      };
      vaultCurrent();
      return await restoreVaultBackup(
        roots,
        'state',
        options.queueOperationId,
        requestId,
        vaultCurrent,
        async (workspace, remote) => {
          const remoteDigest = digest(remote),
            currentScope = () => {
              vaultCurrent();
              workspace.assertCurrent();
            };
          const proof: {
            complete?: {
              header: Awaited<ReturnType<typeof verifyRecoveredTargetVaultState>>['header'];
              snapshotDigest: string;
            };
          } = {};
          const payloadCurrent = () => {
            currentScope();
            if (
              digest(remote) !== remoteDigest ||
              (proof.complete && digest(proof.complete.header) !== proof.complete.snapshotDigest)
            )
              throw Error('restore_snapshot_changed');
            workspace.assertPayloadCurrent();
            currentScope();
          };
          const scope: BackupRestoreValidationScope = Object.freeze({
            directory: workspace.directory,
            assertCurrent: currentScope,
            assertPayloadCurrent: payloadCurrent,
            ensureDirectory: workspace.ensureDirectory,
            inspectFile: workspace.inspectFile,
            withFileBytes: workspace.withFileBytes,
          });
          const verifyComplete = async (expectedSnapshotDigest = options.expectedSnapshotDigest) => {
            payloadCurrent();
            // Retain only the bounded header/digest, not a second copy of parsed scoped rows.
            const { header, snapshotDigest } = await verifyRecoveredTargetVaultState(
              { ...options, expectedSnapshotDigest, current: currentScope },
              scope,
              remote.receipt.files,
            );
            payloadCurrent();
            if (
              digest(header) !== snapshotDigest ||
              (expectedSnapshotDigest && snapshotDigest !== expectedSnapshotDigest)
            )
              throw Error('restore_snapshot_changed');
            return { header, snapshotDigest };
          };
          proof.complete = await verifyComplete();
          payloadCurrent();
          const { header, snapshotDigest } = proof.complete,
            base: CoordinatedRecoveryIdentity = {
              context: header.inputs.context,
              databaseFingerprint: settings.databaseFingerprint,
              operationId: header.operationId,
              nativeDatabases: header.inputs.nativeDatabases,
              restrictionFiles: header.inputs.restrictionFiles,
              artifacts: { root: header.inputs.artifactsRoot },
              witness: options.witness,
            };
          return await withPinnedBackupTestRestoreReservation(
            staging,
            {
              requestId,
              targetDigest,
              repositoryId: remote.repositoryId,
              repositoryOwnerDigest: remote.ownerDigest,
              queueOwnerDigest: remote.receipt.ownerDigest,
              operationId: remote.operationId,
              snapshotId: remote.snapshotId,
              archiveSha256: remote.archiveSha256,
              archiveBytes: remote.archiveBytes,
              snapshotDigest,
              checkpointDigest: header.checkpointDigest,
              sourceDatabaseFingerprint: settings.databaseFingerprint,
              scopeId: options.binding.scopeId,
              journal: {
                installationDigest: options.witness.installationDigest,
                generation: options.witness.generation,
              },
            },
            currentScope,
            async (reservation) => {
              const restored = await restoreRecoveredCoordinatedTestScope(
                base,
                scope,
                remote.receipt.files,
                sandbox,
                reservation,
                async () => {
                  payloadCurrent();
                  await checkDatabase();
                  payloadCurrent();
                },
              );
              payloadCurrent();
              await verifyComplete(snapshotDigest);
              await checkDatabase();
              payloadCurrent();
              return {
                ...restored,
                snapshotDigest,
                credentialsActivated: false as const,
                writerActivated: false as const,
              };
            },
          );
        },
      );
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Complete recovered payload, owner, database and retained reservation diagnostics remain private.
    throw Error('target_vault_test_restore_unavailable');
  } finally {
    active = false;
  }
}
