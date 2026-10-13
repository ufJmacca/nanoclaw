import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import { vaultRootConfiguration } from './vault-root-config.js';
import { vaultRootStateDigest } from './vault-root-state.js';
import { readBackupNasRootConfiguration } from './backup-nas-root-config.js';
import {
  installBackupNasRootConfiguration,
  inspectBackupNasUnclaimedConfigurationStage,
  retireBackupNasUnclaimedConfigurationStage,
} from './backup-nas-config-install.js';
import { backupNasInitializationResource } from './backup-nas-initialization-recovery-scope.js';
import { prepareBackupNasUnderlay } from './backup-nas-underlay.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-config-install-'));
  roots.push(root);
  const configRoot = root + '/config',
    controlRoot = configRoot + '/control',
    storageRoot = root + '/storage';
  for (const [directory, mode] of [
    [configRoot, 0o700],
    [controlRoot, 0o700],
    [storageRoot, 0o711],
  ] as const)
    fs.mkdirSync(directory, { mode });
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
  const claim = (directory: string) => {
    const stat = fs.lstatSync(directory);
    return { device: stat.dev, inode: stat.ino };
  };
  const bootstrap = {
    contract: 'cos-vault-root-state/v1',
    identityDigest: vaultRootStateDigest(vault),
    phase: 'complete',
    claims: { control: claim(controlRoot), storage: claim(storageRoot) },
  };
  const bootstrapFile = configRoot + '/vault-bootstrap.json';
  fs.writeFileSync(bootstrapFile, JSON.stringify(bootstrap), { mode: 0o600 });
  const nas = {
    contract: 'cos-backup-nas-root-config/v1' as const,
    host: '192.168.56.12',
    credentialReference: randomUUID(),
    vaultStateDigest: vaultRootStateDigest(vault),
  };
  const controls = {
    paths: { configRoot, controlRoot, storageRoot },
    assertMemory: vi.fn(),
    assertAuthority: vi.fn(async () => {}),
  };
  return {
    root,
    vault,
    nas,
    bootstrap,
    bootstrapFile,
    controls,
    file: configRoot + '/backup-nas.json',
    journal: controlRoot + '/nas-config-install.json',
  };
}
const denied = /^backup_nas_configuration_installation_unavailable$/;
const retirementDenied = /^backup_nas_configuration_stage_retirement_unavailable$/;
function stagedFixture() {
  const f = fixture(),
    stageId = randomUUID(),
    stage = f.controls.paths.configRoot + '/.backup-nas.' + stageId + '.tmp',
    text = JSON.stringify(f.nas) + '\n';
  fs.writeFileSync(stage, text, { mode: 0o600 });
  return { ...f, stageId, stage, text };
}
function retirementFixture() {
  const f = stagedFixture(),
    stat = fs.lstatSync(f.stage);
  const resource = backupNasInitializationResource({
    kind: 'configuration-stage',
    stageId: f.stageId,
    device: stat.dev,
    inode: stat.ino,
    contentDigest: createHash('sha256').update(f.text).digest('hex'),
  });
  const scope = { nasDigest: digest(f.nas), vaultStateDigest: vaultRootStateDigest(f.vault), resource };
  return {
    ...f,
    resource,
    scope,
    retirement: f.controls.paths.controlRoot + '/nas-initialization-retirement.' + digest(scope) + '.json',
  };
}
it('records durable intent before removing only the exact complete unclaimed configuration stage', async () => {
  const f = retirementFixture(),
    bootstrap = fs.readFileSync(f.bootstrapFile),
    original = fs.unlinkSync;
  let observedEffect = false;
  vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/' + path.basename(f.stage))) {
      observedEffect = true;
      expect(JSON.parse(fs.readFileSync(f.retirement, 'utf8'))).toEqual({
        contract: 'cos-backup-nas-initialization-retirement/v1',
        ...f.scope,
        phase: 'retiring',
      });
    }
    original(file);
  });
  const result = await retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls);
  expect(result).toEqual({
    contract: 'cos-backup-nas-initialization-retirement-result/v1',
    status: 'retired',
    nasDigest: digest(f.nas),
    vaultStateDigest: vaultRootStateDigest(f.vault),
    resourceDigest: digest(f.resource),
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(observedEffect).toBe(true);
  expect(fs.existsSync(f.stage)).toBe(false);
  expect(fs.existsSync(f.file)).toBe(false);
  expect(fs.existsSync(f.journal)).toBe(false);
  expect(fs.readFileSync(f.bootstrapFile)).toEqual(bootstrap);
  expect(JSON.parse(fs.readFileSync(f.retirement, 'utf8')).phase).toBe('retired');
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual(f.nas);
});
it.each(['before-effect', 'after-effect', 'after-completion'])(
  'reconciles %s interruption only with fresh permission and never replays a completed removal',
  async (at) => {
    const f = retirementFixture();
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
    await expect(retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
      retirementDenied,
    );
    expect(fs.existsSync(f.stage)).toBe(at === 'before-effect');
    expect(JSON.parse(fs.readFileSync(f.retirement, 'utf8')).phase).toBe(
      at === 'after-completion' ? 'retired' : 'retiring',
    );
    f.controls.assertAuthority.mockResolvedValue(undefined);
    const unlink = vi.spyOn(fs, 'unlinkSync');
    expect((await retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls)).status).toBe(
      'retired',
    );
    const effects = unlink.mock.calls.filter(([file]) => String(file).endsWith('/' + path.basename(f.stage)));
    expect(effects).toHaveLength(at === 'before-effect' ? 1 : 0);
    expect(fs.existsSync(f.stage)).toBe(false);
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
  'claim',
  'destination',
  'another-stage',
  'permission',
  'memory',
  'journal-scope',
  'journal-mode',
  'wrong-kind',
  'selector',
])('denies %s retirement and preserves all remaining resources', async (reason) => {
  const f = retirementFixture();
  let resource = f.resource;
  if (reason === 'inode') {
    fs.renameSync(f.stage, f.stage + '.keep');
    fs.writeFileSync(f.stage, f.text, { mode: 0o600 });
  }
  if (reason === 'content') fs.writeFileSync(f.stage, f.text + ' ');
  if (reason === 'mode') fs.chmodSync(f.stage, 0o644);
  if (reason === 'owner') fs.chownSync(f.stage, 1000, 1000);
  if (reason === 'hardlink') fs.linkSync(f.stage, f.stage + '.keep');
  if (reason === 'symlink') {
    fs.renameSync(f.stage, f.stage + '.keep');
    fs.symlinkSync(f.stage + '.keep', f.stage);
  }
  if (reason === 'missing') fs.unlinkSync(f.stage);
  if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
  if (reason === 'destination') fs.writeFileSync(f.file, 'KEEP', { mode: 0o600 });
  if (reason === 'another-stage')
    fs.writeFileSync(f.controls.paths.configRoot + '/.backup-nas.' + randomUUID() + '.tmp', f.text, { mode: 0o600 });
  if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_PERMISSION'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  if (reason === 'journal-scope' || reason === 'journal-mode') {
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
  }
  if (reason === 'wrong-kind') resource = { kind: 'closed-underlay', device: 1, inode: 2 };
  if (reason === 'selector') resource = { ...resource, path: '/tmp/foreign' } as unknown as typeof resource;
  const names = fs.readdirSync(f.controls.paths.configRoot).sort();
  await expect(retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, resource, f.controls)).rejects.toThrow(
    retirementDenied,
  );
  expect(fs.readdirSync(f.controls.paths.configRoot).sort()).toEqual(names);
  expect(fs.existsSync(f.stage)).toBe(reason !== 'missing');
});
it.each(['claim', 'inode', 'content', 'parent'])(
  'refuses %s changed after durable intent and before the removal',
  async (reason) => {
    const f = retirementFixture();
    let changed = false;
    f.controls.assertAuthority.mockImplementation(async () => {
      if (changed || !fs.existsSync(f.retirement)) return;
      changed = true;
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.keep');
        fs.writeFileSync(f.stage, f.text, { mode: 0o600 });
      }
      if (reason === 'content') fs.writeFileSync(f.stage, f.text + ' ');
      if (reason === 'parent') {
        fs.renameSync(f.controls.paths.controlRoot, f.controls.paths.controlRoot + '.keep');
        fs.mkdirSync(f.controls.paths.controlRoot, { mode: 0o700 });
      }
    });
    await expect(retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
      retirementDenied,
    );
    expect(changed).toBe(true);
    expect(fs.existsSync(f.stage)).toBe(true);
  },
);
it.each(['resource', 'journal', 'claim'])('denies a %s change during final actual writer closure', async (reason) => {
  const f = retirementFixture(),
    close = fs.closeSync;
  let changed = false;
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const file = fs.readlinkSync('/proc/self/fd/' + fd);
    close(fd);
    if (!changed && file.endsWith('/repository.lock')) {
      changed = true;
      if (reason === 'resource') fs.writeFileSync(f.stage, 'KEEP', { mode: 0o600 });
      if (reason === 'journal') {
        const record = JSON.parse(fs.readFileSync(f.retirement, 'utf8'));
        fs.writeFileSync(f.retirement, JSON.stringify({ ...record, phase: 'retiring' }));
      }
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
    }
  });
  await expect(retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
    retirementDenied,
  );
  expect(changed).toBe(true);
});
it('leaves the stage intact if durable intent sync fails, and resumes after fresh verified durability', async () => {
  const f = retirementFixture(),
    original = fs.fsyncSync;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.existsSync(f.retirement)) throw Error('PRIVATE_SYNC');
    original(fd);
  });
  await expect(retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls)).rejects.toThrow(
    retirementDenied,
  );
  expect(fs.existsSync(f.stage)).toBe(true);
  sync.mockRestore();
  await retireBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.resource, f.controls);
  expect(fs.existsSync(f.stage)).toBe(false);
});
it('observes only the complete unclaimed configuration stage and preserves all resources without adopting it', async () => {
  const f = stagedFixture(),
    before = fs.lstatSync(f.stage),
    bootstrap = fs.readFileSync(f.bootstrapFile),
    result = await inspectBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.controls);
  expect(result).toEqual({
    kind: 'configuration-stage',
    stageId: f.stageId,
    device: before.dev,
    inode: before.ino,
    contentDigest: createHash('sha256').update(f.text).digest('hex'),
  });
  expect(Object.isFrozen(result)).toBe(true);
  expect(fs.readFileSync(f.stage, 'utf8')).toBe(f.text);
  expect(fs.lstatSync(f.stage).ino).toBe(before.ino);
  expect(fs.readFileSync(f.bootstrapFile)).toEqual(bootstrap);
  expect(fs.existsSync(f.file)).toBe(false);
  expect(fs.existsSync(f.journal)).toBe(false);
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
});
it.each([
  'missing',
  'mode',
  'owner',
  'symlink',
  'hardlink',
  'foreign-content',
  'partial',
  'oversized',
  'two-stages',
  'invalid-name',
  'claimed',
  'destination',
  'bootstrap',
  'permission',
])('refuses %s configuration staging without changing it', async (reason) => {
  const f = stagedFixture();
  if (reason === 'missing') fs.unlinkSync(f.stage);
  if (reason === 'mode') fs.chmodSync(f.stage, 0o644);
  if (reason === 'owner') fs.chownSync(f.stage, 1000, 1000);
  if (reason === 'symlink') {
    fs.renameSync(f.stage, f.stage + '.original');
    fs.symlinkSync(f.stage + '.original', f.stage);
  }
  if (reason === 'hardlink') fs.linkSync(f.stage, f.stage + '.linked');
  if (reason === 'foreign-content')
    fs.writeFileSync(f.stage, JSON.stringify({ ...f.nas, credentialReference: randomUUID() }) + '\n');
  if (reason === 'partial') fs.writeFileSync(f.stage, '{');
  if (reason === 'oversized') fs.writeFileSync(f.stage, 'x'.repeat(4097));
  if (reason === 'two-stages')
    fs.writeFileSync(f.controls.paths.configRoot + '/.backup-nas.' + randomUUID() + '.tmp', f.text, { mode: 0o600 });
  if (reason === 'invalid-name') fs.renameSync(f.stage, f.controls.paths.configRoot + '/.backup-nas.foreign.tmp');
  if (reason === 'claimed') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
  if (reason === 'destination') fs.writeFileSync(f.file, 'KEEP', { mode: 0o600 });
  if (reason === 'bootstrap') fs.writeFileSync(f.bootstrapFile, 'KEEP');
  if (reason === 'permission') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_NATIVE'));
  const before = fs.readdirSync(f.controls.paths.configRoot).sort();
  await expect(inspectBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.controls)).rejects.toThrow(
    /^backup_nas_configuration_stage_observation_unavailable$/,
  );
  expect(fs.readdirSync(f.controls.paths.configRoot).sort()).toEqual(before);
  if (reason === 'claimed') expect(fs.readFileSync(f.journal, 'utf8')).toBe('KEEP');
  if (reason === 'destination') expect(fs.readFileSync(f.file, 'utf8')).toBe('KEEP');
});
it.each(['inode', 'content', 'claim', 'another-stage', 'revocation'])(
  'refuses %s during the fresh stage observation challenge',
  async (reason) => {
    const f = stagedFixture();
    let checks = 0;
    f.controls.assertAuthority.mockImplementation(async () => {
      if (++checks !== 3) return;
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.original');
        fs.writeFileSync(f.stage, f.text, { mode: 0o600 });
      }
      if (reason === 'content') fs.writeFileSync(f.stage, f.text + ' ');
      if (reason === 'claim') fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
      if (reason === 'another-stage')
        fs.writeFileSync(f.controls.paths.configRoot + '/.backup-nas.' + randomUUID() + '.tmp', f.text, {
          mode: 0o600,
        });
      if (reason === 'revocation') throw Error('PRIVATE_REVOKED');
    });
    await expect(inspectBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.controls)).rejects.toThrow(
      /^backup_nas_configuration_stage_observation_unavailable$/,
    );
    expect(checks).toBeGreaterThanOrEqual(3);
  },
);
it.each(['inode', 'claim'])('refuses a stage %s change during actual writer closure', async (reason) => {
  const f = stagedFixture(),
    close = fs.closeSync;
  let changed = false;
  vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
    const file = fs.readlinkSync('/proc/self/fd/' + fd);
    close(fd);
    if (!changed && file.endsWith('/repository.lock')) {
      changed = true;
      if (reason === 'inode') {
        fs.renameSync(f.stage, f.stage + '.original');
        fs.writeFileSync(f.stage, f.text, { mode: 0o600 });
      } else fs.writeFileSync(f.journal, 'KEEP', { mode: 0o600 });
    }
  });
  await expect(inspectBackupNasUnclaimedConfigurationStage(f.vault, f.nas, f.controls)).rejects.toThrow(
    /^backup_nas_configuration_stage_observation_unavailable$/,
  );
  expect(changed).toBe(true);
});
it('publishes durable private NAS metadata under the real root writer without changing accepted vault resources', async () => {
  const f = fixture(),
    before = fs.readFileSync(f.bootstrapFile);
  const key = f.controls.paths.configRoot + '/vault.key',
    volume = f.controls.paths.storageRoot + '/vault.luks';
  fs.writeFileSync(key, 'KEEP_KEY', { mode: 0o600 });
  fs.writeFileSync(volume, 'KEEP_VOLUME', { mode: 0o600 });
  const result = await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(process.getuid?.()).toBe(0);
  expect(result).toEqual(f.nas);
  expect(fs.lstatSync(f.file).uid).toBe(0);
  expect(fs.lstatSync(f.file).mode & 0o7777).toBe(0o600);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
  expect(
    readBackupNasRootConfiguration(f.vault, {
      root: f.controls.paths.configRoot,
      assertMemory: f.controls.assertMemory,
    }),
  ).toEqual(f.nas);
  expect(fs.readFileSync(f.bootstrapFile)).toEqual(before);
  expect(fs.readFileSync(key, 'utf8')).toBe('KEEP_KEY');
  expect(fs.readFileSync(volume, 'utf8')).toBe('KEEP_VOLUME');
  expect(JSON.parse(fs.readFileSync(f.journal, 'utf8'))).toMatchObject({
    phase: 'installed',
    stage: null,
    configurationDigest: digest(f.nas),
  });
  expect(fs.readdirSync(f.controls.paths.configRoot).some((name) => name.startsWith('.backup-nas.'))).toBe(false);
});
it('replays the claimed NAS configuration across a fresh source and maintenance generation without replacing it', async () => {
  const f = fixture();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  const inode = fs.lstatSync(f.file).ino;
  const next = vaultRootConfiguration({
    ...f.vault,
    authority: { operationId: randomUUID() },
    target: { ...f.vault.target, minimumGeneration: 4 },
    artifact: { sourceCommit: '1'.repeat(40), sourceTree: '2'.repeat(40), digest: '3'.repeat(64) },
  });
  const sync = vi.spyOn(fs, 'fsyncSync');
  expect(await installBackupNasRootConfiguration(next, f.nas, f.controls)).toEqual(f.nas);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
  expect(sync.mock.calls.length).toBeGreaterThanOrEqual(4);
});
it.each([
  'unclaimed',
  'directory',
  'symlink',
  'config-mode',
  'control-mode',
  'storage-mode',
  'bootstrap-missing',
  'bootstrap-mode',
  'bootstrap-hardlink',
  'bootstrap-identity',
  'bootstrap-claim',
  'bootstrap-phase',
  'authority',
  'memory',
])('refuses initial %s without overwriting it or creating NAS ownership', async (reason) => {
  const f = fixture();
  if (reason === 'unclaimed') fs.writeFileSync(f.file, JSON.stringify(f.nas), { mode: 0o600 });
  if (reason === 'directory') fs.mkdirSync(f.file);
  if (reason === 'symlink') fs.symlinkSync(f.bootstrapFile, f.file);
  if (reason === 'config-mode') fs.chmodSync(f.controls.paths.configRoot, 0o755);
  if (reason === 'control-mode') fs.chmodSync(f.controls.paths.controlRoot, 0o755);
  if (reason === 'storage-mode') fs.chmodSync(f.controls.paths.storageRoot, 0o700);
  if (reason === 'bootstrap-missing') fs.unlinkSync(f.bootstrapFile);
  if (reason === 'bootstrap-mode') fs.chmodSync(f.bootstrapFile, 0o644);
  if (reason === 'bootstrap-hardlink') fs.linkSync(f.bootstrapFile, f.bootstrapFile + '.link');
  if (reason === 'bootstrap-identity')
    fs.writeFileSync(f.bootstrapFile, JSON.stringify({ ...f.bootstrap, identityDigest: '0'.repeat(64) }));
  if (reason === 'bootstrap-claim')
    fs.writeFileSync(
      f.bootstrapFile,
      JSON.stringify({ ...f.bootstrap, claims: { ...f.bootstrap.claims, control: { device: 0, inode: 1 } } }),
    );
  if (reason === 'bootstrap-phase')
    fs.writeFileSync(f.bootstrapFile, JSON.stringify({ ...f.bootstrap, phase: 'intent' }));
  if (reason === 'authority') f.controls.assertAuthority.mockRejectedValue(Error('PRIVATE_AUTHORITY'));
  if (reason === 'memory')
    f.controls.assertMemory.mockImplementation(() => {
      throw Error('PRIVATE_MEMORY');
    });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.journal)).toBe(false);
  if (reason === 'unclaimed') expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual(f.nas);
});
it.each([
  'missing',
  'inode',
  'mode',
  'hardlink',
  'bytes',
  'host',
  'reference',
  'journal-mode',
  'journal-hardlink',
  'journal-scope',
])('refuses a changed claimed %s instead of repairing or adopting it', async (reason) => {
  const f = fixture();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  if (reason === 'missing') fs.unlinkSync(f.file);
  if (reason === 'inode') {
    fs.renameSync(f.file, f.file + '.old');
    fs.writeFileSync(f.file, JSON.stringify(f.nas), { mode: 0o600 });
  }
  if (reason === 'mode') fs.chmodSync(f.file, 0o644);
  if (reason === 'hardlink') fs.linkSync(f.file, f.file + '.link');
  if (reason === 'bytes') fs.writeFileSync(f.file, JSON.stringify({ ...f.nas, host: '192.168.56.13' }));
  if (reason === 'host') f.nas.host = '192.168.56.13';
  if (reason === 'reference') f.nas.credentialReference = randomUUID();
  if (reason === 'journal-mode') fs.chmodSync(f.journal, 0o644);
  if (reason === 'journal-hardlink') fs.linkSync(f.journal, f.journal + '.link');
  if (reason === 'journal-scope') {
    const value = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
    fs.writeFileSync(f.journal, JSON.stringify({ ...value, configurationDigest: '0'.repeat(64) }));
  }
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  if (reason === 'missing') expect(fs.existsSync(f.file)).toBe(false);
});
it('resumes a journaled publication only with fresh authority, then keeps its original inode', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const record = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  expect(record.phase).toBe('publishing');
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(record.file.inode);
});
it('reconciles an interrupted published file with a fresh proof and repeats durability before acknowledgment', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.existsSync(f.file)) throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const inode = fs.lstatSync(f.file).ino;
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(inode);
  expect(fs.lstatSync(f.file).nlink).toBe(1);
});
it('denies a replaced parent across a fresh-authority await without writing through the replacement', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementationOnce(async () => {
    fs.renameSync(f.controls.paths.controlRoot, f.controls.paths.controlRoot + '.old');
    fs.mkdirSync(f.controls.paths.controlRoot, { mode: 0o700 });
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  expect(fs.existsSync(f.journal)).toBe(false);
});
it('does not accumulate more stages when an unclaimed stage remains from an interrupted initial intent', async () => {
  const f = fixture();
  f.controls.assertAuthority.mockImplementation(async () => {
    if (fs.readdirSync(f.controls.paths.configRoot).some((name) => name.startsWith('.backup-nas.')))
      throw Error('PRIVATE_REVOKED');
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  const names = fs.readdirSync(f.controls.paths.configRoot);
  expect(names.filter((name) => name.startsWith('.backup-nas.'))).toHaveLength(1);
  f.controls.assertAuthority.mockResolvedValue(undefined);
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.readdirSync(f.controls.paths.configRoot)).toEqual(names);
  expect(fs.existsSync(f.file)).toBe(false);
});
it('shares the real kernel writer with underlay preparation and never steals the competing lock', async () => {
  const f = fixture();
  let unblock!: () => void,
    entered!: () => void,
    waiting = false;
  const held = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const locked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.controls.assertAuthority.mockImplementation(async () => {
    if (!waiting && fs.existsSync(f.controls.paths.controlRoot + '/repository.lock')) {
      waiting = true;
      entered();
      await held;
    }
  });
  const pending = installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  try {
    await locked;
    await expect(
      prepareBackupNasUnderlay(f.vault, f.nas, {
        paths: { ...f.controls.paths, mount: f.controls.paths.storageRoot + '/nas' },
        assertMemory: f.controls.assertMemory,
        assertAuthority: async () => {},
        isMounted: () => false,
      }),
    ).rejects.toThrow(/^backup_nas_underlay_unavailable$/);
    expect(fs.existsSync(f.controls.paths.storageRoot + '/nas')).toBe(false);
    expect(fs.existsSync(f.file)).toBe(false);
  } finally {
    unblock();
    await pending;
  }
});
it('does not acknowledge a failed journal sync and repeats durability before replay publication', async () => {
  const f = fixture(),
    original = fs.fsyncSync;
  const sync = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.existsSync(f.journal)) throw Error('PRIVATE_DURABILITY');
    return original(fd);
  });
  await expect(installBackupNasRootConfiguration(f.vault, f.nas, f.controls)).rejects.toThrow(denied);
  expect(fs.existsSync(f.file)).toBe(false);
  const before = JSON.parse(fs.readFileSync(f.journal, 'utf8'));
  sync.mockRestore();
  await installBackupNasRootConfiguration(f.vault, f.nas, f.controls);
  expect(fs.lstatSync(f.file).ino).toBe(before.file.inode);
});
