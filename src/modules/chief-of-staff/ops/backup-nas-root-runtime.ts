import { digest } from '../domain/contracts.js';
import { readVaultRootConfiguration, vaultRootConfiguration } from './vault-root-config.js';
import { withVaultRootArtifact } from './vault-root-artifact.js';
import { verifyVaultMemory } from './vault-memory.js';
import { backupNasRootConfiguration, readBackupNasRootConfiguration } from './backup-nas-root-config.js';
import { withRootBackupSmbCredentials, type RootBackupSmbLease } from './backup-smb-root-lease.js';
import { withBackupNasRootJournal } from './backup-nas-root-journal.js';
import { observeBackupNasMount } from './backup-nas-kernel.js';
import { transitionBackupNasMount } from './backup-nas-mount-state.js';
import { executeBackupNasMount } from './backup-nas-mount-process.js';
import { executeBackupNasUnmount } from './backup-nas-unmount-process.js';
/** Fixed installed root route. No caller-selected configuration, paths, utility, PID,
 * descriptor or historical proof is admitted. Configuration and artifacts remain
 * current through all awaits; the root journal retains the real kernel writer.
 */
export async function runBackupNasRootMount(action: 'mount' | 'unmount') {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const role = () => {
      verifyVaultMemory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    if (!['mount', 'unmount'].includes(action)) throw Error('invalid_backup_mount_action');
    const vault = vaultRootConfiguration(readVaultRootConfiguration());
    const nas = backupNasRootConfiguration(readBackupNasRootConfiguration(vault), vault);
    const vaultDigest = digest(vault),
      nasDigest = digest(nas),
      until = Date.now() + (action === 'mount' ? 25000 : 8000);
    return await withVaultRootArtifact(vault, async (artifact) => {
      const trusted = () => {
        role();
        if (abort.signal.aborted || Date.now() >= until) throw Error('root_mount_expired');
        const current = vaultRootConfiguration(readVaultRootConfiguration());
        if (
          digest(current) !== vaultDigest ||
          digest(backupNasRootConfiguration(readBackupNasRootConfiguration(current), current)) !== nasDigest
        )
          throw Error('root_mount_configuration_changed');
        artifact.assertCurrent();
        role();
        if (abort.signal.aborted || Date.now() >= until) throw Error('root_mount_expired');
      };
      trusted();
      const invoke = (credential?: RootBackupSmbLease) => {
        const authority = async () => {
          trusted();
          if (credential) {
            if (credential.signal.aborted) throw Error('root_credential_released');
            await credential.assertCurrent();
          }
          trusted();
        };
        return withBackupNasRootJournal(
          vault,
          nas,
          async (lease) => {
            const observe = () => observeBackupNasMount(vault, nas, lease.readJournal());
            return transitionBackupNasMount(action, lease.scope, {
              assertAuthority: lease.assertCurrent,
              assertRecoveryAuthority: async () => {
                // Ordinary on-demand service execution is never an owner-bound native maintenance grant.
                throw Error('fresh_backup_recovery_authority_required');
              },
              readJournal: async () => lease.readJournal(),
              writeJournal: lease.writeJournal,
              observe: async () => observe(),
              mount: async () => {
                if (!credential || action !== 'mount') throw Error('root_mount_credential_required');
                await executeBackupNasMount(
                  { host: nas.host, userId: vault.owner.uid, groupId: vault.owner.gid },
                  credential,
                  (phase) => {
                    const actual = observe();
                    if (actual.state !== (phase === 'before' ? 'closed' : 'mounted'))
                      throw Error('mount_destination_changed');
                  },
                );
              },
              unmount: async (claim) => {
                if (action !== 'unmount') throw Error('root_unmount_action_required');
                await executeBackupNasUnmount(
                  claim,
                  Object.freeze({ signal: abort.signal, assertCurrent: lease.assertCurrent }),
                  (phase, expected) => {
                    const actual = observe();
                    if (
                      phase === 'before'
                        ? actual.state !== 'mounted' || digest(actual.mount) !== digest(expected)
                        : actual.state !== 'closed'
                    )
                      throw Error('unmount_destination_changed');
                  },
                );
              },
            });
          },
          { assertAuthority: authority },
        );
      };
      if (action === 'mount') {
        const result = await withRootBackupSmbCredentials(vault, nas.credentialReference, invoke);
        trusted();
        return result;
      }
      timer = setTimeout(() => abort.abort(), Math.max(1, until - Date.now()));
      const result = await invoke();
      trusted();
      return result;
    });
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private root/owner/kernel diagnostics and uncertain effects do not enter public status.
    throw Error('backup_nas_root_mount_unavailable');
  } finally {
    abort.abort();
    if (timer) clearTimeout(timer);
  }
}
