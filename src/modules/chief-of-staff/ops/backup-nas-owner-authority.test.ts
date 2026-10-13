import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { acquireHostExecutionLease, releaseHostExecutionLease } from '../../../db/host-execution-lease.js';
import { initializeTarget, protectTarget, writeAtomic } from './target-state.js';
import { beginMaintenance, confirmQuiescence, finishMaintenance } from './maintenance.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { checkVaultAuthority } from './vault-authority.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import { backupNasInitializationRecoveryScope } from './backup-nas-initialization-recovery-scope.js';
import { backupNasRecoveryScope } from './backup-nas-recovery-wire.js';
import {
  openProtectedBackupNasSetupAuthority,
  openProtectedBackupNasRecoveryAuthority,
  openProtectedBackupNasInitializationRecoveryAuthority,
} from './backup-nas-owner-authority.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture(recovery: false | true | 'initialization' = false) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'bn-')),
    root = parent + '/s';
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  initializeTarget(root, binding);
  protectTarget(root, binding);
  const operationId = randomUUID(),
    maintenance = beginMaintenance(root, binding, 'operations-' + operationId, 'deployment');
  await confirmQuiescence(root, binding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  const native = new Database(':memory:');
  native.exec(
    'CREATE TABLE host_execution_lease (singleton_id INTEGER PRIMARY KEY, owner_id TEXT, pid INTEGER, acquired_at TEXT)',
  );
  const hostLease = acquireHostExecutionLease(native);
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
    target: { binding, lifecycle: 'protected', minimumGeneration: maintenance.generation },
    owner: { uid: process.getuid!(), gid: process.getgid!(), home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  let paused = true,
    quiescent = true,
    opened: Awaited<ReturnType<typeof openProtectedBackupNasSetupAuthority>> | undefined;
  const input = {
    root,
    resource: { kind: 'closed-underlay' as const, device: 17, inode: 23 },
    configuration: vault,
    nas,
    operationId,
    maintenance,
    native,
    hostLease,
    check: async () => {
      if (!paused || !quiescent) throw Error('PRIVATE_NATIVE_BOUNDARY');
    },
  };
  const controls = { ownerTargetRoot: root, assertMemory() {} },
    open = async () =>
      (opened = await (
        recovery === 'initialization'
          ? openProtectedBackupNasInitializationRecoveryAuthority
          : recovery
            ? openProtectedBackupNasRecoveryAuthority
            : openProtectedBackupNasSetupAuthority
      )(input, controls));
  cleanups.push(async () => {
    await opened?.authority.close();
    native.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return {
    root,
    binding,
    vault,
    nas,
    maintenance,
    native,
    hostLease,
    input,
    controls,
    open,
    unpause() {
      paused = false;
    },
    loseQuiescence() {
      quiescent = false;
    },
  };
}
it('grants fresh native recovery only for closing the configured NAS connection while preserving accepted vault identity', async () => {
  const f = await fixture(true),
    before = digest(f.vault),
    proof = await f.open();
  expect(proof.scope).toEqual(backupNasRecoveryScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation));
  await checkVaultAuthority(proof.authority, proof.scope, process.getuid!());
  await expect(
    checkVaultAuthority(
      proof.authority,
      backupNasSetupScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation),
      process.getuid!(),
    ),
  ).rejects.toThrow(/^vault_authority_unavailable$/);
  expect(digest(f.vault)).toBe(before);
  expect(JSON.stringify(proof)).not.toContain(proof.authority.token);
});
it('refuses to use an ordinary setup permission as fresh recovery authority', async () => {
  const f = await fixture(),
    proof = await f.open();
  await expect(
    checkVaultAuthority(
      proof.authority,
      backupNasRecoveryScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation),
      process.getuid!(),
    ),
  ).rejects.toThrow(/^vault_authority_unavailable$/);
});
it.each(['host-release', 'host-replacement', 'maintenance-release', 'unpaused', 'not-quiescent'])(
  'withdraws recovery permission after %s from the actual native owner boundary',
  async (reason) => {
    const f = await fixture(true),
      proof = await f.open();
    if (reason === 'host-release') releaseHostExecutionLease(f.native, f.hostLease);
    if (reason === 'host-replacement') f.native.prepare('UPDATE host_execution_lease SET owner_id=?').run(randomUUID());
    if (reason === 'maintenance-release') await finishMaintenance(f.root, f.binding, f.maintenance, async () => true);
    if (reason === 'unpaused') f.unpause();
    if (reason === 'not-quiescent') f.loseQuiescence();
    await expect(checkVaultAuthority(proof.authority, proof.scope, process.getuid!())).rejects.toThrow(
      /^vault_authority_unavailable$/,
    );
  },
);
it('grants only a live NAS-specific permission under actual native and protected maintenance leases without changing vault identity', async () => {
  const f = await fixture(),
    before = digest(f.vault),
    proof = await f.open();
  expect(process.getuid?.()).toBeGreaterThan(0);
  expect(proof.scope).toEqual(backupNasSetupScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation));
  expect(proof.scope.operationId).not.toBe(f.vault.authority.operationId);
  await checkVaultAuthority(proof.authority, proof.scope, process.getuid!());
  expect(digest(f.vault)).toBe(before);
  expect(JSON.stringify(proof)).not.toContain(proof.authority.token);
  await expect(
    checkVaultAuthority(
      proof.authority,
      { ...proof.scope, targetDigest: f.vault.identity.targetDigest },
      process.getuid!(),
    ),
  ).rejects.toThrow(/^vault_authority_unavailable$/);
  await expect(
    checkVaultAuthority(
      proof.authority,
      backupNasSetupScope(f.vault, { ...f.nas, host: '192.168.56.13' }, f.input.operationId, f.maintenance.generation),
      process.getuid!(),
    ),
  ).rejects.toThrow(/^vault_authority_unavailable$/);
});
it('opens a fresh operation after release without replaying the vault installation operation or rewriting its configuration', async () => {
  const f = await fixture(),
    first = await f.open();
  await first.authority.close();
  await finishMaintenance(f.root, f.binding, f.maintenance, async () => true);
  const operationId = randomUUID(),
    maintenance = beginMaintenance(f.root, f.binding, 'operations-' + operationId, 'deployment');
  await confirmQuiescence(f.root, f.binding, maintenance, async () => ({
    activeCoordinators: 0,
    activeDatabaseOperations: 0,
  }));
  f.input.operationId = operationId;
  f.input.maintenance = maintenance;
  const fresh = await f.open();
  await checkVaultAuthority(fresh.authority, fresh.scope, process.getuid!());
  expect(fresh.scope.operationId).toBe(operationId);
  expect(f.input.configuration).toBe(f.vault);
  await expect(checkVaultAuthority(fresh.authority, first.scope, process.getuid!())).rejects.toThrow(
    /^vault_authority_unavailable$/,
  );
});
it.each(['host-release', 'host-replacement', 'maintenance-release', 'unpaused', 'not-quiescent'])(
  'withdraws live setup permission after %s',
  async (reason) => {
    const f = await fixture(),
      proof = await f.open();
    if (reason === 'host-release') releaseHostExecutionLease(f.native, f.hostLease);
    if (reason === 'host-replacement') f.native.prepare('UPDATE host_execution_lease SET owner_id=?').run(randomUUID());
    if (reason === 'maintenance-release') await finishMaintenance(f.root, f.binding, f.maintenance, async () => true);
    if (reason === 'unpaused') f.unpause();
    if (reason === 'not-quiescent') f.loseQuiescence();
    await expect(checkVaultAuthority(proof.authority, proof.scope, process.getuid!())).rejects.toThrow(
      /^vault_authority_unavailable$/,
    );
  },
);
it.each(['operation', 'generation', 'purpose', 'foreign-owner', 'unprotected', 'unsafe-socket-parent', 'memory'])(
  'refuses initial %s without returning an owner capability',
  async (reason) => {
    const f = await fixture();
    if (reason === 'operation') f.input.operationId = randomUUID();
    if (reason === 'generation') f.input.maintenance = { ...f.maintenance, generation: f.maintenance.generation - 1 };
    if (reason === 'purpose') f.input.maintenance = { ...f.maintenance, purpose: 'runtime-disposable' };
    if (reason === 'foreign-owner') f.input.configuration = { ...f.vault, owner: { ...f.vault.owner, uid: 12345 } };
    if (reason === 'unprotected') {
      fs.unlinkSync(f.root + '/protected.json');
      const state = JSON.parse(fs.readFileSync(f.root + '/state.json', 'utf8'));
      state.lifecycle = 'implementation_disposable';
      writeAtomic(f.root, 'state.json', state);
    }
    if (reason === 'unsafe-socket-parent') {
      fs.mkdirSync(f.root + '/vault-authority', { mode: 0o755 });
      fs.chmodSync(f.root + '/vault-authority', 0o755);
    }
    if (reason === 'memory')
      f.controls.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    await expect(f.open()).rejects.toThrow(/^backup_nas_owner_authority_unavailable$/);
  },
);

it('grants only the observed initialization resource under fresh native owner authority', async () => {
  const f = await fixture('initialization'),
    before = digest(f.vault),
    proof = await f.open();
  expect(proof.scope).toEqual(
    backupNasInitializationRecoveryScope(
      f.vault,
      f.nas,
      f.input.resource,
      f.input.operationId,
      f.maintenance.generation,
    ),
  );
  await checkVaultAuthority(proof.authority, proof.scope, process.getuid!());
  for (const scope of [
    backupNasSetupScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation),
    backupNasRecoveryScope(f.vault, f.nas, f.input.operationId, f.maintenance.generation),
    backupNasInitializationRecoveryScope(
      f.vault,
      f.nas,
      { ...f.input.resource, inode: 24 },
      f.input.operationId,
      f.maintenance.generation,
    ),
  ])
    await expect(checkVaultAuthority(proof.authority, scope, process.getuid!())).rejects.toThrow(
      /^vault_authority_unavailable$/,
    );
  expect(digest(f.vault)).toBe(before);
  expect(JSON.stringify(proof)).not.toContain(proof.authority.token);
});
it.each(['host-release', 'host-replacement', 'maintenance-release', 'unpaused', 'not-quiescent'])(
  'withdraws resource recovery permission after %s',
  async (reason) => {
    const f = await fixture('initialization'),
      proof = await f.open();
    if (reason === 'host-release') releaseHostExecutionLease(f.native, f.hostLease);
    if (reason === 'host-replacement') f.native.prepare('UPDATE host_execution_lease SET owner_id=?').run(randomUUID());
    if (reason === 'maintenance-release') await finishMaintenance(f.root, f.binding, f.maintenance, async () => true);
    if (reason === 'unpaused') f.unpause();
    if (reason === 'not-quiescent') f.loseQuiescence();
    await expect(checkVaultAuthority(proof.authority, proof.scope, process.getuid!())).rejects.toThrow(
      /^vault_authority_unavailable$/,
    );
  },
);
it('cannot change the granted inode by mutating caller metadata after admission', async () => {
  const f = await fixture('initialization'),
    proof = await f.open(),
    scope = proof.scope;
  f.input.resource.inode = 24;
  expect(proof.scope).toBe(scope);
  await checkVaultAuthority(proof.authority, scope, process.getuid!());
  await expect(
    checkVaultAuthority(
      proof.authority,
      backupNasInitializationRecoveryScope(
        f.vault,
        f.nas,
        f.input.resource,
        f.input.operationId,
        f.maintenance.generation,
      ),
      process.getuid!(),
    ),
  ).rejects.toThrow(/^vault_authority_unavailable$/);
});
it('refuses invalid observed metadata without opening resource recovery permission', async () => {
  const f = await fixture('initialization');
  f.input.resource.inode = -1;
  await expect(f.open()).rejects.toThrow(/^backup_nas_owner_authority_unavailable$/);
  expect(fs.existsSync(f.root + '/vault-authority')).toBe(false);
});
