import type { VaultProvisionIdentity } from './vault-provision.js';
export type VaultKeyPaths = { stateRoot: string; bootKey: string };
export type VaultKeyControls = { assertAuthority(): Promise<void>; assertMemory(): void };
type Claim = {
  contract: 'cos-vault-key/v1';
  identityDigest: string;
  pathDigest: string;
  device: number;
  inode: number;
};
function directories(paths: VaultKeyPaths) {
  for (const root of [paths.stateRoot, path.dirname(paths.bootKey)]) {
    const stat = fs.lstatSync(root);
    if (
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      fs.realpathSync(root) !== root ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('unsafe_vault_key_directory');
  }
  if (
    !path.isAbsolute(paths.bootKey) ||
    path.resolve(paths.bootKey) !== paths.bootKey ||
    path.basename(paths.bootKey) !== 'vault.key' ||
    /[\0\r\n]/.test(paths.bootKey)
  )
    throw Error('unsafe_vault_key_path');
}
function claimed(paths: VaultKeyPaths, identity: VaultProvisionIdentity): Claim | null {
  const file = path.join(paths.stateRoot, 'keys.json'),
    stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return null;
  if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_vault_key_claim');
  const value = readPrivate<Claim>(file, 2048);
  if (
    !value ||
    Object.keys(value).sort().join(',') !== 'contract,device,identityDigest,inode,pathDigest' ||
    value.contract !== 'cos-vault-key/v1' ||
    value.identityDigest !== digest(identity) ||
    value.pathDigest !== digest(paths.bootKey) ||
    !Number.isSafeInteger(value.device) ||
    value.device < 0 ||
    !Number.isSafeInteger(value.inode) ||
    value.inode < 1
  )
    throw Error('vault_key_claim_conflict');
  return value;
}
export function inspectVaultKey(
  paths: VaultKeyPaths,
  identity: VaultProvisionIdentity,
): 'absent' | 'matching' | 'conflict' {
  try {
    directories(paths);
    const claim = claimed(paths, identity),
      stat = fs.lstatSync(paths.bootKey, { throwIfNoEntry: false });
    if (!stat && !claim) return 'absent';
    if (
      !stat ||
      !claim ||
      !stat.isFile() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1 ||
      stat.size !== 64 ||
      stat.dev !== claim.device ||
      stat.ino !== claim.inode
    )
      return 'conflict';
    return 'matching';
    // eslint-disable-next-line no-catch-all/no-catch-all -- Report only fixed status, never credential paths or claim details.
  } catch {
    return 'conflict';
  }
}
/** Creation is operation-bound and exclusive. An orphaned key is never overwritten or adopted. */
export async function createVaultKey(
  paths: VaultKeyPaths,
  identity: VaultProvisionIdentity,
  controls: VaultKeyControls,
): Promise<void> {
  let fd: number | undefined, key: Buffer | undefined;
  try {
    const authority = async () => {
      controls.assertMemory();
      await controls.assertAuthority();
      controls.assertMemory();
    };
    await authority();
    const observed = inspectVaultKey(paths, identity);
    if (observed === 'conflict') throw Error('vault_key_conflict');
    if (observed === 'matching') return;
    directories(paths);
    const directory = fs.lstatSync(path.dirname(paths.bootKey)),
      state = fs.lstatSync(paths.stateRoot);
    key = randomBytes(64);
    fd = fs.openSync(
      paths.bootKey,
      fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.writeFileSync(fd, key);
    fs.fsyncSync(fd);
    key.fill(0);
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size !== 64 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.nlink !== 1
    )
      throw Error('vault_key_unverified');
    const directoryFd = fs.openSync(
      path.dirname(paths.bootKey),
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(directoryFd);
    } finally {
      fs.closeSync(directoryFd);
    }
    await authority();
    directories(paths);
    const now = fs.lstatSync(path.dirname(paths.bootKey)),
      current = fs.lstatSync(paths.stateRoot),
      file = fs.lstatSync(paths.bootKey);
    if (
      now.dev !== directory.dev ||
      now.ino !== directory.ino ||
      current.dev !== state.dev ||
      current.ino !== state.ino ||
      file.dev !== stat.dev ||
      file.ino !== stat.ino ||
      file.size !== 64 ||
      (file.mode & 0o777) !== 0o600 ||
      file.uid !== stat.uid ||
      file.nlink !== 1 ||
      fs.lstatSync(path.join(paths.stateRoot, 'keys.json'), { throwIfNoEntry: false })
    )
      throw Error('vault_key_changed');
    writeAtomic(paths.stateRoot, 'keys.json', {
      contract: 'cos-vault-key/v1',
      identityDigest: digest(identity),
      pathDigest: digest(paths.bootKey),
      device: stat.dev,
      inode: stat.ino,
    } satisfies Claim);
    await authority();
    if (inspectVaultKey(paths, identity) !== 'matching') throw Error('vault_key_unverified');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Key generation and owner lease diagnostics must not escape this boundary.
    throw Error('vault_key_unavailable');
  } finally {
    key?.fill(0);
    if (fd !== undefined) fs.closeSync(fd);
  }
}
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
