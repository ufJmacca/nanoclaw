import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createVaultRootEffects, type VaultRootControls } from './vault-root-effects.js';
import { provisionVault, VAULT_PROVISION_STEPS } from './vault-provision.js';
import { VAULT_BYTES, VAULT_FREE_FLOOR } from './vault-admission.js';
import * as mountAdapter from './vault-mounts.js';
import * as unitAdapter from './vault-unit-install.js';
import * as cryptoAdapter from './vault-crypto.js';
import * as keyAdapter from './vault-key.js';
import * as allocationAdapter from './vault-allocation.js';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-root-effects-'));
  temporary.push(root);
  const paths = {
    stateRoot: root + '/control',
    volume: root + '/vault.luks',
    bootKey: root + '/keys/vault.key',
    mapper: 'cos-vault-fixture',
    vaultRoot: root + '/vault',
    calendarRoot: '/home/fixture/state/calendar',
    systemUnits: root + '/system',
    ownerUnits: root + '/owner',
  };
  fs.mkdirSync(paths.stateRoot, { mode: 0o700 });
  fs.mkdirSync(root + '/keys', { mode: 0o700 });
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'a'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  const input = {
    userId: process.getuid!(),
    groupId: process.getgid!(),
    service: 'nanoclaw-fixture.service',
    calendarRoot: paths.calendarRoot,
  };
  const observed = new Set<string>(),
    applied: string[] = [];
  const effects = {
    async inspect(step: string) {
      return observed.has(step) ? ('matching' as const) : ('absent' as const);
    },
    async apply(step: string) {
      applied.push(step);
      observed.add(step);
    },
  };
  const controls: VaultRootControls = {
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(),
    assertRole: () => {},
    availableBytes: () => VAULT_BYTES + VAULT_FREE_FLOOR + 256 * 1024 ** 2,
    effects,
  };
  const recovery = Buffer.alloc(64, 77);
  return {
    root,
    paths,
    identity,
    input,
    controls,
    applied,
    observed,
    recovery,
    ports: createVaultRootEffects(paths, identity, input, recovery, controls),
  };
}
it('runs all effects under a durable root journal and lock, then verifies every completed effect on replay', async () => {
  const f = fixture();
  expect(await provisionVault(f.identity, f.ports)).toMatchObject({ status: 'ready' });
  expect(f.applied).toEqual(VAULT_PROVISION_STEPS);
  expect(JSON.parse(fs.readFileSync(f.paths.stateRoot + '/provision.json', 'utf8'))).toMatchObject({
    step: 'units',
    phase: 'complete',
  });
  expect(fs.existsSync(f.paths.stateRoot + '/deploy.lock')).toBe(false);
  await provisionVault(f.identity, f.ports);
  expect(f.applied).toHaveLength(VAULT_PROVISION_STEPS.length);
  expect(f.recovery.equals(Buffer.alloc(64, 77))).toBe(true);
});
it.each([
  'capacity',
  'authority',
  'memory',
  'role',
  'recovery-length',
  'calendar-binding',
  'existing-volume',
  'state-permissions',
])('denies %s before any root resource effect', async (reason) => {
  const f = fixture();
  if (reason === 'capacity') f.controls.availableBytes = () => VAULT_BYTES + VAULT_FREE_FLOOR;
  if (reason === 'authority')
    f.controls.assertAuthority = async () => {
      throw Error('PRIVATE_LEASE');
    };
  if (reason === 'memory')
    f.controls.assertMemory = () => {
      throw Error('PRIVATE_MEMORY');
    };
  if (reason === 'role')
    f.controls.assertRole = () => {
      throw Error('PRIVATE_ROLE');
    };
  if (reason === 'recovery-length') f.recovery = Buffer.alloc(63);
  if (reason === 'calendar-binding') f.input.calendarRoot = '/home/foreign/state/calendar';
  if (reason === 'existing-volume') fs.writeFileSync(f.paths.volume, 'PRIVATE_EXISTING');
  if (reason === 'state-permissions') fs.chmodSync(f.paths.stateRoot, 0o755);
  const ports = createVaultRootEffects(f.paths, f.identity, f.input, f.recovery, f.controls);
  await expect(provisionVault(f.identity, ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(f.applied).toEqual([]);
  expect(fs.existsSync(f.paths.stateRoot + '/provision.json')).toBe(false);
  if (reason === 'existing-volume') expect(fs.readFileSync(f.paths.volume, 'utf8')).toBe('PRIVATE_EXISTING');
});
it('never steals a root operation lock or follows a journal symlink', async () => {
  const f = fixture();
  fs.mkdirSync(f.paths.stateRoot + '/deploy.lock', { mode: 0o700 });
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(fs.existsSync(f.paths.stateRoot + '/deploy.lock')).toBe(true);
  fs.rmdirSync(f.paths.stateRoot + '/deploy.lock');
  fs.writeFileSync(f.root + '/foreign', 'PRIVATE_EXISTING', { mode: 0o600 });
  fs.symlinkSync(f.root + '/foreign', f.paths.stateRoot + '/provision.json');
  await expect(provisionVault(f.identity, f.ports)).rejects.toThrow('vault_provisioning_unavailable');
  expect(fs.readFileSync(f.root + '/foreign', 'utf8')).toBe('PRIVATE_EXISTING');
});
it('rejects an engine identity that differs from the root effect scope before any resource effect', async () => {
  const f = fixture();
  await expect(provisionVault({ ...f.identity, operationId: randomUUID() }, f.ports)).rejects.toThrow(
    'vault_provisioning_unavailable',
  );
  expect(f.applied).toEqual([]);
  expect(fs.existsSync(f.paths.stateRoot + '/provision.json')).toBe(false);
});
it('gives each real adapter only its own path contract instead of the full root configuration', async () => {
  const f = fixture();
  delete f.controls.effects;
  const mounts = vi.spyOn(mountAdapter, 'createVaultMounts'),
    units = vi.spyOn(unitAdapter, 'createVaultUnitInstaller');
  await f.ports.inspect('utilities', f.identity);
  expect(mounts.mock.calls[0][0]).toEqual({
    stateRoot: f.paths.stateRoot,
    vaultRoot: f.paths.vaultRoot,
    calendarRoot: f.paths.calendarRoot,
  });
  expect(units.mock.calls[0][0]).toEqual({
    stateRoot: f.paths.stateRoot,
    systemUnits: f.paths.systemUnits,
    ownerUnits: f.paths.ownerUnits,
  });
});
function activationFixture() {
  const f = fixture();
  delete f.controls.effects;
  let mapped = true,
    mounted = true,
    active = false;
  const crypto = {
    inspect: vi.fn(() => 'matching'),
    mappingStatus: vi.fn<() => 'matching' | 'absent' | 'conflict'>(() => (mapped ? 'matching' : 'absent')),
    filesystemStatus: vi.fn(() => 'matching'),
    close: vi.fn(() => {
      mapped = false;
    }),
  };
  const mounts = {
    inspect: vi.fn(() => (mounted ? 'matching' : 'absent')),
    closed: vi.fn(() => !mounted),
    withArea: vi.fn(() => 'matching'),
  };
  const units = {
    inspect: vi.fn(() => 'matching'),
    active: vi.fn(() => active),
    inactive: vi.fn(() => !active && !mounted),
    stopStorage: vi.fn(async () => {
      active = mounted = false;
    }),
    startStorage: vi.fn(async () => {
      mapped = mounted = active = true;
    }),
  };
  vi.spyOn(cryptoAdapter, 'createVaultCrypto').mockReturnValue(crypto as never);
  vi.spyOn(mountAdapter, 'createVaultMounts').mockReturnValue(mounts as never);
  vi.spyOn(unitAdapter, 'createVaultUnitInstaller').mockReturnValue(units as never);
  vi.spyOn(keyAdapter, 'inspectVaultKey').mockReturnValue('matching');
  vi.spyOn(allocationAdapter, 'inspectVaultAllocation').mockReturnValue('matching');
  const ports = createVaultRootEffects(f.paths, f.identity, f.input, f.recovery, f.controls);
  return {
    ...f,
    ports,
    crypto,
    mounts,
    units,
    setClosed: () => {
      mounted = active = false;
    },
    setActive: () => {
      mapped = mounted = active = true;
    },
  };
}
it('hands a provisioned manual mount to the fixed normal units before reporting readiness', async () => {
  const f = activationFixture();
  await f.ports.activateStorage();
  expect(f.units.stopStorage).toHaveBeenCalledOnce();
  expect(f.crypto.close).toHaveBeenCalledOnce();
  expect(f.units.startStorage).toHaveBeenCalledOnce();
  expect(f.mounts.withArea).toHaveBeenCalledWith('journals', expect.any(Function));
  await f.ports.activateStorage();
  expect(f.units.stopStorage).toHaveBeenCalledOnce();
  expect(f.units.startStorage).toHaveBeenCalledOnce();
});
it('reconciles a claimed mapper whose normal underlays were closed by unit dependency handling', async () => {
  const f = activationFixture();
  f.setClosed();
  await f.ports.activateStorage();
  expect(f.units.stopStorage).not.toHaveBeenCalled();
  expect(f.crypto.close).toHaveBeenCalledOnce();
  expect(f.units.startStorage).toHaveBeenCalledOnce();
});
it.each(['foreign-mapper', 'changed-filesystem', 'revoked-after-stop'])(
  'denies %s during normal activation',
  async (reason) => {
    const f = activationFixture();
    if (reason === 'foreign-mapper') f.crypto.mappingStatus.mockReturnValue('conflict');
    if (reason === 'changed-filesystem') f.crypto.filesystemStatus.mockReturnValue('conflict');
    if (reason === 'revoked-after-stop')
      f.units.stopStorage.mockImplementation(async () => {
        f.setClosed();
        f.controls.assertAuthority = async () => {
          throw Error('PRIVATE_WITHDRAWAL');
        };
      });
    await expect(f.ports.activateStorage()).rejects.toThrow();
    expect(f.crypto.close).not.toHaveBeenCalled();
    expect(f.units.startStorage).not.toHaveBeenCalled();
  },
);
