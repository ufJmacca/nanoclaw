import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';

function ownedDirectory(directory: string): void {
  const stat = fs.lstatSync(directory);
  if (
    !path.isAbsolute(directory) ||
    fs.realpathSync(directory) !== directory ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o022
  )
    throw new Error('unsafe_native_path');
}
async function fileHash(file: string): Promise<string> {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error('unsafe_native_path');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
type BackupReceipt = { version: 1; source: string; file: string; sha256: string; at: string };
/** SQLite's online backup includes committed WAL pages. It never copies or restores a live DB file. */
export async function backupNativeDatabase(source: string, destination: string): Promise<BackupReceipt> {
  ownedDirectory(destination);
  ownedDirectory(path.dirname(source));
  if (fs.realpathSync(source) !== source || !fs.lstatSync(source).isFile()) throw new Error('unsafe_native_path');
  const file = path.join(destination, 'native.sqlite'),
    receipt = path.join(destination, 'native-backup.json');
  if (fs.lstatSync(receipt, { throwIfNoEntry: false })) {
    const previous = readPrivate<BackupReceipt>(receipt);
    if (
      previous.version !== 1 ||
      previous.source !== source ||
      previous.file !== file ||
      previous.sha256 !== (await fileHash(file))
    )
      throw new Error('native_backup_conflict');
    return previous;
  }
  if (fs.lstatSync(file, { throwIfNoEntry: false })) throw new Error('native_backup_conflict');
  const temporary = path.join(destination, '.' + randomUUID() + '.sqlite');
  // Precreate with private permissions; backup() writes into the existing empty file.
  fs.closeSync(fs.openSync(temporary, 'wx', 0o600));
  const live = new Database(source, { readonly: true, fileMustExist: true });
  try {
    await live.backup(temporary);
  } finally {
    live.close();
  }
  // Normalize only the newly owned snapshot. A writable inspection connection clears its own
  // temporary WAL/SHM files; the live source and its journal mode are never changed.
  const copy = new Database(temporary, { fileMustExist: true });
  try {
    if (copy.pragma('journal_mode=DELETE', { simple: true }) !== 'delete') throw new Error('native_backup_invalid');
    if (copy.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('native_backup_invalid');
  } finally {
    copy.close();
  }
  const sha256 = await fileHash(temporary);
  const fd = fs.openSync(temporary, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const value: BackupReceipt = { version: 1, source, file, sha256, at: new Date().toISOString() };
  writeAtomic(destination, 'native-backup.json', value);
  return value;
}

type ServiceRequest = {
  configurationRoot: string;
  receiptRoot: string;
  service: string;
  installationRoot: string;
  payloadRoot: string;
  manifest: string;
  stateRoot: string;
  runtimeEnvironment: string;
};
type OverrideReceipt = {
  version: 1;
  requestDigest: string;
  file: string;
  previous: string | null;
  previousMode: number;
  installed: string;
  phase: 'prepared' | 'installed' | 'restored';
};
function servicePaths(request: ServiceRequest) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]{0,120}\.service$/.test(request.service)) throw new Error('unsafe_service_request');
  for (const [name, file] of Object.entries(request))
    if (name !== 'service' && (!/^\/[a-zA-Z0-9_./-]+$/.test(file) || path.resolve(file) !== file || file === '/'))
      throw new Error('unsafe_service_request');
  ownedDirectory(request.configurationRoot);
  ownedDirectory(request.receiptRoot);
  const folder = path.join(request.configurationRoot, request.service + '.d');
  if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 });
  ownedDirectory(folder);
  return {
    folder,
    file: path.join(folder, '90-cos-release.conf'),
    receipt: path.join(request.receiptRoot, 'service-override.json'),
  };
}
function currentOverride(file: string): { text: string | null; mode: number } {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return { text: null, mode: 0o600 };
  if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o022 || stat.size > 65536)
    throw new Error('service_override_conflict');
  return { text: fs.readFileSync(file, 'utf8'), mode: stat.mode & 0o777 };
}
function writeOverride(folder: string, file: string, text: string, mode: number) {
  const temporary = path.join(folder, '.' + randomUUID() + '.tmp'),
    fd = fs.openSync(temporary, 'wx', mode);
  try {
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  const directory = fs.openSync(folder, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
  try {
    fs.fsyncSync(directory);
  } finally {
    fs.closeSync(directory);
  }
}
/** Caller holds the deployment lock. No restart or data-directory movement is implicit. */
export function installServiceOverride(request: ServiceRequest): { file: string; sha256: string } {
  const { folder, file, receipt } = servicePaths(request);
  const installed = [
    '# NanoClaw tested CoS release',
    '[Service]',
    `WorkingDirectory=${request.installationRoot}`,
    'ExecStart=',
    `ExecStart=${request.payloadRoot}/node/bin/node ${request.payloadRoot}/dist/index.js`,
    `Environment="PATH=${request.payloadRoot}/node/bin:/usr/local/bin:/usr/bin:/bin"`,
    `Environment="NANOCLAW_RELEASE_MANIFEST=${request.manifest}"`,
    `Environment="COS_TARGET_STATE_DIR=${request.stateRoot}"`,
    'Environment="COS_ENABLED=true"',
    `EnvironmentFile=${request.runtimeEnvironment}`,
    '',
  ].join('\n');
  let record: OverrideReceipt;
  const current = currentOverride(file);
  if (fs.lstatSync(receipt, { throwIfNoEntry: false })) {
    record = readPrivate<OverrideReceipt>(receipt);
    if (
      record.version !== 1 ||
      record.requestDigest !== digest(request) ||
      record.file !== file ||
      record.installed !== installed ||
      !['prepared', 'installed'].includes(record.phase) ||
      (current.text !== installed && !(record.phase === 'prepared' && current.text === record.previous))
    )
      throw new Error('service_override_conflict');
  } else {
    record = {
      version: 1,
      requestDigest: digest(request),
      file,
      previous: current.text,
      previousMode: current.mode,
      installed,
      phase: 'prepared',
    };
    writeAtomic(request.receiptRoot, 'service-override.json', record);
  }
  if (current.text !== installed) writeOverride(folder, file, installed, 0o600);
  if (record.phase !== 'installed')
    writeAtomic(request.receiptRoot, 'service-override.json', { ...record, phase: 'installed' });
  return { file, sha256: createHash('sha256').update(installed).digest('hex') };
}
/** Restores configuration only. New messages and SQLite migrations are never rolled back. */
export function restoreServiceOverride(request: ServiceRequest): void {
  const { folder, file, receipt } = servicePaths(request),
    record = readPrivate<OverrideReceipt>(receipt);
  if (
    record.version !== 1 ||
    record.requestDigest !== digest(request) ||
    record.file !== file ||
    !['prepared', 'installed', 'restored'].includes(record.phase) ||
    typeof record.installed !== 'string' ||
    (record.previous !== null && typeof record.previous !== 'string') ||
    !Number.isInteger(record.previousMode) ||
    (record.previousMode & ~0o755) !== 0
  )
    throw new Error('service_override_conflict');
  const current = currentOverride(file).text;
  if (current !== record.installed && current !== record.previous) throw new Error('service_override_conflict');
  if (current !== record.previous) {
    if (record.previous === null) fs.unlinkSync(file);
    else writeOverride(folder, file, record.previous, record.previousMode);
  }
  writeAtomic(request.receiptRoot, 'service-override.json', { ...record, phase: 'restored' });
}
