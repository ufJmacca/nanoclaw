import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { installBackupNasRootConfiguration } from './backup-nas-config-install.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
import { backupNasMountService } from './backup-nas-units.js';
import { installBackupNasOnDemandService } from './backup-nas-service-install.js';
import type { BackupNasMountJournal, BackupNasMountObservation } from './backup-nas-mount-state.js';
import * as rootJournal from './backup-nas-root-journal.js';
const roots: string[] = [],
  denied = /^backup_nas_service_installation_unavailable$/;
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-service-install-'));
  roots.push(root);
  const paths = {
    configRoot: root + '/config',
    controlRoot: root + '/config/control',
    storageRoot: root + '/storage',
    mount: root + '/storage/nas',
    systemUnits: root + '/units',
  };
  for (const [name, mode] of [
    ['configRoot', 0o700],
    ['controlRoot', 0o700],
    ['storageRoot', 0o711],
    ['systemUnits', 0o755],
  ] as const)
    fs.mkdirSync(paths[name], { mode });
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'fixture.service',
    installationRoot: '/home/fixture/app',
    dataRoot: '/home/fixture/app/data',
  };
  const vault = vaultRootConfiguration({
    contract: 'cos-vault-root-config/v2',
    authority: { operationId: randomUUID() },
    identity: {
      operationId: randomUUID(),
      targetDigest: digest(binding),
      recoveryReference: randomUUID(),
      luksUuid: randomUUID(),
      filesystemUuid: randomUUID(),
    },
    target: { binding, lifecycle: 'protected', minimumGeneration: 3 },
    owner: { uid: 1000, gid: 1000, home: '/home/fixture', targetRoot: '/home/fixture/state' },
    artifact: { sourceCommit: 'c'.repeat(40), sourceTree: 'd'.repeat(40), digest: 'e'.repeat(64) },
  });
  const inode = (directory: string) => {
    const stat = fs.lstatSync(directory);
    return { device: stat.dev, inode: stat.ino };
  };
  const bootstrap = {
    contract: 'cos-vault-root-state/v1',
    phase: 'complete',
    identityDigest: vaultRootStateDigest(vault),
    claims: { control: inode(paths.controlRoot), storage: inode(paths.storageRoot) },
  };
  fs.writeFileSync(paths.configRoot + '/vault-bootstrap.json', JSON.stringify(bootstrap), { mode: 0o600 });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const assertMemory = vi.fn(),
    assertAuthority = vi.fn(async () => {});
  const configPaths = { configRoot: paths.configRoot, controlRoot: paths.controlRoot, storageRoot: paths.storageRoot };
  await installBackupNasRootConfiguration(vault, nas, { paths: configPaths, assertMemory, assertAuthority });
  const mountPaths = { ...configPaths, mount: paths.mount };
  await prepareBackupNasUnderlay(vault, nas, {
    paths: mountPaths,
    assertMemory,
    assertAuthority,
    isMounted: () => false,
  });
  assertAuthority.mockClear();
  const definition = backupNasMountService({ artifactDigest: vault.artifact.digest }),
    file = paths.systemUnits + '/' + definition.name,
    journal = paths.controlRoot + '/nas-service-install.json',
    manager: Record<string, string> = {};
  let loadedText: string | undefined;
  const run = vi.fn((_command: string, args: string[]) => {
    if (args[0] === 'daemon-reload') {
      loadedText = fs.readFileSync(file, 'utf8');
      return { status: 0, output: '' };
    }
    const properties = {
      Id: definition.name,
      LoadState: loadedText === undefined ? 'not-found' : 'loaded',
      ActiveState: 'inactive',
      SubState: 'dead',
      MainPID: '0',
      Job: '0',
      UnitFileState: loadedText === undefined ? '' : 'static',
      FragmentPath: loadedText === undefined ? '' : file,
      DropInPaths: '',
      NeedDaemonReload: loadedText !== undefined && fs.readFileSync(file, 'utf8') !== loadedText ? 'yes' : 'no',
      ...manager,
    };
    return {
      status: 0,
      output: Object.entries(properties)
        .map(([name, value]) => name + '=' + value + '\n')
        .join(''),
    };
  });
  const observe = vi.fn(
    (_vault: unknown, _nas: unknown, state: BackupNasMountJournal): BackupNasMountObservation => ({
      state: 'closed',
      underlay: state.underlay,
    }),
  );
  const controls = { paths, assertMemory, assertAuthority, run, observe };
  return { root, paths, vault, nas, controls, definition, file, journal, manager };
}
it('durably installs and reloads only the fixed on-demand definition while preserving vault and mount claims', async () => {
  const f = await fixture(),
    bootstrap = fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json'),
    mount = fs.readFileSync(f.paths.controlRoot + '/nas-mount.json');
  const result = await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(process.getuid?.()).toBe(0);
  expect(result).toMatchObject({
    contract: 'cos-backup-nas-service-installation-result/v1',
    status: 'installed',
    configurationDigest: digest(f.nas),
    artifactDigest: f.vault.artifact.digest,
  });
  expect(fs.readFileSync(f.file, 'utf8')).toBe(f.definition.contents);
  expect(fs.lstatSync(f.file).mode & 0o7777).toBe(0o644);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
  expect(fs.lstatSync(f.journal).mode & 0o7777).toBe(0o600);
  expect(fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json')).toEqual(bootstrap);
  expect(fs.readFileSync(f.paths.controlRoot + '/nas-mount.json')).toEqual(mount);
  expect(
    f.controls.run.mock.calls.every(
      ([command, args]) => command === '/usr/bin/systemctl' && ['show', 'daemon-reload'].includes(args[0]),
    ),
  ).toBe(true);
  expect(f.controls.run.mock.calls.filter(([, args]) => args[0] === 'daemon-reload')).toHaveLength(1);
});
it('replays the installed service without replacing its inode and upgrades only a claimed older helper definition', async () => {
  const f = await fixture();
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  const old = fs.lstatSync(f.file).ino;
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(old);
  const next = vaultRootConfiguration({
    ...f.vault,
    authority: { operationId: randomUUID() },
    target: { ...f.vault.target, minimumGeneration: 4 },
    artifact: { ...f.vault.artifact, digest: '9'.repeat(64) },
  });
  await installBackupNasOnDemandService(next, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).not.toBe(old);
  expect(fs.readFileSync(f.file, 'utf8')).toBe(
    backupNasMountService({ artifactDigest: next.artifact.digest }).contents,
  );
  expect(JSON.parse(fs.readFileSync(f.journal, 'utf8'))).toMatchObject({
    pending: null,
    current: { artifactDigest: next.artifact.digest },
  });
});
it.each([
  'unclaimed-file',
  'symlink',
  'directory',
  'unit-parent-mode',
  'authority',
  'memory',
  'mounted',
  'journal-phase',
])('refuses initial %s without creating service ownership or activating anything', async (reason) => {
  const f = await fixture();
  if (reason === 'unclaimed-file') fs.writeFileSync(f.file, f.definition.contents, { mode: 0o644 });
  if (reason === 'symlink') fs.symlinkSync(f.paths.configRoot + '/backup-nas.json', f.file);
  if (reason === 'directory') fs.mkdirSync(f.file);
  if (reason === 'unit-parent-mode') fs.chmodSync(f.paths.systemUnits, 0o777);
  if (reason === 'authority') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'mounted')
    f.controls.observe.mockReturnValue({
      state: 'mounted',
      mount: { id: 10, device: 0, inode: 1, bindingDigest: '0'.repeat(64) },
    });
  if (reason === 'journal-phase') {
    const p = f.paths.controlRoot + '/nas-mount.json',
      record = JSON.parse(fs.readFileSync(p, 'utf8'));
    fs.writeFileSync(p, JSON.stringify({ ...record, phase: 'mounting', attemptId: randomUUID() }));
  }
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.journal)).toBe(false);
  expect(f.controls.run.mock.calls.some(([, args]) => args[0] !== 'show')).toBe(false);
  if (reason === 'unclaimed-file') expect(fs.readFileSync(f.file, 'utf8')).toBe(f.definition.contents);
});
it.each(['ActiveState', 'MainPID', 'Job', 'UnitFileState', 'FragmentPath', 'DropInPaths', 'Id', 'LoadState'])(
  'refuses a conflicting manager %s before changing claimed service files',
  async (property) => {
    const f = await fixture();
    await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
    const before = fs.lstatSync(f.file).ino;
    f.controls.run.mockClear();
    const bad = {
      ActiveState: 'active',
      MainPID: '12',
      Job: '12',
      UnitFileState: 'enabled',
      FragmentPath: '/run/systemd/system/foreign.service',
      DropInPaths: '/etc/systemd/system/override.conf',
      Id: 'foreign.service',
      LoadState: 'masked',
    };
    f.manager[property] = bad[property as keyof typeof bad];
    await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
    expect(fs.lstatSync(f.file).ino).toBe(before);
    expect(fs.readFileSync(f.file, 'utf8')).toBe(f.definition.contents);
    expect(f.controls.run.mock.calls.some(([, args]) => args[0] === 'daemon-reload')).toBe(false);
  },
);
it.each(['mode', 'hardlink', 'bytes', 'inode', 'missing', 'journal-mode', 'journal-scope'])(
  'refuses a changed claimed %s without repairing or replacing it',
  async (reason) => {
    const f = await fixture();
    await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
    if (reason === 'mode') fs.chmodSync(f.file, 0o666);
    if (reason === 'hardlink') fs.linkSync(f.file, f.file + '.link');
    if (reason === 'bytes') fs.appendFileSync(f.file, '\nExecStart=/bin/sh\n');
    if (reason === 'inode') {
      fs.renameSync(f.file, f.file + '.old');
      fs.writeFileSync(f.file, f.definition.contents, { mode: 0o644 });
    }
    if (reason === 'missing') fs.unlinkSync(f.file);
    if (reason === 'journal-mode') fs.chmodSync(f.journal, 0o644);
    if (reason === 'journal-scope') {
      const record = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
      fs.writeFileSync(f.journal, JSON.stringify({ ...record, configurationDigest: '0'.repeat(64) }));
    }
    f.controls.run.mockClear();
    await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
    expect(f.controls.run.mock.calls.some(([, args]) => args[0] === 'daemon-reload')).toBe(false);
  },
);
it('resumes a journaled pre-publication interruption with fresh authority and its original stage inode', async () => {
  const f = await fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const pending = JSON.parse(fs.readFileSync(f.journal, 'utf8')).pending;
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(pending.claim.inode);
});
it('resumes an interrupted published service without replacing it or starting the NAS', async () => {
  const f = await fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.file)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const inode = fs.lstatSync(f.file).ino;
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
});
it('keeps durable ownership after a reload failure and acknowledges only a verified subsequent manager reload', async () => {
  const f = await fixture(),
    normal = f.controls.run.getMockImplementation()!;
  f.controls.run.mockImplementation((command, args) =>
    args[0] === 'daemon-reload' ? { status: 1, output: 'PRIVATE_MANAGER_DIAGNOSTIC' } : normal(command, args),
  );
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const inode = fs.lstatSync(f.file).ino;
  f.controls.run.mockImplementation(normal);
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
});
it('denies a manager that still reports stale loaded configuration after successful reload status', async () => {
  const f = await fixture(),
    normal = f.controls.run.getMockImplementation()!;
  f.controls.run.mockImplementation((command, args) => {
    const result = normal(command, args);
    return args[0] === 'show' && fs.existsSync(f.file)
      ? { ...result, output: result.output.replace('NeedDaemonReload=no', 'NeedDaemonReload=yes') }
      : result;
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
});
it('refuses a changed unit directory across an authority await without writing through the replacement', async () => {
  const f = await fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.journal)) {
      fs.renameSync(f.paths.systemUnits, f.paths.systemUnits + '.old');
      fs.mkdirSync(f.paths.systemUnits, { mode: 0o755 });
    }
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
});
it('denies changed service files while the enclosing root authority operation finishes', async () => {
  const f = await fixture(),
    original = rootJournal.withBackupNasRootJournal;
  vi.spyOn(rootJournal, 'withBackupNasRootJournal').mockImplementation(async (vault, nas, operation, controls) => {
    const result = await original(vault, nas, operation, controls);
    fs.renameSync(f.file, f.file + '.old');
    fs.writeFileSync(f.file, f.definition.contents, { mode: 0o644 });
    return result;
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
});
it('accepts the empty idle job value observed from the actual Pi manager', async () => {
  const f = await fixture(),
    original = f.controls.run.getMockImplementation()!;
  f.controls.run.mockImplementation((command, args) => {
    const result = original(command, args);
    return args[0] === 'show' ? { ...result, output: result.output.replace('Job=0\n', 'Job=\n') } : result;
  });
  expect(await installBackupNasOnDemandService(f.vault, f.nas, f.controls)).toMatchObject({ status: 'installed' });
});
it('reconciles an interrupted claimed helper upgrade using the already-published new inode', async () => {
  const f = await fixture();
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  const next = vaultRootConfiguration({
    ...f.vault,
    authority: { operationId: randomUUID() },
    target: { ...f.vault.target, minimumGeneration: 4 },
    artifact: { ...f.vault.artifact, digest: '9'.repeat(64) },
  });
  const contents = backupNasMountService({ artifactDigest: next.artifact.digest }).contents;
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.readFileSync(f.file, 'utf8') === contents) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasOnDemandService(next, f.nas, f.controls)).rejects.toThrow(denied);
  const inode = fs.lstatSync(f.file).ino;
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasOnDemandService(next, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
});
it('does not acknowledge failed journal durability and repeats sync before pending publication', async () => {
  const f = await fixture(),
    original = fs.fsyncSync;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_DURABILITY');
    return original(fd);
  });
  await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const record = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  sync.mockRestore();
  await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(record.pending.claim.inode);
});
it('retains the real kernel writer through service publication and refuses a competing mount writer', async () => {
  const f = await fixture();
  let unblock!: () => void,
    entered!: () => void,
    waiting = false;
  const held = new Promise<void>((resolve) => {
      unblock = resolve;
    }),
    locked = new Promise<void>((resolve) => {
      entered = resolve;
    });
  f.controls.assertAuthority.mockImplementation(async () => {
    if (!waiting && fs.existsSync(f.journal)) {
      waiting = true;
      entered();
      await held;
    }
  });
  const pending = installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  try {
    await locked;
    await expect(
      rootJournal.withBackupNasRootJournal(f.vault, f.nas, async () => {}, {
        assertAuthority: async () => {},
        assertMemory: f.controls.assertMemory,
        paths: {
          configRoot: f.paths.configRoot,
          controlRoot: f.paths.controlRoot,
          storageRoot: f.paths.storageRoot,
          mount: f.paths.mount,
        },
      }),
    ).rejects.toThrow(/^backup_nas_root_journal_unavailable$/);
    expect(fs.existsSync(f.file)).toBe(false);
  } finally {
    unblock();
    await pending;
  }
});
