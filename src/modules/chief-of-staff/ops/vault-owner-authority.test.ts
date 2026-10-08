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
import { openProtectedVaultAuthority } from './vault-owner-authority.js';
import { checkVaultAuthority } from './vault-authority.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});
async function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'va-')),
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
  const config = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v1',
    identity: {
      operationId,
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: maintenance.generation },
    owner: { uid: process.getuid!(), gid: process.getgid!(), home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  let quiescent = true,
    paused = true;
  let opened: Awaited<ReturnType<typeof openProtectedVaultAuthority>> | undefined;
  const options = {
    root,
    configuration: config,
    maintenance,
    native,
    hostLease,
    async check() {
      if (!quiescent || !paused) throw Error('PRIVATE_OWNER_ADMISSION');
    },
  };
  const controls = { ownerTargetRoot: root, assertMemory() {} };
  const open = async () => (opened = await openProtectedVaultAuthority(options, controls));
  cleanups.push(async () => {
    await opened?.authority.close();
    native.close();
    fs.rmSync(parent, { recursive: true, force: true });
  });
  return {
    root,
    binding,
    maintenance,
    native,
    hostLease,
    config,
    options,
    controls,
    open,
    loseQuiescence() {
      quiescent = false;
    },
    unpause() {
      paused = false;
    },
  };
}
it('provides a live proof fenced by real protected maintenance and SQLite host leases', async () => {
  const f = await fixture(),
    proof = await f.open();
  await checkVaultAuthority(proof.authority, proof.scope, process.getuid!());
  expect(proof.scope).toEqual({
    operationId: f.config.identity.operationId,
    targetDigest: digest(f.binding),
    generation: f.maintenance.generation,
  });
  expect(JSON.stringify(proof)).not.toContain(proof.authority.token);
});
it.each(['host-release', 'host-replacement', 'maintenance-release', 'lost-quiescence', 'unpaused'])(
  'withdraws root proof after %s without changing data or restoring authority',
  async (reason) => {
    const f = await fixture(),
      proof = await f.open();
    if (reason === 'host-release') releaseHostExecutionLease(f.native, f.hostLease);
    if (reason === 'host-replacement') f.native.prepare('UPDATE host_execution_lease SET owner_id=?').run(randomUUID());
    if (reason === 'maintenance-release') await finishMaintenance(f.root, f.binding, f.maintenance, async () => true);
    if (reason === 'lost-quiescence') f.loseQuiescence();
    if (reason === 'unpaused') f.unpause();
    await expect(checkVaultAuthority(proof.authority, proof.scope, process.getuid!())).rejects.toThrow(
      'vault_authority_unavailable',
    );
  },
);
it.each(['unprotected', 'operation', 'generation', 'foreign-owner', 'memory'])(
  'refuses initial %s before opening a root capability',
  async (reason) => {
    const f = await fixture();
    if (reason === 'unprotected') {
      fs.unlinkSync(f.root + '/protected.json');
      const state = JSON.parse(fs.readFileSync(f.root + '/state.json', 'utf8'));
      state.lifecycle = 'implementation_disposable';
      writeAtomic(f.root, 'state.json', state);
    }
    if (reason === 'operation') f.options.maintenance = { ...f.maintenance, owner: 'operations-' + randomUUID() };
    if (reason === 'generation') f.options.maintenance = { ...f.maintenance, generation: f.maintenance.generation - 1 };
    if (reason === 'foreign-owner') f.options.configuration = { ...f.config, owner: { ...f.config.owner, uid: 12345 } };
    if (reason === 'memory')
      f.controls.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    await expect(f.open()).rejects.toThrow('vault_owner_authority_unavailable');
    expect(fs.readdirSync(f.root)).not.toContain('vault-authority');
  },
);
it('preserves the protection seal when a stale state copy says disposable', async () => {
  const f = await fixture();
  const state = JSON.parse(fs.readFileSync(f.root + '/state.json', 'utf8'));
  state.lifecycle = 'implementation_disposable';
  writeAtomic(f.root, 'state.json', state);
  const proof = await f.open();
  await checkVaultAuthority(proof.authority, proof.scope, process.getuid!());
  expect(fs.existsSync(f.root + '/protected.json')).toBe(true);
});
