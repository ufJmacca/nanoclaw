import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration, type VaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { backupNasRootConfiguration, type BackupNasRootConfiguration } from './backup-nas-root-config.js';
import { observeBackupNasMount } from './backup-nas-kernel.js';
import { withBackupNasRootJournal } from './backup-nas-root-journal.js';
import { backupNasMountService } from './backup-nas-units.js';
import { verifyVaultMemory } from './vault-memory.js';
import {
  backupNasInitializationResource,
  type BackupNasInitializationResource,
} from './backup-nas-initialization-recovery-scope.js';
export type BackupNasServiceInstallControls = {
  /** Mandatory current sealed artifact/configuration and actual owner/native maintenance proof. */
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  paths?: Readonly<{
    configRoot: string;
    controlRoot: string;
    storageRoot: string;
    mount: string;
    systemUnits: string;
  }>;
  observe?: typeof observeBackupNasMount;
  run?(command: string, args: string[]): { status: number; output: string };
};
type Inode = Readonly<{ device: number; inode: number }>;
type Resource = Readonly<{ artifactDigest: string; contentDigest: string; claim: Inode }>;
type Pending = Resource & Readonly<{ stage: string }>;
type Installation = Readonly<{
  contract: 'cos-backup-nas-service-installation/v1';
  configurationDigest: string;
  vaultStateDigest: string;
  unitsParent: Inode;
  current: Resource | null;
  pending: Pending | null;
}>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const inode = (stat: fs.Stats): Inode => ({ device: stat.dev, inode: stat.ino });
const same = (stat: fs.Stats, claim: Inode) => stat.dev === claim.device && stat.ino === claim.inode;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
/** Claimed root files only. The real NAS writer, original closed underlay and idle
 * manager are required through every effect. A pending inode is journaled before
 * publication/replacement. Reload never enables, starts or stops any service.
 */
export function installBackupNasOnDemandService(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasServiceInstallControls,
): Promise<Record<string, unknown>> {
  return withBackupNasService(input, selected, controls, 'install');
}
/** Observe a complete unclaimed fixed service stage without claiming, publishing,
 * reloading or removing it. Existing accepted service and NAS claims stay intact.
 */
export function inspectBackupNasUnclaimedServiceStage(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasServiceInstallControls,
): Promise<BackupNasInitializationResource> {
  return withBackupNasService(input, selected, controls, 'inspect');
}
function withBackupNasService(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasServiceInstallControls,
  mode: 'install',
): Promise<Record<string, unknown>>;
function withBackupNasService(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasServiceInstallControls,
  mode: 'inspect',
): Promise<BackupNasInitializationResource>;
async function withBackupNasService(
  input: VaultRootConfiguration,
  selected: BackupNasRootConfiguration,
  controls: BackupNasServiceInstallControls,
  mode: 'install' | 'inspect',
): Promise<Record<string, unknown> | BackupNasInitializationResource> {
  const descriptors = new Set<number>();
  const close = (fd: number) => {
    if (descriptors.delete(fd)) fs.closeSync(fd);
  };
  let assertResources: (() => void) | undefined;
  try {
    const memory = controls.assertMemory ?? verifyVaultMemory;
    const role = () => {
      memory();
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_required');
    };
    role();
    const vault = vaultRootConfiguration(input),
      nas = backupNasRootConfiguration(selected, vault),
      identityDigest = vaultRootStateDigest(vault),
      configurationDigest = digest(nas),
      definition = backupNasMountService({ artifactDigest: vault.artifact.digest });
    const paths = Object.freeze({
      ...(controls.paths ?? {
        configRoot: '/etc/nanoclaw-cos',
        controlRoot: '/etc/nanoclaw-cos/control',
        storageRoot: '/var/lib/nanoclaw-cos',
        mount: '/var/lib/nanoclaw-cos/nas',
        systemUnits: '/etc/systemd/system',
      }),
    });
    const { systemUnits, ...journalPaths } = paths;
    if (
      Object.keys(paths).sort().join(',') !== 'configRoot,controlRoot,mount,storageRoot,systemUnits' ||
      !path.isAbsolute(systemUnits) ||
      path.resolve(systemUnits) !== systemUnits ||
      systemUnits === '/' ||
      Object.values(journalPaths).some(
        (directory) =>
          systemUnits === directory ||
          systemUnits.startsWith(directory + '/') ||
          directory.startsWith(systemUnits + '/'),
      )
    )
      throw Error('unsafe_unit_parent');
    const result = await withBackupNasRootJournal(
      vault,
      nas,
      async (lease) => {
        const parents = [
          [paths.systemUnits, 0o755],
          [paths.controlRoot, 0o700],
        ] as const;
        const held = parents.map(([directory, mode]) => {
          const before = fs.lstatSync(directory),
            fd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          descriptors.add(fd);
          return { directory, before, fd, mode };
        });
        const [units, control] = held;
        const guard = () => {
          role();
          for (const root of held) {
            for (const stat of [fs.fstatSync(root.fd), fs.lstatSync(root.directory)])
              if (
                !stat.isDirectory() ||
                stat.uid !== 0 ||
                (stat.mode & 0o7777) !== root.mode ||
                !same(stat, inode(root.before))
              )
                throw Error('unit_parent_changed');
            if (fs.realpathSync(root.directory) !== root.directory) throw Error('unit_parent_changed');
          }
        };
        guard();
        const filePath = (root: (typeof held)[number], name: string) => '/proc/self/fd/' + root.fd + '/' + name;
        const destination = filePath(units!, definition.name),
          journalName = 'nas-service-install.json',
          journalPath = filePath(control!, journalName);
        const open = (root: (typeof held)[number], name: string, mode: number, links = 1) => {
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
              (stat.mode & 0o7777) !== mode ||
              stat.nlink !== links ||
              stat.dev !== root.before.dev ||
              !same(stat, inode(before)) ||
              stat.size < 1 ||
              stat.size > 8192 ||
              stat.size !== before.size ||
              stat.mtimeMs !== before.mtimeMs ||
              stat.ctimeMs !== before.ctimeMs
            )
              throw Error('unit_file_changed');
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
            if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== before.size) throw Error('unit_file_changed');
            check();
            return { fd, before, text: bytes.subarray(0, before.size).toString('utf8'), check };
          } finally {
            bytes.fill(0);
          }
        };
        const validInode = (value: unknown): value is Inode =>
          object(value) &&
          Object.keys(value).sort().join(',') === 'device,inode' &&
          Number.isSafeInteger(value.device) &&
          Number(value.device) >= 0 &&
          Number.isSafeInteger(value.inode) &&
          Number(value.inode) > 0;
        const resource = (value: unknown, pending = false): value is Resource => {
          if (
            !object(value) ||
            Object.keys(value).sort().join(',') !==
              (pending ? 'artifactDigest,claim,contentDigest,stage' : 'artifactDigest,claim,contentDigest') ||
            typeof value.artifactDigest !== 'string' ||
            !/^[a-f0-9]{64}$/.test(value.artifactDigest) ||
            !validInode(value.claim) ||
            value.contentDigest !== hash(backupNasMountService({ artifactDigest: value.artifactDigest }).contents)
          )
            return false;
          return (
            !pending ||
            (typeof value.stage === 'string' &&
              /^\.nanoclaw-cos-backup-mount\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
                value.stage,
              ))
          );
        };
        const validate = (value: unknown): Installation => {
          if (
            !object(value) ||
            Object.keys(value).sort().join(',') !==
              'configurationDigest,contract,current,pending,unitsParent,vaultStateDigest' ||
            value.contract !== 'cos-backup-nas-service-installation/v1' ||
            value.configurationDigest !== configurationDigest ||
            value.vaultStateDigest !== identityDigest ||
            !validInode(value.unitsParent) ||
            !same(units!.before, value.unitsParent) ||
            (value.current !== null && !resource(value.current)) ||
            (value.pending !== null && !resource(value.pending, true)) ||
            (value.current === null && value.pending === null)
          )
            throw Error('unit_installation_conflict');
          return value as unknown as Installation;
        };
        let journal: ReturnType<typeof open> | undefined, record: Installation | undefined;
        let resources: Array<ReturnType<typeof open>> = [];
        if (fs.lstatSync(journalPath, { throwIfNoEntry: false })) {
          journal = open(control!, journalName, 0o600);
          record = validate(JSON.parse(journal.text));
        }
        const command = (args: string[]) => {
          role();
          const run =
            controls.run ??
            ((tool: string, values: string[]) => {
              const child = spawnSync(tool, values, {
                cwd: '/',
                env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 5000,
                maxBuffer: 8192,
              });
              if (child.error || child.signal || child.status === null) throw Error('manager_unavailable');
              return { status: child.status, output: child.stdout };
            });
          const result = run('/usr/bin/systemctl', args);
          role();
          if (result.status !== 0 || typeof result.output !== 'string' || Buffer.byteLength(result.output) > 8192)
            throw Error('manager_unverified');
          return result.output;
        };
        const properties = [
          'Id',
          'LoadState',
          'ActiveState',
          'SubState',
          'MainPID',
          'Job',
          'UnitFileState',
          'FragmentPath',
          'DropInPaths',
          'NeedDaemonReload',
        ];
        const manager = (loaded = false) => {
          const output = command(['show', '--no-pager', '--property=' + properties.join(','), definition.name]);
          const values = new Map<string, string>();
          const lines = output.split('\n');
          if (lines.pop() !== '') throw Error('manager_unverified');
          for (const line of lines) {
            const at = line.indexOf('=');
            if (at < 1 || values.has(line.slice(0, at))) throw Error('manager_unverified');
            values.set(line.slice(0, at), line.slice(at + 1));
          }
          if (
            [...values.keys()].sort().join(',') !== [...properties].sort().join(',') ||
            values.get('Id') !== definition.name ||
            !(
              (values.get('ActiveState') === 'inactive' && values.get('SubState') === 'dead') ||
              (values.get('ActiveState') === 'failed' && values.get('SubState') === 'failed')
            ) ||
            values.get('MainPID') !== '0' ||
            !['', '0'].includes(values.get('Job')!) ||
            values.get('DropInPaths') !== '' ||
            !['yes', 'no'].includes(values.get('NeedDaemonReload')!) ||
            (values.get('LoadState') === 'loaded'
              ? !record ||
                values.get('UnitFileState') !== 'static' ||
                values.get('FragmentPath') !== paths.systemUnits + '/' + definition.name
              : values.get('LoadState') !== 'not-found' ||
                !['', 'not-found'].includes(values.get('UnitFileState')!) ||
                values.get('FragmentPath') !== '') ||
            (loaded && (values.get('LoadState') !== 'loaded' || values.get('NeedDaemonReload') !== 'no'))
          )
            throw Error('manager_scope_conflict');
        };
        const local = () => {
          guard();
          journal?.check();
          for (const file of resources) file.check();
          const state = lease.readJournal();
          if (state.phase !== 'closed') throw Error('closed_nas_required');
          const observation = (controls.observe ?? observeBackupNasMount)(vault, nas, state);
          if (observation.state !== 'closed' || digest(observation.underlay) !== digest(state.underlay))
            throw Error('closed_nas_required');
        };
        const current = async () => {
          local();
          manager();
          await lease.assertCurrent();
          local();
          manager();
        };
        const clearResources = () => {
          for (const file of resources) close(file.fd);
          resources = [];
        };
        const inspect = () => {
          clearResources();
          guard();
          journal?.check();
          const stat = fs.lstatSync(destination, { throwIfNoEntry: false }),
            stage = record?.pending
              ? fs.lstatSync(filePath(units!, record.pending.stage), { throwIfNoEntry: false })
              : undefined;
          let installed: Resource | undefined;
          if (stat) {
            installed =
              [record?.pending, record?.current].find((value) => value && same(stat, value.claim)) ?? undefined;
            if (!installed) throw Error('unclaimed_unit_file');
            const file = open(
              units!,
              definition.name,
              0o644,
              stage && record?.pending && same(stat, record.pending.claim) ? 2 : 1,
            );
            if (
              file.text !== backupNasMountService({ artifactDigest: installed.artifactDigest }).contents ||
              hash(file.text) !== installed.contentDigest
            )
              throw Error('unit_content_changed');
            resources.push(file);
          }
          if (stage && record?.pending) {
            const file = open(units!, record.pending.stage, 0o644, stat && same(stat, record.pending.claim) ? 2 : 1);
            if (
              !same(file.before, record.pending.claim) ||
              file.text !== definition.contents ||
              hash(file.text) !== record.pending.contentDigest
            )
              throw Error('unit_stage_changed');
            resources.push(file);
          }
          if (
            record &&
            (!resources.length ||
              (!record.pending && !installed) ||
              (record.pending && !stage && installed?.artifactDigest !== record.pending.artifactDigest))
          )
            throw Error('claimed_unit_missing');
          return { installed, stage };
        };
        const save = (next: Installation) => {
          local();
          const name = '.nas-service-install.' + randomUUID() + '.tmp',
            temporary = filePath(control!, name);
          let fd: number | undefined, owned: fs.Stats | undefined;
          const bytes = Buffer.from(JSON.stringify(validate(next)) + '\n');
          try {
            fd = fs.openSync(
              temporary,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
            owned = fs.fstatSync(fd);
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
            const ready = open(control!, name, 0o600);
            if (!same(ready.before, inode(owned)) || ready.text !== bytes.toString('utf8'))
              throw Error('unit_journal_write_changed');
            close(ready.fd);
            local();
            if (journal) {
              journal.check();
              fs.renameSync(temporary, journalPath);
            } else {
              fs.linkSync(temporary, journalPath);
              fs.unlinkSync(temporary);
            }
            if (journal) close(journal.fd);
            journal = open(control!, journalName, 0o600);
            record = validate(JSON.parse(journal.text));
            if (!same(journal.before, inode(owned)) || digest(record) !== digest(next))
              throw Error('unit_journal_write_changed');
            fs.fsyncSync(journal.fd);
            fs.fsyncSync(control!.fd);
            local();
          } finally {
            bytes.fill(0);
            if (fd !== undefined) fs.closeSync(fd);
            const remaining = fs.lstatSync(temporary, { throwIfNoEntry: false });
            if (owned && remaining?.isFile() && remaining.uid === 0 && same(remaining, inode(owned))) {
              fs.unlinkSync(temporary);
              fs.fsyncSync(control!.fd);
            }
          }
        };
        let observation = inspect();
        if (record?.pending && record.pending.artifactDigest !== vault.artifact.digest)
          throw Error('pending_unit_scope_conflict');
        await current();
        if (mode === 'inspect') {
          if (record?.pending) throw Error('claimed_service_stage');
          const unclaimed = () => {
            guard();
            journal?.check();
            if (
              !journal &&
              (fs.lstatSync(journalPath, { throwIfNoEntry: false }) ||
                fs.lstatSync(destination, { throwIfNoEntry: false }))
            )
              throw Error('unclaimed_service_installation_changed');
            const directory = fs.opendirSync('/proc/self/fd/' + units!.fd, { bufferSize: 32 });
            let stage: string | undefined;
            try {
              let count = 0,
                entry: fs.Dirent | null;
              while ((entry = directory.readSync())) {
                if (++count > 1024) throw Error('service_stage_bounds');
                if (entry.name.startsWith('.nanoclaw-cos-backup-mount.')) {
                  if (
                    stage ||
                    !/^\.nanoclaw-cos-backup-mount\.[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.tmp$/.test(
                      entry.name,
                    )
                  )
                    throw Error('ambiguous_service_stage');
                  stage = entry.name;
                }
              }
            } finally {
              directory.closeSync();
            }
            guard();
            if (!stage) throw Error('service_stage_missing');
            return stage;
          };
          const stage = unclaimed(),
            staged = open(units!, stage, 0o644);
          if (staged.text !== definition.contents) throw Error('service_stage_content_changed');
          resources.push(staged);
          const unchanged = () => {
            guard();
            journal?.check();
            for (const file of resources) file.check();
            if (unclaimed() !== stage) throw Error('service_stage_changed');
            manager();
          };
          await current();
          unchanged();
          assertResources = unchanged;
          return backupNasInitializationResource({
            kind: 'service-stage',
            stageId: stage.slice('.nanoclaw-cos-backup-mount.'.length, -'.tmp'.length),
            ...inode(staged.before),
            contentDigest: hash(staged.text),
          });
        }
        if (!record?.pending && record?.current?.artifactDigest !== vault.artifact.digest) {
          const directory = fs.opendirSync('/proc/self/fd/' + units!.fd, { bufferSize: 32 });
          try {
            let count = 0,
              entry: fs.Dirent | null;
            while ((entry = directory.readSync()))
              if (++count > 1024 || entry.name.startsWith('.nanoclaw-cos-backup-mount.'))
                throw Error('unclaimed_unit_stage');
          } finally {
            directory.closeSync();
          }
          local();
          const stage = '.nanoclaw-cos-backup-mount.' + randomUUID() + '.tmp',
            stagePath = filePath(units!, stage),
            fd = fs.openSync(
              stagePath,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
          descriptors.add(fd);
          const bytes = Buffer.from(definition.contents);
          try {
            fs.writeFileSync(fd, bytes);
            fs.fchmodSync(fd, 0o644);
            fs.fsyncSync(fd);
            fs.fsyncSync(units!.fd);
          } finally {
            bytes.fill(0);
          }
          const staged = open(units!, stage, 0o644);
          if (!same(staged.before, inode(fs.fstatSync(fd))) || staged.text !== definition.contents)
            throw Error('unit_stage_changed');
          close(fd);
          resources.push(staged);
          const next: Installation = {
            contract: 'cos-backup-nas-service-installation/v1',
            configurationDigest,
            vaultStateDigest: identityDigest,
            unitsParent: inode(units!.before),
            current: record?.current ?? null,
            pending: {
              artifactDigest: vault.artifact.digest,
              contentDigest: hash(definition.contents),
              claim: inode(staged.before),
              stage,
            },
          };
          await current();
          save(next);
          observation = inspect();
          await current();
        }
        if (!record || !journal) throw Error('unit_installation_required');
        fs.fsyncSync(journal.fd);
        fs.fsyncSync(control!.fd);
        for (const file of resources) fs.fsyncSync(file.fd);
        fs.fsyncSync(units!.fd);
        await current();
        if (record.pending) {
          const pending = record.pending;
          if (!observation.installed || !same(fs.lstatSync(destination), pending.claim)) {
            if (!observation.stage) throw Error('claimed_unit_stage_missing');
            clearResources();
            local();
            if (observation.installed) fs.renameSync(filePath(units!, pending.stage), destination);
            else fs.linkSync(filePath(units!, pending.stage), destination);
            fs.fsyncSync(units!.fd);
            observation = inspect();
            await current();
          }
          if (observation.stage) {
            clearResources();
            local();
            fs.unlinkSync(filePath(units!, pending.stage));
            fs.fsyncSync(units!.fd);
            inspect();
            await current();
          }
          const { stage: _stage, ...installed } = pending;
          save({ ...record, current: installed, pending: null });
          inspect();
          await current();
        }
        await current();
        if (command(['daemon-reload']) !== '') throw Error('manager_reload_unverified');
        await current();
        manager(true);
        for (const file of resources) fs.fsyncSync(file.fd);
        fs.fsyncSync(units!.fd);
        fs.fsyncSync(journal.fd);
        fs.fsyncSync(control!.fd);
        await current();
        manager(true);
        assertResources = () => {
          guard();
          journal!.check();
          for (const file of resources) file.check();
          manager(true);
        };
        return Object.freeze({
          contract: 'cos-backup-nas-service-installation-result/v1',
          status: 'installed',
          configurationDigest,
          artifactDigest: vault.artifact.digest,
          unitDigest: hash(definition.contents),
        });
      },
      { assertAuthority: controls.assertAuthority, assertMemory: memory, paths: journalPaths },
    );
    // The enclosing root lease performs a final native-authority await before returning.
    // Retain and recheck this operation's own unit/ownership descriptors through that cleanup.
    if (!assertResources) throw Error('unit_resources_required');
    assertResources();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Root paths, private scope and manager/native diagnostics never enter receipts.
    throw Error(
      mode === 'inspect'
        ? 'backup_nas_service_stage_observation_unavailable'
        : 'backup_nas_service_installation_unavailable',
    );
  } finally {
    for (const fd of descriptors) fs.closeSync(fd);
  }
}
