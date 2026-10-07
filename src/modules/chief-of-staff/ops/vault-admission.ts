export const VAULT_BYTES = 1024 ** 3;
export const VAULT_FREE_FLOOR = 2 * 1024 ** 3;
export type VaultPreflight = {
  platform: string;
  architecture: string;
  lifecycle: string;
  maintenanceHeld: boolean;
  hostLeaseHeld: boolean;
  availableBytes: number;
  utilityInstallationBytes: number;
  volumePresent: boolean;
  mountPresent: boolean;
  credentialsPresent: boolean;
  privilegedAccess: boolean;
};
/** Initial creation only. Reconciliation of an existing operation must verify its original journal.
 * This contract never admits adoption or formatting of an existing file, partition or filesystem.
 */
export function assertVaultProvisionAuthority(facts: VaultPreflight): void {
  if (
    facts.platform !== 'linux' ||
    facts.architecture !== 'arm64' ||
    facts.lifecycle !== 'protected' ||
    facts.maintenanceHeld !== true ||
    facts.hostLeaseHeld !== true ||
    facts.privilegedAccess !== true
  )
    throw new Error('vault_provisioning_unverified');
}
export function admitVaultProvisioning(facts: VaultPreflight): void {
  assertVaultProvisionAuthority(facts);
  if (facts.volumePresent !== false || facts.mountPresent !== false || facts.credentialsPresent !== false)
    throw new Error('vault_provisioning_unverified');
  if (
    !Number.isSafeInteger(facts.availableBytes) ||
    !Number.isSafeInteger(facts.utilityInstallationBytes) ||
    facts.utilityInstallationBytes < 0 ||
    facts.availableBytes - VAULT_BYTES - facts.utilityInstallationBytes < VAULT_FREE_FLOOR
  )
    throw new Error('vault_capacity_insufficient');
}
