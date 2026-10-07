import { expect, it, vi } from 'vitest';
import {
  installVaultUtilities,
  vaultUtilitiesStatus,
  VAULT_UTILITIES,
  type VaultUtilityControls,
} from './vault-utilities.js';
function fixture() {
  const installed = new Map<string, string>([['cifs-utils', VAULT_UTILITIES['cifs-utils']]]);
  let simulation = `Inst cryptsetup-bin (${VAULT_UTILITIES['cryptsetup-bin']} Debian:13 [arm64])\nConf cryptsetup-bin (${VAULT_UTILITIES['cryptsetup-bin']} Debian:13 [arm64])\n`;
  const controls: VaultUtilityControls = {
    assertAuthority: vi.fn(async () => {}),
    assertMemory: vi.fn(),
    run: vi.fn((tool, args) => {
      if (tool === '/usr/bin/dpkg-query')
        return installed.has(args.at(-1)!)
          ? { status: 0, output: `installed\t${installed.get(args.at(-1)!)}\n` }
          : { status: 1, output: '' };
      expect(tool).toBe('/usr/bin/apt-get');
      if (args.includes('--simulate')) return { status: 0, output: simulation };
      expect(args).toContain('--no-upgrade');
      expect(args).toContain('--no-remove');
      expect(args).toContain('--no-install-recommends');
      expect(args).toContain('cryptsetup-bin=' + VAULT_UTILITIES['cryptsetup-bin']);
      for (const value of args) {
        const match = /^([a-z0-9][a-z0-9.+-]+(?::arm64)?)=([a-zA-Z0-9.+:~_-]+)$/.exec(value);
        if (match) installed.set(match[1].replace(/:arm64$/, ''), match[2]);
      }
      return { status: 0, output: '' };
    }),
  };
  return {
    installed,
    controls,
    setSimulation(value: string) {
      simulation = value;
    },
  };
}
it('installs only missing pinned utilities and reconciles an already-completed installation', async () => {
  const f = fixture();
  expect(vaultUtilitiesStatus(f.controls)).toBe('absent');
  await installVaultUtilities(f.controls);
  expect(vaultUtilitiesStatus(f.controls)).toBe('matching');
  await installVaultUtilities(f.controls);
  expect(
    vi.mocked(f.controls.run!).mock.calls.filter((c) => c[0] === '/usr/bin/apt-get' && !c[1].includes('--simulate')),
  ).toHaveLength(1);
});
it('pins every necessary newly installed dependency from the checked dry run', async () => {
  const f = fixture();
  f.setSimulation(
    `Inst libcryptsetup12 (2:2.7.5-2 Debian:13 [arm64])\nInst cryptsetup-bin (${VAULT_UTILITIES['cryptsetup-bin']} Debian:13 [arm64])\n`,
  );
  await installVaultUtilities(f.controls);
  const call = vi
    .mocked(f.controls.run!)
    .mock.calls.find((c) => c[0] === '/usr/bin/apt-get' && !c[1].includes('--simulate'))!;
  expect(call[1]).toContain('libcryptsetup12=2:2.7.5-2');
});
it('recognizes dpkg not-installed with an empty version as missing without adopting retained configuration', async () => {
  const f = fixture(),
    run = f.controls.run!;
  f.controls.run = vi.fn((tool, args) =>
    tool === '/usr/bin/dpkg-query' && !f.installed.has(args.at(-1)!)
      ? { status: 0, output: 'not-installed\t\n' }
      : run(tool, args),
  );
  expect(vaultUtilitiesStatus(f.controls)).toBe('absent');
  await installVaultUtilities(f.controls);
  expect(vaultUtilitiesStatus(f.controls)).toBe('matching');
});
it('refuses retained package configuration instead of treating it as a fresh absence', async () => {
  const f = fixture(),
    run = f.controls.run!;
  f.controls.run = vi.fn((tool, args) =>
    tool === '/usr/bin/dpkg-query' && !f.installed.has(args.at(-1)!)
      ? { status: 0, output: `config-files\t${VAULT_UTILITIES['cryptsetup-bin']}\n` }
      : run(tool, args),
  );
  expect(vaultUtilitiesStatus(f.controls)).toBe('conflict');
  await expect(installVaultUtilities(f.controls)).rejects.toThrow('vault_utilities_unavailable');
});
it.each([
  'upgrade',
  'removal',
  'foreign',
  'missing',
  'wrong-version',
  'duplicate',
  'architecture',
  'foreign-configuration',
])('rejects a dry-run %s before any package mutation', async (reason) => {
  const f = fixture();
  const valid = `Inst cryptsetup-bin (${VAULT_UTILITIES['cryptsetup-bin']} Debian:13 [arm64])\n`;
  f.setSimulation(
    reason === 'foreign-configuration'
      ? `Conf unrelated-package (1.0 Debian:13 [arm64])\n${valid}`
      : reason === 'upgrade'
        ? `Inst libcryptsetup12 [2:old] (2:new Debian:13 [arm64])\n${valid}`
        : reason === 'removal'
          ? `Remv systemd [257]\n${valid}`
          : reason === 'foreign'
            ? `Inst unrelated-package (1.0 Debian:13 [arm64])\n${valid}`
            : reason === 'missing'
              ? ''
              : reason === 'wrong-version'
                ? 'Inst cryptsetup-bin (2:other Debian:13 [arm64])\n'
                : reason === 'duplicate'
                  ? valid + valid
                  : valid.replace('[arm64]', '[amd64]'),
  );
  await expect(installVaultUtilities(f.controls)).rejects.toThrow('vault_utilities_unavailable');
  expect(
    vi.mocked(f.controls.run!).mock.calls.some((c) => c[0] === '/usr/bin/apt-get' && !c[1].includes('--simulate')),
  ).toBe(false);
});
it('refuses an already-installed incompatible version without upgrading it', async () => {
  const f = fixture();
  f.installed.set('cifs-utils', '2:foreign');
  expect(vaultUtilitiesStatus(f.controls)).toBe('conflict');
  await expect(installVaultUtilities(f.controls)).rejects.toThrow('vault_utilities_unavailable');
  expect(vi.mocked(f.controls.run!).mock.calls.every((c) => c[0] === '/usr/bin/dpkg-query')).toBe(true);
});
it.each(['authority', 'memory', 'lost-authority', 'false-success', 'interruption'])(
  'closes %s with a fixed private error',
  async (reason) => {
    const f = fixture();
    if (reason === 'authority')
      f.controls.assertAuthority = async () => {
        throw Error('PRIVATE_AUTHORITY');
      };
    if (reason === 'memory')
      f.controls.assertMemory = () => {
        throw Error('PRIVATE_MEMORY');
      };
    if (reason === 'lost-authority')
      f.controls.assertAuthority = async () => {
        if (vi.mocked(f.controls.run!).mock.calls.some((c) => c[1].includes('--simulate'))) throw Error('PRIVATE_LOSS');
      };
    if (['false-success', 'interruption'].includes(reason)) {
      const run = f.controls.run!;
      f.controls.run = vi.fn((tool, args) =>
        tool === '/usr/bin/apt-get' && !args.includes('--simulate')
          ? reason === 'false-success'
            ? { status: 0, output: '' }
            : (() => {
                throw Error('PRIVATE_UTILITY');
              })()
          : run(tool, args),
      );
    }
    await expect(installVaultUtilities(f.controls)).rejects.toThrow('vault_utilities_unavailable');
    if (['authority', 'memory', 'lost-authority'].includes(reason))
      expect(
        vi.mocked(f.controls.run!).mock.calls.some((c) => c[0] === '/usr/bin/apt-get' && !c[1].includes('--simulate')),
      ).toBe(false);
  },
);
