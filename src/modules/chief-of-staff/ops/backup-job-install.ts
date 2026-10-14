import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { deploymentSettings, type DeploymentSettings } from './deployment-settings.js';
import { validateReleaseManifest, type ReleaseManifest } from './release-manifest.js';
import { backupJobUnits } from './backup-job-units.js';
import { readPrivate, writeAtomic } from './target-state.js';
export type BackupJobManager = {
  owned: boolean;
  jobsIdle: boolean;
  timersActive: boolean;
  timersRunning: boolean;
  definitionsLoaded: boolean;
};
export type BackupJobInstallControls = {
  assertCurrent(): Promise<void>;
  inspectManager(): Promise<BackupJobManager>;
  compile(files: readonly string[]): Promise<void>;
  stopTimers(): Promise<void>;
  reload(): Promise<void>;
  enableTimers(): Promise<void>;
  startTimers(): Promise<void>;
};
type Inode = { device: number; inode: number };
type FileClaim = Inode & { sha256: string };
type Pending = FileClaim & { name: string; temporary: string };
type Installation = {
  contract: 'cos-backup-job-installation/v1';
  pathsDigest: string;
  definitionDigest: string;
  releaseId: string;
  phase: 'prepared' | 'published' | 'enabled' | 'active';
  directories: Record<string, Inode>;
  files: Record<string, FileClaim>;
  pending: Pending | null;
};
const hash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const inode = (stat: fs.Stats): Inode => ({ device: stat.dev, inode: stat.ino });
const same = (stat: fs.Stats, value: Inode) => stat.dev === value.device && stat.ino === value.inode;
const validInode = (value: Inode) =>
  value &&
  Number.isSafeInteger(value.device) &&
  value.device >= 0 &&
  Number.isSafeInteger(value.inode) &&
  value.inode > 0;
const validFile = (value: FileClaim) => validInode(value) && /^[a-f0-9]{64}$/.test(value.sha256);
const journal = 'backup-job-installation.json',
  prefix = '.cos-backup-job-';
/** Caller owns the target-operation, schedule, upload and installer locks while
 * publishing. Activation is deliberately separate, after those job/operation
 * locks are released. Only claimed files are replaced; stored publication state
 * never substitutes for the caller's fresh installed-release authority. */
export function createBackupJobInstaller(
  selected: DeploymentSettings,
  selectedManifest: ReleaseManifest,
  controls: BackupJobInstallControls,
) {
  const settings = deploymentSettings(structuredClone(selected)),
    manifest = validateReleaseManifest(structuredClone(selectedManifest));
  if (!['G02', 'G03'].includes(manifest.slice)) throw Error('backup_job_installation_unavailable');
  const paths = {
    config: path.join(settings.userHome, '.config/nanoclaw-cos'),
    units: path.join(settings.userHome, '.config/systemd/user'),
    receipts: settings.stateRoot,
  };
  const settingsPath = path.join(paths.config, 'backup-jobs-target.json'),
    units = backupJobUnits({ settings, settingsPath, releaseId: manifest.releaseId });
  const definitions: Record<string, string> = Object.fromEntries([
    ['backup-jobs-target.json', JSON.stringify(settings) + '\n'],
    ...units.map((unit) => [unit.name, unit.contents]),
  ]);
  const definitionDigest = digest({ settings, manifestDigest: digest(manifest), definitions }),
    pathsDigest = digest(paths);
  const operation = async (activate: boolean): Promise<Record<string, unknown>> => {
    const held: Array<{ name: string; path: string; fd: number; initial: fs.Stats }> = [];
    try {
      await controls.assertCurrent();
      if (process.platform !== 'linux' || !process.getuid?.()) throw Error('owner_required');
      for (const [name, file] of Object.entries(paths)) {
        const initial = fs.lstatSync(file),
          fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        held.push({ name, path: file, initial, fd });
      }
      const directory = (name: string) => held.find((item) => item.name === name)!;
      const pinned = (name: string) => '/proc/self/fd/' + directory(name).fd;
      const location = (name: string) =>
        path.join(pinned(name === 'backup-jobs-target.json' ? 'config' : 'units'), name);
      const guard = () => {
        for (const item of held) {
          if (fs.realpathSync(item.path) !== item.path) throw Error('unsafe_job_parent');
          for (const stat of [fs.lstatSync(item.path), fs.fstatSync(item.fd)])
            if (
              !stat.isDirectory() ||
              stat.uid !== process.getuid?.() ||
              stat.mode & 0o022 ||
              (item.name === 'receipts' && (stat.mode & 0o7777) !== 0o700) ||
              !same(stat, inode(item.initial))
            )
              throw Error('job_parent_changed');
        }
      };
      guard();
      const readFile = (file: string, expected?: FileClaim): FileClaim => {
        guard();
        const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        try {
          const stat = fs.fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.uid !== process.getuid?.() ||
            stat.nlink !== 1 ||
            (stat.mode & 0o7777) !== 0o600 ||
            stat.size > 16384 ||
            (expected && !same(stat, expected)) ||
            !same(fs.lstatSync(file), inode(stat))
          )
            throw Error('job_file_changed');
          const sha256 = hash(fs.readFileSync(fd));
          if (expected && sha256 !== expected.sha256) throw Error('job_file_changed');
          return { ...inode(stat), sha256 };
        } finally {
          fs.closeSync(fd);
        }
      };
      let record: Installation | undefined;
      const receipt = path.join(pinned('receipts'), journal);
      if (fs.lstatSync(receipt, { throwIfNoEntry: false })) {
        readFile(receipt);
        record = readPrivate<Installation>(receipt, 16384);
        if (
          !record ||
          Object.keys(record).sort().join(',') !==
            'contract,definitionDigest,directories,files,pathsDigest,pending,phase,releaseId' ||
          record.contract !== 'cos-backup-job-installation/v1' ||
          record.pathsDigest !== pathsDigest ||
          !/^[a-f0-9]{64}$/.test(record.definitionDigest) ||
          !/^release-[a-zA-Z0-9_-]{1,120}$/.test(record.releaseId) ||
          !['prepared', 'published', 'enabled', 'active'].includes(record.phase) ||
          !record.directories ||
          Object.keys(record.directories).sort().join(',') !== 'config,receipts,units' ||
          held.some(
            (item) =>
              !validInode(record!.directories[item.name]) || !same(item.initial, record!.directories[item.name]),
          ) ||
          !record.files ||
          Array.isArray(record.files) ||
          Object.entries(record.files).some(
            ([name, claim]) =>
              !Object.hasOwn(definitions, name) ||
              !validFile(claim) ||
              Object.keys(claim).sort().join(',') !== 'device,inode,sha256',
          ) ||
          (record.pending !== null &&
            (!record.pending ||
              !Object.hasOwn(definitions, record.pending.name) ||
              !validFile(record.pending) ||
              Object.keys(record.pending).sort().join(',') !== 'device,inode,name,sha256,temporary' ||
              !/^\.cos-backup-job-[a-f0-9-]{36}\.tmp$/.test(record.pending.temporary)))
        )
          throw Error('invalid_job_receipt');
      }
      const checkFiles = () => {
        guard();
        for (const unit of units)
          if (fs.lstatSync(path.join(pinned('units'), unit.name + '.d'), { throwIfNoEntry: false }))
            throw Error('unclaimed_job_dropin');
        const wants = path.join(pinned('units'), 'timers.target.wants');
        if (fs.lstatSync(wants, { throwIfNoEntry: false })) {
          const fd = fs.openSync(wants, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          try {
            const stat = fs.fstatSync(fd);
            if (
              !stat.isDirectory() ||
              stat.uid !== process.getuid?.() ||
              stat.mode & 0o022 ||
              !same(fs.lstatSync(wants), inode(stat))
            )
              throw Error('unsafe_job_enablement_parent');
            for (const unit of units.filter((unit) => unit.name.endsWith('.timer'))) {
              const link = path.join('/proc/self/fd/' + fd, unit.name),
                linked = fs.lstatSync(link, { throwIfNoEntry: false });
              if (!linked) continue;
              if (
                !record?.files[unit.name] ||
                !linked.isSymbolicLink() ||
                linked.uid !== process.getuid?.() ||
                linked.nlink !== 1 ||
                !['../' + unit.name, path.join(paths.units, unit.name)].includes(fs.readlinkSync(link)) ||
                !same(fs.lstatSync(link), inode(linked))
              )
                throw Error('unclaimed_job_enablement');
            }
            if (!same(fs.lstatSync(wants), inode(stat))) throw Error('job_enablement_parent_changed');
          } finally {
            fs.closeSync(fd);
          }
        }
        for (const name of Object.keys(definitions)) {
          const file = location(name),
            stat = fs.lstatSync(file, { throwIfNoEntry: false });
          if (!stat && !record?.files[name]) continue;
          if (!stat || !record?.files[name]) throw Error('unclaimed_job_file');
          readFile(file, record.files[name]);
        }
        for (const item of held.filter((item) => item.name !== 'receipts'))
          for (const name of fs.readdirSync(pinned(item.name)).filter((name) => name.startsWith(prefix)))
            if (name !== record?.pending?.temporary) throw Error('unclaimed_job_temporary');
      };
      const save = () => {
        guard();
        writeAtomic(pinned('receipts'), journal, record);
        guard();
      };
      const recoverPublication = () => {
        const pending = record?.pending;
        if (!pending) return;
        const parent = pending.name === 'backup-jobs-target.json' ? 'config' : 'units',
          temporary = path.join(pinned(parent), pending.temporary),
          destination = location(pending.name);
        if (fs.lstatSync(temporary, { throwIfNoEntry: false })) {
          readFile(temporary, pending);
          const old = record!.files[pending.name];
          if (old) readFile(destination, old);
          else if (fs.lstatSync(destination, { throwIfNoEntry: false })) throw Error('unclaimed_job_file');
          fs.renameSync(temporary, destination);
        }
        readFile(destination, pending);
        const fd = directory(parent).fd;
        fs.fsyncSync(fd);
        record!.files[pending.name] = { device: pending.device, inode: pending.inode, sha256: pending.sha256 };
        record!.pending = null;
        save();
      };
      if (record?.pending) {
        await controls.assertCurrent();
        guard();
        recoverPublication();
      }
      checkFiles();
      const run = async <T>(action: () => Promise<T>): Promise<T> => {
        await controls.assertCurrent();
        checkFiles();
        const result = await action();
        await controls.assertCurrent();
        checkFiles();
        return result;
      };
      const manager = await run(() => controls.inspectManager());
      if (
        !manager ||
        manager.owned !== true ||
        manager.jobsIdle !== true ||
        typeof manager.timersActive !== 'boolean' ||
        typeof manager.timersRunning !== 'boolean' ||
        typeof manager.definitionsLoaded !== 'boolean'
      )
        throw Error('backup_jobs_busy');
      if (activate) {
        if (
          !record ||
          !manager.definitionsLoaded ||
          record.definitionDigest !== definitionDigest ||
          !['enabled', 'active'].includes(record.phase) ||
          Object.keys(record.files).length !== Object.keys(definitions).length
        )
          throw Error('backup_jobs_not_enabled');
        for (const [name, text] of Object.entries(definitions))
          if (record.files[name]?.sha256 !== hash(text)) throw Error('backup_jobs_changed');
        await run(() => controls.startTimers());
        const active = await run(() => controls.inspectManager());
        if (!active.owned || !active.definitionsLoaded || !active.timersActive) throw Error('backup_jobs_not_active');
        record.phase = 'active';
        save();
        return {
          status: 'backup_jobs_active',
          releaseId: manifest.releaseId,
          definitionDigest,
          timers: 2,
          managerVerified: true,
        };
      }
      if (!record) {
        record = {
          contract: 'cos-backup-job-installation/v1',
          pathsDigest,
          definitionDigest,
          releaseId: manifest.releaseId,
          phase: 'prepared',
          directories: Object.fromEntries(held.map((item) => [item.name, inode(item.initial)])),
          files: {},
          pending: null,
        };
        save();
      }
      if (manager.timersRunning) {
        await run(() => controls.stopTimers());
        const stopped = await run(() => controls.inspectManager());
        if (!stopped.owned || !stopped.jobsIdle || stopped.timersRunning) throw Error('backup_jobs_not_stopped');
      }
      record.definitionDigest = definitionDigest;
      record.releaseId = manifest.releaseId;
      record.phase = 'prepared';
      save();
      for (const [name, text] of Object.entries(definitions)) {
        if (record.files[name]?.sha256 === hash(text)) continue;
        await controls.assertCurrent();
        checkFiles();
        const parent = name === 'backup-jobs-target.json' ? 'config' : 'units',
          temporary = prefix + randomUUID() + '.tmp',
          file = path.join(pinned(parent), temporary);
        const fd = fs.openSync(
          file,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
          const stat = fs.fstatSync(fd);
          record.pending = { ...inode(stat), sha256: hash(text), name, temporary };
          save();
        } finally {
          fs.closeSync(fd);
        }
        recoverPublication();
      }
      record.phase = 'published';
      save();
      await run(() => controls.compile(units.map((unit) => path.join(paths.units, unit.name))));
      await run(() => controls.reload());
      const loaded = await run(() => controls.inspectManager());
      if (!loaded.owned || !loaded.jobsIdle || !loaded.definitionsLoaded || loaded.timersRunning)
        throw Error('backup_jobs_unverified');
      await run(() => controls.enableTimers());
      const enabled = await run(() => controls.inspectManager());
      if (!enabled.owned || !enabled.jobsIdle || !enabled.definitionsLoaded || enabled.timersRunning)
        throw Error('backup_jobs_unverified');
      record.phase = 'enabled';
      save();
      return { status: 'backup_jobs_enabled', releaseId: manifest.releaseId, definitionDigest, activated: false };
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Private unit paths, settings and manager diagnostics never leave installation.
      throw Error('backup_job_installation_unavailable');
    } finally {
      for (const item of held.reverse()) fs.closeSync(item.fd);
    }
  };
  return { install: () => operation(false), activate: () => operation(true) };
}
