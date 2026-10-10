import fs from 'node:fs';
import os from 'node:os';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readTarget, type TargetState } from './target-state.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import type { BackupNasSetupOwnerInput } from './backup-nas-owner-authority.js';
import { openProtectedBackupNasSetupAuthority } from './backup-nas-owner-authority.js';
import { backupNasSetupRequest, backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import { backupNasRootConfiguration } from './backup-nas-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasMountService } from './backup-nas-units.js';
import { verifyVaultMemory } from './vault-memory.js';
import { executeBackupNasSetup } from './backup-nas-setup-process.js';
export { backupNasSetupInvocation } from './backup-nas-setup-process.js';
export type BackupNasConfigureArguments = {
  command: 'backup-nas-configure';
  scopeId: string;
  requestId: string;
  host: string;
  credentialReference: string;
};
export type BackupNasConfigureInput = Omit<BackupNasSetupOwnerInput, 'configuration' | 'nas' | 'operationId'> & {
  args: BackupNasConfigureArguments;
  target: TargetState;
  release: ReleaseManifest;
};
export type BackupNasConfigureControls = {
  assertMemory?(): void;
  readConfiguration?(): VaultRootConfiguration;
  readTarget?: (root: string, binding: TargetState['binding']) => TargetState;
  openAuthority?: typeof openProtectedBackupNasSetupAuthority;
  invoke?(vault: VaultRootConfiguration, request: BackupNasSetupRequest, check: () => Promise<void>): Promise<unknown>;
};
export function parseBackupNasConfigureArguments(args: string[]): BackupNasConfigureArguments {
  const values: Record<string, string> = {};
  if (args[0] !== 'backup-nas-configure' || args.length !== 9) throw Error('invalid_admin_arguments');
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
    command: 'backup-nas-configure',
    scopeId: values['--scope'],
    requestId: values['--request-id'],
    host,
    credentialReference: values['--credential-reference'],
  };
}
function openOwnerConfiguration(root: string) {
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
export async function runBackupNasConfigureAdmin(
  input: BackupNasConfigureInput,
  controls: BackupNasConfigureControls = {},
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
    const args = parseBackupNasConfigureArguments([
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
      release.slice !== 'G02' ||
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
      scope = backupNasSetupScope(vault, nas, args.requestId, input.maintenance.generation);
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
    proof = await (controls.openAuthority ?? openProtectedBackupNasSetupAuthority)({
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
    const request = backupNasSetupRequest(
      {
        contract: 'cos-backup-nas-setup-request/v1',
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
      : executeBackupNasSetup(vault, request, current, { assertMemory: memory }));
    await current();
    guard();
    const expected = {
      contract: 'cos-backup-nas-setup-result/v1',
      status: 'configured',
      configurationDigest,
      nasDigest: digest(nas),
      artifactDigest: vault.artifact.digest,
      unitDigest: createHash('sha256')
        .update(backupNasMountService({ artifactDigest: vault.artifact.digest }).contents)
        .digest('hex'),
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
  if (failed || !verified) throw Error('backup_nas_owner_setup_unavailable');
  return verified;
}
