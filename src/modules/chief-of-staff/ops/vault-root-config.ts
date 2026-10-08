import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import type { TargetBinding } from './target-state.js';
import { readPrivate } from './target-state.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
import type { VaultRootPaths } from './vault-root-effects.js';
import { verifyVaultMemory } from './vault-memory.js';
export type VaultRootConfiguration = {
  contract: 'cos-vault-root-config/v2';
  /** A fresh protected maintenance operation; the resource identity below survives releases. */
  authority: { operationId: string };
  identity: VaultProvisionIdentity;
  target: { binding: TargetBinding; lifecycle: 'protected'; minimumGeneration: number };
  owner: { uid: number; gid: number; home: string; targetRoot: string };
  artifact: { sourceCommit: string; sourceTree: string; digest: string };
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) => Object.keys(value).sort().join(',') === expected;
const hash = (value: unknown, length = 64) =>
  typeof value === 'string' && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const uuid = (value: unknown) =>
  typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const absolute = (value: unknown): value is string =>
  typeof value === 'string' && /^\/[a-zA-Z0-9_./-]+$/.test(value) && path.resolve(value) === value && value !== '/';
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 2147483647;
export function vaultRootConfiguration(value: unknown): VaultRootConfiguration {
  try {
    if (
      !object(value) ||
      !keys(value, 'artifact,authority,contract,identity,owner,target') ||
      value.contract !== 'cos-vault-root-config/v2'
    )
      throw Error('invalid_root_configuration');
    const { identity, owner, target, artifact, authority } = value;
    if (!object(authority) || !keys(authority, 'operationId') || !uuid(authority.operationId))
      throw Error('invalid_root_authority');
    if (
      !object(identity) ||
      !keys(identity, 'filesystemUuid,luksUuid,operationId,recoveryReference,targetDigest') ||
      !hash(identity.targetDigest) ||
      [identity.operationId, identity.recoveryReference, identity.luksUuid, identity.filesystemUuid].some(
        (field) => !uuid(field),
      )
    )
      throw Error('invalid_root_identity');
    if (
      !object(owner) ||
      !keys(owner, 'gid,home,targetRoot,uid') ||
      !positive(owner.uid) ||
      !positive(owner.gid) ||
      typeof owner.home !== 'string' ||
      !/^\/home\/[a-zA-Z0-9_.-]+$/.test(owner.home) ||
      !absolute(owner.targetRoot) ||
      !owner.targetRoot.startsWith(owner.home + '/')
    )
      throw Error('invalid_root_owner');
    if (
      !object(target) ||
      !keys(target, 'binding,lifecycle,minimumGeneration') ||
      target.lifecycle !== 'protected' ||
      !Number.isSafeInteger(target.minimumGeneration) ||
      Number(target.minimumGeneration) < 1 ||
      !object(target.binding)
    )
      throw Error('invalid_root_target');
    const binding = target.binding;
    if (
      !keys(binding, 'dataRoot,databaseFingerprint,hostFingerprint,installationRoot,service') ||
      !hash(binding.hostFingerprint) ||
      !hash(binding.databaseFingerprint) ||
      typeof binding.service !== 'string' ||
      !/^[a-zA-Z0-9_.@-]+\.service$/.test(binding.service) ||
      !absolute(binding.installationRoot) ||
      !absolute(binding.dataRoot) ||
      digest(binding) !== identity.targetDigest
    )
      throw Error('root_target_binding_conflict');
    if (
      !object(artifact) ||
      !keys(artifact, 'digest,sourceCommit,sourceTree') ||
      !hash(artifact.digest) ||
      !hash(artifact.sourceCommit, 40) ||
      !hash(artifact.sourceTree, 40)
    )
      throw Error('invalid_root_artifact');
    return Object.freeze({
      contract: 'cos-vault-root-config/v2',
      authority: Object.freeze({ ...authority }),
      identity: Object.freeze({ ...identity }),
      owner: Object.freeze({ ...owner }),
      target: Object.freeze({ ...target, binding: Object.freeze({ ...binding }) }),
      artifact: Object.freeze({ ...artifact }),
    }) as VaultRootConfiguration;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Configuration can contain private target paths; return one fixed failure.
    throw Error('vault_root_configuration_unavailable');
  }
}
/** No caller-selected partitions, key paths, mapper names or root service names. */
export function fixedVaultRootPaths(input: VaultRootConfiguration): VaultRootPaths {
  const value = vaultRootConfiguration(input);
  return Object.freeze({
    stateRoot: '/etc/nanoclaw-cos/control',
    volume: '/var/lib/nanoclaw-cos/vault.luks',
    bootKey: '/etc/nanoclaw-cos/vault.key',
    mapper: 'nanoclaw-cos-vault',
    vaultRoot: '/var/lib/nanoclaw-cos/vault',
    calendarRoot: value.owner.targetRoot + '/calendar',
    systemUnits: '/etc/systemd/system',
    ownerUnits: value.owner.home + '/.config/systemd/user',
  });
}
export function readVaultRootConfiguration(): VaultRootConfiguration {
  try {
    if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
      throw Error('root_process_required');
    verifyVaultMemory();
    const root = '/etc/nanoclaw-cos',
      file = root + '/vault-root.json',
      parent = fs.lstatSync(root),
      stat = fs.lstatSync(file);
    if (
      !parent.isDirectory() ||
      fs.realpathSync(root) !== root ||
      parent.uid !== 0 ||
      (parent.mode & 0o777) !== 0o700 ||
      !stat.isFile() ||
      stat.nlink !== 1 ||
      fs.realpathSync(file) !== file
    )
      throw Error('unsafe_root_configuration');
    const value = vaultRootConfiguration(readPrivate(file, 16384));
    const after = fs.lstatSync(file),
      current = fs.lstatSync(root);
    if (after.dev !== stat.dev || after.ino !== stat.ino || current.dev !== parent.dev || current.ino !== parent.ino)
      throw Error('root_configuration_changed');
    verifyVaultMemory();
    return value;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root configuration paths and diagnostics are private.
    throw Error('vault_root_configuration_unavailable');
  }
}
