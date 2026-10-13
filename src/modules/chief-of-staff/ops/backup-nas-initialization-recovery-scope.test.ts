import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasSetupScope } from './backup-nas-setup-wire.js';
import { backupNasRecoveryScope } from './backup-nas-recovery-wire.js';
import {
  backupNasInitializationResource,
  backupNasInitializationRecoveryScope,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
const fixture = () => {
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
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const resource = {
    kind: 'configuration-stage' as const,
    stageId: randomUUID(),
    device: 17,
    inode: 23,
    contentDigest: 'f'.repeat(64),
  };
  return { vault, nas, resource, operationId: randomUUID() as string, generation: 4 };
};
it.each(['closed-underlay', 'configuration-stage', 'service-stage'] as const)(
  'accepts only a bounded %s observation without a path or effect selector',
  (kind) => {
    const f = fixture(),
      input = kind === 'closed-underlay' ? { kind, device: 17, inode: 23 } : { ...f.resource, kind };
    const selected = backupNasInitializationResource(input);
    expect(selected).toEqual(input);
    expect(selected).not.toBe(input);
    expect(Object.isFrozen(selected)).toBe(true);
  },
);
it('validates and copies each observed identity once, without returning a changed accessor value', () => {
  const f = fixture();
  let reads = 0;
  const value = {
    ...f.resource,
    get inode() {
      return ++reads === 1 ? 23 : -1;
    },
  };
  expect(backupNasInitializationResource(value).inode).toBe(23);
  expect(reads).toBe(1);
});
it.each([
  'unknown-kind',
  'path',
  'mode',
  'pid',
  'effect',
  'extra-underlay-stage',
  'zero-device',
  'zero-inode',
  'negative-inode',
  'fractional-inode',
  'unsafe-inode',
  'nan-device',
  'invalid-stage',
  'upper-stage',
  'invalid-digest',
  'upper-digest',
  'missing-digest',
  'array',
  'null',
])('rejects %s observations before granting resource recovery', (reason) => {
  const f = fixture();
  let value: unknown = { ...f.resource };
  const selected = value as Record<string, unknown>;
  if (reason === 'unknown-kind') selected.kind = 'vault';
  if (reason === 'path') selected.path = '/etc/foreign';
  if (reason === 'mode') selected.mode = 0o600;
  if (reason === 'pid') selected.pid = 42;
  if (reason === 'effect') selected.effect = 'unlink';
  if (reason === 'extra-underlay-stage') selected.kind = 'closed-underlay';
  if (reason === 'zero-device') selected.device = 0;
  if (reason === 'zero-inode') selected.inode = 0;
  if (reason === 'negative-inode') selected.inode = -1;
  if (reason === 'fractional-inode') selected.inode = 2.5;
  if (reason === 'unsafe-inode') selected.inode = Number.MAX_SAFE_INTEGER + 1;
  if (reason === 'nan-device') selected.device = NaN;
  if (reason === 'invalid-stage') selected.stageId = '../foreign';
  if (reason === 'upper-stage') selected.stageId = 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE';
  if (reason === 'invalid-digest') selected.contentDigest = 'old-receipt';
  if (reason === 'upper-digest') selected.contentDigest = 'A'.repeat(64);
  if (reason === 'missing-digest') delete selected.contentDigest;
  if (reason === 'array') value = [];
  if (reason === 'null') value = null;
  expect(() => backupNasInitializationResource(value)).toThrow(/^backup_nas_initialization_resource_unavailable$/);
});
it('binds the exact observed resource, NAS, full vault configuration and purpose while retaining the fresh operation and generation', () => {
  const f = fixture(),
    scope = backupNasInitializationRecoveryScope(f.vault, f.nas, f.resource, f.operationId, f.generation);
  expect(scope).toEqual({
    operationId: f.operationId,
    generation: f.generation,
    targetDigest: digest({
      contract: 'cos-backup-nas-recover-initialization-authority/v1',
      configurationDigest: digest(f.vault),
      nasDigest: digest(f.nas),
      resourceDigest: digest(f.resource),
    }),
  });
  expect(Object.isFrozen(scope)).toBe(true);
  expect(scope.targetDigest).not.toBe(backupNasSetupScope(f.vault, f.nas, f.operationId, f.generation).targetDigest);
  expect(scope.targetDigest).not.toBe(backupNasRecoveryScope(f.vault, f.nas, f.operationId, f.generation).targetDigest);
  expect(scope.targetDigest).not.toBe(f.vault.identity.targetDigest);
});
it.each([
  'kind',
  'inode',
  'device',
  'stage',
  'content',
  'nas-reference',
  'nas-host',
  'vault-artifact',
  'vault-owner',
  'vault-operation',
])('changes recovery permission when the selected %s changes', (reason) => {
  const f = fixture(),
    scope = backupNasInitializationRecoveryScope(f.vault, f.nas, f.resource, f.operationId, f.generation);
  let vault = f.vault,
    nas = f.nas,
    resource: BackupNasInitializationResource = f.resource;
  if (reason === 'kind') resource = { ...f.resource, kind: 'service-stage' };
  if (reason === 'inode') resource = { ...f.resource, inode: 24 };
  if (reason === 'device') resource = { ...f.resource, device: 18 };
  if (reason === 'stage') resource = { ...f.resource, stageId: randomUUID() };
  if (reason === 'content') resource = { ...f.resource, contentDigest: '0'.repeat(64) };
  if (reason === 'nas-reference') nas = { ...f.nas, credentialReference: randomUUID() };
  if (reason === 'nas-host') nas = { ...f.nas, host: '192.168.56.13' };
  if (reason === 'vault-artifact')
    vault = vaultRootConfiguration({ ...f.vault, artifact: { ...f.vault.artifact, digest: '0'.repeat(64) } });
  if (reason === 'vault-owner') {
    vault = vaultRootConfiguration({ ...f.vault, owner: { ...f.vault.owner, uid: 1001 } });
    nas = { ...f.nas, vaultStateDigest: vaultRootStateDigest(vault) };
  }
  if (reason === 'vault-operation')
    vault = vaultRootConfiguration({ ...f.vault, authority: { operationId: randomUUID() } });
  expect(backupNasInitializationRecoveryScope(vault, nas, resource, f.operationId, f.generation).targetDigest).not.toBe(
    scope.targetDigest,
  );
});
it.each(['operation', 'generation', 'stale-generation', 'foreign-nas', 'invalid-resource'])(
  'refuses %s authority inputs',
  (reason) => {
    const f = fixture();
    if (reason === 'operation') f.operationId = 'old-receipt';
    if (reason === 'generation') f.generation = 2.5;
    if (reason === 'stale-generation') f.generation = 2;
    if (reason === 'foreign-nas') f.nas = { ...f.nas, vaultStateDigest: '0'.repeat(64) };
    if (reason === 'invalid-resource') f.resource = { ...f.resource, inode: -1 };
    expect(() => backupNasInitializationRecoveryScope(f.vault, f.nas, f.resource, f.operationId, f.generation)).toThrow(
      /^backup_nas_initialization_recovery_scope_unavailable$/,
    );
  },
);
