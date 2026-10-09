import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { createVaultUnitInstaller, type VaultUnitControls } from './vault-unit-install.js';
import { vaultUnits } from './vault-units.js';
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-unit-install-'));
  temporary.push(root);
  const paths = { stateRoot: root + '/control', systemUnits: root + '/system', ownerUnits: root + '/owner' };
  for (const directory of Object.values(paths)) fs.mkdirSync(directory, { mode: 0o700 });
  fs.chmodSync(paths.ownerUnits, 0o755);
  const input = {
    userId: process.getuid!(),
    service: 'nanoclaw-fixture.service',
    calendarRoot: '/home/fixture/state/calendar',
  };
  const identity = {
    operationId: randomUUID(),
    targetDigest: 'e'.repeat(64),
    recoveryReference: randomUUID(),
    luksUuid: randomUUID(),
    filesystemUuid: randomUUID(),
  };
  let enabled = false;
  const controls: VaultUnitControls = {
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(),
    run: vi.fn((command, args) => {
      if (command === '/usr/bin/systemd-analyze') return { status: 0, output: '' };
      if (args[0] === 'is-enabled')
        return {
          status: enabled ? 0 : 1,
          output: enabled ? 'enabled\nenabled\nenabled\n' : 'disabled\ndisabled\ndisabled\n',
        };
      if (args[0] === 'enable') {
        enabled = true;
        const wants = paths.systemUnits + '/multi-user.target.wants';
        fs.mkdirSync(wants, { mode: 0o755, recursive: true });
        for (const name of args.slice(2))
          if (!fs.lstatSync(wants + '/' + name, { throwIfNoEntry: false }))
            fs.symlinkSync('../' + name, wants + '/' + name);
      }
      return { status: 0, output: '' };
    }),
  };
  return {
    root,
    paths,
    input,
    identity,
    controls,
    installer: createVaultUnitInstaller(paths, input, identity, controls),
  };
}
it('installs only exact generated units, verifies before reload/enable and preserves replayed inodes', async () => {
  const f = fixture();
  expect(f.installer.inspect()).toBe('absent');
  await f.installer.install();
  expect(f.installer.inspect()).toBe('matching');
  const file = f.paths.systemUnits + '/nanoclaw-cos-vault.service',
    before = fs.statSync(file).ino;
  expect(fs.readFileSync(file, 'utf8')).toBe(vaultUnits(f.input)['nanoclaw-cos-vault.service']);
  expect(fs.readFileSync(f.paths.ownerUnits + '/' + f.input.service + '.d/50-cos-vault.conf', 'utf8')).toBe(
    vaultUnits(f.input)['owner-service.conf'],
  );
  await f.installer.install();
  expect(fs.statSync(file).ino).toBe(before);
  const calls = vi.mocked(f.controls.run!).mock.calls;
  expect(calls.filter((c) => c[1][0] === 'enable')).toHaveLength(1);
  expect(calls.findIndex((c) => c[0] === '/usr/bin/systemd-analyze')).toBeLessThan(
    calls.findIndex((c) => c[1][0] === 'daemon-reload'),
  );
  expect(calls.flatMap((c) => c[1]).join(' ')).not.toMatch(/restart|user@|swapoff|sysctl|--now/);
});
it('installs a root-managed user drop-in while preserving the existing private release directory', async () => {
  const f = fixture(),
    privateUnits = f.root + '/private-owner-units',
    releaseDirectory = privateUnits + '/' + f.input.service + '.d';
  fs.mkdirSync(privateUnits, { mode: 0o700 });
  fs.mkdirSync(releaseDirectory, { mode: 0o700 });
  const releaseFile = releaseDirectory + '/90-cos-release.conf';
  fs.writeFileSync(releaseFile, '[Service]\nLimitCORE=0\nMemorySwapMax=0\n', { mode: 0o600 });
  const directoryBefore = fs.statSync(releaseDirectory),
    fileBefore = fs.statSync(releaseFile),
    textBefore = fs.readFileSync(releaseFile, 'utf8');
  fs.chmodSync(f.paths.ownerUnits, 0o755);
  expect(f.installer.inspect()).toBe('absent');
  await f.installer.install();
  expect(f.installer.inspect()).toBe('matching');
  expect(fs.statSync(releaseDirectory).ino).toBe(directoryBefore.ino);
  expect(fs.statSync(releaseDirectory).mode & 0o777).toBe(0o700);
  expect(fs.statSync(releaseFile).ino).toBe(fileBefore.ino);
  expect(fs.statSync(releaseFile).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(releaseFile, 'utf8')).toBe(textBefore);
  expect(fs.readdirSync(releaseDirectory)).toEqual(['90-cos-release.conf']);
  expect(fs.statSync(f.paths.ownerUnits + '/' + f.input.service + '.d/50-cos-vault.conf').uid).toBe(process.getuid!());
});
it.each(['existing-unit', 'existing-dropin', 'symlink', 'authority', 'memory'])(
  'denies %s before systemd mutation',
  async (reason) => {
    const f = fixture(),
      file = f.paths.systemUnits + '/nanoclaw-cos-vault.service';
    if (reason === 'existing-unit') fs.writeFileSync(file, 'PRIVATE_EXISTING');
    if (reason === 'existing-dropin') {
      fs.mkdirSync(f.paths.ownerUnits + '/' + f.input.service + '.d');
      fs.writeFileSync(f.paths.ownerUnits + '/' + f.input.service + '.d/50-cos-vault.conf', 'PRIVATE_EXISTING');
    }
    if (reason === 'symlink') fs.symlinkSync('/dev/null', file);
    if (reason === 'authority')
      f.controls.assertAuthority = async () => {
        throw Error('PRIVATE_LEASE');
      };
    if (reason === 'memory')
      f.controls.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    await expect(f.installer.install()).rejects.toThrow('vault_units_unavailable');
    expect(vi.mocked(f.controls.run!).mock.calls.some((c) => ['enable', 'daemon-reload'].includes(c[1][0]))).toBe(
      false,
    );
    if (reason === 'existing-unit') expect(fs.readFileSync(file, 'utf8')).toBe('PRIVATE_EXISTING');
  },
);
it('refuses compiler failure without enabling or reloading installed units', async () => {
  const f = fixture(),
    run = f.controls.run!;
  f.controls.run = (command, args) =>
    command === '/usr/bin/systemd-analyze' ? { status: 1, output: 'PRIVATE_COMPILER' } : run(command, args);
  await expect(f.installer.install()).rejects.toThrow('vault_units_unavailable');
  expect(vi.mocked(run).mock.calls.some((c) => ['enable', 'daemon-reload'].includes(c[1][0]))).toBe(false);
  f.controls.run = run;
  await f.installer.install();
  expect(f.installer.inspect()).toBe('matching');
});
it.each(['contents', 'inode', 'permissions', 'identity', 'claim-loss'])(
  'denies changed %s without overwriting installed files',
  async (reason) => {
    const f = fixture();
    await f.installer.install();
    const file = f.paths.systemUnits + '/nanoclaw-cos-vault.service';
    if (reason === 'contents') fs.writeFileSync(file, 'PRIVATE_CHANGED');
    if (reason === 'inode') {
      fs.renameSync(file, file + '-original');
      fs.writeFileSync(file, vaultUnits(f.input)['nanoclaw-cos-vault.service'], { mode: 0o644 });
    }
    if (reason === 'permissions') fs.chmodSync(file, 0o666);
    if (reason === 'identity') f.identity.operationId = randomUUID();
    if (reason === 'claim-loss') fs.unlinkSync(f.paths.stateRoot + '/units.json');
    expect(f.installer.inspect()).toBe('conflict');
    await expect(f.installer.install()).rejects.toThrow('vault_units_unavailable');
    if (reason === 'contents') expect(fs.readFileSync(file, 'utf8')).toBe('PRIVATE_CHANGED');
    expect(vi.mocked(f.controls.run!).mock.calls.filter((c) => c[1][0] === 'enable')).toHaveLength(1);
  },
);
it('denies foreign boot links without enabling or overwriting them', async () => {
  const f = fixture();
  await f.installer.install();
  const link = f.paths.systemUnits + '/multi-user.target.wants/nanoclaw-cos-vault.service';
  fs.unlinkSync(link);
  fs.writeFileSync(f.paths.systemUnits + '/foreign.service', 'PRIVATE_FOREIGN');
  fs.symlinkSync('../foreign.service', link);
  expect(f.installer.inspect()).toBe('conflict');
  await expect(f.installer.install()).rejects.toThrow('vault_units_unavailable');
  expect(fs.readlinkSync(link)).toBe('../foreign.service');
  expect(vi.mocked(f.controls.run!).mock.calls.filter((c) => c[1][0] === 'enable')).toHaveLength(1);
});
it('reconciles a lost enablement reply from exact files and boot links without repeating enablement', async () => {
  const f = fixture(),
    run = f.controls.run!;
  f.controls.run = (command, args) => {
    const result = run(command, args);
    if (args[0] === 'enable') throw Error('PRIVATE_LOST_REPLY');
    return result;
  };
  await expect(f.installer.install()).rejects.toThrow('vault_units_unavailable');
  f.controls.run = run;
  await f.installer.install();
  expect(f.installer.inspect()).toBe('matching');
  expect(vi.mocked(run).mock.calls.filter((c) => c[1][0] === 'enable')).toHaveLength(1);
});
it('changes only claimed storage units under live authority and verifies their actual manager states', async () => {
  const f = fixture();
  await f.installer.install();
  const originalRun = f.controls.run!,
    names = Object.keys(vaultUnits(f.input)).filter((name) => name !== 'owner-service.conf');
  let active = true;
  f.controls.run = (tool, args) => {
    if (args[0] === 'stop') {
      expect(args.slice(1)).toEqual(names);
      active = false;
      return { status: 0, output: '' };
    }
    if (args[0] === 'start') {
      expect(args.slice(1)).toEqual(names);
      active = true;
      return { status: 0, output: '' };
    }
    if (args[0] === 'is-active')
      return { status: active ? 0 : 3, output: names.map(() => (active ? 'active\n' : 'inactive\n')).join('') };
    return originalRun(tool, args);
  };
  await f.installer.stopStorage();
  expect(f.installer.inactive()).toBe(true);
  await f.installer.startStorage();
  expect(f.installer.inactive()).toBe(false);
  f.controls.assertAuthority = async () => {
    throw Error('PRIVATE_LEASE');
  };
  await expect(f.installer.stopStorage()).rejects.toThrow('vault_units_unavailable');
  expect(active).toBe(true);
});
it('refuses changed claims and false manager acknowledgement before reporting storage activation', async () => {
  const f = fixture();
  await f.installer.install();
  await expect(f.installer.startStorage()).rejects.toThrow('vault_units_unavailable');
  fs.writeFileSync(f.paths.systemUnits + '/nanoclaw-cos-vault.service', 'PRIVATE_FOREIGN');
  vi.mocked(f.controls.run!).mockClear();
  await expect(f.installer.stopStorage()).rejects.toThrow('vault_units_unavailable');
  expect(
    vi.mocked(f.controls.run!).mock.calls.some(([, args]) => ['daemon-reload', 'start', 'stop'].includes(args[0])),
  ).toBe(false);
});
it('finishes only missing boot links after partial enablement', async () => {
  const f = fixture();
  await f.installer.install();
  const wants = f.paths.systemUnits + '/multi-user.target.wants',
    names = fs.readdirSync(wants);
  fs.unlinkSync(wants + '/' + names[0]);
  const run = f.controls.run!;
  f.controls.run = (command, args) => {
    if (args[0] === 'is-enabled' && !fs.existsSync(wants + '/' + names[0]))
      return {
        status: 1,
        output: args
          .slice(1)
          .map((name) => (fs.existsSync(wants + '/' + name) ? 'enabled\n' : 'disabled\n'))
          .join(''),
      };
    return run(command, args);
  };
  const retained = fs.lstatSync(wants + '/' + names[1]).ino;
  await f.installer.install();
  expect(f.installer.inspect()).toBe('matching');
  expect(fs.lstatSync(wants + '/' + names[1]).ino).toBe(retained);
});
it('sets the new root drop-in traversal mode explicitly under a private process umask', async () => {
  const previous = process.umask(0o077);
  try {
    const f = fixture();
    await f.installer.install();
    expect(fs.statSync(f.paths.ownerUnits + '/' + f.input.service + '.d').mode & 0o777).toBe(0o755);
    expect(f.installer.inspect()).toBe('matching');
  } finally {
    process.umask(previous);
  }
});
