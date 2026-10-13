import os from 'node:os';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasInitializationRecoveryScope } from './backup-nas-initialization-recovery-wire.js';
import { executeBackupNasInitializationRecovery } from './backup-nas-initialization-recovery-process.js';
function fixture(code = '') {
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: process.getuid!(), gid: process.getgid!(), home: os.homedir(), targetRoot: os.homedir() + '/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const nas = {
      contract: 'cos-backup-nas-root-config/v1' as const,
      host: '192.168.56.12',
      credentialReference: randomUUID(),
      vaultStateDigest: vaultRootStateDigest(vault),
    },
    resource = { kind: 'closed-underlay' as const, device: 17, inode: 23 },
    request = {
      contract: 'cos-backup-nas-recover-initialization-request/v1' as const,
      configurationDigest: digest(vault),
      nas,
      resource,
      scope: backupNasInitializationRecoveryScope(vault, nas, resource, randomUUID(), 4),
      authority: { socket: '/home/fixture/proof.sock', token: 'f'.repeat(64) },
    };
  let child: ChildProcess | undefined,
    closed = false;
  const spawnRoot = vi.fn((_command: string, _args: string[], options: SpawnOptions) => {
    child = spawn(process.execPath, ['-e', code], options);
    child.once('close', () => {
      closed = true;
    });
    return child;
  });
  const check = vi.fn(async () => {}),
    controls = {
      assertMemory: vi.fn(),
      spawnRoot,
      stopUnit: vi.fn<(unit: string) => boolean>(() => true),
      deadlineMs: 500,
    };
  const invoke = () => executeBackupNasInitializationRecovery(vault, request, check, controls);
  return { vault, request, check, controls, invoke, child: () => child, closed: () => closed };
}
it('returns only one reply after the actual owned child closes and fresh owner checks pass', async () => {
  const f = fixture(
    'process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write("{\\"status\\":\\"fixture\\"}\\n");});',
  );
  expect(await f.invoke()).toEqual({ status: 'fixture' });
  expect(f.closed()).toBe(true);
  expect(f.controls.stopUnit).not.toHaveBeenCalled();
  const [command, args, options] = f.controls.spawnRoot.mock.calls[0]!;
  expect(command).toBe('/usr/bin/sudo');
  expect(args.at(-1)).toBe('--backup-recover-initialization');
  expect(options.detached).toBe(true);
  expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
  expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('terminates a stalled owned process group that ignores TERM and awaits actual close before releasing inspection', async () => {
  const f = fixture('process.stdin.resume();process.on("SIGTERM",()=>{});setInterval(()=>{},10);');
  f.controls.deadlineMs = 100;
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_process_unavailable$/);
  expect(f.closed()).toBe(true);
  expect(f.controls.stopUnit).toHaveBeenCalledOnce();
  expect(f.controls.stopUnit.mock.calls[0]![0]).toMatch(/^nanoclaw-cos-backup-initialization-/);
  expect(() => process.kill(f.child()!.pid!, 0)).toThrow();
});
it.each(['extra-reply', 'failed-child', 'owner-revoked', 'stop-failed'])(
  'denies %s, redacts nested errors and awaits owned-process closure',
  async (reason) => {
    const code =
      reason === 'extra-reply'
        ? 'process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write("{}\\n{}\\n");});process.on("SIGTERM",()=>{});setInterval(()=>{},10);'
        : reason === 'stop-failed'
          ? 'process.stdin.resume();process.on("SIGTERM",()=>{});setInterval(()=>{},10);'
          : 'process.stdin.resume();process.stdin.once("end",()=>{process.stdout.write("{}\\n");process.exitCode=' +
            (reason === 'failed-child' ? '1' : '0') +
            ';});';
    const f = fixture(code);
    if (reason === 'owner-revoked')
      f.check.mockImplementationOnce(async () => {}).mockRejectedValue(Error('PRIVATE_OWNER_PROOF'));
    if (reason === 'stop-failed') {
      f.controls.stopUnit.mockReturnValue(false);
      f.controls.deadlineMs = 100;
    }
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_initialization_process_unavailable$/);
    expect(f.closed()).toBe(true);
  },
);

it('refuses another permission purpose before starting any owned root process', async () => {
  const f = fixture();
  await expect(
    executeBackupNasInitializationRecovery(
      f.vault,
      { ...f.request, scope: { ...f.request.scope, targetDigest: f.vault.identity.targetDigest } },
      f.check,
      f.controls,
    ),
  ).rejects.toThrow(/^backup_nas_initialization_process_unavailable$/);
  expect(f.controls.spawnRoot).not.toHaveBeenCalled();
});
it('captures the exact resource before an owner admission await and keeps private framing out of arguments and environment', async () => {
  const f = fixture(
    'const parts=[];process.stdin.on("data",b=>parts.push(b));process.stdin.once("end",()=>{const b=Buffer.concat(parts),r=JSON.parse(b.subarray(4));if(b.readUInt32BE(0)!==b.length-4||r.contract!=="cos-backup-nas-recover-initialization-request/v1"||r.resource.inode!==23)process.exitCode=1;else process.stdout.write("{}\\n");});',
  );
  f.check.mockImplementationOnce(async () => {
    f.request.resource.inode = 777;
  });
  expect(await f.invoke()).toEqual({});
  const [, args, options] = f.controls.spawnRoot.mock.calls[0]!;
  for (const privateValue of [
    f.request.nas.host,
    f.request.authority.token,
    f.request.authority.socket,
    'closed-underlay',
  ])
    expect(JSON.stringify({ args, env: options.env })).not.toContain(privateValue);
  expect(f.closed()).toBe(true);
});
