import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
type Underlay = Readonly<{ device: number; inode: number }>;
export type BackupNasMountClaim = Readonly<{ id: number; device: number; inode: number; bindingDigest: string }>;
export type BackupNasMountJournal = Readonly<{
  contract: 'cos-backup-nas-mount-state/v1';
  configurationDigest: string;
  underlay: Underlay;
  phase: 'closed' | 'mounting' | 'mounted' | 'unmounting';
  attemptId: string | null;
  mount: BackupNasMountClaim | null;
}>;
export type BackupNasMountObservation =
  | Readonly<{ state: 'closed'; underlay: Underlay }>
  | Readonly<{ state: 'mounted'; mount: BackupNasMountClaim }>;
export type BackupNasMountStatePorts = {
  /** Installed composition holds the kernel writer and checks current sealed root configuration.
   * Mount additionally holds the current owner credential lease. Neither journal nor observation is authority.
   */
  assertAuthority(): Promise<void>;
  /** Only fresh owner-bound native maintenance may reconcile an unrecorded effect. Ordinary service admission denies it. */
  assertRecoveryAuthority(): Promise<void>;
  readJournal(): Promise<unknown>;
  writeJournal(journal: BackupNasMountJournal): Promise<void>;
  /** Independently admits the actual signed mount, private owner, mount ID and filesystem, or the closed claimed underlay. */
  observe(): Promise<BackupNasMountObservation>;
  mount(): Promise<void>;
  unmount(mount: BackupNasMountClaim): Promise<void>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const hash = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const nonnegative = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
function underlay(value: unknown): value is Underlay {
  return object(value) && keys(value, 'device,inode') && nonnegative(value.device) && positive(value.inode);
}
function mount(value: unknown, bindingDigest: string): value is BackupNasMountClaim {
  return (
    object(value) &&
    keys(value, 'bindingDigest,device,id,inode') &&
    positive(value.id) &&
    nonnegative(value.device) &&
    positive(value.inode) &&
    value.bindingDigest === bindingDigest
  );
}
export function backupNasMountJournal(
  value: unknown,
  scope: Readonly<{ configurationDigest: string; bindingDigest: string }>,
): BackupNasMountJournal {
  if (
    !object(scope) ||
    !keys(scope, 'bindingDigest,configurationDigest') ||
    !hash(scope.configurationDigest) ||
    !hash(scope.bindingDigest) ||
    !object(value) ||
    !keys(value, 'attemptId,configurationDigest,contract,mount,phase,underlay') ||
    value.contract !== 'cos-backup-nas-mount-state/v1' ||
    value.configurationDigest !== scope.configurationDigest ||
    !underlay(value.underlay) ||
    !['closed', 'mounting', 'mounted', 'unmounting'].includes(String(value.phase)) ||
    (value.phase === 'closed' ? value.attemptId !== null || value.mount !== null : !uuid(value.attemptId)) ||
    (value.phase === 'mounting' && value.mount !== null) ||
    (['mounted', 'unmounting'].includes(String(value.phase)) && !mount(value.mount, scope.bindingDigest))
  )
    throw Error('backup_nas_mount_state_unavailable');
  return Object.freeze({
    ...value,
    underlay: Object.freeze({ ...value.underlay }),
    mount: value.mount ? Object.freeze({ ...(value.mount as BackupNasMountClaim) }) : null,
  }) as BackupNasMountJournal;
}
/** Ownership transition logic only. Installed filesystem/kernel adapters are mandatory;
 * synthetic ports exercise interruption/revocation without granting any OS capability.
 */
export async function transitionBackupNasMount(
  action: 'mount' | 'unmount',
  input: Readonly<{ configurationDigest: string; bindingDigest: string }>,
  ports: BackupNasMountStatePorts,
) {
  try {
    if (
      !['mount', 'unmount'].includes(action) ||
      !object(input) ||
      !keys(input, 'bindingDigest,configurationDigest') ||
      !hash(input.configurationDigest) ||
      !hash(input.bindingDigest)
    )
      throw Error('invalid_mount_transition');
    const scope = Object.freeze({ ...input });
    await ports.assertAuthority();
    let journal = backupNasMountJournal(await ports.readJournal(), scope);
    const current = async () => {
      await ports.assertAuthority();
      if (digest(backupNasMountJournal(await ports.readJournal(), scope)) !== digest(journal))
        throw Error('mount_journal_changed');
      await ports.assertAuthority();
    };
    const observe = async () => {
      await current();
      const value = await ports.observe();
      if (
        !object(value) ||
        (!(
          value.state === 'closed' &&
          keys(value, 'state,underlay') &&
          underlay(value.underlay) &&
          digest(value.underlay) === digest(journal.underlay)
        ) &&
          !(value.state === 'mounted' && keys(value, 'mount,state') && mount(value.mount, scope.bindingDigest)))
      )
        throw Error('mount_observation_unverified');
      const snapshot: BackupNasMountObservation =
        value.state === 'closed'
          ? Object.freeze({ state: 'closed', underlay: Object.freeze({ ...value.underlay }) })
          : Object.freeze({ state: 'mounted', mount: Object.freeze({ ...value.mount }) });
      await current();
      return snapshot;
    };
    const persist = async (next: BackupNasMountJournal) => {
      await current();
      const value = backupNasMountJournal(next, scope);
      await ports.writeJournal(value);
      journal = value;
      await current();
    };
    let actual = await observe();
    if (actual.state === 'mounted') {
      if (journal.phase === 'closed') throw Error('unclaimed_mount');
      if (journal.phase === 'mounting') {
        const original = digest(actual);
        await ports.assertRecoveryAuthority();
        const rechecked = await observe();
        if (digest(rechecked) !== original) throw Error('recovery_mount_changed');
        await persist({ ...journal, phase: 'mounted', mount: actual.mount });
      } else if (digest(actual.mount) !== digest(journal.mount)) throw Error('foreign_mount_instance');
    } else if (journal.phase !== 'closed' && !(journal.phase === 'mounting' && action === 'mount')) {
      await persist({ ...journal, phase: 'closed', mount: null, attemptId: null });
    }
    if (action === 'mount' && actual.state === 'closed') {
      if (journal.phase === 'closed') await persist({ ...journal, phase: 'mounting', attemptId: randomUUID() });
      const before = await observe();
      if (before.state !== 'closed') throw Error('mount_changed_before_effect');
      await current();
      await ports.mount();
      await current();
      actual = await observe();
      if (actual.state !== 'mounted') throw Error('mount_effect_unverified');
      await persist({ ...journal, phase: 'mounted', mount: actual.mount });
    } else if (action === 'unmount' && actual.state === 'mounted') {
      if (journal.phase !== 'unmounting') await persist({ ...journal, phase: 'unmounting' });
      const before = await observe();
      if (before.state !== 'mounted' || digest(before.mount) !== digest(journal.mount))
        throw Error('mount_changed_before_unmount');
      await current();
      await ports.unmount(before.mount);
      await current();
      actual = await observe();
      if (actual.state !== 'closed') throw Error('unmount_effect_unverified');
      await persist({ ...journal, phase: 'closed', mount: null, attemptId: null });
    } else if (action === 'mount' && journal.phase === 'unmounting') {
      await persist({ ...journal, phase: 'mounted' });
    }
    actual = await observe();
    if (
      (action === 'mount' &&
        (actual.state !== 'mounted' ||
          journal.phase !== 'mounted' ||
          digest(actual.mount) !== digest(journal.mount))) ||
      (action === 'unmount' && (actual.state !== 'closed' || journal.phase !== 'closed'))
    )
      throw Error('mount_result_unverified');
    await current();
    return Object.freeze({
      contract: 'cos-backup-nas-mount-result/v1' as const,
      status: actual.state,
      configurationDigest: scope.configurationDigest,
      ...(actual.state === 'mounted' ? { mountId: actual.mount.id } : {}),
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- No private journal, kernel proof or utility/authority diagnostics cross the boundary.
    throw Error('backup_nas_mount_state_unavailable');
  }
}
