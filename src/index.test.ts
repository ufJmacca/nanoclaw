import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentProvider } from './agent/provider-types.js';
import type { NewMessage, RegisteredGroup } from './types.js';

const {
  customProviderRegistryState,
  startClaudeProviderRemoteControl,
  deleteSession,
  ensureAgent,
  findChannel,
  formatMessagesMock,
  getAllRegisteredGroups,
  getChannelFactory,
  getMessagesSince,
  getRouterState,
  getRegisteredChannelNames,
  getSession,
  groupQueueIsIdleWaiting,
  groupQueueEnqueueMessageCheck,
  groupQueueSendMessage,
  groupQueueSetProcessMessagesFn,
  providerHookStartRemoteControl,
  providerRegistryGetProvider,
  restoreRemoteControl,
  runContainerAgent,
  setRegisteredGroup,
  setRouterState,
  setSession,
  startRemoteControl,
  stopRemoteControl,
  storeMessage,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} = vi.hoisted(() => ({
  customProviderRegistryState: {
    provider: undefined as AgentProvider | undefined,
  },
  startClaudeProviderRemoteControl: vi.fn(),
  deleteSession: vi.fn(),
  ensureAgent: vi
    .fn()
    .mockResolvedValue({ name: 'test', identifier: 'test', created: true }),
  findChannel: vi.fn(),
  formatMessagesMock: vi.fn((..._args: unknown[]) => ''),
  getAllRegisteredGroups: vi.fn(() => ({})),
  getChannelFactory: vi.fn(),
  getMessagesSince: vi.fn(() => [] as NewMessage[]),
  getRouterState: vi.fn((_key: string) => ''),
  providerHookStartRemoteControl: vi.fn(),
  providerRegistryGetProvider: vi.fn(),
  groupQueueIsIdleWaiting: vi.fn(() => false),
  groupQueueEnqueueMessageCheck: vi.fn(),
  groupQueueSendMessage: vi.fn(() => false),
  groupQueueSetProcessMessagesFn: vi.fn(),
  restoreRemoteControl: vi.fn(),
  getRegisteredChannelNames: vi.fn((): string[] => []),
  getSession: vi.fn(
    (_groupFolder: string, _providerId?: string) =>
      undefined as string | undefined,
  ),
  runContainerAgent: vi.fn(),
  setRegisteredGroup: vi.fn(),
  setRouterState: vi.fn(),
  setSession: vi.fn(),
  startRemoteControl: vi.fn(),
  stopRemoteControl: vi.fn(),
  storeMessage: vi.fn(),
  writeGroupsSnapshot: vi.fn(),
  writeTasksSnapshot: vi.fn(),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    ensureAgent = ensureAgent;
  },
}));

vi.mock('./channels/index.js', () => ({}));

vi.mock('./agent/provider-registry.js', async () => {
  const actual = await vi.importActual<
    typeof import('./agent/provider-registry.js')
  >('./agent/provider-registry.js');

  return {
    ...actual,
    createProviderRegistry: (
      ...args: Parameters<typeof actual.createProviderRegistry>
    ) => {
      if (!customProviderRegistryState.provider) {
        return actual.createProviderRegistry(...args);
      }

      providerRegistryGetProvider.mockImplementation((providerId: string) => {
        if (providerId !== customProviderRegistryState.provider?.id) {
          throw new Error(`Unexpected provider lookup: ${providerId}`);
        }

        return customProviderRegistryState.provider;
      });

      return {
        getProvider: providerRegistryGetProvider,
        listProviders: vi.fn(() => [customProviderRegistryState.provider]),
        register: vi.fn(),
      };
    },
  };
});

vi.mock('./agent/providers/claude-code/remote-control.js', () => ({
  startRemoteControl: startClaudeProviderRemoteControl,
}));

vi.mock('./channels/registry.js', () => ({
  getChannelFactory,
  getRegisteredChannelNames,
}));

vi.mock('./container-runner.js', () => ({
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
}));

vi.mock('./container-runtime.js', () => ({
  cleanupOrphans: vi.fn(),
  ensureContainerRuntimeRunning: vi.fn(),
}));

vi.mock('./db.js', () => ({
  deleteSession,
  getAllChats: vi.fn(() => []),
  getAllRegisteredGroups,
  getAllSessions: vi.fn(() => ({})),
  getAllTasks: vi.fn(() => []),
  getLastBotMessageTimestamp: vi.fn(() => ''),
  getMessagesSince,
  getNewMessages: vi.fn(() => ({ messages: [], newTimestamp: '' })),
  getRouterState,
  getSession,
  initDatabase: vi.fn(),
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata: vi.fn(),
  storeMessage,
}));

vi.mock('./group-queue.js', () => ({
  GroupQueue: class {
    closeStdin = vi.fn();
    enqueueMessageCheck = groupQueueEnqueueMessageCheck;
    isIdleWaiting = groupQueueIsIdleWaiting;
    notifyIdle = vi.fn();
    registerProcess = vi.fn();
    sendMessage = groupQueueSendMessage;
    setProcessMessagesFn = groupQueueSetProcessMessagesFn;
    shutdown = vi.fn(async () => {});
  },
}));

vi.mock('./ipc.js', () => ({
  startIpcWatcher: vi.fn(),
}));

vi.mock('./router.js', () => ({
  escapeXml: vi.fn((value: string) => value),
  findChannel,
  formatMessages: formatMessagesMock,
  formatOutbound: vi.fn((value: string) => value),
}));

vi.mock('./remote-control.js', () => ({
  restoreRemoteControl,
  startRemoteControl,
  stopRemoteControl,
}));

vi.mock('./sender-allowlist.js', () => ({
  isSenderAllowed: vi.fn(() => true),
  isTriggerAllowed: vi.fn(() => true),
  loadSenderAllowlist: vi.fn(() => ({ mode: 'allow' })),
  shouldDropMessage: vi.fn(() => false),
}));

vi.mock('./task-scheduler.js', () => ({
  startSchedulerLoop: vi.fn(),
}));

vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

const ORIGINAL_CWD = process.cwd();
const ORIGINAL_ARGV_1 = process.argv[1];
const INDEX_MODULE_PATH = fileURLToPath(new URL('./index.ts', import.meta.url));

function readBundledGlobalTemplate(): string {
  return fs.readFileSync(
    path.join(ORIGINAL_CWD, 'groups', 'global', 'AGENT.md'),
    'utf-8',
  );
}

function readBundledMainTemplate(): string {
  return fs.readFileSync(
    path.join(ORIGINAL_CWD, 'groups', 'main', 'AGENT.md'),
    'utf-8',
  );
}

function createTempRepo(): string {
  const repoDir = fs.mkdtempSync(
    path.join(os.tmpdir(), 'nanoclaw-index-test-'),
  );
  fs.mkdirSync(path.join(repoDir, 'groups', 'main'), { recursive: true });
  fs.mkdirSync(path.join(repoDir, 'groups', 'global'), { recursive: true });
  return repoDir;
}

function writeGroupFile(
  repoDir: string,
  groupFolder: string,
  fileName: string,
  content: string,
): string {
  const filePath = path.join(repoDir, 'groups', groupFolder, fileName);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function readGroupFile(
  repoDir: string,
  groupFolder: string,
  fileName: string,
): string {
  return fs.readFileSync(
    path.join(repoDir, 'groups', groupFolder, fileName),
    'utf-8',
  );
}

async function loadIndexModule(repoDir: string) {
  process.chdir(repoDir);
  vi.resetModules();
  return import('./index.js');
}

function resetIndexRuntimeMocks(): void {
  customProviderRegistryState.provider = undefined;
  findChannel.mockReset();
  formatMessagesMock.mockReset();
  formatMessagesMock.mockReturnValue('');
  getChannelFactory.mockReset();
  getMessagesSince.mockReset();
  getMessagesSince.mockReturnValue([]);
  getRouterState.mockReset();
  getRouterState.mockReturnValue('');
  getRegisteredChannelNames.mockReset();
  getRegisteredChannelNames.mockReturnValue([]);
  groupQueueEnqueueMessageCheck.mockReset();
  groupQueueIsIdleWaiting.mockReset();
  groupQueueIsIdleWaiting.mockReturnValue(false);
  groupQueueSendMessage.mockReset();
  groupQueueSendMessage.mockReturnValue(false);
  groupQueueSetProcessMessagesFn.mockReset();
  providerHookStartRemoteControl.mockReset();
  providerRegistryGetProvider.mockReset();
  startClaudeProviderRemoteControl.mockReset();
  restoreRemoteControl.mockReset();
  setRouterState.mockReset();
  startRemoteControl.mockReset();
  stopRemoteControl.mockReset();
  storeMessage.mockReset();
}

describe('startup group registration memory seeding', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
    deleteSession.mockReset();
    setRegisteredGroup.mockReset();
    ensureAgent.mockClear();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    runContainerAgent.mockReset();
    setSession.mockReset();
    writeGroupsSnapshot.mockReset();
    writeTasksSnapshot.mockReset();
    resetIndexRuntimeMocks();
  });

  it('seeds new groups from canonical global AGENT.md and renders CLAUDE.md from it', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Compatibility Global\n\nThis should never become canonical.\n',
    );
    const group: RegisteredGroup = {
      name: 'Dev Team',
      folder: 'telegram_dev_team',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('tg:-1002', group);

    // Assert
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'AGENT.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    expect(readGroupFile(repoDir, 'telegram_dev_team', 'CLAUDE.md')).toBe(
      '# Canonical Global\n\nYou are Andy, a personal assistant.\n',
    );
    expect(setRegisteredGroup).toHaveBeenCalledWith('tg:-1002', group);
    expect(ensureAgent).toHaveBeenCalled();
  });

  it('seeds AGENT.md from an existing CLAUDE.md during startup registration', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'slack_product',
      'CLAUDE.md',
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
    const group: RegisteredGroup = {
      name: 'Product',
      folder: 'slack_product',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('slack:C123', group);

    // Assert
    expect(readGroupFile(repoDir, 'slack_product', 'AGENT.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
    expect(readGroupFile(repoDir, 'slack_product', 'CLAUDE.md')).toBe(
      '# Product Memory\n\nKeep this custom workflow exactly.\n',
    );
  });

  it('does not overwrite existing AGENT.md or CLAUDE.md during startup registration', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'main',
      'AGENT.md',
      '# Main Template\n\n## Admin Context\n',
    );
    writeGroupFile(
      repoDir,
      'discord_main',
      'AGENT.md',
      '# Custom Canonical\n\nPreserve this.\n',
    );
    writeGroupFile(
      repoDir,
      'discord_main',
      'CLAUDE.md',
      '# Custom Compatibility\n\nPreserve this too.\n',
    );
    const group: RegisteredGroup = {
      name: 'Control',
      folder: 'discord_main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('dc:main', group);

    // Assert
    expect(readGroupFile(repoDir, 'discord_main', 'AGENT.md')).toBe(
      '# Custom Canonical\n\nPreserve this.\n',
    );
    expect(readGroupFile(repoDir, 'discord_main', 'CLAUDE.md')).toBe(
      '# Custom Compatibility\n\nPreserve this too.\n',
    );
  });

  it('promotes legacy main CLAUDE.md during runtime registration for groups/main', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(repoDir, 'main', 'AGENT.md', readBundledMainTemplate());
    writeGroupFile(
      repoDir,
      'main',
      'CLAUDE.md',
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
    const group: RegisteredGroup = {
      name: 'Control',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
    };

    // Act
    const { _registerGroupForTest } = await loadIndexModule(repoDir);
    _registerGroupForTest('dc:main', group);

    // Assert
    expect(readGroupFile(repoDir, 'main', 'AGENT.md')).toBe(
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
    expect(readGroupFile(repoDir, 'main', 'CLAUDE.md')).toBe(
      '# Existing Main Memory\n\nKeep this control-room context.\n',
    );
  });

  it('backfills AGENT.md for existing registered groups during startup recovery', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(
      repoDir,
      'global',
      'AGENT.md',
      '# Global Template\n\nYou are Andy.\n',
    );
    writeGroupFile(
      repoDir,
      'slack_ops',
      'CLAUDE.md',
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    const group: RegisteredGroup = {
      name: 'Ops',
      folder: 'slack_ops',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
    };

    // Act
    const { _restoreRegisteredGroupsOnStartupForTest } =
      await loadIndexModule(repoDir);
    _restoreRegisteredGroupsOnStartupForTest({ 'slack:C456': group });

    // Assert
    expect(readGroupFile(repoDir, 'slack_ops', 'AGENT.md')).toBe(
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    expect(readGroupFile(repoDir, 'slack_ops', 'CLAUDE.md')).toBe(
      '# Existing Legacy Memory\n\nKeep the runbook exactly.\n',
    );
    expect(ensureAgent).toHaveBeenCalled();
  });

  it('promotes legacy global CLAUDE.md into AGENT.md once during startup recovery', async () => {
    // Arrange
    const repoDir = createTempRepo();
    writeGroupFile(repoDir, 'global', 'AGENT.md', readBundledGlobalTemplate());
    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );

    // Act
    const { _restoreRegisteredGroupsOnStartupForTest } =
      await loadIndexModule(repoDir);
    _restoreRegisteredGroupsOnStartupForTest({});

    // Assert
    expect(readGroupFile(repoDir, 'global', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );

    writeGroupFile(
      repoDir,
      'global',
      'CLAUDE.md',
      '# Later Compatibility Edit\n',
    );
    _restoreRegisteredGroupsOnStartupForTest({});
    expect(readGroupFile(repoDir, 'global', 'AGENT.md')).toBe(
      '# Existing Global Memory\n\nKeep this shared context.\n',
    );
  });
});

describe('provider-scoped runtime sessions', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
    deleteSession.mockReset();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    getSession.mockReset();
    getSession.mockReturnValue(undefined);
    runContainerAgent.mockReset();
    setSession.mockReset();
    writeGroupsSnapshot.mockReset();
    writeTasksSnapshot.mockReset();
    resetIndexRuntimeMocks();
  });

  it('uses the current provider session after a provider switch at runtime', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const startupGroup: RegisteredGroup = {
      name: 'Codex Group',
      folder: 'codex-group',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      providerId: 'claude-code',
    };
    const runtimeGroup: RegisteredGroup = {
      ...startupGroup,
      providerId: 'codex',
    };
    getAllRegisteredGroups.mockReturnValue({ 'codex@g.us': startupGroup });
    getSession.mockImplementation(
      (groupFolder: string | undefined, providerId: string | undefined) => {
        if (groupFolder !== 'codex-group') {
          return undefined;
        }
        if (providerId === 'claude-code') {
          return 'claude-session';
        }
        if (providerId === 'codex') {
          return 'codex-session-current';
        }
        return undefined;
      },
    );
    runContainerAgent.mockResolvedValue({
      status: 'success',
      result: 'done',
      newSessionId: 'codex-session-next',
    });

    // Act
    const { _loadStateForTest, _runAgentForTest, _setRegisteredGroups } =
      await loadIndexModule(repoDir);
    _loadStateForTest();
    _setRegisteredGroups({ 'codex@g.us': runtimeGroup });
    const result = await _runAgentForTest(runtimeGroup, 'Run', 'codex@g.us');

    // Assert
    expect(result).toBe('success');
    expect(getSession.mock.calls).toEqual([
      ['codex-group', 'claude-code'],
      ['codex-group', 'codex'],
    ]);
    expect(runContainerAgent).toHaveBeenCalledTimes(1);
    const [runtimeGroupArg, invocation] = runContainerAgent.mock.calls[0];
    expect(runtimeGroupArg).toEqual(
      expect.objectContaining({
        folder: 'codex-group',
        providerId: 'codex',
      }),
    );
    expect(invocation).toEqual(
      expect.objectContaining({
        prompt: 'Run',
        sessionId: 'codex-session-current',
        groupFolder: 'codex-group',
        chatJid: 'codex@g.us',
      }),
    );
    expect(setSession).toHaveBeenCalledWith(
      'codex-group',
      'codex-session-next',
      'codex',
    );
  });

  it('clears only the active provider session when the runtime reports a stale session', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const group: RegisteredGroup = {
      name: 'Codex Group',
      folder: 'codex-group',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      providerId: 'codex',
    };
    getAllRegisteredGroups.mockReturnValue({ 'codex@g.us': group });
    getSession.mockImplementation(
      (groupFolder: string | undefined, providerId: string | undefined) => {
        if (groupFolder !== 'codex-group') {
          return undefined;
        }
        if (providerId === 'codex') {
          return 'codex-stale-session';
        }
        if (providerId === 'claude-code') {
          return 'claude-session';
        }
        return undefined;
      },
    );
    runContainerAgent.mockResolvedValue({
      status: 'error',
      result: null,
      error: 'no conversation found for session',
    });

    // Act
    const { _loadStateForTest, _runAgentForTest } =
      await loadIndexModule(repoDir);
    _loadStateForTest();
    const result = await _runAgentForTest(group, 'Run', 'codex@g.us');

    // Assert
    expect(result).toBe('error');
    expect(deleteSession).toHaveBeenCalledWith('codex-group', 'codex');
    expect(deleteSession).not.toHaveBeenCalledWith(
      'codex-group',
      'claude-code',
    );
  });
});

describe('thread reply context', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    vi.resetModules();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    resetIndexRuntimeMocks();
  });

  it('clears stale topic context when the latest message is unthreaded', async () => {
    const repoDir = createTempRepo();
    const { _getLatestThreadIdForTest } = await loadIndexModule(repoDir);

    expect(
      _getLatestThreadIdForTest([
        {
          id: 'm1',
          chat_jid: 'tg:123',
          sender: 'alice',
          sender_name: 'Alice',
          content: 'topic message',
          timestamp: '2026-04-07T00:00:00.000Z',
          thread_id: '777',
        },
        {
          id: 'm2',
          chat_jid: 'tg:123',
          sender: 'alice',
          sender_name: 'Alice',
          content: 'main chat message',
          timestamp: '2026-04-07T00:00:01.000Z',
        },
      ]),
    ).toBeUndefined();
  });

  it('uses a deterministic message-id tie-breaker when timestamps collide', async () => {
    const repoDir = createTempRepo();
    const { _getLatestThreadIdForTest } = await loadIndexModule(repoDir);

    expect(
      _getLatestThreadIdForTest([
        {
          id: '11',
          chat_jid: 'tg:123',
          sender: 'alice',
          sender_name: 'Alice',
          content: 'later main chat message',
          timestamp: '2026-04-07T00:00:00.000Z',
        },
        {
          id: '10',
          chat_jid: 'tg:123',
          sender: 'alice',
          sender_name: 'Alice',
          content: 'earlier threaded message',
          timestamp: '2026-04-07T00:00:00.000Z',
          thread_id: '777',
        },
      ]),
    ).toBeUndefined();
  });
});

describe('provider-scoped remote control commands', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    process.argv[1] = ORIGINAL_ARGV_1;
    vi.resetModules();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    resetIndexRuntimeMocks();
    vi.restoreAllMocks();
  });

  it('returns the Codex unsupported message on the real /remote-control command path', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      providerId: 'codex',
    };
    const sendMessage = vi.fn(async () => {});
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage,
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    startRemoteControl.mockResolvedValue({
      ok: true,
      url: 'https://claude.ai/code?bridge=should-not-run',
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    // Act
    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();
    channelOpts?.onMessage('main@g.us', {
      id: 'msg-1',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: '/remote-control',
      timestamp: '2026-04-03T00:00:00.000Z',
      thread_id: '123',
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'main@g.us',
        'Codex does not support remote control in NanoClaw v1.',
        '123',
      );
    });

    // Assert
    expect(startRemoteControl).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('rejects /remote-control from a non-main group on the real command path', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const workerGroup: RegisteredGroup = {
      name: 'Workers',
      folder: 'workers',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: false,
      providerId: 'claude-code',
    };
    const sendMessage = vi.fn(async () => {});
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage,
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'workers@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    getAllRegisteredGroups.mockReturnValue({ 'workers@g.us': workerGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'workers@g.us' ? channel : undefined,
    );
    startClaudeProviderRemoteControl.mockResolvedValue({
      ok: true,
      url: 'https://claude.ai/code?bridge=should-not-run',
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    // Act
    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();
    channelOpts?.onMessage('workers@g.us', {
      id: 'msg-2',
      chat_jid: 'workers@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: '/remote-control',
      timestamp: '2026-04-03T00:00:00.000Z',
    });

    // Assert
    expect(findChannel).not.toHaveBeenCalled();
    expect(startClaudeProviderRemoteControl).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('delegates Claude /remote-control through the provider hook on the real command path', async () => {
    // Arrange
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      providerId: 'claude-code',
    };
    const sendMessage = vi.fn(async () => {});
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage,
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    const claudeProvider: AgentProvider = {
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilities: {
        persistentSessions: true,
        projectMemory: true,
        remoteControl: true,
        agentTeams: true,
        providerSkills: true,
      },
      validateHost: vi.fn(() => []),
      prepareSession: vi.fn(() => ({
        providerStateDir: path.join(
          repoDir,
          'data',
          'sessions',
          'main',
          'claude-code',
        ),
        files: [],
      })),
      buildContainerSpec: vi.fn(() => ({
        mounts: [],
        env: {},
      })),
      serializeRuntimeInput: vi.fn(),
      startRemoteControl: providerHookStartRemoteControl.mockResolvedValue({
        status: 'started',
        url: 'https://claude.ai/code?bridge=delegated',
      }),
    };
    customProviderRegistryState.provider = claudeProvider;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    // Act
    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();
    channelOpts?.onMessage('main@g.us', {
      id: 'msg-3',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content: '/remote-control',
      timestamp: '2026-04-03T00:00:00.000Z',
      thread_id: '456',
    });
    await vi.waitFor(() => {
      expect(sendMessage).toHaveBeenCalledWith(
        'main@g.us',
        'https://claude.ai/code?bridge=delegated',
        '456',
      );
    });

    // Assert
    expect(providerRegistryGetProvider).toHaveBeenCalledWith('claude-code');
    expect(providerHookStartRemoteControl).toHaveBeenCalledWith({
      groupFolder: 'main',
      projectRoot: repoDir,
      env: process.env,
      sender: 'alice',
      chatJid: 'main@g.us',
    });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('attachment follow-up routing', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    process.argv[1] = ORIGINAL_ARGV_1;
    vi.resetModules();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    resetIndexRuntimeMocks();
    vi.restoreAllMocks();
  });

  it('does not advance the cursor when piping attachment follow-ups to an active container', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockReturnValue(true);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    channelOpts?.onMessage('main@g.us', {
      id: '88:attachment',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
      timestamp: '2026-04-07T00:00:10.000Z',
      thread_id: '777',
    });

    expect(storeMessage).toHaveBeenCalledOnce();
    expect(groupQueueSendMessage).toHaveBeenCalledOnce();
    expect(setRouterState).not.toHaveBeenCalled();
  });

  it('enqueues attachment follow-ups for trigger-gated groups when no container is active', async () => {
    const repoDir = createTempRepo();
    const workerGroup: RegisteredGroup = {
      name: 'Workers',
      folder: 'workers',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: false,
      requiresTrigger: true,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'workers@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;

    getAllRegisteredGroups.mockReturnValue({ 'workers@g.us': workerGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'workers@g.us' ? channel : undefined,
    );
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    channelOpts?.onMessage('workers@g.us', {
      id: '99:attachment',
      chat_jid: 'workers@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '@Andy [Document: report.pdf] (/workspace/group/attachments/report_99.pdf)',
      timestamp: '2026-04-07T00:00:20.000Z',
      thread_id: '888',
    });

    expect(storeMessage).toHaveBeenCalledOnce();
    expect(groupQueueSendMessage).toHaveBeenCalledOnce();
    expect(groupQueueEnqueueMessageCheck).toHaveBeenCalledWith('workers@g.us');
  });

  it('does not pipe non-trigger attachment follow-ups into active trigger-gated groups', async () => {
    const repoDir = createTempRepo();
    const workerGroup: RegisteredGroup = {
      name: 'Workers',
      folder: 'workers',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: false,
      requiresTrigger: true,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'workers@g.us'),
      disconnect: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;

    getAllRegisteredGroups.mockReturnValue({ 'workers@g.us': workerGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'workers@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockReturnValue(true);
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    channelOpts?.onMessage('workers@g.us', {
      id: '100:attachment',
      chat_jid: 'workers@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_100.pdf)',
      timestamp: '2026-04-07T00:00:30.000Z',
      thread_id: '888',
    });

    expect(storeMessage).toHaveBeenCalledOnce();
    expect(groupQueueSendMessage).not.toHaveBeenCalled();
    expect(groupQueueEnqueueMessageCheck).toHaveBeenCalledWith('workers@g.us');
  });

  it('does not re-include attachment follow-ups already piped to an active container', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    let containerActive = true;

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockImplementation(() => containerActive);
    formatMessagesMock.mockImplementation((messages: unknown) =>
      (messages as NewMessage[]).map((message) => message.id).join(','),
    );
    getMessagesSince.mockReturnValue([
      {
        id: '88:attachment',
        chat_jid: 'main@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content:
          '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
        timestamp: '2026-04-07T00:00:10.000Z',
      },
      {
        id: 'm2',
        chat_jid: 'main@g.us',
        sender: 'bob',
        sender_name: 'Bob',
        content: 'follow-up message',
        timestamp: '2026-04-07T00:00:11.000Z',
      },
    ] as NewMessage[]);
    runContainerAgent.mockResolvedValue({ status: 'success', result: null });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    channelOpts?.onMessage('main@g.us', {
      id: '88:attachment',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
      timestamp: '2026-04-07T00:00:10.000Z',
      thread_id: '777',
    });

    expect(groupQueueSendMessage).toHaveBeenCalledOnce();

    containerActive = false;
    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;
    const result = await processMessages('main@g.us');

    expect(result).toBe(true);
    expect(formatMessagesMock).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          id: 'm2',
        }),
      ],
      expect.any(String),
    );
    expect(runContainerAgent).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: 'm2',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('retries piped attachment follow-ups after a failed turn', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    let phase: 'initial' | 'retry' = 'initial';

    const attachmentMessage: NewMessage = {
      id: '88:attachment',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
      timestamp: '2026-04-07T00:00:10.000Z',
      thread_id: '777',
    };

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockReturnValue(true);
    formatMessagesMock.mockImplementation((messages: unknown) =>
      (messages as NewMessage[]).map((message) => message.id).join(','),
    );
    getMessagesSince.mockImplementation(() =>
      phase === 'initial'
        ? ([
            {
              id: 'm1',
              chat_jid: 'main@g.us',
              sender: 'bob',
              sender_name: 'Bob',
              content: 'start run',
              timestamp: '2026-04-07T00:00:00.000Z',
            },
          ] as NewMessage[])
        : ([attachmentMessage] as NewMessage[]),
    );
    runContainerAgent.mockImplementationOnce(async () => {
      channelOpts?.onMessage('main@g.us', attachmentMessage);
      return { status: 'error', result: null };
    });
    runContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: null,
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;

    const firstResult = await processMessages('main@g.us');
    expect(firstResult).toBe(false);
    expect(groupQueueSendMessage).toHaveBeenCalledOnce();

    phase = 'retry';
    groupQueueSendMessage.mockReturnValue(false);

    const secondResult = await processMessages('main@g.us');
    expect(secondResult).toBe(true);
    expect(formatMessagesMock).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          id: '88:attachment',
        }),
      ],
      expect.any(String),
    );
    expect(runContainerAgent).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: '88:attachment',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });

  it('does not replay delivered attachment follow-ups after restart', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    const routerState: Record<string, string> = {};
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    let phase: 'initial' | 'restart' = 'initial';

    const initialMessage: NewMessage = {
      id: 'm1',
      chat_jid: 'main@g.us',
      sender: 'bob',
      sender_name: 'Bob',
      content: 'start run',
      timestamp: '2026-04-07T00:00:00.000Z',
    };
    const attachmentMessage: NewMessage = {
      id: '88:attachment',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
      timestamp: '2026-04-07T00:00:10.000Z',
      thread_id: '777',
    };

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    getRouterState.mockImplementation((key: string) => routerState[key] ?? '');
    setRouterState.mockImplementation((key: string, value: string) => {
      routerState[key] = value;
    });
    getMessagesSince.mockImplementation(() =>
      phase === 'initial'
        ? ([initialMessage] as NewMessage[])
        : ([attachmentMessage] as NewMessage[]),
    );
    groupQueueSendMessage.mockReturnValue(true);
    runContainerAgent.mockImplementationOnce(
      async (_group, _request, _proc, onOutput) => {
        channelOpts?.onMessage('main@g.us', attachmentMessage);
        await onOutput?.({ status: 'success', result: null });
        return { status: 'success', result: null };
      },
    );
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;

    const firstResult = await processMessages('main@g.us');
    expect(firstResult).toBe(true);
    expect(routerState['delivered_attachment_ids_by_chat']).toContain(
      '88:attachment',
    );

    phase = 'restart';
    groupQueueSendMessage.mockReset();
    groupQueueSendMessage.mockReturnValue(false);
    groupQueueSetProcessMessagesFn.mockReset();
    runContainerAgent.mockReset();

    await loadIndexModule(repoDir);

    const restartedProcessMessages = groupQueueSetProcessMessagesFn.mock
      .calls[0][0] as (chatJid: string) => Promise<boolean>;
    const secondResult = await restartedProcessMessages('main@g.us');

    expect(secondResult).toBe(true);
    expect(runContainerAgent).not.toHaveBeenCalled();
  });

  it('promotes piped attachments on successful streamed results without a null turn marker', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage: vi.fn(async () => {}),
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    let phase: 'initial' | 'next' = 'initial';

    const attachmentMessage: NewMessage = {
      id: '88:attachment',
      chat_jid: 'main@g.us',
      sender: 'alice',
      sender_name: 'Alice',
      content:
        '[Document: report.pdf] (/workspace/group/attachments/report_88.pdf)',
      timestamp: '2026-04-07T00:00:10.000Z',
      thread_id: '777',
    };

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockReturnValue(true);
    formatMessagesMock.mockImplementation((messages: unknown) =>
      (messages as NewMessage[]).map((message) => message.id).join(','),
    );
    getMessagesSince.mockImplementation(() =>
      phase === 'initial'
        ? ([
            {
              id: 'm1',
              chat_jid: 'main@g.us',
              sender: 'bob',
              sender_name: 'Bob',
              content: 'start run',
              timestamp: '2026-04-07T00:00:00.000Z',
            },
          ] as NewMessage[])
        : ([
            attachmentMessage,
            {
              id: 'm2',
              chat_jid: 'main@g.us',
              sender: 'bob',
              sender_name: 'Bob',
              content: 'follow-up message',
              timestamp: '2026-04-07T00:00:11.000Z',
            },
          ] as NewMessage[]),
    );
    runContainerAgent.mockImplementationOnce(
      async (_group, _request, _proc, onOutput) => {
        channelOpts?.onMessage('main@g.us', attachmentMessage);
        await onOutput?.({ status: 'success', result: 'codex reply' });
        return { status: 'success', result: 'codex reply' };
      },
    );
    runContainerAgent.mockResolvedValueOnce({
      status: 'success',
      result: null,
    });
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(channelOpts).toBeDefined();

    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;

    const firstResult = await processMessages('main@g.us');
    expect(firstResult).toBe(true);
    expect(groupQueueSendMessage).toHaveBeenCalledOnce();

    phase = 'next';
    groupQueueSendMessage.mockReturnValue(false);

    const secondResult = await processMessages('main@g.us');
    expect(secondResult).toBe(true);
    expect(formatMessagesMock).toHaveBeenLastCalledWith(
      [
        expect.objectContaining({
          id: 'm2',
        }),
      ],
      expect.any(String),
    );
    expect(runContainerAgent).toHaveBeenLastCalledWith(
      expect.any(Object),
      expect.objectContaining({
        prompt: 'm2',
      }),
      expect.any(Function),
      expect.any(Function),
    );
  });
});

describe('threaded streaming replies', () => {
  afterEach(() => {
    process.chdir(ORIGINAL_CWD);
    process.argv[1] = ORIGINAL_ARGV_1;
    vi.resetModules();
    getAllRegisteredGroups.mockReset();
    getAllRegisteredGroups.mockReturnValue({});
    resetIndexRuntimeMocks();
    vi.restoreAllMocks();
  });

  it('keeps all streamed chunks in the original thread even if later messages update chat state', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'codex',
    };
    const sendMessage = vi.fn(async () => {});
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage,
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'main@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'topic request',
        timestamp: '2026-04-07T00:00:00.000Z',
        thread_id: '777',
      },
    ] as NewMessage[]);
    runContainerAgent.mockImplementation(
      async (_group, _invocation, _onProcess, onResult) => {
        await onResult({ result: 'first chunk' });
        channelOpts?.onMessage('main@g.us', {
          id: 'm2',
          chat_jid: 'main@g.us',
          sender: 'bob',
          sender_name: 'Bob',
          content: 'main chat follow-up',
          timestamp: '2026-04-07T00:00:01.000Z',
        });
        await onResult({ result: 'second chunk' });
        return { status: 'success', result: null };
      },
    );
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(groupQueueSetProcessMessagesFn).toHaveBeenCalled();
    expect(channelOpts).toBeDefined();

    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;
    const result = await processMessages('main@g.us');

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'main@g.us',
      'first chunk',
      '777',
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'main@g.us',
      'second chunk',
      '777',
    );
  });

  it('refreshes the reply thread between streamed query turns', async () => {
    const repoDir = createTempRepo();
    const mainGroup: RegisteredGroup = {
      name: 'Main',
      folder: 'main',
      trigger: '@Andy',
      added_at: '2026-04-03T00:00:00.000Z',
      isMain: true,
      requiresTrigger: false,
      providerId: 'claude-code',
    };
    const sendMessage = vi.fn(async () => {});
    const channel = {
      name: 'test',
      connect: vi.fn(async () => {}),
      sendMessage,
      isConnected: vi.fn(() => true),
      ownsJid: vi.fn((jid: string) => jid === 'main@g.us'),
      disconnect: vi.fn(async () => {}),
      setTyping: vi.fn(async () => {}),
    };
    let channelOpts:
      | {
          onMessage: (chatJid: string, msg: NewMessage) => void;
        }
      | undefined;
    let idleWaiting = false;

    getAllRegisteredGroups.mockReturnValue({ 'main@g.us': mainGroup });
    getRegisteredChannelNames.mockReturnValue(['test']);
    getChannelFactory.mockImplementation(
      () =>
        (opts: { onMessage: (chatJid: string, msg: NewMessage) => void }) => {
          channelOpts = opts;
          return channel;
        },
    );
    findChannel.mockImplementation((_channels: unknown[], jid: string) =>
      jid === 'main@g.us' ? channel : undefined,
    );
    groupQueueSendMessage.mockImplementation(() => {
      idleWaiting = false;
      return true;
    });
    groupQueueIsIdleWaiting.mockImplementation(() => idleWaiting);
    getMessagesSince.mockReturnValue([
      {
        id: 'm1',
        chat_jid: 'main@g.us',
        sender: 'alice',
        sender_name: 'Alice',
        content: 'topic request',
        timestamp: '2026-04-07T00:00:00.000Z',
        thread_id: '777',
      },
    ] as NewMessage[]);
    runContainerAgent.mockImplementation(
      async (_group, _invocation, _onProcess, onResult) => {
        await onResult({ status: 'success', result: 'first turn' });
        await onResult({ status: 'success', result: null });
        idleWaiting = true;
        channelOpts?.onMessage('main@g.us', {
          id: 'm2',
          chat_jid: 'main@g.us',
          sender: 'bob',
          sender_name: 'Bob',
          content: 'second topic follow-up',
          timestamp: '2026-04-07T00:00:01.000Z',
          thread_id: '888',
        });
        await onResult({ status: 'success', result: 'second turn' });
        await onResult({ status: 'success', result: null });
        return { status: 'success', result: null };
      },
    );
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(() => 0 as any);
    vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => undefined);
    process.argv[1] = INDEX_MODULE_PATH;

    await loadIndexModule(repoDir);
    expect(groupQueueSetProcessMessagesFn).toHaveBeenCalled();
    expect(channelOpts).toBeDefined();

    const processMessages = groupQueueSetProcessMessagesFn.mock.calls[0][0] as (
      chatJid: string,
    ) => Promise<boolean>;
    const result = await processMessages('main@g.us');

    expect(result).toBe(true);
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'main@g.us',
      'first turn',
      '777',
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'main@g.us',
      'second turn',
      '888',
    );
  });
});
