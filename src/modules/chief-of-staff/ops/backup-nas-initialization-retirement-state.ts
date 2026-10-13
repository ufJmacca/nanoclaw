import { digest } from '../domain/contracts.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
export type BackupNasInitializationRetirementScope = Readonly<{
  nasDigest: string;
  vaultStateDigest: string;
  resource: BackupNasInitializationResource;
}>;
export type BackupNasInitializationRetirementJournal = Readonly<
  BackupNasInitializationRetirementScope & {
    contract: 'cos-backup-nas-initialization-retirement/v1';
    phase: 'retiring' | 'retired';
  }
>;
export type BackupNasInitializationRetirementPorts = {
  /** Installed composition must hold the actual root writer, accepted G01 claims,
   * sealed code and a fresh resource-bound owner/native permission. No stored
   * journal or observation grants ownership or authorizes the fixed effect.
   */
  assertAuthority(): Promise<void>;
  readJournal(): Promise<unknown>;
  /** Root adapters must durably publish and sync before this resolves. */
  writeJournal(value: BackupNasInitializationRetirementJournal): Promise<void>;
  observe(): Promise<unknown>;
  /** No caller-selected path or command. The root adapter binds the exact held resource. */
  retire(): Promise<void>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Reflect.ownKeys(value).sort().join(',') === expected;
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function scopeSnapshot(value: unknown): BackupNasInitializationRetirementScope {
  if (!object(value) || !keys(value, 'nasDigest,resource,vaultStateDigest')) throw Error('retirement_scope_conflict');
  const { nasDigest, vaultStateDigest, resource } = value;
  if (!hash(nasDigest) || !hash(vaultStateDigest)) throw Error('retirement_scope_conflict');
  return Object.freeze({ nasDigest, vaultStateDigest, resource: backupNasInitializationResource(resource) });
}
export function backupNasInitializationRetirementJournal(
  value: unknown,
  input: BackupNasInitializationRetirementScope,
): BackupNasInitializationRetirementJournal {
  try {
    const scope = scopeSnapshot(input);
    if (!object(value) || !keys(value, 'contract,nasDigest,phase,resource,vaultStateDigest'))
      throw Error('retirement_journal_conflict');
    const { contract, nasDigest, phase, resource, vaultStateDigest } = value;
    const observed = backupNasInitializationResource(resource);
    if (
      contract !== 'cos-backup-nas-initialization-retirement/v1' ||
      nasDigest !== scope.nasDigest ||
      vaultStateDigest !== scope.vaultStateDigest ||
      (phase !== 'retiring' && phase !== 'retired') ||
      digest(observed) !== digest(scope.resource)
    )
      throw Error('retirement_journal_conflict');
    return Object.freeze({
      contract,
      nasDigest: scope.nasDigest,
      vaultStateDigest: scope.vaultStateDigest,
      resource: observed,
      phase,
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private resource and NAS bindings never enter transition diagnostics.
    throw Error('backup_nas_initialization_retirement_unavailable');
  }
}
/** Durable transition logic only; no installed filesystem effects are connected
 * here. An absent unrecorded resource is denied. An interrupted recorded removal
 * is reconciled under fresh permission without replaying the effect.
 */
export async function transitionBackupNasInitializationRetirement(
  input: BackupNasInitializationRetirementScope,
  ports: BackupNasInitializationRetirementPorts,
) {
  try {
    const scope = scopeSnapshot(input);
    await ports.assertAuthority();
    const initial = await ports.readJournal();
    let journal = initial === null ? undefined : backupNasInitializationRetirementJournal(initial, scope);
    await ports.assertAuthority();
    const current = async () => {
      await ports.assertAuthority();
      const value = await ports.readJournal();
      if (
        journal
          ? value === null || digest(backupNasInitializationRetirementJournal(value, scope)) !== digest(journal)
          : value !== null
      )
        throw Error('retirement_journal_changed');
      await ports.assertAuthority();
    };
    const observe = async () => {
      await current();
      const value = await ports.observe();
      if (!object(value)) throw Error('retirement_observation_conflict');
      const state = value.state;
      let snapshot:
        | Readonly<{ state: 'absent' }>
        | Readonly<{ state: 'present'; resource: BackupNasInitializationResource }>;
      if (state === 'absent' && keys(value, 'state')) snapshot = Object.freeze({ state });
      else if (state === 'present' && keys(value, 'resource,state')) {
        const resource = backupNasInitializationResource(value.resource);
        if (digest(resource) !== digest(scope.resource)) throw Error('retirement_resource_changed');
        snapshot = Object.freeze({ state, resource });
      } else throw Error('retirement_observation_conflict');
      await current();
      return snapshot;
    };
    const persist = async (phase: BackupNasInitializationRetirementJournal['phase']) => {
      await current();
      const next = backupNasInitializationRetirementJournal(
        { contract: 'cos-backup-nas-initialization-retirement/v1', ...scope, phase },
        scope,
      );
      await ports.writeJournal(next);
      journal = next;
      await current();
    };
    let actual = await observe();
    if (!journal) {
      if (actual.state !== 'present') throw Error('unrecorded_absence');
      await persist('retiring');
    }
    if (journal!.phase === 'retired') {
      if (actual.state !== 'absent') throw Error('completed_resource_reappeared');
    } else {
      actual = await observe();
      if (actual.state === 'present') {
        await current();
        await ports.retire();
        await current();
        actual = await observe();
        if (actual.state !== 'absent') throw Error('retirement_effect_unverified');
      }
      await persist('retired');
    }
    actual = await observe();
    if (actual.state !== 'absent' || journal!.phase !== 'retired') throw Error('retirement_completion_unverified');
    await current();
    return Object.freeze({
      contract: 'cos-backup-nas-initialization-retirement-result/v1' as const,
      status: 'retired' as const,
      nasDigest: scope.nasDigest,
      vaultStateDigest: scope.vaultStateDigest,
      resourceDigest: digest(scope.resource),
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Resource, journal, effect and native permission diagnostics remain inside the root adapter.
    throw Error('backup_nas_initialization_retirement_unavailable');
  }
}
