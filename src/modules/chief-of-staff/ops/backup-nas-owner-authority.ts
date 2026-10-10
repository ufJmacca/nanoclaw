import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { assertMaintenanceLease, type MaintenanceLease } from './maintenance.js';
import type Database from 'better-sqlite3';
import { assertHostExecutionLease, type HostExecutionLease } from '../../../db/host-execution-lease.js';
import { openVaultAuthority, type VaultAuthority, type VaultAuthorityScope } from './vault-authority.js';
import { readTarget } from './target-state.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import { backupNasRecoveryScope } from './backup-nas-recovery-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
export type BackupNasSetupOwnerInput = {
  root: string;
  configuration: VaultRootConfiguration;
  nas: BackupNasRootConfiguration;
  operationId: string;
  maintenance: MaintenanceLease;
  native: Database.Database;
  hostLease: HostExecutionLease;
  check(): Promise<void>;
};
export async function openProtectedBackupNasRecoveryAuthority(
  input: BackupNasSetupOwnerInput,
  controls: { assertMemory?(): void; ownerTargetRoot?: string } = {},
): ReturnType<typeof openProtectedBackupNasSetupAuthority> {
  return openProtectedBackupNasAuthority(input, controls, backupNasRecoveryScope);
}
/** The enclosing owner command holds its operation lock and paused native boundary.
 * Each root challenge checks those live leases again. NAS administration uses its own fresh
 * operation; the accepted vault configuration and resource identity stay intact.
 */
export async function openProtectedBackupNasSetupAuthority(
  input: BackupNasSetupOwnerInput,
  controls: { assertMemory?(): void; ownerTargetRoot?: string } = {},
): Promise<{ scope: Readonly<VaultAuthorityScope>; authority: VaultAuthority; check(): Promise<void> }> {
  return openProtectedBackupNasAuthority(input, controls, backupNasSetupScope);
}
async function openProtectedBackupNasAuthority(
  input: BackupNasSetupOwnerInput,
  controls: { assertMemory?(): void; ownerTargetRoot?: string },
  scopeFactory: typeof backupNasSetupScope,
): Promise<{ scope: Readonly<VaultAuthorityScope>; authority: VaultAuthority; check(): Promise<void> }> {
  let authority: VaultAuthority | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const root = input.root,
      native = input.native,
      checkOwner = input.check,
      config = vaultRootConfiguration(input.configuration),
      nas = backupNasRootConfiguration(input.nas, config),
      maintenance = Object.freeze({ ...input.maintenance }),
      hostLease = Object.freeze({ ...input.hostLease });
    const scope = scopeFactory(config, nas, input.operationId, maintenance.generation);
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      !process.getuid?.() ||
      config.owner.uid !== process.getuid?.() ||
      config.owner.gid !== process.getgid?.() ||
      root !== (controls.ownerTargetRoot ?? config.owner.targetRoot) ||
      (controls.ownerTargetRoot === undefined && config.owner.home !== os.homedir()) ||
      maintenance.owner !== 'operations-' + scope.operationId ||
      maintenance.purpose !== 'deployment'
    )
      throw Error('owner_setup_scope_conflict');
    const assertCurrent = () => {
      memory();
      const target = readTarget(root, config.target.binding);
      if (target.lifecycle !== 'protected' || digest(target.binding) !== config.identity.targetDigest)
        throw Error('protected_target_required');
      assertMaintenanceLease(root, config.target.binding, maintenance);
      assertHostExecutionLease(native, hostLease);
    };
    const check = async () => {
      assertCurrent();
      await checkOwner();
      assertCurrent();
    };
    await check();
    const directory = path.join(root, 'vault-authority');
    if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
    authority = await openVaultAuthority(directory, scope, check);
    await check();
    return Object.freeze({ scope, authority, check });
  } catch {
    await authority?.close();
    // eslint-disable-next-line preserve-caught-error -- Private native, maintenance, owner and NAS bindings are never root receipts.
    throw Error('backup_nas_owner_authority_unavailable');
  }
}
