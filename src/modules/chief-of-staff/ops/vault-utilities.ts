export const VAULT_UTILITY_RESERVE = 256 * 1024 ** 2;
export const VAULT_UTILITIES = { 'cryptsetup-bin': '2:2.7.5-2', 'cifs-utils': '2:7.4-1' } as const;
export type VaultUtilityControls = {
  assertAuthority(): Promise<void>;
  assertMemory(): void;
  run?(command: string, args: string[]): { status: number; output: string };
};
const dependencies = new Set([
  'libcryptsetup12',
  'libdevmapper1.02.1',
  'dmsetup',
  'libargon2-1',
  'libjson-c5',
  'libpopt0',
  'libtalloc2',
  'libwbclient0',
  'libkeyutils1',
  'libgssapi-krb5-2',
  'libkrb5-3',
  'libk5crypto3',
  'libkrb5support0',
  'libcom-err2',
]);
function command(controls: VaultUtilityControls, tool: string, args: string[]) {
  controls.assertMemory();
  const result = (
    controls.run ??
    ((name, values) => {
      const child = spawnSync(name, values, {
        cwd: '/',
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C', DEBIAN_FRONTEND: 'noninteractive' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: name === '/usr/bin/apt-get' ? 120000 : 5000,
        maxBuffer: 262144,
      });
      if (child.error || child.signal || child.status === null) throw Error('utility_process_unavailable');
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
    throw Error('utility_output_unavailable');
  return result;
}
function missing(controls: VaultUtilityControls): string[] {
  const needed: string[] = [];
  for (const [name, version] of Object.entries(VAULT_UTILITIES)) {
    const result = command(controls, '/usr/bin/dpkg-query', [
      '--show',
      '--showformat=${db:Status-Status}\t${Version}\n',
      name,
    ]);
    if ((result.status === 1 && !result.output) || (result.status === 0 && result.output === 'not-installed\t\n'))
      needed.push(name);
    else if (result.status !== 0 || result.output !== `installed\t${version}\n`)
      throw Error('utility_version_conflict');
  }
  return needed;
}
export function vaultUtilitiesStatus(controls: VaultUtilityControls): 'absent' | 'matching' | 'conflict' {
  try {
    return missing(controls).length ? 'absent' : 'matching';
    // eslint-disable-next-line no-catch-all/no-catch-all -- Availability exposes only fixed version status, no package-manager diagnostics.
  } catch {
    return 'conflict';
  }
}
/** No source update, OS upgrade or removal. Only checked missing utilities and their necessary new dependencies. */
export async function installVaultUtilities(controls: VaultUtilityControls): Promise<void> {
  try {
    const authority = async () => {
      controls.assertMemory();
      await controls.assertAuthority();
      controls.assertMemory();
    };
    await authority();
    const needed = missing(controls);
    if (!needed.length) return;
    if (!controls.run && (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0))
      throw Error('root_process_required');
    const options = ['--yes', '--no-upgrade', '--no-remove', '--no-install-recommends', '-o', 'DPkg::Lock::Timeout=0'];
    const requested = needed.map((name) => name + '=' + VAULT_UTILITIES[name as keyof typeof VAULT_UTILITIES]);
    const dry = command(controls, '/usr/bin/apt-get', ['--simulate', ...options, 'install', ...requested]);
    if (dry.status !== 0) throw Error('utility_installation_unavailable');
    const plan = new Map<string, { argument: string; version: string }>();
    const configurations: Array<{ name: string; version: string }> = [];
    for (const line of dry.output.split('\n')) {
      if (/^(Remv|Purg)\b/.test(line)) throw Error('utility_removal_denied');
      if (/^Conf\b/.test(line)) {
        const match = /^Conf ([a-z0-9][a-z0-9.+-]+(?::arm64)?) \(([a-zA-Z0-9.+:~_-]+) [^\r\n]*\[arm64\]\)$/.exec(line);
        if (!match) throw Error('utility_configuration_denied');
        configurations.push({ name: match[1].replace(/:arm64$/, ''), version: match[2] });
        continue;
      }
      if (!/^Inst\b/.test(line)) continue;
      const match = /^Inst ([a-z0-9][a-z0-9.+-]+(?::arm64)?) \(([a-zA-Z0-9.+:~_-]+) [^\r\n]*\[arm64\]\)$/.exec(line);
      if (!match) throw Error('utility_upgrade_or_architecture_denied');
      const name = match[1].replace(/:arm64$/, '');
      if (plan.has(name) || plan.size >= 16 || (!needed.includes(name) && !dependencies.has(name)))
        throw Error('utility_scope_conflict');
      if (name in VAULT_UTILITIES && match[2] !== VAULT_UTILITIES[name as keyof typeof VAULT_UTILITIES])
        throw Error('utility_version_conflict');
      plan.set(name, { argument: match[1] + '=' + match[2], version: match[2] });
    }
    if (needed.some((name) => plan.get(name)?.version !== VAULT_UTILITIES[name as keyof typeof VAULT_UTILITIES]))
      throw Error('utility_plan_unverified');
    if (configurations.some((value) => plan.get(value.name)?.version !== value.version))
      throw Error('utility_foreign_configuration_denied');
    await authority();
    // Pin new dependencies too; a repeated request cannot upgrade one already installed by the checked operation.
    if (
      command(controls, '/usr/bin/apt-get', [
        ...options,
        'install',
        ...[...plan.values()].map((value) => value.argument),
      ]).status !== 0
    )
      throw Error('utility_installation_unavailable');
    await authority();
    for (const [name, value] of plan) {
      const proof = command(controls, '/usr/bin/dpkg-query', [
        '--show',
        '--showformat=${db:Status-Status}\t${Version}\n',
        name,
      ]);
      if (proof.status !== 0 || proof.output !== `installed\t${value.version}\n`)
        throw Error('utility_dependency_unverified');
    }
    if (vaultUtilitiesStatus(controls) !== 'matching') throw Error('utility_installation_unverified');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Package diagnostics and owner lease information remain private.
    throw Error('vault_utilities_unavailable');
  }
}
import { spawnSync } from 'node:child_process';
