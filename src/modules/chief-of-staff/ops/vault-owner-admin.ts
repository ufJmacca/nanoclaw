import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { Readable } from 'node:stream';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import { digest } from '../domain/contracts.js';
import { readPrivate } from './target-state.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { openProtectedVaultAuthority } from './vault-owner-authority.js';
import { readVaultRecoveryKey } from './vault-recovery-wire.js';
import { writeVaultRootRequest, type VaultRootHeader } from './vault-root-wire.js';
import { runtimeTestMessages } from './runtime-test-wire.js';
import { verifyVaultMemory } from './vault-memory.js';
import { VAULT_BYTES } from './vault-admission.js';
import { configureVaultStorage } from './vault-storage.js';
export function vaultRootInvocation(input: VaultRootConfiguration) {
  const config = vaultRootConfiguration(input),
    root = '/opt/nanoclaw-cos/vault/' + config.artifact.digest;
  const unit = 'nanoclaw-cos-vault-admin-' + config.authority.operationId + '-' + randomUUID() + '.service';
  const env = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' };
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
      root + '/node',
      root + '/gateway.mjs',
    ],
  };
}
async function invokeRoot(config: VaultRootConfiguration, header: VaultRootHeader, key: Buffer, memory: () => void) {
  memory();
  const command = vaultRootInvocation(config),
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
      signal || code === null ? reject(Error('root_process_unavailable')) : resolve(code),
    );
  });
  exited.catch(() => {});
  let completed = false;
  try {
    await writeVaultRootRequest(child.stdin, header, key, { assertMemory: memory });
    child.stdin.end();
    const replies: unknown[] = [];
    for await (const reply of runtimeTestMessages(child.stdout)) {
      if (replies.length) throw Error('root_reply_count');
      replies.push(reply);
    }
    if ((await exited) !== 0 || replies.length !== 1) throw Error('root_result_unavailable');
    memory();
    completed = true;
    return replies[0];
  } finally {
    if (!completed) {
      child.kill();
      // Only this invocation's fresh UUID unit can be cancelled; no persistent storage or owner service is stopped here.
      spawnSync('/usr/bin/sudo', ['-n', '/usr/bin/systemctl', 'stop', command.unit], {
        cwd: '/',
        env: command.env,
        stdio: 'ignore',
        timeout: 15000,
      });
    }
  }
}
type OwnerInput = Omit<Parameters<typeof openProtectedVaultAuthority>[0], 'configuration'> & { stream?: Readable };
type OwnerControls = {
  assertMemory?(): void;
  readConfiguration?: (root: string) => VaultRootConfiguration;
  openAuthority?: typeof openProtectedVaultAuthority;
  readRecovery?: typeof readVaultRecoveryKey;
  invoke?: (header: VaultRootHeader, key: Buffer) => Promise<unknown>;
  configureStorage?: (roots: CalendarStorageRoots, vaultRoot: string) => void | Promise<void>;
};
/** Installed owner command. Configuration is non-secret metadata at one fixed private target path; recovery is pipe-only. */
export async function runVaultProvisionAdmin(
  input: OwnerInput,
  controls: OwnerControls = {},
): Promise<Record<string, unknown>> {
  let recovery: Buffer | undefined, proof: Awaited<ReturnType<typeof openProtectedVaultAuthority>> | undefined;
  let verified: Record<string, unknown> | undefined,
    failed = false;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    memory();
    const config = (
      controls.readConfiguration ??
      ((root) => vaultRootConfiguration(readPrivate(path.join(root, 'vault-owner.json'), 16384)))
    )(input.root);
    proof = await (controls.openAuthority ?? openProtectedVaultAuthority)({ ...input, configuration: config });
    await proof.check();
    memory();
    const stream = input.stream ?? process.stdin;
    if ((stream as Readable & { isTTY?: boolean }).isTTY) throw Error('private_recovery_pipe_required');
    recovery = await (controls.readRecovery ?? readVaultRecoveryKey)(stream, { assertMemory: memory });
    await proof.check();
    memory();
    const header: VaultRootHeader = {
      contract: 'cos-vault-root-request/v1',
      configurationDigest: digest(config),
      identity: config.identity,
      scope: proof.scope,
      authority: { socket: proof.authority.socket, token: proof.authority.token },
    };
    const result = await (controls.invoke
      ? controls.invoke(header, recovery)
      : invokeRoot(config, header, recovery, memory));
    await proof.check();
    memory();
    if (!result || typeof result !== 'object' || Array.isArray(result)) throw Error('invalid_root_result');
    const receipt = result as Record<string, unknown>;
    if (
      Object.keys(receipt).sort().join(',') !==
        'artifactDigest,contract,identityDigest,sourceCommit,sourceTree,status,volumeBytes' ||
      receipt.contract !== 'cos-vault-root-result/v1' ||
      receipt.status !== 'ready' ||
      receipt.volumeBytes !== VAULT_BYTES ||
      receipt.identityDigest !== digest(config.identity) ||
      receipt.sourceCommit !== config.artifact.sourceCommit ||
      receipt.sourceTree !== config.artifact.sourceTree ||
      receipt.artifactDigest !== config.artifact.digest
    )
      throw Error('root_result_binding_conflict');
    recovery.fill(0);
    await (
      controls.configureStorage ??
      ((roots, vaultRoot) => {
        configureVaultStorage(roots, vaultRoot);
      })
    )(
      {
        targetRoot: config.owner.targetRoot,
        installationRoot: config.target.binding.installationRoot,
        dataRoot: config.target.binding.dataRoot,
      },
      '/var/lib/nanoclaw-cos/vault',
    );
    await proof.check();
    memory();
    verified = Object.freeze({ ...receipt });
    // eslint-disable-next-line no-catch-all/no-catch-all -- Retain only failure status while clearing bytes and closing the private authority below.
  } catch {
    failed = true;
  } finally {
    recovery?.fill(0);
    try {
      await proof?.authority.close();
      // eslint-disable-next-line no-catch-all/no-catch-all -- A failed private cleanup denies the receipt without exposing the path or overriding an earlier failure.
    } catch {
      failed = true;
    }
  }
  if (failed || !verified) throw Error('vault_owner_provision_unavailable');
  return verified;
}
