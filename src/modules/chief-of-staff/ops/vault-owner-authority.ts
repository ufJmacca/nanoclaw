import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';
import { assertHostExecutionLease, type HostExecutionLease } from '../../../db/host-execution-lease.js';
import { digest } from '../domain/contracts.js';
import { readTarget } from './target-state.js';
import { assertMaintenanceLease, type MaintenanceLease } from './maintenance.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { openVaultAuthority, type VaultAuthority } from './vault-authority.js';
import { verifyVaultMemory } from './vault-memory.js';
/** Called only while the owner admin command holds the target operation lock and native host lease. */
export async function openProtectedVaultAuthority(
  input: {
    root: string;
    configuration: VaultRootConfiguration;
    maintenance: MaintenanceLease;
    native: Database.Database;
    hostLease: HostExecutionLease;
    /** Existing owner boundary: paused native binding, current membership and actual native/container quiescence. */
    check(): Promise<void>;
  },
  controls: { assertMemory?(): void; ownerTargetRoot?: string } = {},
) {
  let authority: VaultAuthority | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const root = input.root,
      native = input.native,
      checkOwner = input.check;
    const config = vaultRootConfiguration(input.configuration),
      maintenance = Object.freeze({ ...input.maintenance }),
      hostLease = Object.freeze({ ...input.hostLease }),
      targetRoot = controls.ownerTargetRoot ?? config.owner.targetRoot;
    if (
      process.platform !== 'linux' ||
      process.getuid?.() === 0 ||
      config.owner.uid !== process.getuid?.() ||
      config.owner.gid !== process.getgid?.() ||
      root !== targetRoot ||
      (controls.ownerTargetRoot === undefined && config.owner.home !== os.homedir()) ||
      maintenance.owner !== 'operations-' + config.authority.operationId ||
      maintenance.purpose !== 'deployment' ||
      maintenance.generation < config.target.minimumGeneration
    )
      throw Error('owner_scope_conflict');
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
    const scope = Object.freeze({
      operationId: config.authority.operationId,
      targetDigest: config.identity.targetDigest,
      generation: maintenance.generation,
    });
    authority = await openVaultAuthority(directory, scope, check);
    await check();
    return Object.freeze({ scope, authority, check });
  } catch {
    await authority?.close();
    // eslint-disable-next-line preserve-caught-error -- Native lease, private membership and filesystem diagnostics are not root receipts.
    throw Error('vault_owner_authority_unavailable');
  }
}
