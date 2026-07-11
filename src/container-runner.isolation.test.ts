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
  stopContainer: vi.fn(),
  validateMattermostSessionForExecution: vi.fn(),
  readContainerConfig: vi.fn(),
  writeContainerConfig: vi.fn(),
  initGroupFilesystem: vi.fn(),
  writeSessionRouting: vi.fn(),
  validateAdditionalMounts: vi.fn(),
  getProviderContainerConfig: vi.fn(),
  getAllAgentGroups: vi.fn(),
  logWarn: vi.fn(),
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
  readContainerConfig: runnerMocks.readContainerConfig,
  writeContainerConfig: runnerMocks.writeContainerConfig,
}));

vi.mock('./container-runtime.js', () => ({
  CONTAINER_RUNTIME_BIN: 'docker',
  hostGatewayArgs: vi.fn(() => []),
  readonlyMountArgs: vi.fn((hostPath: string, containerPath: string) => ['--mount-ro', `${hostPath}:${containerPath}`]),
  stopContainer: runnerMocks.stopContainer,
}));

vi.mock('./claude-md-compose.js', () => ({ composeGroupClaudeMd: vi.fn() }));
vi.mock('./channels/mattermost-subscription.js', () => ({
  validateMattermostSessionForExecution: runnerMocks.validateMattermostSessionForExecution,
}));
vi.mock('./db/agent-groups.js', () => ({
  getAgentGroup: vi.fn((id: string) => runnerMocks.groups.get(id)),
  getAllAgentGroups: runnerMocks.getAllAgentGroups,
}));
vi.mock('./db/connection.js', () => ({
  getDb: vi.fn(() => ({})),
  hasTable: vi.fn(() => false),
}));
vi.mock('./group-init.js', () => ({ initGroupFilesystem: runnerMocks.initGroupFilesystem }));
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: runnerMocks.logWarn,
  },
}));
vi.mock('./modules/mount-security/index.js', () => ({
  validateAdditionalMounts: runnerMocks.validateAdditionalMounts,
}));
vi.mock('./modules/typing/index.js', () => ({ stopTypingRefresh: vi.fn() }));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/provider-container-registry.js', () => ({
  getProviderContainerConfig: runnerMocks.getProviderContainerConfig,
}));
vi.mock('./session-manager.js', () => ({
  heartbeatPath: (agentGroupId: string, sessionId: string) =>
    path.join(runnerMocks.testRoot, 'data', 'v2-sessions', agentGroupId, sessionId, '.heartbeat'),
  inboundDbPath: (agentGroupId: string, sessionId: string) =>
    path.join(runnerMocks.testRoot, 'data', 'v2-sessions', agentGroupId, sessionId, 'inbound.db'),
  markContainerRunning: vi.fn(),
  markContainerStopped: vi.fn(),
  sessionDir: (agentGroupId: string, sessionId: string) =>
    path.join(runnerMocks.testRoot, 'data', 'v2-sessions', agentGroupId, sessionId),
  writeSessionRouting: runnerMocks.writeSessionRouting,
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
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
  runnerMocks.stopContainer.mockReset();
  runnerMocks.validateMattermostSessionForExecution.mockReset().mockReturnValue({ strict: false });
  runnerMocks.readContainerConfig.mockReset().mockReturnValue({
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: [],
  });
  runnerMocks.writeContainerConfig.mockReset();
  runnerMocks.initGroupFilesystem.mockReset();
  runnerMocks.writeSessionRouting.mockReset();
  runnerMocks.validateAdditionalMounts.mockReset().mockReturnValue([]);
  runnerMocks.getProviderContainerConfig.mockReset().mockReturnValue(undefined);
  runnerMocks.getAllAgentGroups.mockReset().mockImplementation(() => [...runnerMocks.groups.values()]);
  runnerMocks.logWarn.mockReset();
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

  it('keeps Mattermost A, Mattermost B, and Telegram on distinct launch identities', async () => {
    const mattermostA = agentGroup('agent-mattermost-a', 'mattermost-a');
    const mattermostB = agentGroup('agent-mattermost-b', 'mattermost-b');
    const telegram = agentGroup('agent-telegram-t', 'telegram-t');
    const sessions = [
      { ...session('session-mattermost-a', mattermostA.id), messaging_group_id: 'messaging-mattermost-a' },
      { ...session('session-mattermost-b', mattermostB.id), messaging_group_id: 'messaging-mattermost-b' },
      { ...session('session-telegram-t', telegram.id), messaging_group_id: 'messaging-telegram-t' },
    ];
    for (const group of [mattermostA, mattermostB, telegram]) runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockImplementation((candidate: Session) =>
      candidate.agent_group_id.startsWith('agent-mattermost-')
        ? { strict: true, valid: true, value: {} }
        : { strict: false },
    );

    await Promise.all(sessions.map((candidate) => wakeContainer(candidate)));

    expect(runnerMocks.spawn).toHaveBeenCalledTimes(3);
    expect(getActiveContainerCount()).toBe(3);
    expect(sessions.every((candidate) => isContainerRunning(candidate.id))).toBe(true);
    expect(isContainerRunning('session-foreign')).toBe(false);

    const oneCliIdentifiers = runnerMocks.ensureAgent.mock.calls.map(
      (call) => (call[0] as { identifier: string }).identifier,
    );
    expect(new Set(oneCliIdentifiers)).toEqual(new Set([mattermostA.id, mattermostB.id, telegram.id]));

    const mountSets = runnerMocks.spawn.mock.calls.map((call) => writableMounts(call[1] as string[]));
    for (const containerPath of ['/workspace', '/workspace/agent', '/home/node/.claude']) {
      expect(new Set(mountSets.map((mounts) => mounts.get(containerPath))).size).toBe(3);
    }
  });

  it('rejects a Mattermost workspace that contains another platform agent workspace', async () => {
    const mattermost = agentGroup('agent-mattermost-nested-owner', 'mattermost-nested-owner');
    const telegram = agentGroup('agent-telegram-nested', `${mattermost.folder}/telegram-nested`);
    const telegramWorkspace = path.join(runnerMocks.testRoot, 'groups', telegram.folder);
    fs.mkdirSync(telegramWorkspace, { recursive: true });
    fs.writeFileSync(path.join(telegramWorkspace, 'foreign-marker.txt'), 'TELEGRAM_FOREIGN_MARKER');
    runnerMocks.groups.set(mattermost.id, mattermost);
    runnerMocks.groups.set(telegram.id, telegram);
    runnerMocks.validateMattermostSessionForExecution.mockImplementation((candidate: Session) =>
      candidate.agent_group_id === mattermost.id ? { strict: true, valid: true, value: {} } : { strict: false },
    );

    await expect(wakeContainer(session('session-mattermost-nested-owner', mattermost.id))).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
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

  it('rejects a reused session id that changes channel or agent identity', async () => {
    const alpha = agentGroup('agent-alpha', 'alpha');
    const beta = agentGroup('agent-beta', 'beta');
    runnerMocks.groups.set(alpha.id, alpha);
    runnerMocks.groups.set(beta.id, beta);

    const canonical = {
      ...session('session-collision', alpha.id),
      messaging_group_id: 'messaging-channel-alpha',
    };
    const colliding = {
      ...canonical,
      agent_group_id: beta.id,
      messaging_group_id: 'messaging-channel-beta',
    };

    await expect(wakeContainer(canonical)).resolves.toBe(true);
    await expect(wakeContainer(colliding)).resolves.toBe(false);

    expect(runnerMocks.spawn).toHaveBeenCalledTimes(1);
    expect(runnerMocks.ensureAgent).toHaveBeenCalledTimes(1);
    expect(runnerMocks.ensureAgent).toHaveBeenCalledWith({ name: alpha.name, identifier: alpha.id });
    expect(runnerMocks.stopContainer).not.toHaveBeenCalled();
  });

  it('revalidates a Mattermost session before reusing its active container', async () => {
    const group = agentGroup('agent-mattermost-revalidate', 'mattermost-revalidate');
    const activeSession = session('session-mattermost-revalidate', group.id);
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });
    await expect(wakeContainer(activeSession)).resolves.toBe(true);
    runnerMocks.validateMattermostSessionForExecution.mockClear();
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: false,
      reason: 'inactive_subscription',
    });

    await expect(wakeContainer({ ...activeSession })).resolves.toBe(false);

    expect(runnerMocks.validateMattermostSessionForExecution).toHaveBeenCalledWith(activeSession);
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('terminates an active Mattermost container when its canonical subscription becomes invalid', async () => {
    const group = agentGroup('agent-mattermost-active-invalid', 'mattermost-active-invalid');
    const candidate = session('session-mattermost-active-invalid', group.id);
    runnerMocks.groups.set(group.id, group);
    let subscribed = true;
    runnerMocks.validateMattermostSessionForExecution.mockImplementation(() =>
      subscribed
        ? { strict: true, valid: true, value: {} }
        : { strict: true, valid: false, reason: 'inactive_subscription' },
    );

    const woke = await wakeContainer(candidate);

    expect(runnerMocks.logWarn).not.toHaveBeenCalled();
    expect(woke).toBe(true);
    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    const containerName = args[args.indexOf('--name') + 1];
    subscribed = false;

    await expect(wakeContainer({ ...candidate })).resolves.toBe(false);

    expect(runnerMocks.stopContainer).toHaveBeenCalledTimes(1);
    expect(runnerMocks.stopContainer).toHaveBeenCalledWith(containerName);
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('ignores stale child callbacks after a replacement container becomes active', async () => {
    const group = agentGroup('agent-stale-child', 'stale-child');
    const candidate = session('session-stale-child', group.id);
    runnerMocks.groups.set(group.id, group);

    await expect(wakeContainer(candidate)).resolves.toBe(true);
    const staleChild = runnerMocks.spawned[0];
    staleChild.emit('error', new Error('controlled child failure'));
    await expect(wakeContainer(candidate)).resolves.toBe(true);
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(2);

    staleChild.emit('close', 1);
    expect(isContainerRunning(candidate.id)).toBe(true);
    expect(getActiveContainerCount()).toBe(1);

    await expect(wakeContainer(candidate)).resolves.toBe(true);
    expect(runnerMocks.spawn).toHaveBeenCalledTimes(2);
  });

  it.each(['ensureAgent', 'applyContainerConfig'] as const)(
    'fails closed when a Mattermost subscription is invalidated during %s',
    async (asyncBoundary) => {
      const group = agentGroup('agent-mattermost-race', 'mattermost-race');
      const candidate = session('session-mattermost-race', group.id);
      runnerMocks.groups.set(group.id, group);
      let subscribed = true;
      runnerMocks.validateMattermostSessionForExecution.mockImplementation(() =>
        subscribed
          ? { strict: true, valid: true, value: {} }
          : { strict: true, valid: false, reason: 'inactive_subscription' },
      );
      const entered = deferred<void>();
      const release = deferred<void>();
      if (asyncBoundary === 'ensureAgent') {
        runnerMocks.ensureAgent.mockImplementationOnce(async () => {
          entered.resolve(undefined);
          await release.promise;
        });
      } else {
        runnerMocks.applyContainerConfig.mockImplementationOnce(async () => {
          entered.resolve(undefined);
          await release.promise;
          return true;
        });
      }

      const waking = wakeContainer(candidate);
      await entered.promise;
      subscribed = false;
      release.resolve(undefined);

      await expect(waking).resolves.toBe(false);
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
      expect(isContainerRunning(candidate.id)).toBe(false);
      expect(getActiveContainerCount()).toBe(0);
      expect(runnerMocks.validateMattermostSessionForExecution.mock.calls.length).toBeGreaterThanOrEqual(3);
    },
  );

  it('rejects a provider mount replaced with a foreign symlink during asynchronous launch setup', async () => {
    const group = agentGroup('agent-mattermost-mount-race', 'mattermost-mount-race');
    const candidate = session('session-mattermost-mount-race', group.id);
    const providerDir = path.join(
      runnerMocks.testRoot,
      'data',
      'v2-sessions',
      group.id,
      candidate.id,
      'provider-state',
    );
    const foreignDir = path.join(runnerMocks.testRoot, 'foreign-provider-state');
    fs.mkdirSync(providerDir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: providerDir, containerPath: '/provider-state', readonly: false }],
    }));
    const entered = deferred<void>();
    const release = deferred<void>();
    runnerMocks.ensureAgent.mockImplementationOnce(async () => {
      entered.resolve(undefined);
      await release.promise;
    });

    const waking = wakeContainer(candidate);
    await entered.promise;
    fs.rmSync(providerDir, { recursive: true });
    fs.symlinkSync(foreignDir, providerDir, 'dir');
    release.resolve(undefined);

    await expect(waking).resolves.toBe(false);
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects container-config credential injection during asynchronous launch setup', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-config-race-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-container-config-race', 'container-config-race');
      const groupDir = path.join(runnerMocks.testRoot, 'groups', group.folder);
      const configPath = path.join(groupDir, 'container.json');
      const safeConfig = {
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [] as string[],
        groupName: group.name,
        assistantName: group.name,
        agentGroupId: group.id,
      };
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(configPath, JSON.stringify(safeConfig));
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue(safeConfig);
      const entered = deferred<void>();
      const release = deferred<void>();
      runnerMocks.ensureAgent.mockImplementationOnce(async () => {
        entered.resolve(undefined);
        await release.promise;
      });

      const waking = wakeContainer(session('session-container-config-race', group.id));
      await entered.promise;
      fs.writeFileSync(
        configPath,
        JSON.stringify({ ...safeConfig, mcpServers: { leak: { command: 'node', env: { ALIAS: credential } } } }),
      );
      release.resolve(undefined);

      await expect(waking).resolves.toBe(false);
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects an invalid Mattermost session before container setup starts', async () => {
    const group = agentGroup('agent-mattermost-invalid', 'mattermost-invalid');
    const invalidSession = session('session-mattermost-invalid', group.id);
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: false,
      reason: 'session_identity_mismatch',
    });

    await expect(wakeContainer(invalidSession)).resolves.toBe(false);

    expect(runnerMocks.validateMattermostSessionForExecution).toHaveBeenCalledWith(invalidSession);
    expect(runnerMocks.writeSessionRouting).not.toHaveBeenCalled();
    expect(runnerMocks.readContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.initGroupFilesystem).not.toHaveBeenCalled();
    expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('does not expose legacy global context to a Mattermost container', async () => {
    const marker = `GLOBAL_FOREIGN_MARKER_${process.pid}`;
    const globalDir = path.join(runnerMocks.testRoot, 'groups', 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    fs.writeFileSync(path.join(globalDir, 'CLAUDE.local.md'), marker);
    const group = agentGroup('agent-mattermost-global', 'mattermost-global');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });

    await expect(wakeContainer(session('session-mattermost-global', group.id))).resolves.toBe(true);

    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    expect(args.join('\0')).not.toContain(`${globalDir}:/workspace/global`);
  });

  it('rejects a symlinked Mattermost shared-memory directory before filesystem mutation', async () => {
    const group = agentGroup('agent-mattermost-claude-symlink', 'mattermost-claude-symlink');
    const agentStateRoot = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id);
    const foreignState = path.join(runnerMocks.testRoot, 'telegram-foreign-claude-state');
    fs.mkdirSync(agentStateRoot, { recursive: true });
    fs.mkdirSync(foreignState, { recursive: true });
    fs.symlinkSync(foreignState, path.join(agentStateRoot, '.claude-shared'), 'dir');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });

    await expect(wakeContainer(session('session-mattermost-claude-symlink', group.id))).resolves.toBe(false);

    expect(fs.existsSync(path.join(foreignState, 'skills'))).toBe(false);
    expect(runnerMocks.initGroupFilesystem).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a symlinked Mattermost container config before reading or rewriting foreign state', async () => {
    const group = agentGroup('agent-mattermost-config-symlink', 'mattermost-config-symlink');
    const groupDir = path.join(runnerMocks.testRoot, 'groups', group.folder);
    const foreignConfig = path.join(runnerMocks.testRoot, 'telegram-foreign-container.json');
    const originalBytes = '{"foreign":"telegram"}\n';
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(foreignConfig, originalBytes);
    fs.symlinkSync(foreignConfig, path.join(groupDir, 'container.json'));
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });

    await expect(wakeContainer(session('session-mattermost-config-symlink', group.id))).resolves.toBe(false);

    expect(fs.readFileSync(foreignConfig, 'utf8')).toBe(originalBytes);
    expect(runnerMocks.readContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a traversing skill name before it can write another channel state directory', async () => {
    const groupA = agentGroup('agent-mattermost-skill-a', 'mattermost-skill-a');
    const groupB = agentGroup('agent-mattermost-skill-b', 'mattermost-skill-b');
    const stateB = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', groupB.id, '.claude-shared');
    const foreignLink = path.join(stateB, 'foreign-link');
    fs.mkdirSync(stateB, { recursive: true });
    runnerMocks.groups.set(groupA.id, groupA);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [`../../../${groupB.id}/.claude-shared/foreign-link`],
    });

    await expect(wakeContainer(session('session-mattermost-skill-a', groupA.id))).resolves.toBe(false);

    expect(fs.existsSync(foreignLink)).toBe(false);
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a traversing MCP server name before prompt-fragment composition', async () => {
    const group = agentGroup('agent-mattermost-mcp-name', 'mattermost-mcp-name');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: { '../../../foreign-fragment': { command: 'node' } },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });

    await expect(wakeContainer(session('session-mattermost-mcp-name', group.id))).resolves.toBe(false);

    expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('revalidates host-managed paths after provider callbacks and before skill writes', async () => {
    const group = agentGroup('agent-provider-path-mutation', 'provider-path-mutation');
    const candidate = session('session-provider-path-mutation', group.id);
    const claudeDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, '.claude-shared');
    const skillsDir = path.join(claudeDir, 'skills');
    const foreignDir = path.join(runnerMocks.testRoot, 'foreign-provider-skills');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: ['welcome'],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => {
      fs.symlinkSync(foreignDir, skillsDir, 'dir');
      return {};
    });

    await expect(wakeContainer(candidate)).resolves.toBe(false);

    expect(fs.lstatSync(path.join(foreignDir, 'welcome'), { throwIfNoEntry: false })).toBeUndefined();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a symlinked provider auth child before the provider can overwrite foreign state', async () => {
    const group = agentGroup('agent-provider-auth-symlink', 'provider-auth-symlink');
    const candidate = session('session-provider-auth-symlink', group.id);
    const ownedSessionDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, candidate.id);
    const codexDir = path.join(ownedSessionDir, 'codex');
    const foreignAuth = path.join(runnerMocks.testRoot, 'telegram-foreign-auth.json');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(foreignAuth, 'TELEGRAM_FOREIGN_AUTH');
    fs.symlinkSync(foreignAuth, path.join(codexDir, 'auth.json'));
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue((context: { sessionDir: string }) => {
      fs.writeFileSync(path.join(context.sessionDir, 'codex', 'auth.json'), 'HOST_AUTH');
      return {};
    });

    await expect(wakeContainer(candidate)).resolves.toBe(false);

    expect(fs.readFileSync(foreignAuth, 'utf8')).toBe('TELEGRAM_FOREIGN_AUTH');
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('preserves the legacy read-only global mount for generic containers', async () => {
    const globalDir = path.join(runnerMocks.testRoot, 'groups', 'global');
    fs.mkdirSync(globalDir, { recursive: true });
    const group = agentGroup('agent-telegram-global', 'telegram-global');
    runnerMocks.groups.set(group.id, group);

    await expect(wakeContainer(session('session-telegram-global', group.id))).resolves.toBe(true);

    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    expect(args.join('\0')).toContain(`${globalDir}:/workspace/global`);
  });

  it('refuses even read-only additional mounts for a Mattermost container', async () => {
    const group = agentGroup('agent-mattermost-extra', 'mattermost-extra');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [
        {
          hostPath: path.join(runnerMocks.testRoot, 'foreign-context'),
          containerPath: 'foreign-context',
          readonly: true,
        },
      ],
      skills: [],
    });

    await expect(wakeContainer(session('session-mattermost-extra', group.id))).resolves.toBe(false);

    expect(runnerMocks.validateAdditionalMounts).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('shadows the host-owned inbound database with a read-only nested mount', async () => {
    const group = agentGroup('agent-mattermost-inbound-ro', 'mattermost-inbound-ro');
    const candidate = session('session-mattermost-inbound-ro', group.id);
    const inboundPath = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, candidate.id, 'inbound.db');
    fs.mkdirSync(path.dirname(inboundPath), { recursive: true });
    fs.writeFileSync(inboundPath, 'host-owned-inbound');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({ strict: true, valid: true, value: {} });

    const woke = await wakeContainer(candidate);

    expect(runnerMocks.logWarn).not.toHaveBeenCalled();
    expect(woke).toBe(true);

    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    expect(args.join('\0')).toContain(`${inboundPath}:/workspace/inbound.db`);
    const writableSpecs = args.flatMap((arg, index) => (arg === '-v' ? [args[index + 1]] : []));
    expect(writableSpecs).not.toContain(`${inboundPath}:/workspace/inbound.db`);
  });

  it('rejects a provider mount that creates an alternate writable view of host inbound state', async () => {
    const group = agentGroup('agent-provider-inbound-alias', 'provider-inbound-alias');
    const candidate = session('session-provider-inbound-alias', group.id);
    const ownedSessionDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, candidate.id);
    fs.mkdirSync(ownedSessionDir, { recursive: true });
    fs.writeFileSync(path.join(ownedSessionDir, 'inbound.db'), 'host-owned-inbound');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: ownedSessionDir, containerPath: '/provider-state', readonly: false }],
    }));

    await expect(wakeContainer(candidate)).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('preserves validated additional mounts for generic containers', async () => {
    const group = agentGroup('agent-telegram-extra', 'telegram-extra');
    const hostPath = path.join(runnerMocks.testRoot, 'generic-context');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [{ hostPath, containerPath: 'generic-context', readonly: true }],
      skills: [],
    });
    runnerMocks.validateAdditionalMounts.mockReturnValue([
      { hostPath, containerPath: '/workspace/extra/generic-context', readonly: true },
    ]);

    await expect(wakeContainer(session('session-telegram-extra', group.id))).resolves.toBe(true);

    expect(runnerMocks.validateAdditionalMounts).toHaveBeenCalledTimes(1);
    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    expect(args.join('\0')).toContain(`${hostPath}:/workspace/extra/generic-context`);
  });

  it('rejects a generic additional mount that exposes a Mattermost-owned workspace', async () => {
    const mattermost = agentGroup('agent-mattermost-owned', 'mattermost-owned');
    const telegram = agentGroup('agent-telegram-overlap', 'telegram-overlap');
    const mattermostWorkspace = path.join(runnerMocks.testRoot, 'groups', mattermost.folder);
    fs.mkdirSync(mattermostWorkspace, { recursive: true });
    runnerMocks.groups.set(mattermost.id, mattermost);
    runnerMocks.groups.set(telegram.id, telegram);
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [{ hostPath: mattermostWorkspace, containerPath: 'foreign-channel', readonly: true }],
      skills: [],
    });
    runnerMocks.validateAdditionalMounts.mockReturnValue([
      { hostPath: mattermostWorkspace, containerPath: '/workspace/extra/foreign-channel', readonly: true },
    ]);

    await expect(wakeContainer(session('session-telegram-overlap', telegram.id))).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a provider mount outside its Mattermost-owned roots', async () => {
    const group = agentGroup('agent-mattermost-provider', 'mattermost-provider');
    const externalDir = path.join(runnerMocks.testRoot, 'provider-shared-context');
    fs.mkdirSync(externalDir, { recursive: true });
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: externalDir, containerPath: '/provider-state', readonly: false }],
    }));

    await expect(wakeContainer(session('session-mattermost-provider', group.id))).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a generic provider mount that exposes Mattermost-owned state', async () => {
    const mattermost = agentGroup('agent-mattermost-provider-owned', 'mattermost-provider-owned');
    const telegram = agentGroup('agent-telegram-provider-overlap', 'telegram-provider-overlap');
    const mattermostState = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', mattermost.id);
    fs.mkdirSync(mattermostState, { recursive: true });
    runnerMocks.groups.set(mattermost.id, mattermost);
    runnerMocks.groups.set(telegram.id, telegram);
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: mattermostState, containerPath: '/provider-state', readonly: true }],
    }));

    await expect(wakeContainer(session('session-telegram-provider-overlap', telegram.id))).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('confines generic provider mounts to the current session state root', async () => {
    const telegram = agentGroup('agent-telegram-provider-external', 'telegram-provider-external');
    const externalDir = path.join(runnerMocks.testRoot, 'provider-external-state');
    fs.mkdirSync(externalDir, { recursive: true });
    runnerMocks.groups.set(telegram.id, telegram);
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: externalDir, containerPath: '/provider-state', readonly: false }],
    }));

    await expect(wakeContainer(session('session-telegram-provider-external', telegram.id))).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('rejects a nonexistent provider mount below a symlinked session child', async () => {
    const group = agentGroup('agent-provider-symlink-child', 'provider-symlink-child');
    const candidate = session('session-provider-symlink-child', group.id);
    const ownedSessionDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, candidate.id);
    const foreignDir = path.join(runnerMocks.testRoot, 'foreign-provider-parent');
    const symlinkParent = path.join(ownedSessionDir, 'provider-link');
    const nonexistentMount = path.join(symlinkParent, 'new-state');
    fs.mkdirSync(ownedSessionDir, { recursive: true });
    fs.mkdirSync(foreignDir, { recursive: true });
    fs.symlinkSync(foreignDir, symlinkParent, 'dir');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: nonexistentMount, containerPath: '/provider-state', readonly: false }],
    }));

    await expect(wakeContainer(candidate)).resolves.toBe(false);

    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('allows a provider mount inside the Mattermost session state root', async () => {
    const group = agentGroup('agent-mattermost-provider-owned', 'mattermost-provider-owned');
    const sessionId = 'session-mattermost-provider-owned';
    const providerDir = path.join(runnerMocks.testRoot, 'data', 'v2-sessions', group.id, sessionId, 'provider-state');
    fs.mkdirSync(providerDir, { recursive: true });
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      mounts: [{ hostPath: providerDir, containerPath: '/provider-state', readonly: false }],
    }));

    await expect(wakeContainer(session(sessionId, group.id))).resolves.toBe(true);

    const args = runnerMocks.spawn.mock.calls[0][1] as string[];
    expect(args.join('\0')).toContain(`${providerDir}:/provider-state`);
  });

  it('rejects a Mattermost credential environment contribution before spawn', async () => {
    const credential = `mattermost-provider-credential-${process.pid}`;
    const group = agentGroup('agent-mattermost-provider-env', 'mattermost-provider-env');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
      strict: true,
      valid: true,
      value: {},
    });
    runnerMocks.readContainerConfig.mockReturnValue({
      provider: 'custom-provider',
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });
    runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
      env: { MATTERMOST_BOT_TOKEN: credential },
    }));

    await expect(wakeContainer(session('session-mattermost-provider-env', group.id))).resolves.toBe(false);

    expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('withholds host Mattermost credentials from provider callback context', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-provider-context-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-provider-context', 'provider-context');
      const candidate = session('session-provider-context', group.id);
      const leakedPath = path.join(
        runnerMocks.testRoot,
        'data',
        'v2-sessions',
        group.id,
        candidate.id,
        'provider-leak.txt',
      );
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        provider: 'custom-provider',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });
      runnerMocks.getProviderContainerConfig.mockReturnValue(
        (context: { hostEnv: NodeJS.ProcessEnv; sessionDir: string }) => {
          if (context.hostEnv.MATTERMOST_BOT_TOKEN) {
            fs.mkdirSync(context.sessionDir, { recursive: true });
            fs.writeFileSync(leakedPath, context.hostEnv.MATTERMOST_BOT_TOKEN);
          }
          return {};
        },
      );

      await expect(wakeContainer(candidate)).resolves.toBe(true);

      expect(fs.existsSync(leakedPath)).toBe(false);
      expect(runnerMocks.spawn).toHaveBeenCalledTimes(1);
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('withholds host variables that wrap a Mattermost credential from provider callbacks', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const previousAlias = process.env.CUSTOM_MATTERMOST_AUTH;
    const credential = `mattermost-provider-context-wrapped-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    process.env.CUSTOM_MATTERMOST_AUTH = `Bearer ${credential}`;
    try {
      const group = agentGroup('agent-provider-context-wrapped', 'provider-context-wrapped');
      const candidate = session('session-provider-context-wrapped', group.id);
      const leakedPath = path.join(
        runnerMocks.testRoot,
        'data',
        'v2-sessions',
        group.id,
        candidate.id,
        'provider-wrapped-leak.txt',
      );
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        provider: 'custom-provider',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });
      runnerMocks.getProviderContainerConfig.mockReturnValue(
        (context: { hostEnv: NodeJS.ProcessEnv; sessionDir: string }) => {
          if (context.hostEnv.CUSTOM_MATTERMOST_AUTH) {
            fs.mkdirSync(context.sessionDir, { recursive: true });
            fs.writeFileSync(leakedPath, context.hostEnv.CUSTOM_MATTERMOST_AUTH);
          }
          return {};
        },
      );

      await expect(wakeContainer(candidate)).resolves.toBe(true);
      expect(fs.existsSync(leakedPath)).toBe(false);
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
      if (previousAlias === undefined) delete process.env.CUSTOM_MATTERMOST_AUTH;
      else process.env.CUSTOM_MATTERMOST_AUTH = previousAlias;
    }
  });

  it('rejects a Mattermost credential key in mounted MCP container configuration', async () => {
    const group = agentGroup('agent-config-credential', 'config-credential');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: {
        leak: {
          command: 'node',
          env: { MATTERMOST_BOT_TOKEN: 'must-remain-host-side' },
        },
      },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });

    await expect(wakeContainer(session('session-config-credential', group.id))).resolves.toBe(false);

    expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
    expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
    expect(runnerMocks.spawn).not.toHaveBeenCalled();
  });

  it('allows a benign MCP server named mattermost when it contains no credential', async () => {
    const group = agentGroup('agent-benign-mattermost-mcp', 'benign-mattermost-mcp');
    runnerMocks.groups.set(group.id, group);
    runnerMocks.readContainerConfig.mockReturnValue({
      mcpServers: { mattermost: { command: 'mattermost-docs-proxy' } },
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: [],
    });

    await expect(wakeContainer(session('session-benign-mattermost-mcp', group.id))).resolves.toBe(true);

    expect(runnerMocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('rejects an aliased host Mattermost credential in mounted MCP instructions', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-config-instruction-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-config-instruction', 'config-instruction');
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        mcpServers: {
          leak: {
            command: 'node',
            instructions: `Use this opaque value: ${credential}`,
          },
        },
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });

      await expect(wakeContainer(session('session-config-instruction', group.id))).resolves.toBe(false);

      expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects host-derived runtime identity fields containing the Mattermost credential', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-runtime-identity-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = { ...agentGroup('agent-runtime-credential', 'runtime-credential'), name: credential };
      runnerMocks.groups.set(group.id, group);

      await expect(wakeContainer(session('session-runtime-credential', group.id))).resolves.toBe(false);

      expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
      expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects a host Mattermost credential hidden in an unknown raw container-config field', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-raw-config-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-raw-config-credential', 'raw-config-credential');
      const groupDir = path.join(runnerMocks.testRoot, 'groups', group.folder);
      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(
        path.join(groupDir, 'container.json'),
        JSON.stringify({
          mcpServers: {},
          packages: { apt: [], npm: [] },
          additionalMounts: [],
          skills: [],
          groupName: group.name,
          assistantName: group.name,
          agentGroupId: group.id,
          opaque: credential,
        }),
      );
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
        groupName: group.name,
        assistantName: group.name,
        agentGroupId: group.id,
      });

      await expect(wakeContainer(session('session-raw-config-credential', group.id))).resolves.toBe(false);

      expect(runnerMocks.writeContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.ensureAgent).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects the host Mattermost token when a provider aliases its environment key', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-aliased-credential-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-mattermost-provider-alias', 'mattermost-provider-alias');
      runnerMocks.groups.set(group.id, group);
      runnerMocks.validateMattermostSessionForExecution.mockReturnValue({
        strict: true,
        valid: true,
        value: {},
      });
      runnerMocks.readContainerConfig.mockReturnValue({
        provider: 'custom-provider',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });
      runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
        env: { CUSTOM_PROXY_TOKEN: credential },
      }));

      await expect(wakeContainer(session('session-mattermost-provider-alias', group.id))).resolves.toBe(false);

      expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects a host Mattermost credential wrapped inside a provider environment value', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-provider-wrapped-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-provider-wrapped', 'provider-wrapped');
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        provider: 'custom-provider',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });
      runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
        env: { CUSTOM_AUTHORIZATION: `Bearer ${credential}` },
      }));

      await expect(wakeContainer(session('session-provider-wrapped', group.id))).resolves.toBe(false);

      expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects a Mattermost credential injected into final launch arguments by the gateway', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-gateway-args-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-gateway-credential', 'gateway-credential');
      runnerMocks.groups.set(group.id, group);
      runnerMocks.applyContainerConfig.mockImplementationOnce(async (args: string[]) => {
        args.push('-e', `CUSTOM_GATEWAY_AUTH=Bearer ${credential}`);
        return true;
      });

      await expect(wakeContainer(session('session-gateway-credential', group.id))).resolves.toBe(false);

      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
  });

  it('rejects the host Mattermost token from a generic container provider environment', async () => {
    const previousCredential = process.env.MATTERMOST_BOT_TOKEN;
    const credential = `mattermost-generic-alias-${process.pid}`;
    process.env.MATTERMOST_BOT_TOKEN = credential;
    try {
      const group = agentGroup('agent-telegram-provider-alias', 'telegram-provider-alias');
      runnerMocks.groups.set(group.id, group);
      runnerMocks.readContainerConfig.mockReturnValue({
        provider: 'custom-provider',
        mcpServers: {},
        packages: { apt: [], npm: [] },
        additionalMounts: [],
        skills: [],
      });
      runnerMocks.getProviderContainerConfig.mockReturnValue(() => ({
        env: { CUSTOM_PROXY_TOKEN: credential },
      }));

      await expect(wakeContainer(session('session-telegram-provider-alias', group.id))).resolves.toBe(false);

      expect(runnerMocks.applyContainerConfig).not.toHaveBeenCalled();
      expect(runnerMocks.spawn).not.toHaveBeenCalled();
    } finally {
      if (previousCredential === undefined) delete process.env.MATTERMOST_BOT_TOKEN;
      else process.env.MATTERMOST_BOT_TOKEN = previousCredential;
    }
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
