import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  parseBackupNasInitializationRecoverArguments,
  runBackupNasInitializationRecoverAdmin,
  type BackupNasInitializationRecoverInput,
  type BackupNasInitializationRecoverControls,
} from './backup-nas-owner-setup.js';
import { backupNasInitializationRecoveryScope } from './backup-nas-initialization-recovery-scope.js';
import type { BackupNasInitializationRecoveryRequest } from './backup-nas-initialization-recovery-wire.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const args = () => ({
  command: 'backup-nas-recover-initialization' as const,
  scopeId: 'fixture',
  requestId: randomUUID(),
  host: '192.168.56.12',
  credentialReference: randomUUID(),
});
const cli = (a: BackupNasInitializationRecoverInput['args']) => [
  a.command,
  '--scope',
  a.scopeId,
  '--request-id',
  a.requestId,
  '--host',
  a.host,
  '--credential-reference',
  a.credentialReference,
];
function fixture() {
  const selected = args(),
    release = fixtureVaultRelease('G02'),
    root = fs.mkdtempSync(path.join(os.homedir(), '.cos-init-recovery-test-')),
    nonce = randomUUID(),
    binding = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: '/home/fixture/app',
      dataRoot: '/home/fixture/app/data',
    };
  roots.push(root);
  fs.chmodSync(root, 0o700);
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
    owner: { uid: process.getuid!(), gid: process.getgid!(), home: os.homedir(), targetRoot: root },
    artifact: {
      sourceCommit: release.source.commit,
      sourceTree: release.source.tree,
      digest: release.vaultArtifact!.digest,
    },
  });
  const target = {
      version: 1 as const,
      lifecycle: 'protected' as const,
      releaseId: release.releaseId,
      generation: 4,
      maintenance: true,
      maintenanceId: nonce,
      binding,
    },
    nas = {
      contract: 'cos-backup-nas-root-config/v1' as const,
      host: selected.host,
      credentialReference: selected.credentialReference,
      vaultStateDigest: vaultRootStateDigest(vault),
    };
  const proof = {
    scope: backupNasSetupScope(vault, nas, selected.requestId, 4),
    authority: {
      socket: '/home/fixture/private/proof.sock',
      token: 'f'.repeat(64),
      close: vi.fn(async () => {}),
    },
    check: vi.fn(async () => {}),
  };
  const input: BackupNasInitializationRecoverInput = {
    root,
    args: selected,
    target,
    release,
    maintenance: { owner: 'operations-' + selected.requestId, nonce, purpose: 'deployment', generation: 4 },
    native: {} as never,
    hostLease: {} as never,
    check: vi.fn(async () => {}),
  };
  const readConfiguration = vi.fn(() => vault),
    readTarget = vi.fn<NonNullable<BackupNasInitializationRecoverControls['readTarget']>>(() => target),
    memory = vi.fn(),
    openAuthority = vi.fn<NonNullable<BackupNasInitializationRecoverControls['openAuthority']>>(async () => proof);
  const invoke = vi.fn(
    async (config: typeof vault, request: BackupNasSetupRequest, check: () => Promise<void>): Promise<unknown> => {
      await check();
      return {
        contract: 'cos-backup-nas-initialization-inspection-result/v1',
        status: 'observed',
        configurationDigest: digest(config),
        nasDigest: digest(request.nas),
        artifactDigest: config.artifact.digest,
        resource: { kind: 'closed-underlay', device: 17, inode: 23 },
        scopeDigest: digest(request.scope),
      };
    },
  );
  const resource = { kind: 'closed-underlay' as const, device: 17, inode: 23 };
  const recoveryProof = {
    scope: backupNasInitializationRecoveryScope(vault, nas, resource, selected.requestId, 4),
    authority: { socket: '/home/fixture/private/resource.sock', token: 'e'.repeat(64), close: vi.fn(async () => {}) },
    check: vi.fn(async () => {}),
  };
  const openRecoveryAuthority = vi.fn<NonNullable<BackupNasInitializationRecoverControls['openRecoveryAuthority']>>(
    async (selected) => {
      recoveryProof.scope = backupNasInitializationRecoveryScope(
        selected.configuration,
        selected.nas,
        selected.resource,
        selected.operationId,
        selected.maintenance.generation,
      );
      return recoveryProof;
    },
  );
  const invokeRecovery = vi.fn(
    async (
      config: typeof vault,
      request: BackupNasInitializationRecoveryRequest,
      check: () => Promise<void>,
    ): Promise<unknown> => {
      await check();
      return {
        contract: 'cos-backup-nas-initialization-recovery-result/v1',
        status: 'retired',
        configurationDigest: digest(config),
        nasDigest: digest(request.nas),
        artifactDigest: config.artifact.digest,
        scopeDigest: digest(request.scope),
        vaultStateDigest: vaultRootStateDigest(config),
        resourceDigest: digest(request.resource),
      };
    },
  );
  const controls: BackupNasInitializationRecoverControls = {
    assertMemory: memory,
    readConfiguration,
    readTarget,
    openAuthority,
    invoke,
    openRecoveryAuthority,
    invokeRecovery,
  };
  return {
    vault,
    nas,
    input,
    proof,
    recoveryProof,
    controls,
    readConfiguration,
    readTarget,
    memory,
    openAuthority,
    invoke,
    openRecoveryAuthority,
    invokeRecovery,
  };
}

function progress(f: ReturnType<typeof fixture>) {
  const file = fs.readdirSync(f.input.root).find((name) => name.startsWith('nas-initialization-progress.'));
  return file ? JSON.parse(fs.readFileSync(path.join(f.input.root, file), 'utf8')) : null;
}
it('parses only fixed destination metadata, with no resource or path selector', () => {
  const f = fixture();
  expect(parseBackupNasInitializationRecoverArguments(cli(f.input.args))).toEqual(f.input.args);
  expect(() => parseBackupNasInitializationRecoverArguments([...cli(f.input.args), '--inode', '23'])).toThrow(
    /^invalid_admin_arguments$/,
  );
});
it('durably captures the verified observation, closes setup permission, and opens fresh exact resource permission', async () => {
  const f = fixture(),
    original = f.openRecoveryAuthority.getMockImplementation()!;
  f.openRecoveryAuthority.mockImplementation(async (input) => {
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
    expect(progress(f).resource).toEqual(input.resource);
    expect(progress(f).phase).toBe('observed');
    return original(input);
  });
  const result = await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  expect(result.status).toBe('retired');
  expect(Object.keys(result).length).toBe(8);
  expect(progress(f).phase).toBe('retired');
  expect(f.recoveryProof.authority.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(f.nas.host);
  expect(JSON.stringify(progress(f))).not.toContain(f.proof.authority.token);
});
it('retries from durable observed metadata after removal without requiring a new root observation', async () => {
  const f = fixture(),
    original = f.invokeRecovery.getMockImplementation()!;
  f.invokeRecovery.mockRejectedValueOnce(Error('lost_ack_after_removal'));
  await expect(runBackupNasInitializationRecoverAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_initialization_recovery_unavailable$/,
  );
  expect(progress(f).phase).toBe('observed');
  f.invoke.mockRejectedValue(Error('resource_already_absent'));
  f.input.args.requestId = randomUUID();
  f.input.maintenance.owner = 'operations-' + f.input.args.requestId;
  const result = await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  expect(result.status).toBe('retired');
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.openAuthority).toHaveBeenCalledOnce();
  expect(f.openRecoveryAuthority).toHaveBeenCalledTimes(2);
  expect(f.invokeRecovery).toHaveBeenCalledTimes(2);
  expect(f.invokeRecovery.mock.calls[1][1].resource.inode).toBe(23);
  expect(f.invokeRecovery.mock.calls[1][1].scope.operationId).toBe(f.input.args.requestId);
  expect(original).toBeDefined();
});
it('reconciles a completed progress record after a lost owner acknowledgement under fresh permission', async () => {
  const f = fixture();
  await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  f.invoke.mockRejectedValue(Error('absent'));
  expect((await runBackupNasInitializationRecoverAdmin(f.input, f.controls)).status).toBe('retired');
  expect(f.openRecoveryAuthority).toHaveBeenCalledTimes(2);
  expect(progress(f).resource.inode).toBe(23);
});
it.each(['close', 'receipt'])('does not use completed metadata to bypass an inspection %s failure', async (reason) => {
  const f = fixture();
  await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  if (reason === 'close') f.proof.authority.close.mockRejectedValue(Error('failed_close'));
  else f.invoke.mockResolvedValue({ status: 'observed' });
  await expect(runBackupNasInitializationRecoverAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_initialization_recovery_unavailable$/,
  );
  expect(f.openRecoveryAuthority).toHaveBeenCalledOnce();
});
it('admits a subsequent freshly verified resource only after the previous one completed', async () => {
  const f = fixture();
  await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  const original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (...args) => ({
    ...((await original(...args)) as Record<string, unknown>),
    resource: { kind: 'closed-underlay', device: 17, inode: 24 },
  }));
  await runBackupNasInitializationRecoverAdmin(f.input, f.controls);
  expect(progress(f).resource.inode).toBe(24);
  expect(f.invokeRecovery.mock.calls[1][1].resource.inode).toBe(24);
});
it.each(['extra', 'symbol', 'configuration', 'resource', 'scope'])(
  'denies %s recovery receipts and retains retry metadata',
  async (reason) => {
    const f = fixture(),
      original = f.invokeRecovery.getMockImplementation()!;
    f.invokeRecovery.mockImplementation(async (...args) => {
      const result = (await original(...args)) as Record<PropertyKey, unknown>;
      if (reason === 'extra') result.path = '/tmp/foreign';
      if (reason === 'symbol') result[Symbol('path')] = 'foreign';
      if (reason === 'configuration') result.configurationDigest = 'd'.repeat(64);
      if (reason === 'resource') result.resourceDigest = 'd'.repeat(64);
      if (reason === 'scope') result.scopeDigest = 'd'.repeat(64);
      return result;
    });
    await expect(runBackupNasInitializationRecoverAdmin(f.input, f.controls)).rejects.toThrow(
      /^backup_nas_owner_initialization_recovery_unavailable$/,
    );
    expect(progress(f).phase).toBe('observed');
    expect(f.recoveryProof.authority.close).toHaveBeenCalledOnce();
  },
);
it.each([
  'setup-close',
  'setup-revoked',
  'recovery-scope',
  'recovery-revoked',
  'recovery-close',
  'owner-change',
  'progress-change',
])('denies %s before an owner acknowledgement', async (reason) => {
  const f = fixture();
  if (reason === 'setup-close') f.proof.authority.close.mockRejectedValue(Error('close'));
  if (reason === 'setup-revoked') f.proof.check.mockRejectedValue(Error('revoked'));
  if (reason === 'recovery-scope')
    f.openRecoveryAuthority.mockImplementation(async () => ({ ...f.recoveryProof, scope: f.proof.scope }));
  if (reason === 'recovery-revoked') f.recoveryProof.check.mockRejectedValue(Error('revoked'));
  if (reason === 'recovery-close') f.recoveryProof.authority.close.mockRejectedValue(Error('close'));
  if (reason === 'owner-change')
    f.proof.authority.close.mockImplementation(async () => {
      f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
    });
  if (reason === 'progress-change')
    f.openRecoveryAuthority.mockImplementation(async () => {
      const file = fs.readdirSync(f.input.root).find((name) => name.startsWith('nas-initialization-progress.'))!;
      fs.writeFileSync(path.join(f.input.root, file), 'foreign');
      return f.recoveryProof;
    });
  await expect(runBackupNasInitializationRecoverAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_initialization_recovery_unavailable$/,
  );
  if (['setup-close', 'setup-revoked', 'owner-change'].includes(reason))
    expect(f.invokeRecovery).not.toHaveBeenCalled();
  if (reason === 'recovery-close') expect(progress(f).phase).toBe('observed');
});
it('denies a malformed root observation before storing metadata or opening resource permission', async () => {
  const f = fixture();
  f.invoke.mockResolvedValue({ status: 'observed', resource: { kind: 'closed-underlay', device: 17, inode: 23 } });
  await expect(runBackupNasInitializationRecoverAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_initialization_recovery_unavailable$/,
  );
  expect(progress(f)).toBeNull();
  expect(f.openRecoveryAuthority).not.toHaveBeenCalled();
});
it.each(['preserve', 'replace'])(
  'holds actual owner configuration through both proof lifetimes: %s',
  async (action) => {
    const f = fixture(),
      file = path.join(f.input.root, 'vault-owner.json'),
      bytes = JSON.stringify(f.vault);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const inode = fs.statSync(file).ino;
    const controls = { ...f.controls };
    delete controls.readConfiguration;
    if (action === 'replace')
      f.recoveryProof.authority.close.mockImplementation(async () => {
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, bytes, { mode: 0o600 });
      });
    if (action === 'preserve') {
      expect((await runBackupNasInitializationRecoverAdmin(f.input, controls)).status).toBe('retired');
      expect(fs.statSync(file).ino).toBe(inode);
    } else
      await expect(runBackupNasInitializationRecoverAdmin(f.input, controls)).rejects.toThrow(
        /^backup_nas_owner_initialization_recovery_unavailable$/,
      );
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
    expect(f.recoveryProof.authority.close).toHaveBeenCalledOnce();
  },
);
