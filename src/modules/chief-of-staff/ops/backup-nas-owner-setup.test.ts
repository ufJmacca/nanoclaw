import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasMountService } from './backup-nas-units.js';
import { backupNasSetupScope, type BackupNasSetupRequest } from './backup-nas-setup-wire.js';
import {
  backupNasSetupInvocation,
  parseBackupNasConfigureArguments,
  runBackupNasConfigureAdmin,
  type BackupNasConfigureInput,
  type BackupNasConfigureControls,
} from './backup-nas-owner-setup.js';
const args = () => ({
  command: 'backup-nas-configure' as const,
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
function fixture(
  selectedRoot = os.homedir() + '/.config/nanoclaw-cos/state',
  slice: 'G02' | 'G03' | 'G04' | 'G05' | 'G06' = 'G02',
) {
  const selected = args(),
    release = fixtureVaultRelease(slice),
    root = selectedRoot,
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
  const input: BackupNasConfigureInput = {
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
    readTarget = vi.fn<NonNullable<BackupNasConfigureControls['readTarget']>>(() => target),
    memory = vi.fn(),
    openAuthority = vi.fn<NonNullable<BackupNasConfigureControls['openAuthority']>>(async () => proof);
  const invoke = vi.fn(
    async (config: typeof vault, request: BackupNasSetupRequest, check: () => Promise<void>): Promise<unknown> => {
      await check();
      return {
        contract: 'cos-backup-nas-setup-result/v1',
        status: 'configured',
        configurationDigest: digest(config),
        nasDigest: digest(request.nas),
        artifactDigest: config.artifact.digest,
        unitDigest: createHash('sha256')
          .update(backupNasMountService({ artifactDigest: config.artifact.digest }).contents)
          .digest('hex'),
        scopeDigest: digest(request.scope),
      };
    },
  );
  const publishSelection = vi.fn<NonNullable<BackupNasConfigureControls['publishSelection']>>(async () => {});
  const controls: BackupNasConfigureControls = {
    assertMemory: memory,
    readConfiguration,
    readTarget,
    openAuthority,
    invoke,
  };
  Object.assign(controls, { publishSelection });
  return {
    vault,
    nas,
    input,
    proof,
    controls,
    readConfiguration,
    readTarget,
    memory,
    openAuthority,
    invoke,
    publishSelection,
  };
}
it('publishes the configured NAS selection only after the exact root installation receipt is verified', async () => {
  const f = fixture();
  expect((await runBackupNasConfigureAdmin(f.input, f.controls)).status).toBe('configured');
  expect(f.publishSelection).toHaveBeenCalledOnce();
  expect(f.publishSelection.mock.calls[0]?.[0]).toEqual({
    contract: 'cos-backup-nas-selection/v1',
    targetDigest: f.vault.identity.targetDigest,
    nas: f.nas,
  });
  const denied = fixture();
  denied.invoke.mockResolvedValue({ status: 'configured' });
  await expect(runBackupNasConfigureAdmin(denied.input, denied.controls)).rejects.toThrow(
    'backup_nas_owner_setup_unavailable',
  );
  expect(denied.publishSelection).not.toHaveBeenCalled();
});
it('the owner setup command publishes through the default filesystem boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.cos-nas-setup-'));
  fs.chmodSync(root, 0o700);
  try {
    const f = fixture(root);
    delete f.controls.publishSelection;
    expect((await runBackupNasConfigureAdmin(f.input, f.controls)).status).toBe('configured');
    const file = path.join(root, 'backup-nas-selection.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      contract: 'cos-backup-nas-selection/v1',
      targetDigest: f.vault.identity.targetDigest,
      nas: f.nas,
    });
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
it('parses NAS metadata while rejecting destination, command and credential-value selectors', () => {
  const a = args();
  expect(parseBackupNasConfigureArguments(cli(a))).toEqual(a);
  for (const host of ['10.1.2.3', '172.16.1.1', '192.168.0.6'])
    expect(parseBackupNasConfigureArguments(cli({ ...a, host })).host).toBe(host);
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
  expect(() => parseBackupNasConfigureArguments(values)).toThrow(/^invalid_admin_arguments$/);
});
it.each(['G02', 'G03', 'G04', 'G05', 'G06'] as const)(
  '%s uses a fresh live setup proof and verifies the exact source-bound root receipt while preserving the accepted owner configuration',
  async (slice) => {
    const f = fixture(undefined, slice),
      before = digest(f.vault),
      result = await runBackupNasConfigureAdmin(f.input, f.controls);
    expect(result.status).toBe('configured');
    expect(digest(f.vault)).toBe(before);
    expect(f.openAuthority).toHaveBeenCalledOnce();
    const selected = f.openAuthority.mock.calls[0]![0];
    expect(selected.operationId).toBe(f.input.args.requestId);
    expect(selected.configuration.identity).toEqual(f.vault.identity);
    expect(selected.nas).toEqual(f.nas);
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(f.proof.authority.token);
    expect(JSON.stringify(result)).not.toContain(f.nas.host);
  },
);
it('selects only the installed sealed helper with core/swap limits and a minimal environment', async () => {
  const f = fixture();
  await runBackupNasConfigureAdmin(f.input, f.controls);
  const request = f.invoke.mock.calls[0]![1],
    invocation = backupNasSetupInvocation(f.vault, request),
    root = '/opt/nanoclaw-cos/vault/' + f.vault.artifact.digest;
  expect(invocation.tool).toBe('/usr/bin/sudo');
  expect(invocation.args.slice(-3)).toEqual([root + '/node', root + '/gateway.mjs', '--backup-configure']);
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
  if (reason === 'root-receipt') f.invoke.mockResolvedValue({ status: 'configured' });
  if (reason === 'lost-proof') f.proof.check.mockRejectedValue(Error('PRIVATE_PROOF'));
  if (reason === 'cleanup') f.proof.authority.close.mockRejectedValue(Error('PRIVATE_SOCKET'));
  await expect(runBackupNasConfigureAdmin(f.input, f.controls)).rejects.toThrow(/^backup_nas_owner_setup_unavailable$/);
  if (!['root-receipt', 'lost-proof', 'cleanup'].includes(reason)) expect(f.invoke).not.toHaveBeenCalled();
  if (['proof-scope', 'root-receipt', 'lost-proof', 'cleanup'].includes(reason))
    expect(f.proof.authority.close).toHaveBeenCalledOnce();
  if (['root-receipt', 'cleanup'].includes(reason)) expect(f.invoke).toHaveBeenCalledOnce();
});
it('denies an owner configuration change across the root invocation and closes the permission before returning', async () => {
  const f = fixture();
  f.invoke.mockImplementation(async () => {
    f.readConfiguration.mockReturnValue({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } });
    return { status: 'configured' };
  });
  await expect(runBackupNasConfigureAdmin(f.input, f.controls)).rejects.toThrow(/^backup_nas_owner_setup_unavailable$/);
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
      expect((await runBackupNasConfigureAdmin(f.input, controls)).status).toBe('configured');
      expect(fs.lstatSync(file).ino).toBe(before);
    } else
      await expect(runBackupNasConfigureAdmin(f.input, controls)).rejects.toThrow(
        /^backup_nas_owner_setup_unavailable$/,
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
  await expect(runBackupNasConfigureAdmin(f.input, f.controls)).rejects.toThrow(/^backup_nas_owner_setup_unavailable$/);
  expect(f.invoke).toHaveBeenCalledOnce();
});
