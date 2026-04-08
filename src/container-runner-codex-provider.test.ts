import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { PassThrough } from 'stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { RegisteredGroup } from './types.js';

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';
const CODEX_SKILLS_PARENT_DIR = path.join(process.cwd(), 'container');
const CODEX_SKILLS_SOURCE_DIR = path.join(
  CODEX_SKILLS_PARENT_DIR,
  'codex-skills',
);

interface LoadedSubject {
  runContainerAgent: typeof import('./container-runner.js').runContainerAgent;
  spawnMock: ReturnType<typeof vi.fn>;
}

const originalCodexAuthFile = process.env.CODEX_AUTH_FILE;
const originalCodexModel = process.env.CODEX_MODEL;
const originalCodexReasoningEffort = process.env.CODEX_REASONING_EFFORT;
const originalCwd = process.cwd();
interface SerializedContainerInput {
  providerId: string;
  runtimeInput: Record<string, unknown> & {
    providerData?: Record<string, unknown>;
  };
}

function createFakeProcess() {
  const proc = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
    pid: number;
  };
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = vi.fn();
  proc.pid = 12345;
  return proc;
}

function emitOutputMarker(
  proc: ReturnType<typeof createFakeProcess>,
  output: import('./container-runner.js').ContainerOutput,
): void {
  proc.stdout.push(
    `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`,
  );
}

async function loadSubject(
  dataDir: string,
  groupsDir: string,
  fakeProc: ReturnType<typeof createFakeProcess>,
): Promise<LoadedSubject> {
  const spawnMock = vi.fn(() => fakeProc);

  vi.resetModules();

  vi.doMock('./config.js', () => ({
    COMPATIBILITY_AGENT_PROVIDER: 'codex',
    CONTAINER_IMAGE: 'nanoclaw-agent:latest',
    CONTAINER_MAX_OUTPUT_SIZE: 10485760,
    CONTAINER_TIMEOUT: 1800000,
    DATA_DIR: dataDir,
    GROUPS_DIR: groupsDir,
    IDLE_TIMEOUT: 1800000,
    ONECLI_URL: 'http://localhost:10254',
    TIMEZONE: 'UTC',
  }));

  vi.doMock('./logger.js', () => ({
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  }));

  vi.doMock('./mount-security.js', () => ({
    validateAdditionalMounts: vi.fn(() => []),
  }));

  vi.doMock('./container-runtime.js', () => ({
    CONTAINER_RUNTIME_BIN: 'docker',
    hostGatewayArgs: () => [],
    readonlyMountArgs: (hostPath: string, containerPath: string) => [
      '-v',
      `${hostPath}:${containerPath}:ro`,
    ],
    stopContainer: vi.fn(),
  }));

  vi.doMock('@onecli-sh/sdk', () => ({
    OneCLI: class {
      applyContainerConfig = vi.fn().mockResolvedValue(true);
      createAgent = vi.fn().mockResolvedValue({ id: 'test' });
      ensureAgent = vi
        .fn()
        .mockResolvedValue({ name: 'test', identifier: 'test', created: true });
    },
  }));

  vi.doMock('child_process', async () => {
    const actual =
      await vi.importActual<typeof import('child_process')>('child_process');
    return {
      ...actual,
      spawn: spawnMock,
    };
  });

  const module = await import('./container-runner.js');

  return {
    runContainerAgent: module.runContainerAgent,
    spawnMock,
  };
}

function createCodexGroup(): RegisteredGroup {
  return {
    name: 'Test Group',
    folder: 'test-group',
    trigger: '@Andy',
    added_at: new Date().toISOString(),
    providerId: 'codex',
  };
}

function captureSerializedInput(
  fakeProc: ReturnType<typeof createFakeProcess>,
): () => SerializedContainerInput {
  let stdinPayload = '';

  fakeProc.stdin.on('data', (chunk) => {
    stdinPayload += chunk.toString();
  });

  return () => JSON.parse(stdinPayload) as SerializedContainerInput;
}

function cleanupCodexSkillsBackups(): void {
  if (!fs.existsSync(CODEX_SKILLS_PARENT_DIR)) {
    return;
  }

  const backupDirs = fs
    .readdirSync(CODEX_SKILLS_PARENT_DIR)
    .filter((entry) => entry.startsWith('.codex-skills-backup-'))
    .map((entry) => path.join(CODEX_SKILLS_PARENT_DIR, entry))
    .sort();

  if (!fs.existsSync(CODEX_SKILLS_SOURCE_DIR) && backupDirs.length > 0) {
    fs.renameSync(backupDirs[0], CODEX_SKILLS_SOURCE_DIR);
    backupDirs.shift();
  }

  for (const backupDir of backupDirs) {
    fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

function replaceCodexSkillsSource(state: 'empty' | 'missing'): () => void {
  const backupDir = path.join(
    CODEX_SKILLS_PARENT_DIR,
    `.codex-skills-backup-${state}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`,
  );
  const sourceExists = fs.existsSync(CODEX_SKILLS_SOURCE_DIR);

  if (sourceExists) {
    fs.renameSync(CODEX_SKILLS_SOURCE_DIR, backupDir);
  }

  if (state === 'empty') {
    fs.mkdirSync(CODEX_SKILLS_SOURCE_DIR, { recursive: true });
  }

  return () => {
    fs.rmSync(CODEX_SKILLS_SOURCE_DIR, { recursive: true, force: true });

    if (sourceExists) {
      fs.renameSync(backupDir, CODEX_SKILLS_SOURCE_DIR);
    }
  };
}

describe('container runner Codex provider compatibility', () => {
  let tempRoot: string;
  let dataDir: string;
  let groupsDir: string;

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-container-codex-provider-'),
    );
    dataDir = path.join(tempRoot, 'data');
    groupsDir = path.join(tempRoot, 'groups');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(groupsDir, { recursive: true });
  });

  afterEach(() => {
    if (originalCodexAuthFile === undefined) {
      delete process.env.CODEX_AUTH_FILE;
    } else {
      process.env.CODEX_AUTH_FILE = originalCodexAuthFile;
    }
    if (originalCodexModel === undefined) {
      delete process.env.CODEX_MODEL;
    } else {
      process.env.CODEX_MODEL = originalCodexModel;
    }
    if (originalCodexReasoningEffort === undefined) {
      delete process.env.CODEX_REASONING_EFFORT;
    } else {
      process.env.CODEX_REASONING_EFFORT = originalCodexReasoningEffort;
    }
    process.chdir(originalCwd);
    cleanupCodexSkillsBackups();
    vi.clearAllMocks();
    vi.resetModules();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('copies repo Codex skills into the group workspace while preserving AGENTS, the Codex home mount, and env-resolved providerData', async () => {
    // Arrange
    const group = createCodexGroup();
    const groupDir = path.join(groupsDir, group.folder);
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      group.folder,
      'codex',
    );
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    const skillName = 'runtime-compatibility-skill';
    const sourceSkillDir = path.join(CODEX_SKILLS_SOURCE_DIR, skillName);
    const syncedSkillFile = path.join(
      groupDir,
      '.agents',
      'skills',
      skillName,
      'SKILL.md',
    );
    const providerSkillFile = path.join(
      providerStateDir,
      'skills',
      skillName,
      'SKILL.md',
    );
    const fakeProc = createFakeProcess();
    const readSerializedInput = captureSerializedInput(fakeProc);

    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    process.env.CODEX_AUTH_FILE = authFile;
    process.env.CODEX_MODEL = 'gpt-5-codex-env';
    process.env.CODEX_REASONING_EFFORT = 'high';
    fs.mkdirSync(sourceSkillDir, { recursive: true });
    fs.writeFileSync(
      path.join(sourceSkillDir, 'SKILL.md'),
      '# Runtime Compatibility Skill\n',
    );

    try {
      const { runContainerAgent, spawnMock } = await loadSubject(
        dataDir,
        groupsDir,
        fakeProc,
      );
      spawnMock.mockImplementation(
        (runtimeBin: string, runtimeArgs: string[]) => {
          // Assert the compatibility artifacts are materialized before container start.
          expect(runtimeBin).toBe('docker');
          expect(
            fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8'),
          ).toBe('# Canonical Agent\n');
          expect(fs.readFileSync(syncedSkillFile, 'utf-8')).toBe(
            '# Runtime Compatibility Skill\n',
          );
          expect(fs.existsSync(providerSkillFile)).toBe(false);
          expect(runtimeArgs).toContain(
            `${providerStateDir}:/home/node/.codex`,
          );
          return fakeProc;
        },
      );

      // Act
      const runPromise = runContainerAgent(
        group,
        {
          prompt: 'Ship the Codex provider slice.',
          groupFolder: group.folder,
          chatJid: 'test@g.us',
          isMain: false,
        },
        () => {},
      );

      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
      await vi.waitFor(() =>
        expect(readSerializedInput().runtimeInput.providerData).toEqual({
          model: 'gpt-5-codex-env',
          reasoningEffort: 'high',
        }),
      );

      // Assert
      expect(readSerializedInput()).toEqual({
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Ship the Codex provider slice.',
          groupFolder: group.folder,
          chatJid: 'test@g.us',
          isMain: false,
          isScheduledTask: false,
          providerData: {
            model: 'gpt-5-codex-env',
            reasoningEffort: 'high',
          },
        },
      });
      expect(readSerializedInput().runtimeInput).not.toHaveProperty(
        'providerOptions',
      );
      expect(
        fs.readFileSync(path.join(providerStateDir, 'auth.json'), 'utf-8'),
      ).toBe('{"auth":"chatgpt"}\n');

      emitOutputMarker(fakeProc, {
        status: 'success',
        result: 'ok',
        newSessionId: 'session-123',
      });
      fakeProc.emit('close', 0);

      await expect(runPromise).resolves.toEqual({
        status: 'success',
        result: 'ok',
        newSessionId: 'session-123',
      });
    } finally {
      fs.rmSync(sourceSkillDir, { recursive: true, force: true });
    }
  });

  it('normalizes legacy Codex provider options before writing runtime input to the container', async () => {
    // Arrange
    const group: RegisteredGroup = {
      ...createCodexGroup(),
      providerOptions: {
        profile: 'gpt-5-codex-legacy',
        reasoning: 'medium',
        ignored: 'value',
      },
    };
    const groupDir = path.join(groupsDir, group.folder);
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    const fakeProc = createFakeProcess();
    const readSerializedInput = captureSerializedInput(fakeProc);

    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    process.env.CODEX_AUTH_FILE = authFile;

    const { runContainerAgent, spawnMock } = await loadSubject(
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const runPromise = runContainerAgent(
      group,
      {
        prompt: 'Normalize legacy provider options.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(readSerializedInput().runtimeInput.providerData).toEqual({
        model: 'gpt-5-codex-legacy',
        reasoningEffort: 'medium',
      }),
    );
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'normalized',
      newSessionId: 'session-normalized',
    });
    fakeProc.emit('close', 0);

    const result = await runPromise;

    // Assert
    expect(result).toEqual({
      status: 'success',
      result: 'normalized',
      newSessionId: 'session-normalized',
    });
    expect(readSerializedInput()).toEqual({
      providerId: 'codex',
      runtimeInput: {
        prompt: 'Normalize legacy provider options.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
        isScheduledTask: false,
        providerData: {
          model: 'gpt-5-codex-legacy',
          reasoningEffort: 'medium',
        },
      },
    });
    expect(readSerializedInput().runtimeInput).not.toHaveProperty(
      'providerOptions',
    );
    expect(readSerializedInput().runtimeInput.providerData).not.toHaveProperty(
      'profile',
    );
    expect(readSerializedInput().runtimeInput.providerData).not.toHaveProperty(
      'reasoning',
    );
  });

  it('omits providerData from container runtime input when no Codex runtime config resolves', async () => {
    // Arrange
    const group = createCodexGroup();
    const groupDir = path.join(groupsDir, group.folder);
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    const isolatedProjectRoot = path.join(tempRoot, 'isolated-project-root');
    const fakeProc = createFakeProcess();
    const readSerializedInput = captureSerializedInput(fakeProc);

    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.mkdirSync(isolatedProjectRoot, { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    process.env.CODEX_AUTH_FILE = authFile;
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    process.chdir(isolatedProjectRoot);

    const { runContainerAgent, spawnMock } = await loadSubject(
      dataDir,
      groupsDir,
      fakeProc,
    );

    // Act
    const runPromise = runContainerAgent(
      group,
      {
        prompt: 'Launch without Codex runtime config.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
      },
      () => {},
    );

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
    await vi.waitFor(() =>
      expect(readSerializedInput().runtimeInput.prompt).toBe(
        'Launch without Codex runtime config.',
      ),
    );
    emitOutputMarker(fakeProc, {
      status: 'success',
      result: 'no-provider-data',
      newSessionId: 'session-no-provider-data',
    });
    fakeProc.emit('close', 0);

    const result = await runPromise;

    // Assert
    expect(result).toEqual({
      status: 'success',
      result: 'no-provider-data',
      newSessionId: 'session-no-provider-data',
    });
    expect(readSerializedInput()).toEqual({
      providerId: 'codex',
      runtimeInput: {
        prompt: 'Launch without Codex runtime config.',
        groupFolder: group.folder,
        chatJid: 'test@g.us',
        isMain: false,
        isScheduledTask: false,
      },
    });
    expect(readSerializedInput().runtimeInput).not.toHaveProperty(
      'providerData',
    );
    expect(readSerializedInput().runtimeInput).not.toHaveProperty(
      'providerOptions',
    );
  });

  it.each(['missing', 'empty'] as const)(
    'does not fail when container/codex-skills is %s',
    async (sourceState) => {
      // Arrange
      const group = createCodexGroup();
      const groupDir = path.join(groupsDir, group.folder);
      const providerStateDir = path.join(
        dataDir,
        'sessions',
        group.folder,
        'codex',
      );
      const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
      const restoreCodexSkillsSource = replaceCodexSkillsSource(sourceState);
      const fakeProc = createFakeProcess();

      fs.mkdirSync(groupDir, { recursive: true });
      fs.writeFileSync(path.join(groupDir, 'AGENT.md'), '# Canonical Agent\n');
      fs.mkdirSync(path.dirname(authFile), { recursive: true });
      fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
      process.env.CODEX_AUTH_FILE = authFile;

      try {
        const { runContainerAgent, spawnMock } = await loadSubject(
          dataDir,
          groupsDir,
          fakeProc,
        );

        // Act
        const runPromise = runContainerAgent(
          group,
          {
            prompt: `Handle the ${sourceState} Codex skills source.`,
            groupFolder: group.folder,
            chatJid: 'test@g.us',
            isMain: false,
          },
          () => {},
        );

        await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));
        emitOutputMarker(fakeProc, {
          status: 'success',
          result: 'ok',
          newSessionId: `session-${sourceState}`,
        });
        fakeProc.emit('close', 0);

        const result = await runPromise;

        // Assert
        expect(result).toEqual({
          status: 'success',
          result: 'ok',
          newSessionId: `session-${sourceState}`,
        });
        expect(fs.readFileSync(path.join(groupDir, 'AGENTS.md'), 'utf-8')).toBe(
          '# Canonical Agent\n',
        );
        expect(
          fs.readFileSync(path.join(providerStateDir, 'auth.json'), 'utf-8'),
        ).toBe('{"auth":"chatgpt"}\n');
        expect(spawnMock.mock.calls[0][1]).toContain(
          `${providerStateDir}:/home/node/.codex`,
        );
      } finally {
        restoreCodexSkillsSource();
      }
    },
  );
});
