import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
import { vaultUnits, type VaultUnitInput } from './vault-units.js';
export type VaultUnitPaths = { stateRoot: string; systemUnits: string; ownerUnits: string };
export type VaultUnitControls = {
  assertAuthority(): Promise<void>;
  assertMemory(): void;
  run?(command: string, args: string[]): { status: number; output: string };
};
type Inode = { device: number; inode: number };
type Claim = {
  contract: 'cos-vault-units/v1';
  identityDigest: string;
  pathsDigest: string;
  inputDigest: string;
  directory: Inode | null;
  files: Record<string, Inode>;
};
const filename = 'units.json';
function inode(stat: fs.Stats): Inode {
  return { device: stat.dev, inode: stat.ino };
}
function same(stat: fs.Stats, value: Inode) {
  return stat.dev === value.device && stat.ino === value.inode;
}
function directory(file: string, uid: number, mode?: number) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isDirectory() ||
    fs.realpathSync(file) !== file ||
    stat.uid !== uid ||
    stat.mode & 0o022 ||
    (mode !== undefined && (stat.mode & 0o777) !== mode)
  )
    throw Error('unsafe_unit_directory');
  return stat;
}
/** Installs exact claimed files and enables future boot. Owner reload, activation and process controls have separate target gates. */
export function createVaultUnitInstaller(
  paths: VaultUnitPaths,
  input: VaultUnitInput,
  identity: VaultProvisionIdentity,
  controls: VaultUnitControls,
) {
  const units = vaultUnits(input),
    inputDigest = digest(input),
    dropin = path.join(paths.ownerUnits, input.service + '.d');
  const systemNames = Object.keys(units).filter((name) => name !== 'owner-service.conf');
  const file = (name: string) =>
    name === 'owner-service.conf' ? path.join(dropin, '50-cos-vault.conf') : path.join(paths.systemUnits, name);
  const guard = () => {
    if (digest(input) !== inputDigest) throw Error('unit_binding_changed');
    const values = Object.values(paths);
    for (const value of values)
      if (!path.isAbsolute(value) || path.resolve(value) !== value || value === '/' || /[\0\r\n]/.test(value))
        throw Error('unsafe_unit_path');
    if (values.some((a, i) => values.some((b, j) => i !== j && (a === b || a.startsWith(b + '/')))))
      throw Error('overlapping_unit_paths');
    directory(paths.systemUnits, process.getuid!());
    directory(paths.ownerUnits, input.userId, 0o700);
    return directory(paths.stateRoot, process.getuid!(), 0o700);
  };
  const read = (): Claim | null => {
    const stat = fs.lstatSync(path.join(paths.stateRoot, filename), { throwIfNoEntry: false });
    if (!stat) return null;
    if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_unit_claim');
    const value = readPrivate<Claim>(path.join(paths.stateRoot, filename), 8192);
    const valid = (entry: Inode) =>
      entry &&
      Object.keys(entry).sort().join(',') === 'device,inode' &&
      Number.isSafeInteger(entry.device) &&
      entry.device >= 0 &&
      Number.isSafeInteger(entry.inode) &&
      entry.inode > 0;
    if (
      !value ||
      Object.keys(value).sort().join(',') !== 'contract,directory,files,identityDigest,inputDigest,pathsDigest' ||
      value.contract !== 'cos-vault-units/v1' ||
      value.identityDigest !== digest(identity) ||
      value.pathsDigest !== digest(paths) ||
      value.inputDigest !== inputDigest ||
      (value.directory !== null && !valid(value.directory)) ||
      !value.files ||
      Array.isArray(value.files) ||
      Object.entries(value.files).some(([name, entry]) => !Object.hasOwn(units, name) || !valid(entry))
    )
      throw Error('unit_claim_conflict');
    return value;
  };
  const checkDirectory = (record: Claim | null) => {
    const stat = fs.lstatSync(dropin, { throwIfNoEntry: false });
    if (!stat && !record?.directory) return null;
    if (!stat || !record?.directory || !same(directory(dropin, process.getuid!(), 0o755), record.directory))
      throw Error('foreign_unit_dropin');
    return stat;
  };
  const checkFiles = (record: Claim | null): boolean => {
    checkDirectory(record);
    let complete = true;
    for (const [name, text] of Object.entries(units)) {
      const stat = fs.lstatSync(file(name), { throwIfNoEntry: false }),
        expected = record?.files[name];
      if (!stat && !expected) {
        complete = false;
        continue;
      }
      if (!stat || !expected) throw Error('unclaimed_unit_file');
      const fd = fs.openSync(file(name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(fd);
        if (
          !current.isFile() ||
          current.uid !== process.getuid?.() ||
          current.nlink !== 1 ||
          (current.mode & 0o777) !== 0o644 ||
          !same(current, expected) ||
          current.size > 8192 ||
          fs.readFileSync(fd, 'utf8') !== text ||
          !same(fs.lstatSync(file(name)), expected)
        )
          throw Error('installed_unit_changed');
      } finally {
        fs.closeSync(fd);
      }
    }
    return complete;
  };
  const command = (tool: string, args: string[]) => {
    controls.assertMemory();
    const result = (
      controls.run ??
      ((name, values) => {
        const child = spawnSync(name, values, {
          cwd: '/',
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
          timeout: 15000,
          maxBuffer: 262144,
        });
        if (child.error || child.signal || child.status === null) throw Error('unit_process_unavailable');
        return { status: child.status, output: child.stdout ?? '' };
      })
    )(tool, args);
    controls.assertMemory();
    if (
      !Number.isSafeInteger(result.status) ||
      result.status < 0 ||
      typeof result.output !== 'string' ||
      Buffer.byteLength(result.output) > 262144
    )
      throw Error('unit_process_unverified');
    return result;
  };
  const links = (): boolean => {
    const wants = path.join(paths.systemUnits, 'multi-user.target.wants');
    if (!fs.lstatSync(wants, { throwIfNoEntry: false })) return false;
    directory(wants, process.getuid!());
    let complete = true;
    for (const name of systemNames) {
      const link = path.join(wants, name),
        stat = fs.lstatSync(link, { throwIfNoEntry: false });
      if (!stat) {
        complete = false;
        continue;
      }
      if (!stat.isSymbolicLink() || stat.uid !== process.getuid?.() || fs.realpathSync(link) !== file(name))
        throw Error('foreign_unit_enablement');
    }
    return complete;
  };
  const enabled = () => {
    const complete = links();
    const result = command('/usr/bin/systemctl', ['is-enabled', ...systemNames]);
    if (result.status === 0 && result.output === systemNames.map(() => 'enabled\n').join('') && complete) return true;
    const states = result.output.split('\n');
    if (
      result.status === 1 &&
      states.pop() === '' &&
      states.length === systemNames.length &&
      states.every((value) => ['enabled', 'disabled'].includes(value)) &&
      states.includes('disabled') &&
      !complete
    )
      return false;
    throw Error('unit_enablement_conflict');
  };
  const inspect = (): 'absent' | 'matching' | 'conflict' => {
    try {
      controls.assertMemory();
      guard();
      const complete = checkFiles(read());
      links();
      return complete && enabled() ? 'matching' : 'absent';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Report fixed status without root path or systemd diagnostics.
    } catch {
      return 'conflict';
    }
  };
  const authority = async () => {
    controls.assertMemory();
    await controls.assertAuthority();
    controls.assertMemory();
    guard();
  };
  return {
    inspect,
    async install() {
      try {
        await authority();
        if (!controls.run && (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0))
          throw Error('root_process_required');
        const state = inode(guard());
        let record = read();
        checkFiles(record);
        links();
        if (record && Object.keys(record.files).length === Object.keys(units).length && enabled()) return;
        record ??= {
          contract: 'cos-vault-units/v1',
          identityDigest: digest(identity),
          pathsDigest: digest(paths),
          inputDigest,
          directory: null,
          files: {},
        };
        const persist = () => {
          if (!same(guard(), state)) throw Error('unit_control_changed');
          writeAtomic(paths.stateRoot, filename, record);
        };
        await authority();
        if (!checkDirectory(record)) {
          const fd = fs.openSync(
            paths.ownerUnits,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          try {
            if (!same(fs.fstatSync(fd), inode(directory(paths.ownerUnits, input.userId, 0o700))))
              throw Error('unit_parent_changed');
            fs.mkdirSync(`/proc/self/fd/${fd}/${input.service}.d`, { mode: 0o755 });
            fs.fsyncSync(fd);
            record.directory = inode(directory(dropin, process.getuid!(), 0o755));
            persist();
          } finally {
            fs.closeSync(fd);
          }
        }
        for (const [name, text] of Object.entries(units)) {
          await authority();
          checkFiles(record);
          if (record.files[name]) continue;
          const parent = name === 'owner-service.conf' ? dropin : paths.systemUnits,
            before = directory(parent, process.getuid!()),
            parentFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
          let fd: number | undefined;
          try {
            if (!same(fs.fstatSync(parentFd), inode(before))) throw Error('unit_parent_changed');
            fd = fs.openSync(
              `/proc/self/fd/${parentFd}/${path.basename(file(name))}`,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o644,
            );
            fs.fchmodSync(fd, 0o644);
            fs.writeFileSync(fd, text);
            fs.fsyncSync(fd);
            fs.fsyncSync(parentFd);
            const created = fs.fstatSync(fd);
            if (
              !same(directory(parent, process.getuid!()), inode(before)) ||
              !same(fs.lstatSync(file(name)), inode(created))
            )
              throw Error('unit_file_changed');
            record.files[name] = inode(created);
            persist();
          } finally {
            if (fd !== undefined) fs.closeSync(fd);
            fs.closeSync(parentFd);
          }
        }
        await authority();
        if (
          !checkFiles(record) ||
          command('/usr/bin/systemd-analyze', ['verify', '--man=no', ...systemNames.map(file)]).status !== 0
        )
          throw Error('unit_compiler_unavailable');
        await authority();
        if (!checkFiles(record) || command('/usr/bin/systemctl', ['daemon-reload']).status !== 0)
          throw Error('unit_reload_unavailable');
        await authority();
        if (
          !checkFiles(record) ||
          command('/usr/bin/systemctl', ['enable', '--no-reload', ...systemNames]).status !== 0
        )
          throw Error('unit_enablement_unavailable');
        await authority();
        if (inspect() !== 'matching') throw Error('unit_installation_unverified');
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Unit paths, private operation identities and utility diagnostics stay private.
        throw Error('vault_units_unavailable');
      }
    },
  };
}
