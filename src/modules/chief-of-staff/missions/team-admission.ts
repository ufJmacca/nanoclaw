import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from '../ops/target-state.js';
import { TEAM_TEMPLATES, TEAM_PUBLIC_RETRIEVAL } from '../contracts/team-templates.js';
export const TEAM_ADMISSION_POLICY = Object.freeze({
  contract: 'cos-team-policy/v1',
  maxSteps: 6,
  maxWorkers: 2,
  publicRetrieval: TEAM_PUBLIC_RETRIEVAL,
  mainContext: 'retained',
  rework: 'approved_original_limits',
});
export type TeamAdmissionChange = {
  expectedRevision: number;
  enabled: boolean;
  templateBundleDigest: string;
  policyDigest: string;
  reviewRef: string;
};
export type TeamAdmission = {
  contract: 'cos-team-admission/v1';
  scopeId: string;
  ownerId: string;
  bindingDigest: string;
  revision: number;
  enabled: boolean;
  templateBundleDigest: string;
  policyDigest: string;
  reviewRef: string;
  requestId: string;
  requestDigest: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function parseTeamAdmissionChange(value: unknown): TeamAdmissionChange {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'enabled,expectedRevision,policyDigest,reviewRef,templateBundleDigest' ||
    !Number.isSafeInteger(value.expectedRevision) ||
    Number(value.expectedRevision) < 0 ||
    typeof value.enabled !== 'boolean' ||
    value.templateBundleDigest !== digest(TEAM_TEMPLATES) ||
    value.policyDigest !== digest(TEAM_ADMISSION_POLICY) ||
    typeof value.reviewRef !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/ -]{0,199}$/.test(value.reviewRef)
  )
    throw Error('invalid_team_configuration');
  return structuredClone(value) as TeamAdmissionChange;
}
function filename(root: string, scope: string): string {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('unsafe_team_configuration');
  return path.join(root, 'team-admission-' + digest(scope) + '.json');
}
/** Bounded, nonblocking reads; an alias or changing file cannot provide authority. */
function readRecord(file: string): unknown {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 4096
    )
      throw Error('unsafe_team_configuration');
    const bytes = Buffer.alloc(4097);
    let size = 0;
    while (size < bytes.length) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, size);
      if (!n) break;
      size += n;
    }
    const after = fs.fstatSync(fd),
      named = fs.lstatSync(file);
    if (
      size !== stat.size ||
      size > 4096 ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.ctimeMs !== stat.ctimeMs ||
      named.ino !== stat.ino ||
      named.dev !== stat.dev ||
      named.isSymbolicLink()
    )
      throw Error('unsafe_team_configuration');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    fs.closeSync(fd);
  }
}
function strictRead(file: string, binding: CosBinding): TeamAdmission | null {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return null;
  const value = readRecord(file);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !==
      'bindingDigest,contract,enabled,ownerId,policyDigest,requestDigest,requestId,reviewRef,revision,scopeId,templateBundleDigest' ||
    value.contract !== 'cos-team-admission/v1' ||
    value.scopeId !== binding.scopeId ||
    value.ownerId !== binding.ownerId ||
    value.bindingDigest !== digest(binding) ||
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.requestId !== 'string' ||
    !uuid.test(value.requestId) ||
    typeof value.requestDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.requestDigest)
  )
    throw Error('team_configuration_conflict');
  const change = parseTeamAdmissionChange({
    expectedRevision: Number(value.revision) - 1,
    enabled: value.enabled,
    templateBundleDigest: value.templateBundleDigest,
    policyDigest: value.policyDigest,
    reviewRef: value.reviewRef,
  });
  if (value.requestDigest !== digest({ binding, change })) throw Error('team_configuration_conflict');
  return value as TeamAdmission;
}
export function readTeamAdmissionManifest(file: string): TeamAdmissionChange {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw Error('unsafe_team_configuration');
  return parseTeamAdmissionChange(readRecord(file));
}
/** Host-owned read only. Missing, replaced or malformed configuration never enables team admission. */
export function readTeamAdmission(root: string, binding: CosBinding): TeamAdmission | null {
  try {
    return strictRead(filename(root, binding.scopeId), binding);
  } catch {
    return null;
  }
}
/** Caller holds target/host maintenance ownership and has verified the exact reviewed database template bundle and policy. */
export function configureTeamAdmission(
  root: string,
  binding: CosBinding,
  requestId: string,
  input: unknown,
): TeamAdmission {
  const change = parseTeamAdmissionChange(input);
  if (binding.provider !== 'codex' || !uuid.test(requestId)) throw Error('invalid_team_configuration');
  const file = filename(root, binding.scopeId),
    old = strictRead(file, binding),
    requestDigest = digest({ binding, change });
  if (old?.requestId === requestId) {
    if (old.requestDigest !== requestDigest) throw Error('team_configuration_conflict');
    return old;
  }
  if ((old?.revision ?? 0) !== change.expectedRevision || !Number.isSafeInteger(change.expectedRevision + 1))
    throw Error('team_configuration_conflict');
  const record: TeamAdmission = {
    contract: 'cos-team-admission/v1',
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    bindingDigest: digest(binding),
    revision: change.expectedRevision + 1,
    enabled: change.enabled,
    templateBundleDigest: change.templateBundleDigest,
    policyDigest: change.policyDigest,
    reviewRef: change.reviewRef,
    requestId,
    requestDigest,
  };
  writeAtomic(root, path.basename(file), record);
  return record;
}
