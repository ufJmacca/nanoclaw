import { expect, it } from 'vitest';
import { admitVaultProvisioning, VAULT_BYTES, VAULT_FREE_FLOOR, type VaultPreflight } from './vault-admission.js';

const facts = (): VaultPreflight => ({
  platform: 'linux',
  architecture: 'arm64',
  lifecycle: 'protected',
  maintenanceHeld: true,
  hostLeaseHeld: true,
  availableBytes: VAULT_BYTES + VAULT_FREE_FLOOR + 10 * 1024 ** 2,
  utilityInstallationBytes: 10 * 1024 ** 2,
  volumePresent: false,
  mountPresent: false,
  credentialsPresent: false,
  privilegedAccess: true,
});
it('admits only a new volume after locks, protected target and post-allocation capacity pass', () => {
  expect(() => admitVaultProvisioning(facts())).not.toThrow();
});
it.each([
  { availableBytes: 2518044672 },
  { availableBytes: NaN },
  { utilityInstallationBytes: -1 },
  { volumePresent: true },
  { mountPresent: true },
  { credentialsPresent: true },
  { lifecycle: 'implementation_disposable' },
  { lifecycle: 'unknown' },
  { maintenanceHeld: false },
  { hostLeaseHeld: false },
  { privilegedAccess: false },
  { platform: 'darwin' },
  { architecture: 'x64' },
])('rejects unsafe initial provisioning facts: %j', (patch) => {
  expect(() => admitVaultProvisioning({ ...facts(), ...patch })).toThrow();
});
it('reserves installation space and never rounds away the free-space floor', () => {
  const f = facts();
  f.availableBytes--;
  expect(() => admitVaultProvisioning(f)).toThrow('vault_capacity_insufficient');
});
