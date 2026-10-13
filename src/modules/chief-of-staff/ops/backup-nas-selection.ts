import fs from 'node:fs';
import path from 'node:path';
import { backupNasMountCommand } from './backup-nas-units.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';

export type BackupNasSelection = Readonly<{
  contract: 'cos-backup-nas-selection/v1';
  targetDigest: string;
  nas: BackupNasRootConfiguration;
}>;
const name = 'backup-nas-selection.json';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stagePattern =
  /^backup-nas-selection\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.partial$/;
const pinned = (fd: number) => '/proc/self/fd/' + fd;
function selectionMetadata(value: unknown): BackupNasSelection {
  const object = (input: unknown): input is Record<string, unknown> =>
    !!input && typeof input === 'object' && !Array.isArray(input);
  const hash = (input: unknown) => typeof input === 'string' && /^[a-f0-9]{64}$/.test(input);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'contract,nas,targetDigest' ||
    value.contract !== 'cos-backup-nas-selection/v1' ||
    !hash(value.targetDigest) ||
    !object(value.nas) ||
    Object.keys(value.nas).sort().join(',') !== 'contract,credentialReference,host,vaultStateDigest' ||
    value.nas.contract !== 'cos-backup-nas-root-config/v1' ||
    typeof value.nas.host !== 'string' ||
    typeof value.nas.credentialReference !== 'string' ||
    !uuid.test(value.nas.credentialReference) ||
    !hash(value.nas.vaultStateDigest)
  )
    throw Error('invalid_nas_selection');
  // The fixed mount definition validates the private IPv4 endpoint; this does
  // not execute it or grant a mount/credential capability.
  backupNasMountCommand({ host: value.nas.host, userId: 1, groupId: 1 });
  return Object.freeze({
    contract: 'cos-backup-nas-selection/v1',
    targetDigest: value.targetDigest,
    nas: Object.freeze({ ...value.nas }),
  }) as BackupNasSelection;
}
export function backupNasSelection(value: unknown, input: VaultRootConfiguration): BackupNasSelection {
  const vault = vaultRootConfiguration(input);
  const selected = selectionMetadata(value);
  if (selected.targetDigest !== vault.identity.targetDigest) throw Error('nas_selection_conflict');
  return Object.freeze({
    contract: 'cos-backup-nas-selection/v1',
    targetDigest: vault.identity.targetDigest,
    nas: backupNasRootConfiguration(selected.nas, vault),
  });
}

/** Non-secret destination metadata, never a restored permission or credential.
 * A verified root setup receipt and the caller's live owner/native proofs precede
 * this publication. Existing values cannot be replaced by another destination. */
export async function publishBackupNasSelection(
  root: string,
  selected: BackupNasSelection,
  operationId: string,
  check: () => Promise<void>,
): Promise<void> {
  const descriptors: number[] = [];
  try {
    if (
      process.platform !== 'linux' ||
      !path.isAbsolute(root) ||
      path.resolve(root) !== root ||
      root === '/' ||
      typeof operationId !== 'string' ||
      !uuid.test(operationId)
    )
      throw Error('selection_publication_scope');
    const bytes = Buffer.from(JSON.stringify(selectionMetadata(selected)) + '\n');
    if (bytes.length > 8192) throw Error('selection_bounds');
    await check();
    if (fs.realpathSync(root) !== root) throw Error('selection_parent_changed');
    const before = fs.lstatSync(root),
      parentFd = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    descriptors.push(parentFd);
    const parent = () => {
      for (const current of [fs.fstatSync(parentFd), fs.lstatSync(root)])
        if (
          !current.isDirectory() ||
          current.uid !== process.getuid?.() ||
          (current.mode & 0o7777) !== 0o700 ||
          current.dev !== before.dev ||
          current.ino !== before.ino ||
          fs.realpathSync(root) !== root
        )
          throw Error('selection_parent_changed');
    };
    const current = async () => {
      parent();
      await check();
      parent();
    };
    const held = (file: string, links: number[]) => {
      parent();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.push(fd);
      const initial = fs.fstatSync(fd);
      const verify = () => {
        parent();
        for (const stat of [fs.fstatSync(fd), fs.lstatSync(file)])
          if (
            !stat.isFile() ||
            stat.uid !== before.uid ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.dev !== before.dev ||
            stat.dev !== initial.dev ||
            stat.ino !== initial.ino ||
            !links.includes(stat.nlink) ||
            stat.size !== bytes.length ||
            stat.mtimeMs !== initial.mtimeMs ||
            stat.ctimeMs !== initial.ctimeMs
          )
            throw Error('selection_file_changed');
        const data = Buffer.alloc(bytes.length + 1);
        try {
          if (
            fs.readSync(fd, data, 0, data.length, 0) !== bytes.length ||
            !data.subarray(0, bytes.length).equals(bytes)
          )
            throw Error('selection_content_changed');
        } finally {
          data.fill(0);
        }
        parent();
      };
      verify();
      return { fd, initial, verify };
    };
    const final = path.join(pinned(parentFd), name),
      stageName = 'backup-nas-selection.' + operationId + '.partial',
      stage = path.join(pinned(parentFd), stageName);
    parent();
    if (fs.lstatSync(final, { throwIfNoEntry: false })) {
      const old = held(final, [1, 2]);
      await current();
      old.verify();
      if (old.initial.nlink === 2) {
        const aliases = fs
          .readdirSync(pinned(parentFd))
          .filter(
            (entry) =>
              stagePattern.test(entry) && fs.lstatSync(path.join(pinned(parentFd), entry)).ino === old.initial.ino,
          );
        if (aliases.length !== 1) throw Error('selection_alias_unverified');
        const alias = path.join(pinned(parentFd), aliases[0]),
          aliasProof = held(alias, [2]);
        await current();
        old.verify();
        aliasProof.verify();
        fs.unlinkSync(alias);
      }
      fs.fsyncSync(parentFd);
      await current();
      const proof = held(final, [1]);
      proof.verify();
      return;
    }
    if (!fs.lstatSync(stage, { throwIfNoEntry: false })) {
      const fd = fs.openSync(
        stage,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.fsyncSync(parentFd);
    }
    const pending = held(stage, [1]);
    await current();
    pending.verify();
    fs.linkSync(stage, final);
    fs.fsyncSync(parentFd);
    const linked = held(final, [2]);
    await current();
    linked.verify();
    const alias = held(stage, [2]);
    alias.verify();
    if (alias.initial.ino !== linked.initial.ino) throw Error('selection_alias_changed');
    fs.unlinkSync(stage);
    fs.fsyncSync(parentFd);
    await current();
    const completed = held(final, [1]);
    completed.verify();
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private endpoint metadata, paths and publication errors stay within the owner boundary.
    throw Error('backup_nas_selection_unavailable');
  } finally {
    for (const fd of descriptors.reverse()) fs.closeSync(fd);
  }
}
