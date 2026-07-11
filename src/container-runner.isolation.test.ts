import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentGroup, Session } from './types.js';

const runnerMocks = vi.hoisted(() => ({
  testRoot: `/tmp/nanoclaw-container-runner-isolation-${process.pid}`,
  groups: new Map<string, AgentGroup>(),
  spawned: [] as EventEmitter[],
  spawn: vi.fn(),
  ensureAgent: vi.fn(),
  applyContainerConfig: vi.fn(),
}));

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  spawn: runnerMocks.spawn,
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = runnerMocks.ensureAgent;
    applyContainerConfig = runnerMocks.applyContainerConfig;
  },
}));

vi.mock('./config.js', () => ({
  CONTAINER_IMAGE: 'nanoclaw-test:latest',
  CONTAINER_IMAGE_BASE: 'nanoclaw-test',
  CONTAINER_INSTALL_LABEL: 'nanoclaw-install=test',
  DATA_DIR: path.join(runnerMocks.testRoot, 'data'),
  GROUPS_DIR: path.join(runnerMocks.testRoot, 'groups'),
  ONECLI_API_KEY: undefined,
  ONECLI_URL: undefined,
  TIMEZONE: 'UTC',
}));

vi.mock('./container-config.js', () => ({
  readContainerConfig: vi.fn(() => ({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
  })),
  writeContainerConfig: vi.fn(),
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((hostPath: string, containerPath: string) => ['--mount-ro', `${hostPath}:${containerPath}`]),
  stopContainer: vi.fn(),
}));

vi.mock('./claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => runnerMocks.groups.get(id)),
}));
vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => ({})),
  hasTable: vi.fn(() => false),
}));
vi.mock('./group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));
vi.mock('./modules/mount-security/index.js', () => ({ validateAdditionalMounts: vi.fn(() => []) }));
vi.mock('./modules/typing/index.js', () => ({ stopTypingRefresh: vi.fn() }));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/provider-container-registry.js', () => ({
  getProviderContainerConfig: vi.fn(() => undefined),
}));
vi.mock('./session-manager.js', () => ({
  heartbeatPath: (agentGroupId: string, sessionId: string) =>
    path.join(runnerMocks.testRoot, 'data', 'v2-sessions', agentGroupId, sessionId, '.heartbeat'),
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  sessionDir: (agentGroupId: string, sessionId: string) =>
    path.join(runnerMocks.testRoot, 'data', 'v2-sessions', agentGroupId, sessionId),
  writeSessionRouting: vi.fn(),
}));

import { getActiveContainerCount, isContainerRunning, wakeContainer } from './container-runner.js';

function agentGroup(id: string, folder: string): AgentGroup {
  return {
    id,
    name: `Agent ${id}`,
    folder,
    agent_provider: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function session(id: string, agentGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: `messaging-${id}`,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function writableMounts(args: string[]): Map<string, string> {
  const mounts = new Map<string, string>();
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-v') continue;
    const mount = args[i + 1];
    const separator = mount.lastIndexOf(':');
    mounts.set(mount.slice(separator + 1), mount.slice(0, separator));
  }
  return mounts;
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

beforeEach(() => {
  fs.rmSync(runnerMocks.testRoot, { recursive: true, force: true });
  fs.mkdirSync(runnerMocks.testRoot, { recursive: true });
  runnerMocks.groups.clear();
  runnerMocks.spawned.length = 0;
  runnerMocks.spawn.mockReset().mockImplementation(() => {
    const child = new EventEmitter() as EventEmitter & {
      kill: ReturnType<typeof vi.fn>;
      stderr: { on: ReturnType<typeof vi.fn> };
      stdout: { on: ReturnType<typeof vi.fn> };
    };
    child.kill = vi.fn();
    child.stderr = { on: vi.fn() };
    child.stdout = { on: vi.fn() };
    runnerMocks.spawned.push(child);
    return child;
  });
  runnerMocks.ensureAgent.mockReset().mockResolvedValue(undefined);
  runnerMocks.applyContainerConfig.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  for (const child of runnerMocks.spawned) child.emit('close', 0);
  fs.rmSync(runnerMocks.testRoot, { recursive: true, force: true });
});

describe('container execution isolation', () => {
  it('uses disjoint writable mount sources for distinct agent groups', async () => {
    const alpha = agentGroup('agent-alpha', 'alpha');
    const beta = agentGroup('agent-beta', 'beta');
    runnerMocks.groups.set(alpha.id, alpha);
    runnerMocks.groups.set(beta.id, beta);

    await Promise.all([
      wakeContainer(session('session-alpha', alpha.id)),
      wakeContainer(session('session-beta', beta.id)),
    ]);

    const mountSets = runnerMocks.spawn.mock.calls.map((call) => writableMounts(call[1] as string[]));
    const alphaSessionDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', alpha.id, 'session-alpha');
    const betaSessionDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', beta.id, 'session-beta');
    const mountsBySessionDir = new Map(mountSets.map((mounts) => [mounts.get('/workspace'), mounts]));
    const alphaMounts = mountsBySessionDir.get(alphaSessionDir);
    const betaMounts = mountsBySessionDir.get(betaSessionDir);

    expect(alphaMounts).toBeDefined();
    expect(betaMounts).toBeDefined();
    expect(alphaMounts).toMatchObject(
      new Map([
        ['/workspace', alphaSessionDir],
        ['/workspace/agent', path.join(runnerMocks.testRoot, 'groups', alpha.folder)],
        ['/home/node/.claude', path.join(runnerMocks.testRoot, 'data', 'v2-sessions', alpha.id, '.claude-shared')],
      ]),
    );
    expect(betaMounts).toMatchObject(
      new Map([
        ['/workspace', betaSessionDir],
        ['/workspace/agent', path.join(runnerMocks.testRoot, 'groups', beta.folder)],
        ['/home/node/.claude', path.join(runnerMocks.testRoot, 'data', 'v2-sessions', beta.id, '.claude-shared')],
      ]),
    );

    const isolatedContainerPaths = ['/workspace', '/workspace/agent', '/home/node/.claude'];
    for (const containerPath of isolatedContainerPaths) {
      expect(alphaMounts?.get(containerPath)).not.toBe(betaMounts?.get(containerPath));
    }
  });

  it('keys active and in-flight executions by session id', async () => {
    const group = agentGroup('agent-shared', 'shared');
    runnerMocks.groups.set(group.id, group);
    const firstSession = session('session-one', group.id);
    const secondSession = session('session-two', group.id);

    const firstWake = wakeContainer(firstSession);
    const duplicateWake = wakeContainer({ ...firstSession });
    const secondWake = wakeContainer(secondSession);

    expect(duplicateWake).toBe(firstWake);
    expect(secondWake).not.toBe(firstWake);
    await Promise.all([firstWake, duplicateWake, secondWake]);
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(2);
    expect(getActiveContainerCount()).toBe(2);
    expect(isContainerRunning(firstSession.id)).toBe(true);
    expect(isContainerRunning(secondSession.id)).toBe(true);

    await wakeContainer({ ...firstSession });
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it('keeps Mattermost credentials host-side during container launch', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = 'container-exclusion-fixture-credential';
    process.env.MATTERMOST_BOT_TOKEN = credential;

    try {
      const group = agentGroup('agent-credential-boundary', 'credential-boundary');
      runnerMocks.groups.set(group.id, group);

      await wakeContainer(session('session-credential-boundary', group.id));

      const args = runnerMocks.spawn.mock.calls[0][1] as string[];
      const renderedArgs = args.join('\0');
      const environmentEntries = args.flatMap((arg, index) => (arg === '-e' ? [args[index + 1]] : []));
      const mountSpecs = args.flatMap((arg, index) => (arg === '-v' || arg === '--mount-ro' ? [args[index + 1]] : []));

      expect(renderedArgs).not.toContain(credential);
      expect(
        environmentEntries.some(
          (entry) => entry === 'MATTERMOST_BOT_TOKEN' || entry.startsWith('MATTERMOST_BOT_TOKEN='),
        ),
      ).toBe(false);

      const hostEnvFile = path.join(process.cwd(), '.env');
      for (const spec of mountSpecs) {
        const source = spec.slice(0, spec.lastIndexOf(':'));
        expect(pathContains(source, hostEnvFile)).toBe(false);
      }
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });
});
