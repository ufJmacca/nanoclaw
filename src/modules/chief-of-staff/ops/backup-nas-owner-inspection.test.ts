import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  parseBackupNasInspectArguments,
  runBackupNasInspectAdmin,
  type BackupNasInspectInput,
  type BackupNasInspectControls,
} from './backup-nas-owner-setup.js';
import { backupNasInspectionInvocation } from './backup-nas-inspection-process.js';
const args = () => ({
  command: 'backup-nas-inspect-initialization' as const,
  scopeId: 'fixture',
  requestId: randomUUID(),
  host: '192.168.56.12',
  credentialReference: randomUUID(),
});
const cli = (a: ReturnType<typeof args>) => [
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
    root = os.homedir() + '/.config/nanoclaw-cos/state',
    nonce = randomUUID(),
    binding = {
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
  const input: BackupNasInspectInput = {
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
    readTarget = vi.fn<NonNullable<BackupNasInspectControls['readTarget']>>(() => target),
    memory = vi.fn(),
    openAuthority = vi.fn<NonNullable<BackupNasInspectControls['openAuthority']>>(async () => proof);
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
  const controls: BackupNasInspectControls = {
    assertMemory: memory,
    readConfiguration,
    readTarget,
    openAuthority,
    invoke,
  };
  return { vault, nas, input, proof, controls, readConfiguration, readTarget, memory, openAuthority, invoke };
}
it('parses NAS metadata while rejecting destination, command and credential-value selectors', () => {
  const a = args();
  expect(parseBackupNasInspectArguments(cli(a))).toEqual(a);
  for (const host of ['10.1.2.3', '172.16.1.1', '192.168.0.6'])
    expect(parseBackupNasInspectArguments(cli({ ...a, host })).host).toBe(host);
});
it.each([
  'extra',
  'duplicate',
  'password',
  'public-host',
  'multicast',
  'ipv6',
  'hostname',
  'reference',
  'operation',
  'scope',
])('refuses %s admin arguments', (reason) => {
  const a = args(),
    values = cli(a);
  if (reason === 'extra') values.push('--mount', '/tmp/foreign');
  if (reason === 'duplicate') values[7] = '--host';
  if (reason === 'password') values[7] = '--password';
  if (reason === 'public-host') values[6] = '8.8.8.8';
  if (reason === 'multicast') values[6] = '224.0.0.1';
  if (reason === 'ipv6') values[6] = '::1';
  if (reason === 'hostname') values[6] = 'nas.local';
  if (reason === 'reference') values[8] = 'PRIVATE_SECRET';
  if (reason === 'operation') values[4] = 'old-receipt';
  if (reason === 'scope') values[2] = '../foreign';
  expect(() => parseBackupNasInspectArguments(values)).toThrow(/^invalid_admin_arguments$/);
});
it('uses a fresh live setup proof and verifies the exact source-bound root receipt while preserving the accepted owner configuration', async () => {
  const f = fixture(),
    before = digest(f.vault),
    result = await runBackupNasInspectAdmin(f.input, f.controls);
  expect(result.status).toBe('observed');
  expect(digest(f.vault)).toBe(before);
  expect(f.openAuthority).toHaveBeenCalledOnce();
  const selected = f.openAuthority.mock.calls[0]![0];
  expect(selected.operationId).toBe(f.input.args.requestId);
  expect(selected.configuration.identity).toEqual(f.vault.identity);
  expect(selected.nas).toEqual(f.nas);
  expect(f.proof.authority.close).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain(f.proof.authority.token);
  expect(JSON.stringify(result)).not.toContain(f.nas.host);
});
it('selects only the installed sealed helper with core/swap limits and a minimal environment', async () => {
  const f = fixture();
  await runBackupNasInspectAdmin(f.input, f.controls);
  const request = f.invoke.mock.calls[0]![1],
    invocation = backupNasInspectionInvocation(f.vault, request),
    root = '/opt/nanoclaw-cos/vault/' + f.vault.artifact.digest;
  expect(invocation.tool).toBe('/usr/bin/sudo');
  expect(invocation.args.slice(-3)).toEqual([root + '/node', root + '/gateway.mjs', '--backup-inspect-initialization']);
  for (const setting of [
    '--property=LimitCORE=0',
    '--property=MemorySwapMax=0',
    '--property=RuntimeMaxSec=90',
    '--property=KillMode=control-group',
  ])
    expect(invocation.args).toContain(setting);
  expect(Object.keys(invocation.env).sort()).toEqual(['LANG', 'LC_ALL', 'PATH']);
  expect(invocation.args.join(' ')).not.toContain(request.authority.token);
});
it.each([
  'memory',
  'foreign-owner',
  'private-boundary',
  'operation',
  'release-slice',
  'backup-gate',
  'lifecycle',
  'target-release',
  'target-binding',
  'artifact',
  'proof-scope',
  'root-receipt',
  'lost-proof',
  'cleanup',
])('denies %s without acknowledging NAS installation', async (reason) => {
  const f = fixture();
  if (reason === 'memory')
    f.memory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'foreign-owner')
    f.readConfiguration.mockReturnValue({ ...f.vault, owner: { ...f.vault.owner, uid: f.vault.owner.uid + 1 } });
  if (reason === 'private-boundary')
    f.input.check = async () => {
      throw Error('PRIVATE_OWNER');
    };
  if (reason === 'operation') f.input.maintenance = { ...f.input.maintenance, owner: 'operations-' + randomUUID() };
  if (reason === 'release-slice') f.input.release = fixtureVaultRelease('G01');
  if (reason === 'backup-gate') delete f.input.release.checks.backup_mount;
  if (reason === 'lifecycle')
    f.readTarget.mockReturnValue({ ...f.input.target, lifecycle: 'implementation_disposable' });
  if (reason === 'target-release') f.readTarget.mockReturnValue({ ...f.input.target, releaseId: 'release-foreign' });
  if (reason === 'target-binding')
    f.readTarget.mockReturnValue({
      ...f.input.target,
      binding: { ...f.input.target.binding, databaseFingerprint: '0'.repeat(64) },
    });
  if (reason === 'artifact')
    f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '0'.repeat(64) } });
  if (reason === 'proof-scope') f.proof.scope = { ...f.proof.scope, targetDigest: f.vault.identity.targetDigest };
  if (reason === 'root-receipt') f.invoke.mockResolvedValue({ status: 'observed' });
  if (reason === 'lost-proof') f.proof.check.mockRejectedValue(Error('PRIVATE_PROOF'));
  if (reason === 'cleanup') f.proof.authority.close.mockRejectedValue(Error('PRIVATE_SOCKET'));
  await expect(runBackupNasInspectAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_inspection_unavailable$/,
  );
  if (!['root-receipt', 'lost-proof', 'cleanup'].includes(reason)) expect(f.invoke).not.toHaveBeenCalled();
  if (['proof-scope', 'root-receipt', 'lost-proof', 'cleanup'].includes(reason))
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
  if (['root-receipt', 'cleanup'].includes(reason)) expect(f.invoke).toHaveBeenCalledOnce();
});
it('denies an owner configuration change across the root invocation and closes the permission before returning', async () => {
  const f = fixture();
  f.invoke.mockImplementation(async () => {
    f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
    return { status: 'observed' };
  });
  await expect(runBackupNasInspectAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_inspection_unavailable$/,
  );
  expect(f.invoke).toHaveBeenCalledOnce();
  expect(f.proof.authority.close).toHaveBeenCalledOnce();
});
it.each(['preserve', 'replace'])('keeps actual owner configuration descriptors current through %s', async (action) => {
  const f = fixture(),
    root = fs.mkdtempSync(path.join(os.homedir(), '.nas-setup-test-'));
  fs.chmodSync(root, 0o700);
  try {
    const vault = vaultRootConfiguration({ ...f.vault, owner: { ...f.vault.owner, targetRoot: root } }),
      file = root + '/vault-owner.json',
      bytes = JSON.stringify(vault);
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const before = fs.lstatSync(file).ino;
    const nas = { ...f.nas, vaultStateDigest: vaultRootStateDigest(vault) };
    f.input.root = root;
    f.proof.scope = backupNasSetupScope(vault, nas, f.input.args.requestId, f.input.maintenance.generation);
    const controls = { ...f.controls };
    delete controls.readConfiguration;
    if (action === 'replace') {
      const original = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation(async (...args) => {
        const result = await original(...args);
        fs.renameSync(file, file + '.old');
        fs.writeFileSync(file, bytes, { mode: 0o600 });
        return result;
      });
    }
    if (action === 'preserve') {
      expect((await runBackupNasInspectAdmin(f.input, controls)).status).toBe('observed');
      expect(fs.lstatSync(file).ino).toBe(before);
    } else
      await expect(runBackupNasInspectAdmin(f.input, controls)).rejects.toThrow(
        /^backup_nas_owner_inspection_unavailable$/,
      );
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect(f.invoke).toHaveBeenCalledOnce();
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('denies changed owner metadata during final private-permission cleanup', async () => {
  const f = fixture();
  f.proof.authority.close.mockImplementation(async () => {
    f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
  });
  await expect(runBackupNasInspectAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_inspection_unavailable$/,
  );
  expect(f.invoke).toHaveBeenCalledOnce();
});

it.each([
  { kind: 'closed-underlay', device: 17, inode: 0 },
  { kind: 'closed-underlay', device: 17, inode: 23, path: '/tmp' },
  { kind: 'service-stage', device: 17, inode: 23 },
  { kind: 'closed-underlay', device: 17, inode: 23, token: 'PRIVATE_SELECTOR' },
])('denies invalid observed resource $kind before returning the root observation', async (resource) => {
  const f = fixture(),
    original = f.invoke.getMockImplementation()!;
  f.invoke.mockImplementation(async (...args) => ({
    ...((await original(...args)) as Record<string, unknown>),
    resource,
  }));
  await expect(runBackupNasInspectAdmin(f.input, f.controls)).rejects.toThrow(
    /^backup_nas_owner_inspection_unavailable$/,
  );
  expect(f.proof.authority.close).toHaveBeenCalledOnce();
});
