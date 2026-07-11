import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertSafeMattermostContractEnvironment,
  MATTERMOST_CONTRACT_IMAGE,
  POSTGRES_CONTRACT_IMAGE,
  type MattermostContractMount,
  type MattermostContractSafetyInput,
} from './safety.js';

const MATTERMOST_CONTRACT_VOLUME_NAMES = [
  'mattermost-bleve',
  'mattermost-client-plugins',
  'mattermost-config',
  'mattermost-data',
  'mattermost-logs',
  'mattermost-plugins',
  'postgres-data',
] as const;

export interface MattermostContractHarnessDependencies {
  assertSafe(): void | Promise<void>;
  start(): Promise<void>;
  proveRootMutation(): Promise<void>;
  runGreenSuite(): Promise<void>;
  stop(): Promise<void>;
}

export async function runMattermostContractHarness(dependencies: MattermostContractHarnessDependencies): Promise<void> {
  await dependencies.assertSafe();
  let primaryFailure: unknown;
  try {
    await dependencies.start();
    await dependencies.proveRootMutation();
    await dependencies.runGreenSuite();
  } catch (error) {
    primaryFailure = error;
  }
  try {
    await dependencies.stop();
  } catch (cleanupFailure) {
    if (primaryFailure !== undefined) {
      throw new AggregateError([primaryFailure, cleanupFailure], 'Mattermost contract run and cleanup both failed', {
        cause: cleanupFailure,
      });
    }
    throw cleanupFailure;
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

export interface MattermostContractCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface MattermostContractCommand {
  executable: string;
  args: readonly string[];
  cwd: string;
  environment: Readonly<Record<string, string>>;
  timeoutMs: number;
}

export type MattermostContractCommandExecutor = (
  command: MattermostContractCommand,
) => Promise<MattermostContractCommandResult>;

export async function executeMattermostContractCommand(
  command: MattermostContractCommand,
): Promise<MattermostContractCommandResult> {
  if (!path.isAbsolute(command.cwd) || command.timeoutMs < 1 || !Number.isSafeInteger(command.timeoutMs)) {
    throw new Error('Mattermost contract command was invalid');
  }
  return new Promise((resolve, reject) => {
    execFile(
      command.executable,
      [...command.args],
      {
        cwd: command.cwd,
        encoding: 'utf8',
        env: { ...command.environment },
        maxBuffer: 4 * 1024 * 1024,
        timeout: command.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ exitCode: 0, stdout, stderr });
          return;
        }
        if (error.killed) {
          reject(new Error('Mattermost contract command timed out'));
          return;
        }
        if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(new Error('Mattermost contract command output exceeded its limit'));
          return;
        }
        if (typeof error.code === 'number') {
          resolve({ exitCode: error.code, stdout, stderr });
          return;
        }
        if (error.signal) {
          resolve({ exitCode: 1, stdout, stderr });
          return;
        }
        reject(new Error('Mattermost contract command could not start'));
      },
    );
  });
}

export interface MattermostContractHarnessOptions {
  repoRoot: string;
  callerEnvironment: Readonly<Record<string, string | undefined>>;
  hostArchitecture: string;
  projectName: string;
  execute: MattermostContractCommandExecutor;
}

export function createMattermostContractHarnessDependencies(
  options: MattermostContractHarnessOptions,
): MattermostContractHarnessDependencies {
  if (!path.isAbsolute(options.repoRoot) || !/^[a-z0-9][a-z0-9_-]{0,62}$/.test(options.projectName)) {
    throw new Error('Mattermost contract command harness options were invalid');
  }
  const composeArgs = [
    'compose',
    '-f',
    path.join(options.repoRoot, 'test/contracts/mattermost/docker-compose.yml'),
    '-p',
    options.projectName,
  ];
  const commandEnvironment = contractCommandEnvironment(options.callerEnvironment);
  const execute = (executable: string, args: readonly string[], timeoutMs: number, extraEnvironment = {}) =>
    options.execute({
      executable,
      args,
      cwd: options.repoRoot,
      environment: { ...commandEnvironment, ...extraEnvironment },
      timeoutMs,
    });
  const checked = async (
    executable: string,
    args: readonly string[],
    timeoutMs: number,
    extraEnvironment?: Readonly<Record<string, string>>,
  ): Promise<MattermostContractCommandResult> => {
    const result = await execute(executable, args, timeoutMs, extraEnvironment);
    if (result.exitCode !== 0) {
      throw new Error(`Mattermost contract command failed: ${executable} ${args[0] ?? ''}`.trim());
    }
    return result;
  };
  return {
    async assertSafe() {
      assertSafeMattermostContractEnvironment({
        callerEnvironment: options.callerEnvironment,
        endpoint: 'http://127.0.0.1:8065',
        dockerContext: options.callerEnvironment.DOCKER_CONTEXT,
        dockerHost: options.callerEnvironment.DOCKER_HOST,
        hostArchitecture: options.hostArchitecture,
        images: { mattermost: MATTERMOST_CONTRACT_IMAGE, postgres: POSTGRES_CONTRACT_IMAGE },
        services: [],
        networks: [],
      });
      const contextResult = await checked('docker', ['context', 'show'], 30_000);
      const dockerContext = contextResult.stdout.trim();
      if (dockerContext !== 'default') {
        throw new Error('Mattermost contract tests require the local default Docker context');
      }
      const hostResult = await checked(
        'docker',
        ['context', 'inspect', dockerContext, '--format', '{{json .Endpoints.docker.Host}}'],
        30_000,
      );
      let dockerHost: unknown;
      try {
        dockerHost = JSON.parse(hostResult.stdout.trim());
      } catch (err) {
        if (!(err instanceof SyntaxError)) throw err;
        throw new Error('Mattermost contract Docker endpoint was invalid', { cause: err });
      }
      if (typeof dockerHost !== 'string') throw new Error('Mattermost contract Docker endpoint was invalid');
      const composeResult = await checked('docker', [...composeArgs, 'config', '--format', 'json'], 30_000);
      const safetyInput = parseMattermostContractComposeConfig(composeResult.stdout, {
        callerEnvironment: options.callerEnvironment,
        dockerContext,
        dockerHost,
        hostArchitecture: options.hostArchitecture,
        projectName: options.projectName,
      });
      assertSafeMattermostContractEnvironment(safetyInput);
    },
    async start() {
      await checked('docker', [...composeArgs, 'up', '-d'], 600_000);
    },
    async proveRootMutation() {
      const result = await execute(
        'pnpm',
        [
          'exec',
          'vitest',
          'run',
          '--config',
          path.join(options.repoRoot, 'vitest.mattermost.config.ts'),
          '-t',
          'preserves outbound channel and root_id',
        ],
        600_000,
        {
          NANOCLAW_MM_CONTRACT_ACTIVE: '1',
          NANOCLAW_MM_CONTRACT_MUTATE_ROOT_ID: '1',
        },
      );
      if (result.exitCode === 0 || !`${result.stdout}\n${result.stderr}`.includes('CONTRACT_ROOT_ID_ASSERTION')) {
        throw new Error('Mattermost contract root_id mutation was not detected');
      }
    },
    async runGreenSuite() {
      await checked(
        'pnpm',
        ['exec', 'vitest', 'run', '--config', path.join(options.repoRoot, 'vitest.mattermost.config.ts')],
        600_000,
        { NANOCLAW_MM_CONTRACT_ACTIVE: '1' },
      );
    },
    async stop() {
      await checked('docker', [...composeArgs, 'down', '--volumes', '--remove-orphans', '--timeout', '10'], 120_000);
    },
  };
}

function contractCommandEnvironment(
  callerEnvironment: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const allowedKeys = [
    'CI',
    'DOCKER_CONTEXT',
    'DOCKER_HOST',
    'FORCE_COLOR',
    'HOME',
    'PATH',
    'RUNNER_TEMP',
    'TEMP',
    'TMP',
    'TMPDIR',
  ];
  return Object.fromEntries(
    allowedKeys.flatMap((key) => {
      const value = callerEnvironment[key];
      return value === undefined ? [] : [[key, value]];
    }),
  );
}

export function parseMattermostContractComposeConfig(
  serialized: string,
  runtime: Pick<
    MattermostContractSafetyInput,
    'callerEnvironment' | 'dockerContext' | 'dockerHost' | 'hostArchitecture'
  > & { readonly projectName: string },
): MattermostContractSafetyInput {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new Error('Mattermost contract Compose configuration was invalid', { cause: err });
  }
  if (
    !isRecord(value) ||
    !isRecord(value.services) ||
    !isRecord(value.networks) ||
    (value.volumes !== undefined && !isRecord(value.volumes))
  ) {
    throw new Error('Mattermost contract Compose configuration was invalid');
  }
  const composeServices = value.services;
  const composeNetworks = value.networks;
  const composeVolumes = value.volumes ?? {};
  const serviceNames = Object.keys(composeServices).sort();
  if (serviceNames.length !== 2 || serviceNames[0] !== 'mattermost' || serviceNames[1] !== 'postgres') {
    throw new Error('Mattermost contract Compose configuration was invalid');
  }
  const services = serviceNames.map((name) => normalizeComposeService(name, composeServices[name]));
  const networks = Object.entries(composeNetworks).map(([name, network]) => {
    if (
      !isRecord(network) ||
      (network.external !== undefined && typeof network.external !== 'boolean') ||
      (network.internal !== undefined && typeof network.internal !== 'boolean') ||
      (network.name !== undefined && typeof network.name !== 'string')
    ) {
      throw new Error('Mattermost contract Compose configuration was invalid');
    }
    if (network.name !== `${runtime.projectName}_${name}`) {
      throw new Error(`Mattermost contract Compose networks must be project-scoped: ${name}`);
    }
    return { name, external: network.external === true, internal: network.internal === true };
  });
  for (const [name, volume] of Object.entries(composeVolumes)) {
    if (
      !isRecord(volume) ||
      (volume.external !== undefined && typeof volume.external !== 'boolean') ||
      (volume.driver !== undefined && typeof volume.driver !== 'string')
    ) {
      throw new Error('Mattermost contract Compose configuration was invalid');
    }
    if (volume.external === true) {
      throw new Error(`Mattermost contract Compose volumes must not be external: ${name}`);
    }
    if (volume.driver_opts !== undefined) {
      throw new Error(`Mattermost contract Compose volumes must not use driver options: ${name}`);
    }
    if (volume.driver !== undefined) {
      throw new Error(`Mattermost contract Compose volumes must use the default local driver: ${name}`);
    }
    if (volume.name !== `${runtime.projectName}_${name}`) {
      throw new Error(`Mattermost contract Compose volumes must be project-scoped: ${name}`);
    }
  }
  const volumeNames = Object.keys(composeVolumes).sort();
  if (
    volumeNames.length !== MATTERMOST_CONTRACT_VOLUME_NAMES.length ||
    volumeNames.some((name, index) => name !== MATTERMOST_CONTRACT_VOLUME_NAMES[index])
  ) {
    throw new Error('Mattermost contract Compose volumes must match the disposable topology');
  }
  return {
    callerEnvironment: runtime.callerEnvironment,
    endpoint: 'http://127.0.0.1:8065',
    dockerContext: runtime.dockerContext,
    dockerHost: runtime.dockerHost,
    hostArchitecture: runtime.hostArchitecture,
    images: {
      mattermost: requiredString((composeServices.mattermost as Record<string, unknown>).image),
      postgres: requiredString((composeServices.postgres as Record<string, unknown>).image),
    },
    services,
    networks,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error('Mattermost contract Compose configuration was invalid');
  }
  return value;
}

function normalizeComposeService(name: string, value: unknown): MattermostContractSafetyInput['services'][number] {
  const unnormalizedHostPrivileges = [
    'cap_add',
    'cgroup',
    'devices',
    'ipc',
    'pid',
    'uts',
    'userns_mode',
    'use_api_socket',
    'volumes_from',
  ];
  if (
    !isRecord(value) ||
    unnormalizedHostPrivileges.some((key) => value[key] !== undefined) ||
    typeof value.image !== 'string' ||
    (value.privileged !== undefined && typeof value.privileged !== 'boolean') ||
    (value.network_mode !== undefined && typeof value.network_mode !== 'string') ||
    (value.volumes !== undefined && !Array.isArray(value.volumes)) ||
    (value.ports !== undefined && !Array.isArray(value.ports))
  ) {
    throw new Error('Mattermost contract Compose configuration was invalid');
  }
  const mounts: MattermostContractMount[] = (value.volumes ?? []).map((mount) => {
    if (
      !isRecord(mount) ||
      (mount.type !== 'bind' && mount.type !== 'tmpfs' && mount.type !== 'volume') ||
      (mount.source !== undefined && typeof mount.source !== 'string') ||
      typeof mount.target !== 'string' ||
      mount.target.length === 0
    ) {
      throw new Error('Mattermost contract Compose configuration was invalid');
    }
    return { type: mount.type, source: mount.source, target: mount.target } as MattermostContractMount;
  });
  const ports = (value.ports ?? []).map((port) => {
    if (
      !isRecord(port) ||
      (port.host_ip !== undefined && typeof port.host_ip !== 'string') ||
      (port.target !== undefined && (typeof port.target !== 'number' || !Number.isSafeInteger(port.target))) ||
      (port.published !== undefined && typeof port.published !== 'string')
    ) {
      throw new Error('Mattermost contract Compose configuration was invalid');
    }
    return { hostIp: port.host_ip, target: port.target, published: port.published };
  });
  return {
    name,
    privileged: value.privileged,
    networkMode: value.network_mode,
    ports,
    mounts,
  };
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const dependencies = createMattermostContractHarnessDependencies({
    repoRoot,
    callerEnvironment: process.env,
    hostArchitecture: process.arch,
    projectName: `nanoclaw-mm-contract-${process.pid}`,
    execute: executeMattermostContractCommand,
  });
  runMattermostContractHarness(dependencies).then(
    () => {
      process.stdout.write('Disposable Mattermost contract suite passed.\n');
    },
    (error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown Mattermost contract failure';
      process.stderr.write(`Disposable Mattermost contract suite failed: ${message}\n`);
      process.exitCode = 1;
    },
  );
}
