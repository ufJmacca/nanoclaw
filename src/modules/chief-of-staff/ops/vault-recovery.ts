import { digest } from '../domain/contracts.js';
import { VAULT_BYTES } from './vault-admission.js';
import type { VaultProvisionIdentity, VaultProvisionPorts } from './vault-provision.js';
export type VaultRecoveryPorts = Pick<
  VaultProvisionPorts,
  'withLock' | 'assertAuthority' | 'assertMemory' | 'readJournal'
> & {
  /** Verifies the recovery key and all existing claims without provisioning or opening a mapper. */
  inspectRecovery(): Promise<'mounted' | 'closed'>;
  closeStorage(): Promise<void>;
  openRecovery(): Promise<void>;
  mountStorage(): Promise<void>;
  verifyCanary(): Promise<void>;
  startStorage(): Promise<void>;
};
/** Recovery uses an already completed vault. Failed or revoked checks never manufacture a ready receipt. */
export async function checkVaultRecovery(
  identity: VaultProvisionIdentity,
  ports: VaultRecoveryPorts,
): Promise<Record<string, unknown>> {
  try {
    return await ports.withLock(async () => {
      const authority = async () => {
        ports.assertMemory();
        await ports.assertAuthority();
        ports.assertMemory();
      };
      const effect = async (operation: () => Promise<void>) => {
        await authority();
        await operation();
        await authority();
      };
      await authority();
      const journal = ports.readJournal();
      if (
        !journal ||
        Object.keys(journal).sort().join(',') !== 'contract,identity,phase,step' ||
        journal.contract !== 'cos-vault-provision/v1' ||
        journal.phase !== 'complete' ||
        journal.step !== 'units' ||
        digest(journal.identity) !== digest(identity)
      )
        throw Error('completed_vault_required');
      const initial = await ports.inspectRecovery();
      if (initial === 'mounted') await effect(() => ports.verifyCanary());
      else if (initial !== 'closed') throw Error('vault_recovery_state_conflict');
      const close = async () => {
        await effect(() => ports.closeStorage());
        if ((await ports.inspectRecovery()) !== 'closed') throw Error('vault_not_closed');
        await authority();
      };
      await close();
      await effect(() => ports.openRecovery());
      await effect(() => ports.mountStorage());
      await effect(() => ports.verifyCanary());
      await close();
      await effect(() => ports.startStorage());
      if ((await ports.inspectRecovery()) !== 'mounted') throw Error('normal_storage_unavailable');
      await effect(() => ports.verifyCanary());
      return { status: 'ready', volumeBytes: VAULT_BYTES, identityDigest: digest(identity) };
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Recovery material, root paths and command diagnostics stay private.
    throw Error('vault_recovery_unavailable');
  }
}
