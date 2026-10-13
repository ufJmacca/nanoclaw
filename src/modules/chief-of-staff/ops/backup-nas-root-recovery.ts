import type { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { readVaultRootConfiguration, vaultRootConfiguration } from './vault-root-config.js';
import { readBackupNasRootConfiguration, backupNasRootConfiguration } from './backup-nas-root-config.js';
import { withVaultRootArtifact } from './vault-root-artifact.js';
import { readBackupNasRecoveryRequest, backupNasRecoveryRequest } from './backup-nas-recovery-wire.js';
import { checkVaultAuthority } from './vault-authority.js';
import { withBackupNasRootJournal } from './backup-nas-root-journal.js';
import { observeBackupNasMount } from './backup-nas-kernel.js';
import { executeBackupNasUnmount } from './backup-nas-unmount-process.js';
import { transitionBackupNasMount } from './backup-nas-mount-state.js';
import { verifyVaultMemory } from './vault-memory.js';
/** Source-only composition ports. The installed route has no role, path, utility,
 * mount ID, PID or service selector and never opens a credential or creates a mount.
 */
export type BackupNasRootRecoveryControls = {
  assertMemory?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  readNasConfiguration?: typeof readBackupNasRootConfiguration;
  withArtifact?: typeof withVaultRootArtifact;
  readRequest?: typeof readBackupNasRecoveryRequest;
  checkAuthority?: typeof checkVaultAuthority;
  withJournal?: typeof withBackupNasRootJournal;
  observe?: typeof observeBackupNasMount;
  unmount?: typeof executeBackupNasUnmount;
  assertServiceIdle?(): void;
};
const unit = 'nanoclaw-cos-backup-mount.service';
/** Manager observation only. Recovery cannot race a queued/running mount service
 * or leave an active oneshot unit claiming that a closed connection remains active.
 */
export function verifyBackupNasRecoveryServiceIdle(output: unknown): void {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 4096) throw Error('manager_bounds');
    const properties = new Map<string, string>();
    for (const line of output.split('\n').filter(Boolean)) {
      const field = line.match(/^([A-Za-z]+)=(.*)$/);
      if (!field || properties.has(field[1])) throw Error('manager_fields');
      properties.set(field[1], field[2]);
    }
    if (
      [...properties.keys()].sort().join(',') !==
        'ActiveState,DropInPaths,FragmentPath,Id,Job,LoadState,MainPID,NeedDaemonReload,SubState,UnitFileState' ||
      properties.get('Id') !== unit ||
      properties.get('LoadState') !== 'loaded' ||
      !['inactive/dead', 'failed/failed'].includes(properties.get('ActiveState') + '/' + properties.get('SubState')) ||
      properties.get('MainPID') !== '0' ||
      !['', '0'].includes(properties.get('Job')!) ||
      properties.get('UnitFileState') !== 'static' ||
      properties.get('FragmentPath') !== '/etc/systemd/system/' + unit ||
      properties.get('DropInPaths') !== '' ||
      properties.get('NeedDaemonReload') !== 'no'
    )
      throw Error('service_not_idle');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Manager diagnostics and unit paths remain private.
    throw Error('backup_nas_recovery_service_unavailable');
  }
}
function assertServiceIdle(): void {
  const result = spawnSync(
    '/usr/bin/systemctl',
    [
      'show',
      '--property=Id,LoadState,ActiveState,SubState,MainPID,Job,UnitFileState,FragmentPath,DropInPaths,NeedDaemonReload',
      unit,
    ],
    {
      cwd: '/',
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 4096,
      timeout: 1000,
    },
  );
  if (result.error || result.signal || result.status !== 0) throw Error('backup_nas_recovery_service_unavailable');
  verifyBackupNasRecoveryServiceIdle(result.stdout);
}
/** A fresh owner/native recovery capability may close an uncertain effect from
 * recorded mount intent. Actual root/memory, sealed code, fixed root configuration,
 * idle service observation and the kernel writer surround every await. Unclaimed
 * mounts remain refused; the independent kernel instance must match before unmount.
 */
export async function runBackupNasRootRecovery(
  stream: Readable,
  controls: BackupNasRootRecoveryControls = {},
): Promise<Record<string, unknown>> {
  const abort = new AbortController(),
    until = Date.now() + 30000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role = () => {
      memory();
      if (
        process.platform !== 'linux' ||
        process.arch !== 'arm64' ||
        process.getuid?.() !== 0 ||
        abort.signal.aborted ||
        Date.now() >= until
      )
        throw Error('root_recovery_unavailable');
    };
    role();
    const readConfiguration = controls.readConfiguration ?? readVaultRootConfiguration,
      readNasConfiguration = controls.readNasConfiguration ?? readBackupNasRootConfiguration,
      vault = vaultRootConfiguration(readConfiguration()),
      nas = backupNasRootConfiguration(readNasConfiguration(vault), vault),
      configurationDigest = digest(vault),
      nasDigest = digest(nas);
    const currentConfiguration = () => {
      role();
      const current = vaultRootConfiguration(readConfiguration());
      if (
        digest(current) !== configurationDigest ||
        digest(backupNasRootConfiguration(readNasConfiguration(current), current)) !== nasDigest
      )
        throw Error('recovery_configuration_changed');
      role();
    };
    timer = setTimeout(() => abort.abort(), Math.max(1, until - Date.now()));
    const result = await (controls.withArtifact ?? withVaultRootArtifact)(vault, async (artifact) => {
      const trusted = () => {
        currentConfiguration();
        artifact.assertCurrent();
        role();
      };
      trusted();
      const request = backupNasRecoveryRequest(
        await (controls.readRequest ?? readBackupNasRecoveryRequest)(stream, vault, { assertMemory: trusted }),
        vault,
      );
      trusted();
      if (digest(request.nas) !== nasDigest) throw Error('recovery_destination_conflict');
      const assertAuthority = async () => {
        trusted();
        await (controls.checkAuthority ?? checkVaultAuthority)(request.authority, request.scope, vault.owner.uid);
        trusted();
        (controls.assertServiceIdle ?? assertServiceIdle)();
        trusted();
      };
      await assertAuthority();
      const closed = await (controls.withJournal ?? withBackupNasRootJournal)(
        vault,
        nas,
        async (lease) => {
          const observe = () => (controls.observe ?? observeBackupNasMount)(vault, nas, lease.readJournal());
          return transitionBackupNasMount('unmount', lease.scope, {
            assertAuthority: lease.assertCurrent,
            assertRecoveryAuthority: lease.assertCurrent,
            readJournal: async () => lease.readJournal(),
            writeJournal: lease.writeJournal,
            observe: async () => observe(),
            mount: async () => {
              throw Error('recovery_mount_prohibited');
            },
            unmount: async (claim) => {
              await (controls.unmount ?? executeBackupNasUnmount)(
                claim,
                Object.freeze({ signal: abort.signal, assertCurrent: lease.assertCurrent }),
                (phase, expected) => {
                  trusted();
                  const actual = observe();
                  if (
                    phase === 'before'
                      ? actual.state !== 'mounted' || digest(actual.mount) !== digest(expected)
                      : actual.state !== 'closed'
                  )
                    throw Error('recovery_mount_instance_changed');
                  trusted();
                },
              );
            },
          });
        },
        { assertAuthority, assertMemory: memory },
      );
      // The journal holds its claims through its final native await. No new
      // authority await is introduced after those verified descriptors close.
      trusted();
      if (
        Object.keys(closed).sort().join(',') !== 'configurationDigest,contract,status' ||
        closed.contract !== 'cos-backup-nas-mount-result/v1' ||
        closed.status !== 'closed' ||
        closed.configurationDigest !== nasDigest
      )
        throw Error('recovery_result_unverified');
      return Object.freeze({
        contract: 'cos-backup-nas-recover-unmount-result/v1',
        status: 'closed',
        configurationDigest,
        nasDigest,
        artifactDigest: vault.artifact.digest,
        scopeDigest: digest(request.scope),
      });
    });
    currentConfiguration();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private owner, service, mount and uncertain effect diagnostics never enter a success receipt.
    throw Error('backup_nas_root_recovery_unavailable');
  } finally {
    abort.abort();
    if (timer) clearTimeout(timer);
    stream.destroy();
  }
}
