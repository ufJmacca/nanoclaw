import os from 'node:os';
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import { executeBackupNasSetup } from './backup-nas-setup-process.js';
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
    request = {
      contract: 'cos-backup-nas-setup-request/v1' as const,
      configurationDigest: digest(vault),
      nas,
      scope: backupNasSetupScope(vault, nas, randomUUID(), 4),
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
  const invoke = () => executeBackupNasSetup(vault, request, check, controls);
  return { request, check, controls, invoke, child: () => child, closed: () => closed };
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
  expect(args.at(-1)).toBe('--backup-configure');
  expect(options.detached).toBe(true);
  expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore']);
  expect(f.check.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it('terminates a stalled owned process group that ignores TERM and awaits actual close before releasing setup', async () => {
  const f = fixture('process.stdin.resume();process.on("SIGTERM",()=>{});setInterval(()=>{},10);');
  f.controls.deadlineMs = 100;
  await expect(f.invoke()).rejects.toThrow(/^backup_nas_setup_process_unavailable$/);
  expect(f.closed()).toBe(true);
  expect(f.controls.stopUnit).toHaveBeenCalledOnce();
  expect(f.controls.stopUnit.mock.calls[0]![0]).toMatch(/^nanoclaw-cos-backup-setup-/);
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
    await expect(f.invoke()).rejects.toThrow(/^backup_nas_setup_process_unavailable$/);
    expect(f.closed()).toBe(true);
  },
);
