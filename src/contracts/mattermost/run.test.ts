import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  createMattermostContractHarnessDependencies,
  executeMattermostContractCommand,
  parseMattermostContractComposeConfig,
  runMattermostContractHarness,
  type MattermostContractHarnessDependencies,
  type MattermostContractCommand,
} from './run.js';
import { MATTERMOST_CONTRACT_IMAGE, POSTGRES_CONTRACT_IMAGE } from './safety.js';

const CONTRACT_PROJECT_NAME = 'nanoclaw-mm-contract-test';
const CONTRACT_VOLUME_NAMES = [
  'mattermost-bleve',
  'mattermost-client-plugins',
  'mattermost-config',
  'mattermost-data',
  'mattermost-logs',
  'mattermost-plugins',
  'postgres-data',
] as const;

function contractVolumes(names: readonly string[] = CONTRACT_VOLUME_NAMES): Record<string, { name: string }> {
  return Object.fromEntries(names.map((name) => [name, { name: `${CONTRACT_PROJECT_NAME}_${name}` }]));
}

function harnessDependencies(
  overrides: Partial<MattermostContractHarnessDependencies> = {},
): MattermostContractHarnessDependencies {
  return {
    assertSafe: vi.fn(),
    start: vi.fn(async () => undefined),
    proveRootMutation: vi.fn(async () => undefined),
    runGreenSuite: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe('Mattermost contract harness runner', () => {
  it('binds the real contract proxy only on loopback and closes its sockets', async () => {
    const runModule = (await import('./run.js')) as unknown as {
      createMattermostContractLoopbackProxy?: (
        targetHost: string,
        targetPort: number,
        dependencies: { createServer: never; createConnection: never },
      ) => Promise<{ close(): Promise<void> }>;
    };
    expect(runModule.createMattermostContractLoopbackProxy).toEqual(expect.any(Function));
    if (!runModule.createMattermostContractLoopbackProxy) return;

    const client = new PassThrough();
    const upstream = new PassThrough();
    let acceptConnection: ((socket: PassThrough) => void) | undefined;
    const server = {
      once: vi.fn().mockReturnThis(),
      off: vi.fn().mockReturnThis(),
      listen: vi.fn((_options: unknown, callback: () => void) => callback()),
      close: vi.fn((callback: (error?: Error) => void) => callback()),
    };
    const createServer = vi.fn((listener: (socket: PassThrough) => void) => {
      acceptConnection = listener;
      return server;
    });
    const createConnection = vi.fn(() => upstream);
    const proxy = await runModule.createMattermostContractLoopbackProxy('10.255.255.1', 8065, {
      createServer: createServer as never,
      createConnection: createConnection as never,
    });
    expect(server.listen).toHaveBeenCalledWith(
      { host: '127.0.0.1', port: 8065, exclusive: true },
      expect.any(Function),
    );
    acceptConnection!(client);
    expect(createConnection).toHaveBeenCalledWith({ host: '10.255.255.1', port: 8065 });
    await proxy.close();
    expect(client.destroyed).toBe(true);
    expect(upstream.destroyed).toBe(true);
    expect(server.close).toHaveBeenCalledOnce();
  });

  it('executes argv without a shell and captures bounded process results', async () => {
    await expect(
      executeMattermostContractCommand({
        executable: process.execPath,
        args: [
          '-e',
          'require("node:fs").writeSync(1, "contract-out"); require("node:fs").writeSync(2, "contract-err"); process.exitCode = 7',
        ],
        cwd: process.cwd(),
        environment: { PATH: process.env.PATH ?? '' },
        timeoutMs: 5_000,
      }),
    ).resolves.toEqual({ exitCode: 7, stdout: 'contract-out', stderr: 'contract-err' });
  });

  it('validates Compose, proves the root mutation, runs Green, and destroys volumes', async () => {
    const commands: MattermostContractCommand[] = [];
    const closeProxy = vi.fn(async () => undefined);
    const createLoopbackProxy = vi.fn(async () => ({ close: closeProxy }));
    const composeConfig = JSON.stringify({
      services: {
        mattermost: {
          image: MATTERMOST_CONTRACT_IMAGE,
          volumes: [{ type: 'volume', source: 'mattermost-data', target: '/mattermost/data' }],
        },
        postgres: {
          image: POSTGRES_CONTRACT_IMAGE,
          volumes: [{ type: 'volume', source: 'postgres-data', target: '/var/lib/postgresql' }],
        },
      },
      volumes: contractVolumes(),
      networks: {
        contract: { name: 'nanoclaw-mm-contract-test_contract', external: false, internal: true },
      },
    });
    const execute = vi.fn(async (command: MattermostContractCommand) => {
      commands.push(command);
      const joined = [command.executable, ...command.args].join(' ');
      if (joined === 'docker context show') return { exitCode: 0, stdout: 'default\n', stderr: '' };
      if (joined.includes('docker context inspect')) {
        return { exitCode: 0, stdout: '"unix:///var/run/docker.sock"\n', stderr: '' };
      }
      if (joined.includes('config --format json')) return { exitCode: 0, stdout: composeConfig, stderr: '' };
      if (joined.includes(' ps -q mattermost')) {
        return { exitCode: 0, stdout: `${'a'.repeat(64)}\n`, stderr: '' };
      }
      if (joined.startsWith(`docker inspect ${'a'.repeat(64)} `)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            'nanoclaw-mm-contract-test_contract': { IPAddress: '172.20.0.2' },
          }),
          stderr: '',
        };
      }
      if (command.environment.NANOCLAW_MM_CONTRACT_MUTATE_ROOT_ID === '1') {
        return { exitCode: 1, stdout: '', stderr: 'CONTRACT_ROOT_ID_ASSERTION' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const dependencies = createMattermostContractHarnessDependencies({
      repoRoot: '/repo',
      callerEnvironment: { PATH: '/usr/bin', HOME: '/tmp/contract-home' },
      hostArchitecture: 'x64',
      projectName: 'nanoclaw-mm-contract-test',
      execute,
      createLoopbackProxy,
    });

    await expect(runMattermostContractHarness(dependencies)).resolves.toBeUndefined();

    expect(commands.map((command) => [command.executable, ...command.args].join(' '))).toEqual([
      'docker context show',
      'docker context inspect default --format {{json .Endpoints.docker.Host}}',
      'docker compose -f /repo/test/contracts/mattermost/docker-compose.yml -p nanoclaw-mm-contract-test config --format json',
      'docker compose -f /repo/test/contracts/mattermost/docker-compose.yml -p nanoclaw-mm-contract-test up -d',
      'docker compose -f /repo/test/contracts/mattermost/docker-compose.yml -p nanoclaw-mm-contract-test ps -q mattermost',
      `docker inspect ${'a'.repeat(64)} --format {{json .NetworkSettings.Networks}}`,
      'pnpm exec vitest run --config /repo/vitest.mattermost.config.ts -t preserves outbound channel and root_id',
      'pnpm exec vitest run --config /repo/vitest.mattermost.config.ts',
      'docker compose -f /repo/test/contracts/mattermost/docker-compose.yml -p nanoclaw-mm-contract-test down --volumes --remove-orphans --timeout 10',
    ]);
    expect(createLoopbackProxy).toHaveBeenCalledWith('172.20.0.2', 8065);
    expect(closeProxy).toHaveBeenCalledOnce();
  });

  it('does not mistake an unrelated live-test failure for the root mutation proof', async () => {
    const composeConfig = JSON.stringify({
      services: {
        mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
        postgres: { image: POSTGRES_CONTRACT_IMAGE },
      },
      volumes: contractVolumes(),
      networks: {},
    });
    const reportDiagnostic = vi.fn();
    const createLoopbackProxy = vi.fn(async () => ({ close: vi.fn(async () => undefined) }));
    const execute = vi.fn(async (command: MattermostContractCommand) => {
      const joined = [command.executable, ...command.args].join(' ');
      if (joined === 'docker context show') return { exitCode: 0, stdout: 'default\n', stderr: '' };
      if (joined.includes('docker context inspect')) {
        return { exitCode: 0, stdout: '"unix:///var/run/docker.sock"\n', stderr: '' };
      }
      if (joined.includes('config --format json')) return { exitCode: 0, stdout: composeConfig, stderr: '' };
      if (joined.includes(' ps -q mattermost')) {
        return { exitCode: 0, stdout: `${'b'.repeat(64)}\n`, stderr: '' };
      }
      if (joined.startsWith(`docker inspect ${'b'.repeat(64)} `)) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            'nanoclaw-mm-contract-test_contract': { IPAddress: '172.20.0.3' },
          }),
          stderr: '',
        };
      }
      if (joined.includes(' ps --all ')) return { exitCode: 0, stdout: 'mattermost exited', stderr: '' };
      if (joined.includes(' logs --no-color ')) {
        return {
          exitCode: 0,
          stdout:
            'open /mattermost/config/config.json: permission denied password=synthetic-password Authorization: Bearer synthetic-bot-token',
          stderr: '',
        };
      }
      if (command.environment.NANOCLAW_MM_CONTRACT_MUTATE_ROOT_ID === '1') {
        return {
          exitCode: 1,
          stdout: '',
          stderr: 'unrelated infrastructure failure token=synthetic-worker-token',
        };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const dependencies = createMattermostContractHarnessDependencies({
      repoRoot: '/repo',
      callerEnvironment: { PATH: '/usr/bin' },
      hostArchitecture: 'x64',
      projectName: 'nanoclaw-mm-contract-test',
      execute,
      reportDiagnostic,
      createLoopbackProxy,
    });

    await expect(runMattermostContractHarness(dependencies)).rejects.toThrow(
      'Mattermost contract root_id mutation was not detected',
    );
    expect(execute.mock.calls.some(([{ args }]) => args.includes('down') && args.includes('--volumes'))).toBe(true);
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    const diagnostic = reportDiagnostic.mock.calls[0]![0] as string;
    expect(diagnostic).toContain('permission denied');
    expect(diagnostic).toContain('[REDACTED]');
    expect(diagnostic).not.toContain('synthetic-password');
    expect(diagnostic).not.toContain('synthetic-bot-token');
    expect(diagnostic).not.toContain('synthetic-worker-token');
  });

  it('reports a redacted full live-suite failure before cleanup', async () => {
    const reportDiagnostic = vi.fn();
    const execute = vi.fn(async (command: MattermostContractCommand) => {
      const joined = [command.executable, ...command.args].join(' ');
      if (command.executable === 'pnpm') {
        return { exitCode: 1, stdout: '', stderr: 'GREEN_ASSERTION token=synthetic-green-token' };
      }
      if (joined.includes(' ps --all ')) return { exitCode: 0, stdout: 'mattermost running', stderr: '' };
      if (joined.includes(' logs --no-color ')) {
        return { exitCode: 0, stdout: 'green failure detail password=synthetic-green-password', stderr: '' };
      }
      return { exitCode: 0, stdout: '', stderr: '' };
    });
    const dependencies = createMattermostContractHarnessDependencies({
      repoRoot: '/repo',
      callerEnvironment: { PATH: '/usr/bin' },
      hostArchitecture: 'x64',
      projectName: 'nanoclaw-mm-contract-test',
      execute,
      reportDiagnostic,
    });

    await expect(dependencies.runGreenSuite()).rejects.toThrow('Mattermost contract live suite failed');
    expect(reportDiagnostic).toHaveBeenCalledOnce();
    const diagnostic = reportDiagnostic.mock.calls[0]![0] as string;
    expect(diagnostic).toContain('GREEN_ASSERTION');
    expect(diagnostic).toContain('green failure detail');
    expect(diagnostic).not.toContain('synthetic-green-token');
    expect(diagnostic).not.toContain('synthetic-green-password');
  });

  it('normalizes the complete Compose safety surface before startup', () => {
    expect(
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: {
              image: MATTERMOST_CONTRACT_IMAGE,
              privileged: false,
              network_mode: 'bridge',
              ports: [{ host_ip: '127.0.0.1', target: 8065, published: '8065' }],
              volumes: [{ type: 'volume', source: 'mattermost-data', target: '/mattermost/data' }],
            },
            postgres: {
              image: POSTGRES_CONTRACT_IMAGE,
              volumes: [{ type: 'tmpfs', target: '/tmp' }],
            },
          },
          volumes: contractVolumes(),
          networks: {
            contract: { name: 'nanoclaw-mm-contract-test_contract', external: false, internal: true },
          },
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toEqual({
      callerEnvironment: {},
      endpoint: 'http://127.0.0.1:8065',
      dockerContext: 'default',
      dockerHost: 'unix:///var/run/docker.sock',
      hostArchitecture: 'x64',
      images: { mattermost: MATTERMOST_CONTRACT_IMAGE, postgres: POSTGRES_CONTRACT_IMAGE },
      services: [
        {
          name: 'mattermost',
          privileged: false,
          networkMode: 'bridge',
          ports: [{ hostIp: '127.0.0.1', target: 8065, published: '8065' }],
          mounts: [{ type: 'volume', source: 'mattermost-data', target: '/mattermost/data' }],
        },
        {
          name: 'postgres',
          privileged: undefined,
          networkMode: undefined,
          ports: [],
          mounts: [{ type: 'tmpfs', source: undefined, target: '/tmp' }],
        },
      ],
      networks: [{ name: 'contract', external: false, internal: true }],
    });
  });

  it('rejects unnormalized host-privilege fields instead of silently ignoring them', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE, pid: 'host' },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose configuration was invalid');
  });

  it('rejects external top-level Compose volumes instead of attaching shared storage', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          volumes: { shared: { external: true } },
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose volumes must not be external: shared');
  });

  it('rejects top-level volume driver options that could bind host storage', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          volumes: {
            shared: { driver: 'local', driver_opts: { type: 'none', device: '/srv/shared', o: 'bind' } },
          },
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose volumes must not use driver options: shared');
  });

  it('rejects fixed top-level volume names outside the disposable Compose project', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          volumes: { data: { name: 'shared-production-data' } },
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose volumes must be project-scoped: data');
  });

  it('rejects custom top-level volume drivers', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          volumes: { data: { name: 'nanoclaw-mm-contract-test_data', driver: 'nfs' } },
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose volumes must use the default local driver: data');
  });

  it('rejects fixed top-level network names outside the disposable Compose project', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          networks: {
            contract: { name: 'shared-production-network', external: false, internal: true },
          },
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: 'nanoclaw-mm-contract-test',
        },
      ),
    ).toThrow('Mattermost contract Compose networks must be project-scoped: contract');
  });

  it('rejects an incomplete disposable named-volume topology', () => {
    expect(() =>
      parseMattermostContractComposeConfig(
        JSON.stringify({
          services: {
            mattermost: { image: MATTERMOST_CONTRACT_IMAGE },
            postgres: { image: POSTGRES_CONTRACT_IMAGE },
          },
          volumes: contractVolumes(CONTRACT_VOLUME_NAMES.filter((name) => name !== 'postgres-data')),
          networks: {},
        }),
        {
          callerEnvironment: {},
          dockerContext: 'default',
          dockerHost: 'unix:///var/run/docker.sock',
          hostArchitecture: 'x64',
          projectName: CONTRACT_PROJECT_NAME,
        },
      ),
    ).toThrow('Mattermost contract Compose volumes must match the disposable topology');
  });

  it('always destroys the disposable environment when the live suite fails', async () => {
    const failure = new Error('injected live contract failure');
    const dependencies = harnessDependencies({
      runGreenSuite: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(runMattermostContractHarness(dependencies)).rejects.toBe(failure);

    expect(dependencies.assertSafe).toHaveBeenCalledOnce();
    expect(dependencies.start).toHaveBeenCalledOnce();
    expect(dependencies.proveRootMutation).toHaveBeenCalledOnce();
    expect(dependencies.runGreenSuite).toHaveBeenCalledOnce();
    expect(dependencies.stop).toHaveBeenCalledOnce();
  });

  it('cleans a partially created environment when startup fails', async () => {
    const failure = new Error('injected compose startup failure');
    const dependencies = harnessDependencies({
      start: vi.fn(async () => {
        throw failure;
      }),
    });

    await expect(runMattermostContractHarness(dependencies)).rejects.toBe(failure);

    expect(dependencies.stop).toHaveBeenCalledOnce();
    expect(dependencies.proveRootMutation).not.toHaveBeenCalled();
    expect(dependencies.runGreenSuite).not.toHaveBeenCalled();
  });

  it('preserves both the live failure and a cleanup failure', async () => {
    const liveFailure = new Error('injected live failure');
    const cleanupFailure = new Error('injected cleanup failure');
    const dependencies = harnessDependencies({
      runGreenSuite: vi.fn(async () => {
        throw liveFailure;
      }),
      stop: vi.fn(async () => {
        throw cleanupFailure;
      }),
    });

    const failure = await runMattermostContractHarness(dependencies).then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([liveFailure, cleanupFailure]);
  });
});
