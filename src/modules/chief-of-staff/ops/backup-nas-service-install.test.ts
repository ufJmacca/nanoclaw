import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { installBackupNasRootConfiguration } from './backup-nas-config-install.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
import { backupNasMountService } from './backup-nas-units.js';
import {
  installBackupNasOnDemandService,
  inspectBackupNasUnclaimedServiceStage,
  retireBackupNasUnclaimedServiceStage,
} from './backup-nas-service-install.js';
import { backupNasInitializationResource } from './backup-nas-initialization-recovery-scope.js';
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
async function stagedFixture(upgrade = false) {
  const f = await fixture();
  if (upgrade) await installBackupNasOnDemandService(f.vault, f.nas, f.controls);
  const vault = upgrade
    ? vaultRootConfiguration({ ...f.vault, artifact: { ...f.vault.artifact, digest: '9'.repeat(64) } })
    : f.vault;
  const definition = backupNasMountService({ artifactDigest: vault.artifact.digest }),
    stageId = randomUUID(),
    stage = f.paths.systemUnits + '/.nanoclaw-cos-backup-mount.' + stageId + '.tmp';
  fs.writeFileSync(stage, definition.contents, { mode: 0o644 });
  f.controls.run.mockClear();
  return { ...f, vault, definition, stageId, stage };
}
async function retirementFixture(upgrade = false) {
  const f = await stagedFixture(upgrade),
    stat = fs.lstatSync(f.stage);
  const resource = backupNasInitializationResource({
    kind: 'service-stage',
    stageId: f.stageId,
    device: stat.dev,
    inode: stat.ino,
    contentDigest: createHash('sha256').update(f.definition.contents).digest('hex'),
  });
  const scope = { nasDigest: digest(f.nas), vaultStateDigest: vaultRootStateDigest(f.vault), resource };
  return {
    ...f,
    resource,
    scope,
    retirement: f.paths.controlRoot + '/nas-initialization-retirement.' + digest(scope) + '.json',
  };
}
const retirementDenied = /^backup_nas_service_stage_retirement_unavailable$/;
it.each([false, true])(
  'retires only the exact unclaimed service stage and preserves installed resources (upgrade=%s)',
  async (upgrade) => {
    const f = await retirementFixture(upgrade),
      mount = fs.readFileSync(f.paths.controlRoot + '/nas-mount.json'),
      bootstrap = fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json'),
      configuration = fs.readFileSync(f.paths.configRoot + '/backup-nas.json'),
      installed = upgrade ? fs.readFileSync(f.file) : undefined,
      journal = upgrade ? fs.readFileSync(f.journal) : undefined,
      original = fs.unlinkSync;
    let effect = false;
    vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
      if (String(file).endsWith('/' + path.basename(f.stage))) {
        effect = true;
        expect(JSON.parse(fs.readFileSync(f.retirement, 'utf8'))).toEqual({
          contract: 'cos-backup-nas-initialization-retirement/v1',
          ...f.scope,
          phase: 'retiring',
        });
      }
      original(file);
    });
    const result = await retireBackupNasUnclaimedServiceStage(f.vault, f.nas, f.resource, f.controls);
    expect(effect).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result).toEqual({
      contract: 'cos-backup-nas-initialization-retirement-result/v1',
      status: 'retired',
      nasDigest: digest(f.nas),
      vaultStateDigest: vaultRootStateDigest(f.vault),
      resourceDigest: digest(f.resource),
    });
    expect(fs.existsSync(f.stage)).toBe(false);
    expect(fs.readFileSync(f.paths.controlRoot + '/nas-mount.json')).toEqual(mount);
    expect(fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json')).toEqual(bootstrap);
    expect(fs.readFileSync(f.paths.configRoot + '/backup-nas.json')).toEqual(configuration);
    if (upgrade) {
      expect(fs.readFileSync(f.file)).toEqual(installed);
      expect(fs.readFileSync(f.journal)).toEqual(journal);
    } else {
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.existsSync(f.journal)).toBe(false);
    }
    expect(f.controls.run.mock.calls.every(([, args]) => args[0] === 'show')).toBe(true);
  },
);
it.each(['before-effect', 'after-effect', 'after-completion'])(
  'reconciles %s interruption with fresh permission and never replays removal',
  async (at) => {
    const f = await retirementFixture();
    f.controls.assertAuthority.mockImplementation(async () => {
      if (!fs.existsSync(f.retirement)) return;
      const record = JSON.parse(fs.readFileSync(f.retirement, 'utf8'));
      if (
        at === 'before-effect' ||
        (at === 'after-effect' && !fs.existsSync(f.stage)) ||
        (at === 'after-completion' && record.phase === 'retired')
      )
        throw Error('PRIVATE_REVOKED');
    });
    await expect(retireBackupNasUnclaimedServiceStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
      retirementDenied,
    );
    expect(fs.existsSync(f.stage)).toBe(at === 'before-effect');
    expect(JSON.parse(fs.readFileSync(f.retirement, 'utf8')).phase).toBe(
      at === 'after-completion' ? 'retired' : 'retiring',
    );
    f.controls.assertAuthority.mockResolvedValue(undefined);
    const unlink = vi.spyOn(fs, 'unlinkSync');
    expect((await retireBackupNasUnclaimedServiceStage(f.vault, f.nas, f.resource, f.controls)).status).toBe('retired');
    expect(unlink.mock.calls.filter(([file]) => String(file).endsWith('/' + path.basename(f.stage)))).toHaveLength(
      at === 'before-effect' ? 1 : 0,
    );
  },
);
it.each([
  'inode',
  'content',
  'mode',
  'owner',
  'hardlink',
  'symlink',
  'missing',
  'pending',
  'destination',
  'another-stage',
  'active',
  'job',
  'mount',
  'permission',
  'memory',
  'journal-scope',
  'journal-mode',
  'wrong-kind',
  'selector',
])('denies %s retirement and preserves all remaining staging and installed claims', async (reason) => {
  const f = await retirementFixture();
  let resource = f.resource;
  if (reason === 'inode') {
    fs.renameSync(f.stage, f.stage + '.keep');
    fs.writeFileSync(f.stage, f.definition.contents, { mode: 0o644 });
  }
  if (reason === 'content') fs.writeFileSync(f.stage, 'KEEP');
  if (reason === 'mode') fs.chmodSync(f.stage, 0o600);
  if (reason === 'owner') fs.chownSync(f.stage, 1000, 1000);
  if (reason === 'hardlink') fs.linkSync(f.stage, f.stage + '.keep');
  if (reason === 'symlink') {
    fs.renameSync(f.stage, f.stage + '.keep');
    fs.symlinkSync(f.stage + '.keep', f.stage);
  }
  if (reason === 'missing') fs.unlinkSync(f.stage);
  if (reason === 'pending')
    fs.writeFileSync(
      f.journal,
      JSON.stringify({
        contract: 'cos-backup-nas-service-installation/v1',
        configurationDigest: digest(f.nas),
        vaultStateDigest: vaultRootStateDigest(f.vault),
        unitsParent: { device: fs.lstatSync(f.paths.systemUnits).dev, inode: fs.lstatSync(f.paths.systemUnits).ino },
        current: null,
        pending: {
          artifactDigest: f.vault.artifact.digest,
          contentDigest: createHash('sha256').update(f.definition.contents).digest('hex'),
          claim: { device: resource.device, inode: resource.inode },
          stage: path.basename(f.stage),
        },
      }),
      { mode: 0o600 },
    );
  if (reason === 'destination') fs.writeFileSync(f.file, 'KEEP', { mode: 0o644 });
  if (reason === 'another-stage')
    fs.writeFileSync(
      f.paths.systemUnits + '/.nanoclaw-cos-backup-mount.' + randomUUID() + '.tmp',
      f.definition.contents,
      { mode: 0o644 },
    );
  if (reason === 'active') f.manager.ActiveState = 'active';
  if (reason === 'job') f.manager.Job = '14';
  if (reason === 'mount')
    f.controls.observe.mockImplementation(() => {
      throw Error('PRIVATE_MOUNT');
    });
  if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_PERMISSION'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'journal-scope' || reason === 'journal-mode')
    fs.writeFileSync(
      f.retirement,
      JSON.stringify({
        contract: 'cos-backup-nas-initialization-retirement/v1',
        ...f.scope,
        nasDigest: reason === 'journal-scope' ? '0'.repeat(64) : f.scope.nasDigest,
        phase: 'retiring',
      }),
      { mode: reason === 'journal-mode' ? 0o644 : 0o600 },
    );
  if (reason === 'wrong-kind') resource = { kind: 'closed-underlay', device: 1, inode: 2 };
  if (reason === 'selector') resource = { ...resource, path: '/tmp/foreign' } as unknown as typeof resource;
  const mount = fs.readFileSync(f.paths.controlRoot + '/nas-mount.json'),
    names = fs.readdirSync(f.paths.systemUnits).sort();
  await expect(retireBackupNasUnclaimedServiceStage(f.vault, f.nas, resource, f.controls)).rejects.toThrow(
    retirementDenied,
  );
  expect(fs.readdirSync(f.paths.systemUnits).sort()).toEqual(names);
  expect(fs.readFileSync(f.paths.controlRoot + '/nas-mount.json')).toEqual(mount);
});
it.each(['claim', 'inode', 'manager', 'parent', 'mount-journal'])(
  'refuses %s changed after durable intent before removal',
  async (reason) => {
    const f = await retirementFixture();
    let changed = false;
    f.controls.assertAuthority.mockImplementation(async () => {
      if (changed || !fs.existsSync(f.retirement)) return;
      changed = true;
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.keep');
        fs.writeFileSync(f.stage, f.definition.contents, { mode: 0o644 });
      }
      if (reason === 'manager') f.manager.Job = '14';
      if (reason === 'parent') {
        fs.renameSync(f.paths.systemUnits, f.paths.systemUnits + '.keep');
        fs.mkdirSync(f.paths.systemUnits, { mode: 0o755 });
      }
      if (reason === 'mount-journal') fs.writeFileSync(f.paths.controlRoot + '/nas-mount.json', 'KEEP');
    });
    await expect(retireBackupNasUnclaimedServiceStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
      retirementDenied,
    );
    expect(changed).toBe(true);
    expect(fs.existsSync(reason === 'parent' ? f.paths.systemUnits + '.keep/' + path.basename(f.stage) : f.stage)).toBe(
      true,
    );
  },
);
it.each(['resource', 'journal', 'claim', 'manager', 'mount-journal'])(
  'refuses %s changed during the final root journal closure',
  async (reason) => {
    const f = await retirementFixture(),
      original = rootJournal.withBackupNasRootJournal;
    vi.spyOn(rootJournal, 'withBackupNasRootJournal').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (reason === 'resource') fs.writeFileSync(f.stage, 'KEEP', { mode: 0o644 });
      if (reason === 'journal') {
        const record = JSON.parse(fs.readFileSync(f.retirement, 'utf8'));
        fs.writeFileSync(f.retirement, JSON.stringify({ ...record, phase: 'retiring' }));
      }
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'manager') f.manager.Job = '14';
      if (reason === 'mount-journal') fs.writeFileSync(f.paths.controlRoot + '/nas-mount.json', 'KEEP');
      return result;
    });
    await expect(retireBackupNasUnclaimedServiceStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
      retirementDenied,
    );
  },
);
it.each([false, true])(
  'observes an unclaimed service stage while preserving the accepted installation (upgrade=%s)',
  async (upgrade) => {
    const f = await stagedFixture(upgrade),
      before = fs.lstatSync(f.stage),
      bootstrap = fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json'),
      mount = fs.readFileSync(f.paths.controlRoot + '/nas-mount.json'),
      installed = upgrade ? fs.readFileSync(f.file) : undefined,
      journal = upgrade ? fs.readFileSync(f.journal) : undefined;
    const result = await inspectBackupNasUnclaimedServiceStage(f.vault, f.nas, f.controls);
    expect(result).toEqual({
      kind: 'service-stage',
      stageId: f.stageId,
      device: before.dev,
      inode: before.ino,
      contentDigest: createHash('sha256').update(f.definition.contents).digest('hex'),
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(fs.lstatSync(f.stage).ino).toBe(before.ino);
    expect(fs.readFileSync(f.stage, 'utf8')).toBe(f.definition.contents);
    expect(fs.readFileSync(f.paths.configRoot + '/vault-bootstrap.json')).toEqual(bootstrap);
    expect(fs.readFileSync(f.paths.controlRoot + '/nas-mount.json')).toEqual(mount);
    if (upgrade) {
      expect(fs.readFileSync(f.file)).toEqual(installed);
      expect(fs.readFileSync(f.journal)).toEqual(journal);
    } else {
      expect(fs.existsSync(f.file)).toBe(false);
      expect(fs.existsSync(f.journal)).toBe(false);
    }
    expect(f.controls.run.mock.calls.every(([, args]) => args[0] === 'show')).toBe(true);
    await expect(installBackupNasOnDemandService(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  },
);
it.each([
  'missing',
  'mode',
  'owner',
  'symlink',
  'hardlink',
  'content',
  'partial',
  'oversized',
  'two-stages',
  'invalid-name',
  'unclaimed-unit',
  'claimed-stage',
  'mounted',
  'busy-manager',
  'queued-manager',
  'permission',
])('refuses %s service staging without adopting or removing it', async (reason) => {
  const f = await stagedFixture();
  if (reason === 'missing') fs.unlinkSync(f.stage);
  if (reason === 'mode') fs.chmodSync(f.stage, 0o600);
  if (reason === 'owner') fs.chownSync(f.stage, 1000, 1000);
  if (reason === 'symlink') {
    fs.renameSync(f.stage, f.stage + '.original');
    fs.symlinkSync(f.stage + '.original', f.stage);
  }
  if (reason === 'hardlink') fs.linkSync(f.stage, f.stage + '.linked');
  if (reason === 'content')
    fs.writeFileSync(f.stage, backupNasMountService({ artifactDigest: '8'.repeat(64) }).contents);
  if (reason === 'partial') fs.writeFileSync(f.stage, '[Unit]');
  if (reason === 'oversized') fs.writeFileSync(f.stage, 'x'.repeat(8193));
  if (reason === 'two-stages')
    fs.writeFileSync(
      f.paths.systemUnits + '/.nanoclaw-cos-backup-mount.' + randomUUID() + '.tmp',
      f.definition.contents,
      { mode: 0o644 },
    );
  if (reason === 'invalid-name')
    fs.renameSync(f.stage, f.paths.systemUnits + '/.nanoclaw-cos-backup-mount.foreign.tmp');
  if (reason === 'unclaimed-unit') fs.writeFileSync(f.file, 'KEEP', { mode: 0o644 });
  if (reason === 'claimed-stage') {
    const st = fs.lstatSync(f.stage),
      u = fs.lstatSync(f.paths.systemUnits);
    fs.writeFileSync(
      f.journal,
      JSON.stringify({
        contract: 'cos-backup-nas-service-installation/v1',
        configurationDigest: digest(f.nas),
        vaultStateDigest: vaultRootStateDigest(f.vault),
        unitsParent: { device: u.dev, inode: u.ino },
        current: null,
        pending: {
          artifactDigest: f.vault.artifact.digest,
          contentDigest: createHash('sha256').update(f.definition.contents).digest('hex'),
          claim: { device: st.dev, inode: st.ino },
          stage: path.basename(f.stage),
        },
      }),
      { mode: 0o600 },
    );
  }
  if (reason === 'mounted') f.controls.observe.mockReturnValue({ state: 'mounted' } as never);
  if (reason === 'busy-manager') {
    f.manager.ActiveState = 'active';
    f.manager.SubState = 'running';
  }
  if (reason === 'queued-manager') f.manager.Job = '7';
  if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_NATIVE'));
  const names = fs.readdirSync(f.paths.systemUnits).sort();
  await expect(inspectBackupNasUnclaimedServiceStage(f.vault, f.nas, f.controls)).rejects.toThrow(
    /^backup_nas_service_stage_observation_unavailable$/,
  );
  expect(fs.readdirSync(f.paths.systemUnits).sort()).toEqual(names);
  expect(f.controls.run.mock.calls.every(([, args]) => args[0] === 'show')).toBe(true);
});
it.each(['inode', 'claim', 'another-stage', 'revocation'])(
  'refuses stage %s changed after its descriptor is held',
  async (reason) => {
    const f = await stagedFixture(),
      open = fs.openSync;
    let opened = false,
      changed = false;
    vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
      const fd = open(...args);
      if (String(args[0]).endsWith(path.basename(f.stage))) opened = true;
      return fd;
    });
    f.controls.assertAuthority.mockImplementation(async () => {
      if (!opened || changed) return;
      changed = true;
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.original');
        fs.writeFileSync(f.stage, f.definition.contents, { mode: 0o644 });
      }
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'another-stage')
        fs.writeFileSync(
          f.paths.systemUnits + '/.nanoclaw-cos-backup-mount.' + randomUUID() + '.tmp',
          f.definition.contents,
          { mode: 0o644 },
        );
      if (reason === 'revocation') throw Error('PRIVATE_REVOKED');
    });
    await expect(inspectBackupNasUnclaimedServiceStage(f.vault, f.nas, f.controls)).rejects.toThrow(
      /^backup_nas_service_stage_observation_unavailable$/,
    );
    expect(changed).toBe(true);
  },
);
it.each(['inode', 'claim', 'manager'])(
  'refuses stage %s changes during the enclosing root lease final closure',
  async (reason) => {
    const f = await stagedFixture(),
      original = rootJournal.withBackupNasRootJournal;
    vi.spyOn(rootJournal, 'withBackupNasRootJournal').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.original');
        fs.writeFileSync(f.stage, f.definition.contents, { mode: 0o644 });
      }
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'manager') f.manager.Job = '8';
      return result;
    });
    await expect(inspectBackupNasUnclaimedServiceStage(f.vault, f.nas, f.controls)).rejects.toThrow(
      /^backup_nas_service_stage_observation_unavailable$/,
    );
  },
);
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
