import type { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import {
  readVaultRootConfiguration,
  vaultRootConfiguration,
  type VaultRootConfiguration,
} from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { withVaultRootArtifact } from './vault-root-artifact.js';
import { checkVaultAuthority } from './vault-authority.js';
import { verifyVaultMemory } from './vault-memory.js';
import {
  backupNasInitializationRecoveryRequest,
  readBackupNasInitializationRecoveryRequest,
} from './backup-nas-initialization-recovery-wire.js';
import type { BackupNasInitializationResource } from './backup-nas-initialization-recovery-scope.js';
import type { BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { retireBackupNasUnclaimedConfigurationStage } from './backup-nas-config-install.js';
import { retireBackupNasUnclaimedUnderlay } from './backup-nas-underlay.js';
import { retireBackupNasUnclaimedServiceStage } from './backup-nas-service-install.js';
import { verifyBackupNasRecoveryServiceIdle } from './backup-nas-root-recovery.js';
type RetirementControls = { assertAuthority(): Promise<void>; assertMemory?(): void };
/** Fixed resource kinds map only to independently guarded root adapters. No
 * request field selects a path, utility, service, PID or generic filesystem effect.
 */
export function retireBackupNasInitialization(
  vault: VaultRootConfiguration,
  nas: BackupNasRootConfiguration,
  resource: BackupNasInitializationResource,
  controls: RetirementControls,
) {
  return resource.kind === 'configuration-stage'
    ? retireBackupNasUnclaimedConfigurationStage(vault, nas, resource, controls)
    : resource.kind === 'closed-underlay'
      ? retireBackupNasUnclaimedUnderlay(vault, nas, resource, controls)
      : retireBackupNasUnclaimedServiceStage(vault, nas, resource, controls);
}
export type BackupNasRootInitializationRecoveryControls = {
  /** Source-only composition fixtures. No installed role or effect overrides. */
  assertMemory?(): void;
  readConfiguration?: typeof readVaultRootConfiguration;
  withArtifact?: typeof withVaultRootArtifact;
  readRequest?: typeof readBackupNasInitializationRecoveryRequest;
  checkAuthority?: typeof checkVaultAuthority;
  retireResource?: typeof retireBackupNasInitialization;
  assertServiceIdle?(): void;
};
const unit = 'nanoclaw-cos-backup-mount.service';
const fields = 'Id,LoadState,ActiveState,SubState,MainPID,Job,UnitFileState,FragmentPath,DropInPaths,NeedDaemonReload';
/** Initialization may precede the first unit publication. A missing fixed unit
 * must still have no job or process. A loaded unit follows existing idle recovery
 * checks; this observation never changes the service manager.
 */
export function verifyBackupNasInitializationServiceIdle(output: unknown): void {
  try {
    if (typeof output !== 'string' || Buffer.byteLength(output) > 4096 || !output.endsWith('\n'))
      throw Error('manager_bounds');
    const lines = output.split('\n');
    lines.pop();
    const properties = new Map<string, string>();
    for (const line of lines) {
      const field = line.match(/^([A-Za-z]+)=(.*)$/);
      if (!field || properties.has(field[1])) throw Error('manager_fields');
      properties.set(field[1], field[2]);
    }
    if ([...properties.keys()].sort().join(',') !== fields.split(',').sort().join(',')) throw Error('manager_fields');
    if (properties.get('LoadState') === 'not-found') {
      if (
        properties.get('Id') !== unit ||
        properties.get('ActiveState') !== 'inactive' ||
        properties.get('SubState') !== 'dead' ||
        properties.get('MainPID') !== '0' ||
        !['', '0'].includes(properties.get('Job')!) ||
        !['', 'not-found'].includes(properties.get('UnitFileState')!) ||
        properties.get('FragmentPath') !== '' ||
        properties.get('DropInPaths') !== '' ||
        properties.get('NeedDaemonReload') !== 'no'
      )
        throw Error('manager_not_idle');
    } else verifyBackupNasRecoveryServiceIdle(output);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Manager paths and private observation diagnostics never leave root administration.
    throw Error('backup_nas_initialization_service_unavailable');
  }
}
function assertServiceIdle(): void {
  const result = spawnSync('/usr/bin/systemctl', ['show', '--property=' + fields, unit], {
    cwd: '/',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 4096,
    timeout: 1000,
  });
  if (result.error || result.signal || result.status !== 0)
    throw Error('backup_nas_initialization_service_unavailable');
  verifyBackupNasInitializationServiceIdle(result.stdout);
}
/** Fresh resource-bound private proof, actual root/memory and held sealed code
 * surround every awaited boundary. Each adapter independently holds accepted
 * G01 claims, the real writer and exact resources through durable completion.
 */
export async function runBackupNasRootInitializationRecovery(
  stream: Readable,
  controls: BackupNasRootInitializationRecoveryControls = {},
) {
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      until = Date.now() + 30000;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0 || Date.now() >= until)
        throw Error('root_initialization_recovery_unavailable');
    };
    role();
    const readConfiguration = controls.readConfiguration ?? readVaultRootConfiguration,
      vault = vaultRootConfiguration(readConfiguration()),
      configurationDigest = digest(vault);
    const currentConfiguration = () => {
      role();
      if (digest(vaultRootConfiguration(readConfiguration())) !== configurationDigest)
        throw Error('root_configuration_changed');
    };
    const result = await (controls.withArtifact ?? withVaultRootArtifact)(vault, async (artifact) => {
      const trusted = () => {
        currentConfiguration();
        artifact.assertCurrent();
        role();
      };
      const idle = () => {
        trusted();
        (controls.assertServiceIdle ?? assertServiceIdle)();
        trusted();
      };
      trusted();
      const request = backupNasInitializationRecoveryRequest(
        await (controls.readRequest ?? readBackupNasInitializationRecoveryRequest)(stream, vault, {
          assertMemory: trusted,
        }),
        vault,
      );
      trusted();
      const assertAuthority = async () => {
        idle();
        await (controls.checkAuthority ?? checkVaultAuthority)(request.authority, request.scope, vault.owner.uid);
        idle();
      };
      await assertAuthority();
      const retired = await (controls.retireResource ?? retireBackupNasInitialization)(
        vault,
        request.nas,
        request.resource,
        { assertAuthority, assertMemory: memory },
      );
      idle();
      const expected = {
        contract: 'cos-backup-nas-initialization-retirement-result/v1',
        status: 'retired',
        nasDigest: digest(request.nas),
        vaultStateDigest: vaultRootStateDigest(vault),
        resourceDigest: digest(request.resource),
      };
      if (
        !retired ||
        Reflect.ownKeys(retired).sort().join(',') !== 'contract,nasDigest,resourceDigest,status,vaultStateDigest' ||
        digest(retired) !== digest(expected)
      )
        throw Error('retirement_receipt_conflict');
      return Object.freeze({
        contract: 'cos-backup-nas-initialization-recovery-result/v1' as const,
        status: 'retired' as const,
        configurationDigest,
        nasDigest: expected.nasDigest,
        artifactDigest: vault.artifact.digest,
        scopeDigest: digest(request.scope),
        vaultStateDigest: expected.vaultStateDigest,
        resourceDigest: expected.resourceDigest,
      });
    });
    currentConfiguration();
    (controls.assertServiceIdle ?? assertServiceIdle)();
    currentConfiguration();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Capabilities, private NAS configuration and durable resource diagnostics never enter output.
    throw Error('backup_nas_root_initialization_recovery_unavailable');
  } finally {
    stream.destroy();
  }
}
