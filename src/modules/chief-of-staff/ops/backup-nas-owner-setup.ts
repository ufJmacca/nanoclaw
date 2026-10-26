import fs from 'node:fs';
import os from 'node:os';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readTarget, type TargetState } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasSetupOwnerInput } from './backup-nas-owner-authority.js';
import {
  openProtectedBackupNasSetupAuthority,
  openProtectedBackupNasRecoveryAuthority,
  openProtectedBackupNasInitializationRecoveryAuthority,
} from './backup-nas-owner-authority.js';
import { backupNasSetupRequest, backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { backupNasRootConfiguration } from './backup-nas-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasMountService } from './backup-nas-units.js';
import { verifyVaultMemory } from './vault-memory.js';
import { executeBackupNasSetup } from './backup-nas-setup-process.js';
import {
  backupNasRecoveryRequest,
  backupNasRecoveryScope,
  type BackupNasRecoveryRequest,
} from './backup-nas-recovery-wire.js';
import { executeBackupNasRecovery } from './backup-nas-recovery-process.js';
import { executeBackupNasInitializationInspection } from './backup-nas-inspection-process.js';
import { backupNasInitializationResource } from './backup-nas-initialization-recovery-scope.js';
import {
  backupNasInitializationRecoveryRequest,
  backupNasInitializationRecoveryScope,
  type BackupNasInitializationRecoveryRequest,
} from './backup-nas-initialization-recovery-wire.js';
import { executeBackupNasInitializationRecovery } from './backup-nas-initialization-recovery-process.js';
import { withBackupNasInitializationProgress } from './backup-nas-initialization-progress.js';
import { backupNasSelection, publishBackupNasSelection, type BackupNasSelection } from './backup-nas-selection.js';
export { backupNasSetupInvocation } from './backup-nas-setup-process.js';
type NasAdminCommand =
  | 'backup-nas-configure'
  | 'backup-nas-recover-unmount'
  | 'backup-nas-inspect-initialization'
  | 'backup-nas-recover-initialization';
type NasAdminArguments<C extends NasAdminCommand> = {
  command: C;
  scopeId: string;
  requestId: string;
  host: string;
  credentialReference: string;
};
type NasAdminInput<A> = Omit<BackupNasSetupOwnerInput, 'configuration' | 'nas' | 'operationId'> & {
  args: A;
  target: TargetState;
  release: ReleaseManifest;
};
type NasAdminControls<R> = {
  assertMemory?(): void;
  readConfiguration?(): VaultRootConfiguration;
  readTarget?: (root: string, binding: TargetState['binding']) => TargetState;
  openAuthority?: typeof openProtectedBackupNasSetupAuthority;
  invoke?(vault: VaultRootConfiguration, request: R, check: () => Promise<void>): Promise<unknown>;
  publishSelection?(selection: BackupNasSelection, check: () => Promise<void>): Promise<void>;
};
export type BackupNasConfigureArguments = NasAdminArguments<'backup-nas-configure'>;
export type BackupNasConfigureInput = NasAdminInput<BackupNasConfigureArguments>;
export type BackupNasConfigureControls = NasAdminControls<BackupNasSetupRequest>;
export type BackupNasRecoverArguments = NasAdminArguments<'backup-nas-recover-unmount'>;
export type BackupNasRecoverInput = NasAdminInput<BackupNasRecoverArguments>;
export type BackupNasRecoverControls = NasAdminControls<BackupNasRecoveryRequest>;
export type BackupNasInspectArguments = NasAdminArguments<'backup-nas-inspect-initialization'>;
export type BackupNasInspectInput = NasAdminInput<BackupNasInspectArguments>;
export type BackupNasInspectControls = NasAdminControls<BackupNasSetupRequest>;
export type BackupNasInitializationRecoverArguments = NasAdminArguments<'backup-nas-recover-initialization'>;
export type BackupNasInitializationRecoverInput = NasAdminInput<BackupNasInitializationRecoverArguments>;
export type BackupNasInitializationRecoverControls = NasAdminControls<BackupNasSetupRequest> & {
  openRecoveryAuthority?: typeof openProtectedBackupNasInitializationRecoveryAuthority;
  invokeRecovery?(
    vault: VaultRootConfiguration,
    request: BackupNasInitializationRecoveryRequest,
    check: () => Promise<void>,
  ): Promise<unknown>;
};
export function parseBackupNasConfigureArguments(args: string[]): BackupNasConfigureArguments {
  return parseNasAdminArguments('backup-nas-configure', args);
}
export function parseBackupNasRecoverArguments(args: string[]): BackupNasRecoverArguments {
  return parseNasAdminArguments('backup-nas-recover-unmount', args);
}
export function parseBackupNasInspectArguments(args: string[]): BackupNasInspectArguments {
  return parseNasAdminArguments('backup-nas-inspect-initialization', args);
}
export function parseBackupNasInitializationRecoverArguments(args: string[]): BackupNasInitializationRecoverArguments {
  return parseNasAdminArguments('backup-nas-recover-initialization', args);
}
function parseNasAdminArguments<C extends NasAdminCommand>(command: C, args: string[]): NasAdminArguments<C> {
  const values: Record<string, string> = {};
  if (args[0] !== command || args.length !== 9) throw Error('invalid_admin_arguments');
  for (let index = 1; index < args.length; index += 2) {
    if (
      !['--scope', '--request-id', '--host', '--credential-reference'].includes(args[index]) ||
      values[args[index]] !== undefined ||
      !args[index + 1]
    )
      throw Error('invalid_admin_arguments');
    values[args[index]] = args[index + 1];
  }
  const uuid = (value: string) =>
      /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value),
    host = values['--host'] ?? '',
    parts = host.split('.').map(Number);
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(values['--scope'] ?? '') ||
    !uuid(values['--request-id'] ?? '') ||
    !uuid(values['--credential-reference'] ?? '') ||
    isIP(host) !== 4 ||
    !(
      parts[0] === 10 ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    )
  )
    throw Error('invalid_admin_arguments');
  return {
    command,
    scopeId: values['--scope'],
    requestId: values['--request-id'],
    host,
    credentialReference: values['--credential-reference'],
  };
}
/** Read-only held owner configuration; installed callers select the bound target root. */
export function openOwnerConfiguration(root: string) {
  const parent = fs.lstatSync(root),
    parentFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let fd: number | undefined;
  try {
    const currentParent = () => {
      for (const stat of [fs.fstatSync(parentFd), fs.lstatSync(root)])
        if (
          !stat.isDirectory() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o700 ||
          stat.dev !== parent.dev ||
          stat.ino !== parent.ino ||
          fs.realpathSync(root) !== root
        )
          throw Error('owner_configuration_parent_changed');
    };
    currentParent();
    const file = '/proc/self/fd/' + parentFd + '/vault-owner.json';
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const held = fd,
      before = fs.fstatSync(held);
    const check = () => {
      currentParent();
      for (const stat of [fs.fstatSync(held), fs.lstatSync(file)])
        if (
          !stat.isFile() ||
          stat.uid !== process.getuid?.() ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== 1 ||
          stat.dev !== parent.dev ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size < 1 ||
          stat.size > 16384 ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs
        )
          throw Error('owner_configuration_changed');
    };
    check();
    const bytes = Buffer.alloc(before.size + 1);
    try {
      if (fs.readSync(held, bytes, 0, bytes.length, 0) !== before.size) throw Error('owner_configuration_changed');
      check();
      const configuration = vaultRootConfiguration(JSON.parse(bytes.subarray(0, before.size).toString('utf8')));
      return {
        configuration,
        check,
        close() {
          try {
            fs.closeSync(held);
          } finally {
            fs.closeSync(parentFd);
          }
        },
      };
    } finally {
      bytes.fill(0);
    }
  } catch {
    if (fd !== undefined) fs.closeSync(fd);
    fs.closeSync(parentFd);
    // eslint-disable-next-line preserve-caught-error -- Private configuration paths and file diagnostics remain inside the owner boundary.
    throw Error('owner_configuration_unavailable');
  }
}
/** The existing context command owns the operation lock, native host lease and
 * paused private membership checks. This adds a destination-bound live permission
 * without rewriting owner configuration, vault resources or recovery references.
 */
type NasAdminPolicy<C extends NasAdminCommand, R> = {
  parse(args: string[]): NasAdminArguments<C>;
  scope: typeof backupNasSetupScope;
  request(value: unknown, vault: VaultRootConfiguration): R;
  requestContract: string;
  openAuthority: typeof openProtectedBackupNasSetupAuthority;
  invoke(
    vault: VaultRootConfiguration,
    request: R,
    check: () => Promise<void>,
    assertMemory: () => void,
  ): Promise<unknown>;
  receipt(vault: VaultRootConfiguration, result: unknown): Record<string, unknown>;
  unavailable: string;
  operation?(context: {
    vault: VaultRootConfiguration;
    nas: ReturnType<typeof backupNasRootConfiguration>;
    args: NasAdminArguments<C>;
    check(): Promise<void>;
    memory(): void;
  }): Promise<Record<string, unknown>>;
};
export function runBackupNasConfigureAdmin(
  input: BackupNasConfigureInput,
  controls: BackupNasConfigureControls = {},
): Promise<Record<string, unknown>> {
  return runProtectedNasAdmin(input, controls, {
    parse: parseBackupNasConfigureArguments,
    scope: backupNasSetupScope,
    request: backupNasSetupRequest,
    requestContract: 'cos-backup-nas-setup-request/v1',
    openAuthority: openProtectedBackupNasSetupAuthority,
    invoke: (vault, request, check, memory) => executeBackupNasSetup(vault, request, check, { assertMemory: memory }),
    receipt: (vault) => ({
      contract: 'cos-backup-nas-setup-result/v1',
      status: 'configured',
      unitDigest: createHash('sha256')
        .update(backupNasMountService({ artifactDigest: vault.artifact.digest }).contents)
        .digest('hex'),
    }),
    unavailable: 'backup_nas_owner_setup_unavailable',
  });
}
export function runBackupNasRecoverAdmin(
  input: BackupNasRecoverInput,
  controls: BackupNasRecoverControls = {},
): Promise<Record<string, unknown>> {
  return runProtectedNasAdmin(input, controls, {
    parse: parseBackupNasRecoverArguments,
    scope: backupNasRecoveryScope,
    request: backupNasRecoveryRequest,
    requestContract: 'cos-backup-nas-recover-unmount-request/v1',
    openAuthority: openProtectedBackupNasRecoveryAuthority,
    invoke: (vault, request, check, memory) =>
      executeBackupNasRecovery(vault, request, check, { assertMemory: memory }),
    receipt: () => ({ contract: 'cos-backup-nas-recover-unmount-result/v1', status: 'closed' }),
    unavailable: 'backup_nas_owner_recovery_unavailable',
  });
}
/** Inspection has no credential or resource effect. Verify its exact root receipt
 * under the same current protected context, held configuration and native leases.
 * Returning this tuple does not authorize cleanup or adopt the observed resource.
 */
export function runBackupNasInspectAdmin(
  input: BackupNasInspectInput,
  controls: BackupNasInspectControls = {},
): Promise<Record<string, unknown>> {
  return runProtectedNasAdmin(input, controls, {
    parse: parseBackupNasInspectArguments,
    scope: backupNasSetupScope,
    request: backupNasSetupRequest,
    requestContract: 'cos-backup-nas-setup-request/v1',
    openAuthority: openProtectedBackupNasSetupAuthority,
    invoke: (vault, request, check, memory) =>
      executeBackupNasInitializationInspection(vault, request, check, { assertMemory: memory }),
    receipt: (_vault, result) => ({
      contract: 'cos-backup-nas-initialization-inspection-result/v1',
      status: 'observed',
      resource: backupNasInitializationResource(
        result && typeof result === 'object' ? (result as Record<string, unknown>).resource : undefined,
      ),
    }),
    unavailable: 'backup_nas_owner_inspection_unavailable',
  });
}
/** Save a verified observation before cleanup. A lost root or owner acknowledgement
 * retries that exact metadata with fresh permission; absence alone cannot recreate
 * an observation or authorize removal. Root independently checks current claims
 * and its durable resource-specific intent on every attempt.
 */
export function runBackupNasInitializationRecoverAdmin(
  input: BackupNasInitializationRecoverInput,
  controls: BackupNasInitializationRecoverControls = {},
): Promise<Record<string, unknown>> {
  return runProtectedNasAdmin(input, controls, {
    parse: parseBackupNasInitializationRecoverArguments,
    scope: backupNasSetupScope,
    request: backupNasSetupRequest,
    requestContract: 'cos-backup-nas-setup-request/v1',
    openAuthority: openProtectedBackupNasSetupAuthority,
    invoke: (vault, request, check, memory) =>
      executeBackupNasInitializationInspection(vault, request, check, { assertMemory: memory }),
    receipt: () => ({}),
    unavailable: 'backup_nas_owner_initialization_recovery_unavailable',
    operation: async ({ vault, nas, args, check, memory }) =>
      withBackupNasInitializationProgress(
        { root: vault.owner.targetRoot, nasDigest: digest(nas), vaultStateDigest: vaultRootStateDigest(vault), check },
        async (progress) => {
          const current = async () => {
            progress.assertCurrent();
            await check();
            progress.assertCurrent();
          };
          const observationUnavailable = Error('initialization_observation_unavailable');
          const invokePhase = async (
            kind: 'inspect' | 'retire',
            resource?: ReturnType<typeof backupNasInitializationResource>,
          ): Promise<Record<string, unknown>> => {
            let proof: Awaited<ReturnType<typeof openProtectedBackupNasSetupAuthority>> | undefined;
            try {
              await current();
              const scope =
                  kind === 'inspect'
                    ? backupNasSetupScope(vault, nas, args.requestId, input.maintenance.generation)
                    : backupNasInitializationRecoveryScope(
                        vault,
                        nas,
                        resource!,
                        args.requestId,
                        input.maintenance.generation,
                      ),
                selected = {
                  root: vault.owner.targetRoot,
                  configuration: vault,
                  nas,
                  operationId: args.requestId,
                  maintenance: input.maintenance,
                  native: input.native,
                  hostLease: input.hostLease,
                  check: current,
                };
              proof =
                kind === 'inspect'
                  ? await (controls.openAuthority ?? openProtectedBackupNasSetupAuthority)(selected)
                  : await (controls.openRecoveryAuthority ?? openProtectedBackupNasInitializationRecoveryAuthority)({
                      ...selected,
                      resource: resource!,
                    });
              await proof.check();
              await current();
              if (digest(proof.scope) !== digest(scope)) throw Error('initialization_permission_conflict');
              const live = async () => {
                await proof!.check();
                await current();
              };
              const common = {
                configurationDigest: digest(vault),
                nas,
                scope,
                authority: { socket: proof.authority.socket, token: proof.authority.token },
              };
              let result: unknown;
              if (kind === 'inspect') {
                const request = backupNasSetupRequest(
                  { contract: 'cos-backup-nas-setup-request/v1', ...common },
                  vault,
                );
                try {
                  result = await (controls.invoke
                    ? controls.invoke(vault, request, live)
                    : executeBackupNasInitializationInspection(vault, request, live, { assertMemory: memory }));
                } catch {
                  // Only an invocation refusal with still-current permission can select
                  // completed metadata for fresh independent root reconciliation.
                  await live();
                  throw observationUnavailable;
                }
              } else {
                const request = backupNasInitializationRecoveryRequest(
                  { contract: 'cos-backup-nas-recover-initialization-request/v1', ...common, resource },
                  vault,
                );
                result = await (controls.invokeRecovery
                  ? controls.invokeRecovery(vault, request, live)
                  : executeBackupNasInitializationRecovery(vault, request, live, { assertMemory: memory }));
              }
              await live();
              const expected = {
                contract:
                  kind === 'inspect'
                    ? 'cos-backup-nas-initialization-inspection-result/v1'
                    : 'cos-backup-nas-initialization-recovery-result/v1',
                status: kind === 'inspect' ? 'observed' : 'retired',
                configurationDigest: digest(vault),
                nasDigest: digest(nas),
                artifactDigest: vault.artifact.digest,
                scopeDigest: digest(scope),
                ...(kind === 'inspect'
                  ? {
                      resource: backupNasInitializationResource(
                        result && typeof result === 'object' ? (result as Record<string, unknown>).resource : undefined,
                      ),
                    }
                  : { vaultStateDigest: vaultRootStateDigest(vault), resourceDigest: digest(resource) }),
              };
              if (
                !result ||
                typeof result !== 'object' ||
                Array.isArray(result) ||
                Reflect.ownKeys(result).sort().join(',') !== Reflect.ownKeys(expected).sort().join(',') ||
                digest(result) !== digest(expected)
              )
                throw Error('initialization_receipt_conflict');
              return Object.freeze(expected);
            } finally {
              try {
                await proof?.authority.close();
              } finally {
                await current();
              }
            }
          };
          let selected = progress.read();
          if (!selected || selected.phase === 'retired') {
            let observation: Record<string, unknown> | undefined;
            try {
              observation = await invokePhase('inspect');
            } catch (error) {
              if (!selected || error !== observationUnavailable) throw error;
              await current();
            }
            if (observation) {
              selected = Object.freeze({
                contract: 'cos-backup-nas-initialization-progress/v1' as const,
                nasDigest: digest(nas),
                vaultStateDigest: vaultRootStateDigest(vault),
                resource: backupNasInitializationResource(observation.resource),
                phase: 'observed' as const,
              });
              await progress.write(selected);
            }
          }
          if (!selected) throw Error('initialization_progress_unavailable');
          const result = await invokePhase('retire', selected.resource);
          await current();
          await progress.write({ ...selected, phase: 'retired' });
          await current();
          return result;
        },
      ),
  });
}
async function runProtectedNasAdmin<C extends NasAdminCommand, R>(
  input: NasAdminInput<NasAdminArguments<C>>,
  controls: NasAdminControls<R>,
  policy: NasAdminPolicy<C, R>,
): Promise<Record<string, unknown>> {
  let proof: Awaited<ReturnType<typeof openProtectedBackupNasSetupAuthority>> | undefined,
    held: ReturnType<typeof openOwnerConfiguration> | undefined,
    finalGuard: (() => void) | undefined,
    verified: Record<string, unknown> | undefined,
    failed = false;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || !process.getuid?.())
        throw Error('owner_required');
    };
    role();
    await input.check();
    role();
    if (Object.keys(input.args).sort().join(',') !== 'command,credentialReference,host,requestId,scopeId')
      throw Error('invalid_setup_arguments');
    const args = policy.parse([
        input.args.command,
        '--scope',
        input.args.scopeId,
        '--request-id',
        input.args.requestId,
        '--host',
        input.args.host,
        '--credential-reference',
        input.args.credentialReference,
      ]),
      release = validateReleaseManifest(input.release);
    if (
      !['G02', 'G03', 'G04', 'G05', 'G06'].includes(release.slice) ||
      !release.vaultArtifact ||
      input.maintenance.owner !== 'operations-' + args.requestId ||
      input.maintenance.purpose !== 'deployment'
    )
      throw Error('setup_release_or_operation_unavailable');
    if (!controls.readConfiguration) held = openOwnerConfiguration(input.root);
    const readConfiguration =
        controls.readConfiguration ??
        (() => {
          held!.check();
          return held!.configuration;
        }),
      vault = vaultRootConfiguration(readConfiguration()),
      configurationDigest = digest(vault);
    if (
      vault.owner.uid !== process.getuid?.() ||
      vault.owner.gid !== process.getgid?.() ||
      vault.owner.home !== os.homedir() ||
      vault.owner.targetRoot !== input.root ||
      digest(input.target.binding) !== vault.identity.targetDigest ||
      vault.artifact.digest !== release.vaultArtifact.digest ||
      vault.artifact.sourceCommit !== release.source.commit ||
      vault.artifact.sourceTree !== release.source.tree
    )
      throw Error('setup_owner_or_artifact_conflict');
    const nas = backupNasRootConfiguration(
        {
          contract: 'cos-backup-nas-root-config/v1',
          host: args.host,
          credentialReference: args.credentialReference,
          vaultStateDigest: vaultRootStateDigest(vault),
        },
        vault,
      ),
      scope = policy.scope(vault, nas, args.requestId, input.maintenance.generation);
    const guard = () => {
      role();
      held?.check();
      if (digest(vaultRootConfiguration(readConfiguration())) !== configurationDigest)
        throw Error('setup_owner_configuration_changed');
      const target = (controls.readTarget ?? readTarget)(input.root, vault.target.binding);
      if (
        target.lifecycle !== 'protected' ||
        digest(target.binding) !== vault.identity.targetDigest ||
        target.releaseId !== release.releaseId ||
        target.generation !== input.maintenance.generation ||
        !target.maintenance ||
        target.maintenanceId !== input.maintenance.nonce
      )
        throw Error('setup_target_changed');
    };
    finalGuard = guard;
    const check = async () => {
      guard();
      await input.check();
      guard();
    };
    await check();
    if (policy.operation) {
      verified = Object.freeze(await policy.operation({ vault, nas, args, check, memory }));
      await check();
    } else {
      proof = await (controls.openAuthority ?? policy.openAuthority)({
        root: input.root,
        configuration: vault,
        nas,
        operationId: args.requestId,
        maintenance: input.maintenance,
        native: input.native,
        hostLease: input.hostLease,
        check,
      });
      await proof.check();
      guard();
      if (digest(proof.scope) !== digest(scope)) throw Error('setup_permission_conflict');
      const request = policy.request(
        {
          contract: policy.requestContract,
          configurationDigest,
          nas,
          scope,
          authority: { socket: proof.authority.socket, token: proof.authority.token },
        },
        vault,
      );
      const current = async () => {
        await proof!.check();
        await check();
      };
      const result = await (controls.invoke
        ? controls.invoke(vault, request, current)
        : policy.invoke(vault, request, current, memory));
      await current();
      guard();
      const expected = {
        ...policy.receipt(vault, result),
        configurationDigest,
        nasDigest: digest(nas),
        artifactDigest: vault.artifact.digest,
        scopeDigest: digest(scope),
      };
      if (
        !result ||
        typeof result !== 'object' ||
        Array.isArray(result) ||
        Object.keys(result).sort().join(',') !== Object.keys(expected).sort().join(',') ||
        digest(result) !== digest(expected)
      )
        throw Error('setup_root_receipt_conflict');
      verified = Object.freeze(expected);
      if (args.command === 'backup-nas-configure') {
        const selection = backupNasSelection(
          {
            contract: 'cos-backup-nas-selection/v1',
            targetDigest: vault.identity.targetDigest,
            nas,
          },
          vault,
        );
        await current();
        await (controls.publishSelection
          ? controls.publishSelection(selection, current)
          : publishBackupNasSelection(input.root, selection, args.requestId, current));
        await current();
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- Only status is retained while private authority and configuration descriptors close.
  } catch {
    failed = true;
  } finally {
    try {
      await proof?.authority.close();
      finalGuard?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Changed metadata or failed permission cleanup cannot produce success.
    } catch {
      failed = true;
    } finally {
      try {
        held?.close();
        // eslint-disable-next-line no-catch-all/no-catch-all -- Descriptor cleanup diagnostics are private.
      } catch {
        failed = true;
      }
    }
  }
  if (failed || !verified) throw Error(policy.unavailable);
  return verified;
}
