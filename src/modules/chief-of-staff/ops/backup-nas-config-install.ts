import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import { verifyVaultMemory } from './vault-memory.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
import {
  backupNasInitializationRetirementJournal,
  transitionBackupNasInitializationRetirement,
} from './backup-nas-initialization-retirement-state.js';
import { withBackupNasInitializationRetirementJournal } from './backup-nas-initialization-retirement-journal.js';
type RetirementResult = Awaited<ReturnType<typeof transitionBackupNasInitializationRetirement>>;
type Paths = Readonly<{ configRoot: string; controlRoot: string; storageRoot: string }>;
export type BackupNasConfigurationInstallControls = {
  /** The installed caller must recheck the sealed helper, current configuration and actual native maintenance proof. */
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  /** Source-only filesystem fixtures. No installed path or role selector. */
  paths?: Paths;
};
type Inode = Readonly<{ device: number; inode: number }>;
type Installation = Readonly<{
  contract: 'cos-backup-nas-config-installation/v1';
  configurationDigest: string;
  vaultStateDigest: string;
  phase: 'publishing' | 'installed';
  stage: string | null;
  file: Inode;
}>;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const inode = (stat: fs.Stats): Inode => ({ device: stat.dev, inode: stat.ino });
const same = (stat: fs.Stats, claim: Inode) => stat.dev === claim.device && stat.ino === claim.inode;
/** First installation only, or exact replay of a root-owned publication. The accepted
 * G01 bootstrap is required and preserved. Metadata is synced and its inode journaled
 * before an exclusive hard-link publication; a retry never adopts an unclaimed file.
 * Every effect remains under the real root writer and a fresh native authority check.
 */
export function installBackupNasRootConfiguration(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
): Promise<BackupNasRootConfiguration> {
  return withBackupNasRootConfiguration(input, selected, controls, 'install');
}
/** Observe one complete unclaimed first-install stage. This grants no ownership,
 * performs no publication or repair, and preserves accepted G01 resources.
 */
export function inspectBackupNasUnclaimedConfigurationStage(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
): Promise<BackupNasInitializationResource> {
  return withBackupNasRootConfiguration(input, selected, controls, 'inspect');
}
/** Fresh resource-specific permission is mandatory. Only this exact complete
 * unclaimed stage may be removed, with durable intent before the fixed unlink.
 * Existing G01 resources and NAS publication claims are never changed.
 */
export function retireBackupNasUnclaimedConfigurationStage(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  resource: BackupNasInitializationResource,
  controls: BackupNasConfigurationInstallControls,
): Promise<RetirementResult> {
  return withBackupNasRootConfiguration(input, selected, controls, 'retire', resource);
}
function withBackupNasRootConfiguration(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
  mode: 'install',
): Promise<BackupNasRootConfiguration>;
function withBackupNasRootConfiguration(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
  mode: 'inspect',
): Promise<BackupNasInitializationResource>;
function withBackupNasRootConfiguration(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
  mode: 'retire',
  resource: BackupNasInitializationResource,
): Promise<RetirementResult>;
async function withBackupNasRootConfiguration(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasConfigurationInstallControls,
  mode: 'install' | 'inspect' | 'retire',
  selectedResource?: BackupNasInitializationResource,
): Promise<BackupNasRootConfiguration | BackupNasInitializationResource | RetirementResult> {
  const descriptors = new Set<number>();
  let finalObservation: (() => void) | undefined;
  const close = (fd: number) => {
    if (descriptors.delete(fd)) fs.closeSync(fd);
  };
  try {
    const role = () => {
      (controls.assertMemory ?? verifyVaultMemory)();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault),
      configurationDigest = digest(nas),
      identityDigest = vaultRootStateDigest(vault);
    const recovery = mode === 'retire' ? backupNasInitializationResource(selectedResource) : undefined;
    if (recovery && recovery.kind !== 'configuration-stage') throw Error('configuration_stage_required');
    const paths = Object.freeze({
      ...(controls.paths ?? {
        configRoot: '/etc/nanoclaw-cos',
        controlRoot: '/etc/nanoclaw-cos/control',
        storageRoot: '/var/lib/nanoclaw-cos',
      }),
    });
    if (
      Object.keys(paths).sort().join(',') !== 'configRoot,controlRoot,storageRoot' ||
      paths.controlRoot !== paths.configRoot + '/control' ||
      Object.values(paths).some(
        (directory) =>
          !path.isAbsolute(directory) ||
          path.resolve(directory) !== directory ||
          directory === '/' ||
          fs.realpathSync(path.dirname(directory)) !== path.dirname(directory),
      )
    )
      throw Error('unsafe_root_paths');
    const parents = (
      [
        ['configRoot', 0o700],
        ['controlRoot', 0o700],
        ['storageRoot', 0o711],
      ] as const
    ).map(([name, mode]) => {
      const directory = paths[name],
        before = fs.lstatSync(directory),
        fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      descriptors.add(fd);
      return { directory, before, fd, mode };
    });
    const [config, control, storage] = parents;
    const guard = () => {
      role();
      for (const root of parents) {
        for (const stat of [fs.fstatSync(root.fd), fs.lstatSync(root.directory)])
          if (
            !stat.isDirectory() ||
            stat.uid !== 0 ||
            (stat.mode & 0o7777) !== root.mode ||
            stat.dev !== root.before.dev ||
            stat.ino !== root.before.ino
          )
            throw Error('root_parent_changed');
        if (fs.realpathSync(root.directory) !== root.directory) throw Error('root_parent_changed');
      }
    };
    guard();
    const filePath = (root: (typeof parents)[number], name: string) => '/proc/self/fd/' + root.fd + '/' + name;
    const open = (root: (typeof parents)[number], name: string, links = 1) => {
      guard();
      const file = filePath(root, name),
        initial = fs.lstatSync(file),
        fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      descriptors.add(fd);
      const before = fs.fstatSync(fd);
      const privateFile = (stat: fs.Stats) => {
        if (
          !stat.isFile() ||
          stat.uid !== 0 ||
          (stat.mode & 0o7777) !== 0o600 ||
          stat.nlink !== links ||
          stat.dev !== root.before.dev ||
          stat.dev !== before.dev ||
          stat.ino !== before.ino ||
          stat.size < 1 ||
          stat.size > 4096 ||
          stat.size !== before.size ||
          stat.mtimeMs !== before.mtimeMs ||
          stat.ctimeMs !== before.ctimeMs
        )
          throw Error('root_file_changed');
      };
      privateFile(initial);
      const check = () => {
        guard();
        privateFile(fs.fstatSync(fd));
        privateFile(fs.lstatSync(file));
      };
      const bytes = Buffer.alloc(before.size + 1);
      try {
        check();
        if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('root_file_changed');
        check();
        const text = bytes.subarray(0, before.size).toString('utf8'),
          value: unknown = JSON.parse(text);
        return { fd, before, text, value, check };
      } finally {
        bytes.fill(0);
      }
    };
    const bootstrap = open(config!, 'vault-bootstrap.json'),
      accepted = bootstrap.value;
    if (
      !object(accepted) ||
      Object.keys(accepted).sort().join(',') !== 'claims,contract,identityDigest,phase' ||
      accepted.contract !== 'cos-vault-root-state/v1' ||
      accepted.identityDigest !== identityDigest ||
      accepted.phase !== 'complete' ||
      !object(accepted.claims) ||
      Object.keys(accepted.claims).sort().join(',') !== 'control,storage'
    )
      throw Error('accepted_vault_required');
    for (const [name, root] of [
      ['control', control!],
      ['storage', storage!],
    ] as const)
      if (
        !object(accepted.claims[name]) ||
        Object.keys(accepted.claims[name]).sort().join(',') !== 'device,inode' ||
        digest(accepted.claims[name]) !== digest(inode(root.before))
      )
        throw Error('accepted_vault_claim_changed');
    const authority = async () => {
      guard();
      bootstrap.check();
      await controls.assertAuthority();
      bootstrap.check();
      guard();
    };
    await authority();
    const writer = new BackupRepositoryWriter(
      digest({ contract: 'cos-backup-nas-mount-writer/v1', configurationDigest }),
      async (operation) => {
        guard();
        const result = await operation('/proc/self/fd/' + control!.fd);
        guard();
        return result;
      },
    );
    const result = await writer.exclusive(async (lease) => {
      const filename = 'nas-config-install.json',
        journalPath = filePath(control!, filename),
        destination = filePath(config!, 'backup-nas.json');
      let journal: ReturnType<typeof open> | undefined;
      let resources: Array<ReturnType<typeof open>> = [];
      const current = async () => {
        lease.assertCurrent();
        journal?.check();
        for (const resource of resources) resource.check();
        await authority();
        journal?.check();
        for (const resource of resources) resource.check();
        lease.assertCurrent();
      };
      const validate = (value: unknown): Installation => {
        if (
          !object(value) ||
          Object.keys(value).sort().join(',') !== 'configurationDigest,contract,file,phase,stage,vaultStateDigest' ||
          value.contract !== 'cos-backup-nas-config-installation/v1' ||
          value.configurationDigest !== configurationDigest ||
          value.vaultStateDigest !== identityDigest ||
          !['publishing', 'installed'].includes(String(value.phase)) ||
          !object(value.file) ||
          Object.keys(value.file).sort().join(',') !== 'device,inode' ||
          !Number.isSafeInteger(value.file.device) ||
          Number(value.file.device) < 0 ||
          !Number.isSafeInteger(value.file.inode) ||
          Number(value.file.inode) < 1 ||
          (value.phase === 'installed'
            ? value.stage !== null
            : typeof value.stage !== 'string' ||
              !/^\.backup-nas\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
                value.stage,
              ))
        )
          throw Error('nas_installation_conflict');
        return value as unknown as Installation;
      };
      const save = (record: Installation) => {
        guard();
        bootstrap.check();
        lease.assertCurrent();
        journal?.check();
        const name = '.backup-nas-journal.' + randomUUID() + '.tmp',
          temporary = filePath(control!, name);
        let temporaryFd: number | undefined, owned: fs.Stats | undefined;
        const bytes = Buffer.from(JSON.stringify(validate(record)) + '\n');
        try {
          temporaryFd = fs.openSync(
            temporary,
            fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
            0o600,
          );
          owned = fs.fstatSync(temporaryFd);
          fs.writeFileSync(temporaryFd, bytes);
          fs.fsyncSync(temporaryFd);
          const ready = open(control!, name);
          ready.check();
          if (!same(ready.before, inode(owned)) || ready.text !== bytes.toString('utf8'))
            throw Error('nas_installation_write_changed');
          close(ready.fd);
          guard();
          bootstrap.check();
          lease.assertCurrent();
          if (journal) {
            journal.check();
            fs.renameSync(temporary, journalPath);
          } else {
            fs.linkSync(temporary, journalPath);
            fs.unlinkSync(temporary);
          }
          if (journal) close(journal.fd);
          journal = open(control!, filename);
          if (!same(journal.before, inode(owned)) || digest(validate(journal.value)) !== digest(record))
            throw Error('nas_installation_write_changed');
          fs.fsyncSync(journal.fd);
          fs.fsyncSync(control!.fd);
          journal.check();
        } finally {
          bytes.fill(0);
          if (temporaryFd !== undefined) fs.closeSync(temporaryFd);
          const remaining = fs.lstatSync(temporary, { throwIfNoEntry: false });
          if (owned && remaining && same(remaining, inode(owned)) && remaining.isFile() && remaining.uid === 0) {
            fs.unlinkSync(temporary);
            fs.fsyncSync(control!.fd);
          }
        }
      };
      const text =
        JSON.stringify({
          contract: nas.contract,
          host: nas.host,
          credentialReference: nas.credentialReference,
          vaultStateDigest: nas.vaultStateDigest,
        }) + '\n';
      await current();
      if (mode === 'inspect' || mode === 'retire') {
        const unclaimed = () => {
          guard();
          bootstrap.check();
          if (
            fs.lstatSync(journalPath, { throwIfNoEntry: false }) ||
            fs.lstatSync(destination, { throwIfNoEntry: false })
          )
            throw Error('unclaimed_configuration_stage_required');
          const directory = fs.opendirSync('/proc/self/fd/' + config!.fd, { bufferSize: 32 });
          let stage: string | undefined;
          try {
            let count = 0,
              entry: fs.Dirent | null;
            while ((entry = directory.readSync())) {
              if (++count > 128) throw Error('stage_inspection_bounds');
              if (entry.name.startsWith('.backup-nas.')) {
                if (
                  stage ||
                  !/^\.backup-nas\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
                    entry.name,
                  )
                )
                  throw Error('ambiguous_configuration_stage');
                stage = entry.name;
              }
            }
          } finally {
            directory.closeSync();
          }
          guard();
          return stage;
        };
        if (mode === 'retire') {
          if (!recovery || recovery.kind !== 'configuration-stage') throw Error('configuration_stage_required');
          const scope = Object.freeze({
              nasDigest: configurationDigest,
              vaultStateDigest: identityDigest,
              resource: recovery,
            }),
            name = '.backup-nas.' + recovery.stageId + '.tmp',
            point = filePath(config!, name),
            retirementName = 'nas-initialization-retirement.' + digest(scope) + '.json';
          let staged: ReturnType<typeof open> | undefined, retiredStat: fs.Stats | undefined;
          const namespace = () => {
            const actual = unclaimed();
            if (actual !== undefined && actual !== name) throw Error('another_configuration_stage');
            if (retiredStat) {
              if (actual !== undefined || fs.lstatSync(point, { throwIfNoEntry: false }))
                throw Error('retired_stage_reappeared');
              const stat = fs.fstatSync(staged!.fd);
              if (
                !stat.isFile() ||
                stat.uid !== 0 ||
                (stat.mode & 0o7777) !== 0o600 ||
                stat.nlink !== 0 ||
                stat.dev !== retiredStat.dev ||
                stat.ino !== retiredStat.ino ||
                stat.size !== retiredStat.size ||
                stat.mtimeMs !== retiredStat.mtimeMs ||
                stat.ctimeMs !== retiredStat.ctimeMs
              )
                throw Error('removed_stage_changed');
            } else staged?.check();
            return actual;
          };
          const observe = () => {
            const actual = namespace();
            if (actual === undefined) {
              // Repeat the parent sync for an unlink interrupted before durability.
              // Absence is accepted only with a matching recorded intent.
              fs.fsyncSync(config!.fd);
              return Object.freeze({ state: 'absent' as const });
            }
            if (!staged) {
              staged = open(config!, name);
              if (
                staged.text !== text ||
                digest(backupNasRootConfiguration(staged.value, vault)) !== configurationDigest
              )
                throw Error('configuration_stage_content_changed');
              resources = [staged];
            }
            staged.check();
            const actualResource = backupNasInitializationResource({
              kind: 'configuration-stage',
              stageId: recovery.stageId,
              ...inode(staged.before),
              contentDigest: createHash('sha256').update(staged.text).digest('hex'),
            });
            if (digest(actualResource) !== digest(recovery)) throw Error('configuration_stage_resource_changed');
            return Object.freeze({ state: 'present' as const, resource: actualResource });
          };
          const assertRecovery = async () => {
            namespace();
            await current();
            namespace();
          };
          return withBackupNasInitializationRetirementJournal(
            scope,
            {
              controlFd: control!.fd,
              assertAuthority: assertRecovery,
              assertMemory: controls.assertMemory,
            },
            async (retirement) => {
              const result = await transitionBackupNasInitializationRetirement(scope, {
                assertAuthority: retirement.assertCurrent,
                readJournal: async () => retirement.readJournal(),
                writeJournal: retirement.writeJournal,
                observe: async () => observe(),
                retire: async () => {
                  namespace();
                  lease.assertCurrent();
                  guard();
                  bootstrap.check();
                  if (!staged || observe().state !== 'present') throw Error('held_stage_required');
                  staged.check();
                  fs.unlinkSync(point);
                  retiredStat = fs.fstatSync(staged.fd);
                  resources = [];
                  fs.fsyncSync(config!.fd);
                  namespace();
                },
              });
              const completion = open(control!, retirementName);
              if (backupNasInitializationRetirementJournal(completion.value, scope).phase !== 'retired')
                throw Error('retirement_completion_required');
              resources.push(completion);
              finalObservation = () => {
                guard();
                bootstrap.check();
                completion.check();
                if (namespace() !== undefined) throw Error('retirement_absence_required');
                if (backupNasInitializationRetirementJournal(completion.value, scope).phase !== 'retired')
                  throw Error('retirement_completion_required');
              };
              finalObservation();
              return result;
            },
          );
        }
        const stage = unclaimed(),
          staged = stage ? open(config!, stage) : undefined;
        if (!stage || !staged) throw Error('configuration_stage_missing');
        if (staged.text !== text || digest(backupNasRootConfiguration(staged.value, vault)) !== configurationDigest)
          throw Error('configuration_stage_content_changed');
        resources = [staged];
        finalObservation = () => {
          staged.check();
          if (unclaimed() !== stage) throw Error('configuration_stage_changed');
          staged.check();
        };
        await current();
        finalObservation();
        return backupNasInitializationResource({
          kind: 'configuration-stage',
          stageId: stage.slice('.backup-nas.'.length, -'.tmp'.length),
          ...inode(staged.before),
          contentDigest: createHash('sha256').update(staged.text).digest('hex'),
        });
      }
      let record: Installation;
      if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
        journal = open(control!, filename);
        record = validate(journal.value);
      } else {
        if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('unclaimed_nas_configuration');
        await current();
        const directory = fs.opendirSync('/proc/self/fd/' + config!.fd, { bufferSize: 32 });
        try {
          let count = 0,
            entry: fs.Dirent | null;
          while ((entry = directory.readSync()))
            if (++count > 128 || entry.name.startsWith('.backup-nas.')) throw Error('unclaimed_nas_stage');
        } finally {
          directory.closeSync();
        }
        guard();
        const stage = '.backup-nas.' + randomUUID() + '.tmp',
          stagePath = filePath(config!, stage);
        const fd = fs.openSync(
          stagePath,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        descriptors.add(fd);
        const bytes = Buffer.from(text);
        try {
          fs.writeFileSync(fd, bytes);
          fs.fsyncSync(fd);
          fs.fsyncSync(config!.fd);
        } finally {
          bytes.fill(0);
        }
        const staged = open(config!, stage);
        if (!same(staged.before, inode(fs.fstatSync(fd))) || staged.text !== text) throw Error('nas_stage_changed');
        close(fd);
        resources = [staged];
        record = validate({
          contract: 'cos-backup-nas-config-installation/v1',
          configurationDigest,
          vaultStateDigest: identityDigest,
          phase: 'publishing',
          stage,
          file: inode(staged.before),
        });
        await current();
        save(record);
      }
      const clearResources = () => {
        for (const resource of resources) close(resource.fd);
        resources = [];
      };
      const inspect = () => {
        clearResources();
        guard();
        journal!.check();
        const stage = record.stage
            ? fs.lstatSync(filePath(config!, record.stage), { throwIfNoEntry: false })
            : undefined,
          installed = fs.lstatSync(destination, { throwIfNoEntry: false }),
          links = stage && installed ? 2 : 1;
        for (const name of [...(stage ? [record.stage!] : []), ...(installed ? ['backup-nas.json'] : [])]) {
          const resource = open(config!, name, links);
          if (
            !same(resource.before, record.file) ||
            resource.text !== text ||
            digest(backupNasRootConfiguration(resource.value, vault)) !== configurationDigest
          )
            throw Error('nas_configuration_changed');
          resources.push(resource);
        }
        if (!resources.length || (record.phase === 'installed' && !installed))
          throw Error('claimed_nas_configuration_missing');
        return { stage, installed };
      };
      let observation = inspect();
      await current();
      // Repeat durability of a previous interrupted journal before it can authorize publication.
      fs.fsyncSync(journal!.fd);
      fs.fsyncSync(control!.fd);
      for (const resource of resources) fs.fsyncSync(resource.fd);
      fs.fsyncSync(config!.fd);
      await current();
      if (record.phase === 'publishing') {
        if (!observation.installed) {
          if (!observation.stage || !record.stage) throw Error('claimed_nas_stage_missing');
          clearResources();
          guard();
          lease.assertCurrent();
          journal!.check();
          fs.linkSync(filePath(config!, record.stage), destination);
          fs.fsyncSync(config!.fd);
          observation = inspect();
          await current();
        }
        if (observation.stage) {
          clearResources();
          guard();
          journal!.check();
          lease.assertCurrent();
          fs.unlinkSync(filePath(config!, record.stage!));
          fs.fsyncSync(config!.fd);
          inspect();
          await current();
        }
        record = validate({ ...record, phase: 'installed', stage: null });
        save(record);
        await current();
      }
      inspect();
      for (const resource of resources) fs.fsyncSync(resource.fd);
      fs.fsyncSync(config!.fd);
      fs.fsyncSync(journal!.fd);
      fs.fsyncSync(control!.fd);
      await current();
      return nas;
    });
    // The writer's final native closure happens before this synchronous check.
    // Keep every resource descriptor and the accepted bootstrap pinned until it passes.
    finalObservation?.();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private endpoints, paths and native-proof diagnostics are never installation receipts.
    throw Error(
      mode === 'inspect'
        ? 'backup_nas_configuration_stage_observation_unavailable'
        : mode === 'retire'
          ? 'backup_nas_configuration_stage_retirement_unavailable'
          : 'backup_nas_configuration_installation_unavailable',
    );
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}
