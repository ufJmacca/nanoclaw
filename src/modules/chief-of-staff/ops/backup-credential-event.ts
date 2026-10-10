import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import type { BackupQueueReceipt } from './backup-queue.js';

export type CredentialChange = {
  sourceKind: 'calendar_reader' | 'calendar_owned_event_writer' | 'backup_repository';
  sourceKey: string;
  generation: number;
  phase: 'ready' | 'refreshing' | 'uncertain' | 'revoked';
  files: Array<{ name: string; bytes: Buffer }>;
};
export type CredentialJournal = (change: CredentialChange, assertCurrent: () => void) => Promise<void>;
export type CredentialEvent = Omit<CredentialChange, 'files'> & {
  contract: 'cos-backup-credential-event/v1';
  ownerDigest: string;
  operationId: string;
  files: BackupQueueReceipt['files'];
};
export type CredentialHead = {
  contract: 'cos-backup-credential-head/v1';
  event: CredentialEvent;
  receipt: BackupQueueReceipt;
};
export const credentialEventName = 'credential-event.json';
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const fileName = (name: unknown) =>
  typeof name === 'string' && /^[a-z][a-z0-9.-]{0,63}$/.test(name) && name !== credentialEventName;
export function credentialSource(event: Pick<CredentialEvent, 'sourceKind' | 'sourceKey'>): string {
  return digest({ sourceKind: event.sourceKind, sourceKey: event.sourceKey });
}
export const credentialHeadName = (event: CredentialEvent) => '.cos-credential-' + credentialSource(event) + '.json';
export const credentialHeadFile = (name: string) => /^\.cos-credential-[a-f0-9]{64}\.json$/.test(name);
export const credentialTemporary = (name: string) => /^\.cos-credential-[a-f0-9]{64}-[a-f0-9-]{36}\.tmp$/.test(name);
function eventId(value: Omit<CredentialEvent, 'operationId'>): string {
  const bytes = Buffer.from(digest(value), 'hex').subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const id = bytes.toString('hex');
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}
export function validateCredentialEvent(value: CredentialEvent, ownerDigest: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !==
      'contract,files,generation,operationId,ownerDigest,phase,sourceKey,sourceKind' ||
    value.contract !== 'cos-backup-credential-event/v1' ||
    value.ownerDigest !== ownerDigest ||
    !hex(ownerDigest) ||
    !['calendar_reader', 'calendar_owned_event_writer', 'backup_repository'].includes(value.sourceKind) ||
    !hex(value.sourceKey) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    !['ready', 'refreshing', 'uncertain', 'revoked'].includes(value.phase) ||
    !Array.isArray(value.files) ||
    value.files.length < 1 ||
    value.files.length > 8 ||
    new Set(value.files.map((file) => file?.name)).size !== value.files.length ||
    value.files.some(
      (file) =>
        !file ||
        Object.keys(file).sort().join(',') !== 'bytes,name,sha256' ||
        !fileName(file.name) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 1 ||
        !hex(file.sha256),
    ) ||
    value.files.reduce((sum, file) => sum + file.bytes, 0) > 1024 ** 2 ||
    value.files.map((file) => file.name).join(',') !==
      [...value.files]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((file) => file.name)
        .join(',')
  )
    throw Error('invalid_credential_event');
  const { operationId, ...identity } = value;
  if (eventId(identity) !== operationId) throw Error('credential_event_identity_changed');
}
export function makeCredentialEvent(change: CredentialChange, ownerDigest: string): CredentialEvent {
  if (!change || !Array.isArray(change.files) || change.files.some((file) => !file || !Buffer.isBuffer(file.bytes)))
    throw Error('invalid_credential_change');
  const identity = {
    contract: 'cos-backup-credential-event/v1' as const,
    ownerDigest,
    sourceKind: change.sourceKind,
    sourceKey: change.sourceKey,
    generation: change.generation,
    phase: change.phase,
    files: change.files
      .map((file) => ({ name: file.name, bytes: file.bytes.length, sha256: hash(file.bytes) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
  const event = { ...identity, operationId: eventId(identity) };
  validateCredentialEvent(event, ownerDigest);
  return event;
}
export function credentialHead(event: CredentialEvent, receipt: BackupQueueReceipt): CredentialHead {
  validateCredentialEvent(event, receipt.ownerDigest);
  const bytes = Buffer.from(JSON.stringify(event) + '\n');
  try {
    const files = [...event.files, { name: credentialEventName, bytes: bytes.length, sha256: hash(bytes) }].sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    if (
      receipt.kind !== 'credentials' ||
      receipt.state !== 'pending' ||
      receipt.operationId !== event.operationId ||
      digest(receipt.files) !== digest(files)
    )
      throw Error('credential_receipt_conflict');
    return { contract: 'cos-backup-credential-head/v1', event, receipt };
  } finally {
    bytes.fill(0);
  }
}
/** Completion evidence only. It never authorizes credential access, replay, restore or queue deletion. */
export function validateCredentialHead(value: CredentialHead, owner: string, name?: string): void {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'contract,event,receipt' ||
    value.contract !== 'cos-backup-credential-head/v1'
  )
    throw Error('invalid_credential_head');
  validateCredentialEvent(value.event, owner);
  if (
    digest(credentialHead(value.event, value.receipt)) !== digest(value) ||
    (name && name !== credentialHeadName(value.event))
  )
    throw Error('credential_head_conflict');
}
export function credentialOrder(event: CredentialEvent): number {
  const rank = { ready: 0, refreshing: 1, uncertain: 2, revoked: 2 };
  if (event.generation > Math.floor(Number.MAX_SAFE_INTEGER / 3)) throw Error('credential_generation_bounds');
  return event.generation * 3 + rank[event.phase];
}
export function readCredentialMetadata<T>(file: string, device: number, json = true): T {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  let bytes: Buffer | undefined;
  try {
    const initial = fs.fstatSync(fd);
    if (
      !initial.isFile() ||
      initial.dev !== device ||
      initial.uid !== process.getuid?.() ||
      initial.nlink !== 1 ||
      (initial.mode & 0o777) !== 0o600 ||
      initial.size > 16384
    )
      throw Error('unsafe_credential_metadata');
    bytes = Buffer.alloc(initial.size + 1);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0),
      after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      count !== initial.size ||
      after.size !== initial.size ||
      after.mtimeMs !== initial.mtimeMs ||
      after.ctimeMs !== initial.ctimeMs ||
      current.dev !== initial.dev ||
      current.ino !== initial.ino
    )
      throw Error('credential_metadata_changed');
    return (
      json
        ? JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count)))
        : Buffer.from(bytes.subarray(0, count))
    ) as T;
  } finally {
    bytes?.fill(0);
    fs.closeSync(fd);
  }
}
export function credentialMetadata(root: string, device: number, owner: string) {
  const names = fs.readdirSync(root),
    headNames = names.filter(credentialHeadFile),
    temporaries = names.filter(credentialTemporary);
  if (headNames.length > 1024 || temporaries.length > 2) throw Error('credential_metadata_bounds');
  const heads = headNames.map((name) => {
    const head = readCredentialMetadata<CredentialHead>(path.join(root, name), device);
    validateCredentialHead(head, owner, name);
    return head;
  });
  for (const name of temporaries) readCredentialMetadata<Buffer>(path.join(root, name), device, false).fill(0);
  return { heads, temporaries, names: [...headNames, ...temporaries] };
}
/** Recover only byte prefixes corroborated by verified pending snapshots or canonical completion heads.
 * Every temporary is validated before any unlink; publication metadata never substitutes for fresh authority. */
export function recoverCredentialTemporaries(
  root: string,
  device: number,
  names: string[],
  candidates: CredentialHead[],
  assertCurrent: () => void,
): void {
  const matches = names.map((name) => {
    const file = path.join(root, name),
      before = fs.lstatSync(file),
      bytes = readCredentialMetadata<Buffer>(file, device, false);
    try {
      const source = name.slice('.cos-credential-'.length, '.cos-credential-'.length + 64);
      if (
        !candidates.some((head) => {
          if (credentialSource(head.event) !== source) return false;
          const expected = Buffer.from(JSON.stringify(head) + '\n');
          try {
            return bytes.length <= expected.length && bytes.equals(expected.subarray(0, bytes.length));
          } finally {
            expected.fill(0);
          }
        })
      )
        throw Error('credential_temporary_unclaimed');
      return { file, before };
    } finally {
      bytes.fill(0);
    }
  });
  const fd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    for (const { file, before } of matches) {
      assertCurrent();
      const current = fs.lstatSync(file);
      if (
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        current.size !== before.size ||
        current.mtimeMs !== before.mtimeMs ||
        current.ctimeMs !== before.ctimeMs
      )
        throw Error('credential_temporary_changed');
      fs.unlinkSync(file);
      fs.fsyncSync(fd);
    }
  } finally {
    fs.closeSync(fd);
  }
}
export function publishCredentialHead(root: string, head: CredentialHead, assertCurrent: () => void): void {
  const bytes = Buffer.from(JSON.stringify(head) + '\n');
  if (bytes.length > 16384) throw Error('credential_head_bounds');
  assertCurrent();
  const file = path.join(root, '.cos-credential-' + credentialSource(head.event) + '-' + randomUUID() + '.tmp');
  const fd = fs.openSync(
      file,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    ),
    initial = fs.fstatSync(fd);
  const directory = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
    assertCurrent();
    fs.renameSync(file, path.join(root, credentialHeadName(head.event)));
    fs.fsyncSync(directory);
    assertCurrent();
  } finally {
    bytes.fill(0);
    try {
      const current = fs.lstatSync(file, { throwIfNoEntry: false });
      if (
        current &&
        current.dev === initial.dev &&
        current.ino === initial.ino &&
        current.isFile() &&
        current.nlink === 1 &&
        current.uid === initial.uid
      ) {
        assertCurrent();
        fs.unlinkSync(file);
        fs.fsyncSync(directory);
      }
    } finally {
      fs.closeSync(directory);
      fs.closeSync(fd);
    }
  }
}
