import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';

import { createProviderRegistry } from '../../provider-registry.js';

describe('codex host provider', () => {
  const ORIGINAL_ENV = { ...process.env };
  const originalCwd = process.cwd();
  const tempRoots: string[] = [];

  function restoreProcessEnv(): void {
    for (const key of Object.keys(process.env)) {
      if (!(key in ORIGINAL_ENV)) {
        delete process.env[key];
      }
    }

    for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }

  function createTempRepo(envFileContent?: string): string {
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    if (envFileContent) {
      fs.writeFileSync(path.join(tempRoot, '.env'), envFileContent);
    }

    return tempRoot;
  }

  function createRuntimeInvocationContext(
    providerOptions?: Record<string, unknown>,
  ) {
    return {
      prompt: 'Solve the task',
      sessionId: 'session-123',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      isScheduledTask: false,
      assistantName: 'Codex',
      script: 'echo test',
      providerOptions,
    };
  }

  function installFakeCodexCli(
    tempRoot: string,
    statusesByAuthContents: Record<string, { status: number; text: string }>,
  ): void {
    const binDir = path.join(tempRoot, 'bin');
    const scriptPath = path.join(binDir, 'codex');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(
      scriptPath,
      `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const authFile = path.join(process.env.CODEX_HOME || '', 'auth.json');
const content = fs.existsSync(authFile) ? fs.readFileSync(authFile, 'utf8') : '';
const statuses = ${JSON.stringify(statusesByAuthContents)};
const status = statuses[content] || { status: 1, text: 'Not logged in' };
process.stderr.write(status.text + '\\n');
process.exit(status.status);
`,
      { mode: 0o755 },
    );

    process.env.PATH = `${binDir}:${ORIGINAL_ENV.PATH ?? ''}`;
  }

  afterEach(() => {
    restoreProcessEnv();
    process.chdir(originalCwd);
    while (tempRoots.length > 0) {
      const tempRoot = tempRoots.pop();
      if (tempRoot) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
      }
    }
  });

  it('prepares Codex AGENTS memory, auth staging, workspace skill sync, and launched capability flags', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    process.env.CODEX_AUTH_FILE = authFile;
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    const containerSpec = provider.buildContainerSpec({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(provider.capabilities).toEqual({
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: true,
    });
    expect(preparedSession.providerStateDir).toBe(
      path.join(dataDir, 'sessions', 'test-group', 'codex'),
    );
    expect(preparedSession.files).toEqual([
      {
        sourcePath: path.join(groupDir, 'AGENT.md'),
        targetPath: path.join(groupDir, 'AGENTS.md'),
      },
      {
        sourcePath: authFile,
        targetPath: path.join(
          dataDir,
          'sessions',
          'test-group',
          'codex',
          'auth.json',
        ),
      },
    ]);
    expect(preparedSession.allowedSourceRoots).toEqual([
      path.dirname(authFile),
    ]);
    expect(preparedSession.metadata).toMatchObject({
      codexAuthSourceFile: authFile,
    });
    expect(preparedSession.metadata?.codexAuthSourceHash).toMatch(
      /^[0-9a-f]{64}$/,
    );
    expect(preparedSession.directorySyncs).toEqual([
      {
        sourcePath: path.join(projectRoot, 'container', 'codex-skills'),
        targetPath: path.join(groupDir, '.agents', 'skills'),
      },
    ]);
    expect(containerSpec).toEqual({
      mounts: [
        {
          hostPath: path.join(dataDir, 'sessions', 'test-group', 'codex'),
          containerPath: '/home/node/.codex',
          readonly: false,
        },
      ],
      env: {
        CODEX_HOME: '/home/node/.codex',
      },
      workdir: '/workspace/group',
    });
  });

  it('syncs refreshed auth.json back to the configured CODEX_AUTH_FILE after a run', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"after"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"after"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"after"}\n');
  });

  it('does not overwrite a newer host auth.json that changed after session preparation', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"stale-session"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.writeFileSync(authFile, '{"refresh":"newer"}\n');
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"stale-session"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"newer"}\n');
  });

  it('does not sync an invalid refreshed auth.json back to the configured CODEX_AUTH_FILE', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    installFakeCodexCli(tempRoot, {
      '{"refresh":"invalid"}\n': {
        status: 1,
        text: 'Not logged in',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(preparedSession.providerStateDir, 'auth.json'),
      '{"refresh":"invalid"}\n',
    );

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"before"}\n');
  });

  it('preserves host auth.json permissions when syncing refreshed credentials', async () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"refresh":"before"}\n');
    fs.chmodSync(authFile, 0o600);
    installFakeCodexCli(tempRoot, {
      '{"refresh":"after"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });
    fs.mkdirSync(preparedSession.providerStateDir, { recursive: true });
    const refreshedAuthFile = path.join(
      preparedSession.providerStateDir,
      'auth.json',
    );
    fs.writeFileSync(refreshedAuthFile, '{"refresh":"after"}\n');
    fs.chmodSync(refreshedAuthFile, 0o644);

    // Act
    await provider.finalizeSession?.({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
      preparedSession,
    });

    // Assert
    expect(fs.readFileSync(authFile, 'utf8')).toBe('{"refresh":"after"}\n');
    expect(fs.statSync(authFile).mode & 0o777).toBe(0o600);
  });

  it('clears stale provider auth cache when the configured source auth file is missing', () => {
    // Arrange
    const tempRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), 'nanoclaw-codex-host-provider-'),
    );
    tempRoots.push(tempRoot);

    const projectRoot = process.cwd();
    const dataDir = path.join(tempRoot, 'data');
    const groupDir = path.join(tempRoot, 'groups', 'test-group');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    const providerStateDir = path.join(
      dataDir,
      'sessions',
      'test-group',
      'codex',
    );
    fs.mkdirSync(groupDir, { recursive: true });
    fs.mkdirSync(providerStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(providerStateDir, 'auth.json'),
      '{"stale":true}\n',
    );
    process.env.CODEX_AUTH_FILE = authFile;

    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const preparedSession = provider.prepareSession({
      projectRoot,
      dataDir,
      groupFolder: 'test-group',
      groupDir,
      isMain: false,
    });

    // Assert
    expect(preparedSession.files).toEqual([
      {
        sourcePath: path.join(groupDir, 'AGENT.md'),
        targetPath: path.join(groupDir, 'AGENTS.md'),
      },
    ]);
    expect(fs.existsSync(path.join(providerStateDir, 'auth.json'))).toBe(false);
  });

  it('adds a readiness error when CODEX_REASONING_EFFORT is invalid in project env', () => {
    // Arrange
    const tempRoot = createTempRepo('CODEX_REASONING_EFFORT=turbo\n');
    const authFile = path.join(tempRoot, 'codex-auth', 'auth.json');
    fs.mkdirSync(path.dirname(authFile), { recursive: true });
    fs.writeFileSync(authFile, '{"auth":"chatgpt"}\n');
    installFakeCodexCli(tempRoot, {
      '{"auth":"chatgpt"}\n': {
        status: 0,
        text: 'Logged in using ChatGPT',
      },
    });
    process.env.CODEX_AUTH_FILE = authFile;
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const checks = provider.validateHost(process.env, tempRoot);

    // Assert
    expect(checks).toContainEqual({
      status: 'error',
      code: 'runtime_config_invalid',
      message:
        'Codex runtime configuration is invalid: Invalid Codex reasoning effort "turbo". Expected one of: low, medium, high, xhigh.',
    });
  });

  it('serializes only canonical providerData when canonical provider options are set', () => {
    // Arrange
    const tempRoot = createTempRepo(
      ['CODEX_MODEL=gpt-env', 'CODEX_REASONING_EFFORT=medium'].join('\n'),
    );
    process.chdir(tempRoot);
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const runtimeInput = provider.serializeRuntimeInput(
      createRuntimeInvocationContext({
        model: 'gpt-canonical',
        profile: 'gpt-legacy',
        reasoningEffort: 'low',
        reasoning: 'high',
        ignored: 'value',
      }),
    );

    // Assert
    expect(runtimeInput).toEqual({
      prompt: 'Solve the task',
      sessionId: 'session-123',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      isScheduledTask: false,
      assistantName: 'Codex',
      script: 'echo test',
      providerData: {
        model: 'gpt-canonical',
        reasoningEffort: 'low',
      },
    });
  });

  it('lets provider options override env defaults while normalizing legacy aliases', () => {
    // Arrange
    const tempRoot = createTempRepo(
      ['CODEX_MODEL=gpt-env', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );
    process.chdir(tempRoot);
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const runtimeInput = provider.serializeRuntimeInput(
      createRuntimeInvocationContext({
        profile: 'gpt-legacy',
        reasoning: 'medium',
      }),
    );

    // Assert
    expect(runtimeInput.providerData).toEqual({
      model: 'gpt-legacy',
      reasoningEffort: 'medium',
    });
  });

  it('resolves project defaults from process.cwd without widening the runtime context', () => {
    // Arrange
    const tempRoot = createTempRepo(
      ['CODEX_MODEL=gpt-dotenv', 'CODEX_REASONING_EFFORT=high'].join('\n'),
    );
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    process.chdir(tempRoot);
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const runtimeInput = provider.serializeRuntimeInput(
      createRuntimeInvocationContext(),
    );

    // Assert
    expect(runtimeInput.providerData).toEqual({
      model: 'gpt-dotenv',
      reasoningEffort: 'high',
    });
  });

  it('omits providerData when neither env defaults nor provider options resolve', () => {
    // Arrange
    const tempRoot = createTempRepo();
    delete process.env.CODEX_MODEL;
    delete process.env.CODEX_REASONING_EFFORT;
    process.chdir(tempRoot);
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const runtimeInput = provider.serializeRuntimeInput(
      createRuntimeInvocationContext(),
    );

    // Assert
    expect(runtimeInput).toEqual({
      prompt: 'Solve the task',
      sessionId: 'session-123',
      groupFolder: 'test-group',
      chatJid: 'test@g.us',
      isMain: false,
      isScheduledTask: false,
      assistantName: 'Codex',
      script: 'echo test',
    });
    expect('providerData' in runtimeInput).toBe(false);
  });

  it('fails before container launch when provider-option reasoning is invalid', () => {
    // Arrange
    const tempRoot = createTempRepo();
    process.chdir(tempRoot);
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const serializeRuntimeInput = () =>
      provider.serializeRuntimeInput(
        createRuntimeInvocationContext({
          reasoning: 'turbo',
        }),
      );

    // Assert
    expect(serializeRuntimeInput).toThrowError(
      'Invalid Codex reasoning effort "turbo". Expected one of: low, medium, high, xhigh.',
    );
  });

  it('returns an explicit unsupported result for remote control', async () => {
    // Arrange
    const provider = createProviderRegistry().getProvider('codex');

    // Act
    const result = await provider.startRemoteControl?.({
      groupFolder: 'test-group',
      projectRoot: '/workspace/project',
      env: process.env,
      sender: 'user1',
      chatJid: 'test@g.us',
    });

    // Assert
    expect(result).toEqual({
      status: 'unsupported',
      message: 'Codex does not support remote control in NanoClaw v1.',
    });
  });
});
