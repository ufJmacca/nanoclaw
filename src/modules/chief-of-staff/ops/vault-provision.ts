import {
  admitVaultProvisioning,
  assertVaultProvisionAuthority,
  VAULT_BYTES,
  VAULT_FREE_FLOOR,
  type VaultPreflight,
} from './vault-admission.js';
import { digest } from '../domain/contracts.js';
export const VAULT_PROVISION_STEPS = [
  'utilities',
  'keys',
  'allocate',
  'luks',
  'recovery',
  'filesystem',
  'mount',
  'canary',
  'units',
] as const;
export type VaultProvisionStep = (typeof VAULT_PROVISION_STEPS)[number];
export type VaultProvisionIdentity = {
  operationId: string;
  targetDigest: string;
  recoveryReference: string;
  luksUuid: string;
  filesystemUuid: string;
};
export type VaultProvisionJournal = {
  contract: 'cos-vault-provision/v1';
  identity: VaultProvisionIdentity;
  step: VaultProvisionStep;
  phase: 'intent' | 'applied' | 'complete';
};
/** Ports belong to the pinned root administration artifact, never the runtime or a worker. */
export type VaultProvisionPorts = {
  withLock<T>(operation: () => Promise<T>): Promise<T>;
  assertAuthority(): Promise<void>;
  assertMemory(): void;
  preflight(): Promise<VaultPreflight>;
  availableBytes(): number;
  readJournal(): VaultProvisionJournal | null;
  writeJournal(record: VaultProvisionJournal): void;
  inspect(step: VaultProvisionStep, identity: VaultProvisionIdentity): Promise<'absent' | 'matching' | 'conflict'>;
  apply(step: VaultProvisionStep, identity: VaultProvisionIdentity): Promise<void>;
};
export async function provisionVault(
  identity: VaultProvisionIdentity,
  ports: VaultProvisionPorts,
): Promise<Record<string, unknown>> {
  try {
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
    if (
      !identity ||
      Object.keys(identity).sort().join(',') !== 'filesystemUuid,luksUuid,operationId,recoveryReference,targetDigest' ||
      !/^[a-f0-9]{64}$/.test(identity.targetDigest) ||
      [identity.operationId, identity.recoveryReference, identity.luksUuid, identity.filesystemUuid].some(
        (value) => typeof value !== 'string' || !uuid.test(value),
      )
    )
      throw Error('invalid_vault_identity');
    return await ports.withLock(async () => {
      const authority = async () => {
        ports.assertMemory();
        await ports.assertAuthority();
        ports.assertMemory();
      };
      await authority();
      const facts = await ports.preflight();
      let journal = ports.readJournal();
      if (!journal) admitVaultProvisioning(facts);
      else {
        if (
          journal.contract !== 'cos-vault-provision/v1' ||
          digest(journal.identity) !== digest(identity) ||
          Object.keys(journal).sort().join(',') !== 'contract,identity,phase,step' ||
          !VAULT_PROVISION_STEPS.includes(journal.step) ||
          !['intent', 'applied', 'complete'].includes(journal.phase) ||
          (journal.phase === 'complete' && journal.step !== 'units')
        )
          throw Error('vault_journal_conflict');
        // Existing allocation belongs only to this journal; the adapter verifies its inode and volume UUID.
        assertVaultProvisionAuthority(facts);
      }
      const space = async () => {
        const allocation = await ports.inspect('allocate', identity),
          utilities = await ports.inspect('utilities', identity);
        if (allocation === 'conflict' || utilities === 'conflict') throw Error('vault_resource_conflict');
        const free = ports.availableBytes(),
          reserve =
            (allocation === 'absent' ? VAULT_BYTES : 0) + (utilities === 'absent' ? facts.utilityInstallationBytes : 0);
        if (
          !Number.isSafeInteger(free) ||
          !Number.isSafeInteger(reserve) ||
          reserve < 0 ||
          free - reserve < VAULT_FREE_FLOOR
        )
          throw Error('vault_capacity_insufficient');
      };
      await space();
      const first = journal ? VAULT_PROVISION_STEPS.indexOf(journal.step) + (journal.phase === 'intent' ? 0 : 1) : 0;
      for (const step of VAULT_PROVISION_STEPS.slice(0, first))
        if ((await ports.inspect(step, identity)) !== 'matching') throw Error('vault_completed_step_changed');
      if (journal?.phase === 'complete') {
        await authority();
        await space();
        return { status: 'ready', volumeBytes: VAULT_BYTES, identityDigest: digest(identity) };
      }
      const resumedIntent = journal?.phase === 'intent' ? journal.step : null;
      for (const step of VAULT_PROVISION_STEPS.slice(first)) {
        await authority();
        await space();
        const observed = await ports.inspect(step, identity);
        if (observed === 'conflict') throw Error('vault_resource_conflict');
        if (observed === 'absent' && resumedIntent === step && ['luks', 'filesystem'].includes(step))
          throw Error('vault_format_uncertain');
        journal = { contract: 'cos-vault-provision/v1', identity, step, phase: 'intent' };
        ports.writeJournal(journal);
        if (observed === 'absent') {
          await authority();
          await ports.apply(step, identity);
        }
        await authority();
        await space();
        if ((await ports.inspect(step, identity)) !== 'matching') throw Error('vault_step_unverified');
        journal = { ...journal, phase: step === 'units' ? 'complete' : 'applied' };
        ports.writeJournal(journal);
      }
      return { status: 'ready', volumeBytes: VAULT_BYTES, identityDigest: digest(identity) };
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root utility diagnostics and recovery-key transport failures stay private.
    throw new Error('vault_provisioning_unavailable');
  }
}
