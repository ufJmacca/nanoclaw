import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, writeAtomic, type TargetState } from './target-state.js';
import type { ReleaseManifest } from './release-manifest.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultOwnerConfiguration } from './vault-owner-configuration.js';
import { openProtectedVaultAuthority } from './vault-owner-authority.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { vaultStagedRoot } from './vault-root-installer.js';
import { writeVaultInstallRequest, type VaultInstallRequest } from './vault-install-wire.js';
import { runtimeTestMessages } from './runtime-test-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
export function vaultInstallInvocation(config: VaultRootConfiguration, releaseId: string) {
  config = vaultRootConfiguration(config);
  const source = vaultStagedRoot(config, releaseId),
    unit = 'nanoclaw-cos-vault-install-' + config.authority.operationId + '-' + randomUUID() + '.service',
    env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
  return {
    tool: '/usr/bin/sudo',
    unit,
    env,
    args: [
      '-n',
      '/usr/bin/systemd-run',
      '--quiet',
      '--pipe',
      '--wait',
      '--collect',
      '--unit=' + unit,
      '--property=LimitCORE=0',
      '--property=MemorySwapMax=0',
      '--property=RuntimeMaxSec=600',
      '--',
      '/usr/bin/env',
      '-i',
      'PATH=' + env.PATH,
      'LANG=C',
      'LC_ALL=C',
      source + '/node',
      source + '/gateway.mjs',
      '--install',
    ],
  };
}
async function invoke(request: VaultInstallRequest, memory: () => void) {
  memory();
  const command = vaultInstallInvocation(request.configuration, request.releaseId),
    child = spawn(command.tool, command.args, {
      cwd: '/',
      env: command.env,
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 650000,
    });
  child.stdin.on('error', () => {});
  const exited = new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) =>
      signal || code === null ? reject(Error('installer_unavailable')) : resolve(code),
    );
  });
  exited.catch(() => {});
  let complete = false;
  try {
    await writeVaultInstallRequest(child.stdin, request, { assertMemory: memory });
    child.stdin.end();
    const replies: unknown[] = [];
    for await (const reply of runtimeTestMessages(child.stdout)) {
      if (replies.length) throw Error('installer_reply_count');
      replies.push(reply);
    }
    if ((await exited) !== 0 || replies.length !== 1) throw Error('installer_unavailable');
    memory();
    complete = true;
    return replies[0];
  } finally {
    if (!complete) {
      child.kill();
      spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', command.unit], {
        cwd: '/',
        env: command.env,
        stdio: 'ignore',
        timeout: 15000,
      });
    }
  }
}
type Input = Omit<Parameters<typeof openProtectedVaultAuthority>[0], 'configuration'> & {
  target: TargetState;
  release: ReleaseManifest;
  payloadRoot: string;
};
type Controls = {
  assertMemory?(): void;
  assertOwner?(): void;
  owner?: Pick<VaultRootConfiguration['owner'], 'uid' | 'gid' | 'home'>;
  readTarget?: typeof readTarget;
  readConfiguration?: () => VaultRootConfiguration | undefined;
  saveConfiguration?: (configuration: VaultRootConfiguration) => void;
  openAuthority?: typeof openProtectedVaultAuthority;
  invoke?: (request: VaultInstallRequest) => Promise<unknown>;
};
/** Caller holds the existing OS operation lock and actual paused owner/native/maintenance leases. No recovery material is read. */
export async function runVaultInstallAdmin(input: Input, controls: Controls = {}): Promise<Record<string, unknown>> {
  let proof: Awaited<ReturnType<typeof openProtectedVaultAuthority>> | undefined;
  let verified: Record<string, unknown> | undefined,
    failed = false;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory,
      ownerRole =
        controls.assertOwner ??
        (() => {
          if (process.platform !== 'linux' || !process.getuid?.()) throw Error('owner_process_required');
        }),
      guard = () => {
        memory();
        ownerRole();
      };
    guard();
    await input.check();
    guard();
    const owner = {
        ...(controls.owner ?? { uid: process.getuid!(), gid: process.getgid!(), home: os.homedir() }),
        targetRoot: input.root,
      },
      file = path.join(input.root, 'vault-owner.json'),
      before = fs.lstatSync(file, { throwIfNoEntry: false });
    const previous = controls.readConfiguration
      ? controls.readConfiguration()
      : before
        ? (() => {
            if (!before.isFile() || before.nlink !== 1 || fs.realpathSync(file) !== file)
              throw Error('unsafe_owner_configuration');
            return vaultRootConfiguration(readPrivate(file, 16384));
          })()
        : undefined;
    const config = vaultOwnerConfiguration({
        release: input.release,
        target: (controls.readTarget ?? readTarget)(input.root, input.target.binding),
        maintenance: input.maintenance,
        owner,
        previous,
      }),
      source = vaultStagedRoot(config, input.release.releaseId);
    if (input.payloadRoot !== path.dirname(path.dirname(source))) throw Error('owner_payload_binding_conflict');
    await input.check();
    guard();
    if (!previous || digest(previous) !== digest(config)) {
      if (controls.saveConfiguration) controls.saveConfiguration(config);
      else {
        const current = fs.lstatSync(file, { throwIfNoEntry: false });
        if (
          before
            ? !current ||
              before.ino !== current.ino ||
              before.dev !== current.dev ||
              before.size !== current.size ||
              before.ctimeMs !== current.ctimeMs ||
              before.mtimeMs !== current.mtimeMs
            : current
        )
          throw Error('owner_configuration_changed');
        writeAtomic(input.root, 'vault-owner.json', config);
      }
    }
    proof = await (controls.openAuthority ?? openProtectedVaultAuthority)({ ...input, configuration: config });
    await proof.check();
    guard();
    if (
      digest(proof.scope) !==
      digest({
        operationId: config.authority.operationId,
        targetDigest: config.identity.targetDigest,
        generation: config.target.minimumGeneration,
      })
    )
      throw Error('owner_install_scope_conflict');
    const request: VaultInstallRequest = {
      contract: 'cos-vault-root-install-request/v1',
      releaseId: input.release.releaseId,
      configuration: config,
      authority: { socket: proof.authority.socket, token: proof.authority.token },
    };
    const result = await (controls.invoke ? controls.invoke(request) : invoke(request, guard));
    await proof.check();
    guard();
    const receipt = result as Record<string, unknown>;
    if (
      !receipt ||
      typeof receipt !== 'object' ||
      Array.isArray(receipt) ||
      Object.keys(receipt).sort().join(',') !== 'artifactDigest,configurationDigest,contract,identityDigest,status' ||
      receipt.contract !== 'cos-vault-root-installation-result/v1' ||
      receipt.status !== 'installed' ||
      receipt.configurationDigest !== digest(config) ||
      receipt.identityDigest !== vaultRootStateDigest(config) ||
      receipt.artifactDigest !== config.artifact.digest
    )
      throw Error('root_install_receipt_conflict');
    verified = Object.freeze({ ...receipt, recoveryReference: config.identity.recoveryReference });
    // eslint-disable-next-line no-catch-all/no-catch-all -- Keep only failure status while the private proof is closed below.
  } catch {
    failed = true;
  } finally {
    try {
      await proof?.authority.close();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Cleanup errors can contain private socket paths; retain failure status only.
    } catch {
      failed = true;
    }
  }
  if (failed || !verified) throw Error('vault_owner_installation_unavailable');
  return verified;
}
