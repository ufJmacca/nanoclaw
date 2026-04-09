import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const runnerModuleUrl = pathToFileURL(
  path.join(packageRoot, 'dist', 'index.js'),
).href;
const codexProviderModuleUrl = pathToFileURL(
  path.join(packageRoot, 'dist', 'providers', 'codex.js'),
).href;
const sharedTempRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'nanoclaw-agent-runner-codex-'),
);
const sharedGroupDir = path.join(sharedTempRoot, 'group');
const sharedGlobalDir = path.join(sharedTempRoot, 'global');
const sharedCodexHomeDir = path.join(sharedTempRoot, 'codex-home');
const sharedFakeCodexPath = path.join(sharedTempRoot, 'codex');
const sharedRecordPath = path.join(sharedTempRoot, 'codex-run.json');
const originalEnv = {
  NANOCLAW_WORKSPACE_GROUP_DIR: process.env.NANOCLAW_WORKSPACE_GROUP_DIR,
  NANOCLAW_WORKSPACE_GLOBAL_DIR: process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR,
  NANOCLAW_CODEX_HOME_DIR: process.env.NANOCLAW_CODEX_HOME_DIR,
  NANOCLAW_CODEX_BIN: process.env.NANOCLAW_CODEX_BIN,
  NANOCLAW_CODEX_RECORD_FILE: process.env.NANOCLAW_CODEX_RECORD_FILE,
  NANOCLAW_CODEX_STDOUT_EVENTS: process.env.NANOCLAW_CODEX_STDOUT_EVENTS,
  NANOCLAW_CODEX_EMIT_THREAD_STARTED:
    process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED,
  NANOCLAW_CODEX_RESULT_TEXT: process.env.NANOCLAW_CODEX_RESULT_TEXT,
};

async function collectOutputs(iterable) {
  const outputs = [];
  for await (const output of iterable) {
    outputs.push(output);
  }
  return outputs;
}

async function loadRunnerModule() {
  return import(`${runnerModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

async function loadCodexProviderModule() {
  return import(`${codexProviderModuleUrl}?t=${Date.now()}-${Math.random()}`);
}

function expectedCodexConfig({
  model,
  reasoningEffort,
  instructionsPath,
  isMain = false,
  chatJid = 'codex@g.us',
  groupFolder = 'codex-group',
  mcpServerPath = '/app/dist/ipc-mcp-stdio.js',
}) {
  const lines = [
    'forced_login_method = "chatgpt"',
    'cli_auth_credentials_store = "file"',
  ];

  if (model) {
    lines.push(`model = ${JSON.stringify(model)}`);
  }

  if (reasoningEffort) {
    lines.push(
      `model_reasoning_effort = ${JSON.stringify(reasoningEffort)}`,
    );
  }

  lines.push('');

  if (instructionsPath) {
    lines.push(
      `model_instructions_file = ${JSON.stringify(instructionsPath)}`,
    );
    lines.push('');
  }

  lines.push('[mcp_servers.nanoclaw]');
  lines.push(`command = ${JSON.stringify('node')}`);
  lines.push(`args = [${JSON.stringify(mcpServerPath)}]`);
  lines.push('');
  lines.push('[mcp_servers.nanoclaw.env]');
  lines.push(`NANOCLAW_CHAT_JID = ${JSON.stringify(chatJid)}`);
  lines.push(`NANOCLAW_GROUP_FOLDER = ${JSON.stringify(groupFolder)}`);
  lines.push(`NANOCLAW_IS_MAIN = ${JSON.stringify(isMain ? '1' : '0')}`);

  return `${lines.join('\n')}\n`;
}

function writeFakeCodexBinary(scriptPath) {
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');

const recordPath = process.env.NANOCLAW_CODEX_RECORD_FILE;
const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
const authPath = path.join(process.env.CODEX_HOME, 'auth.json');
const agentsPath = path.join(process.cwd(), 'AGENTS.md');
const record = {
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  codexHome: process.env.CODEX_HOME,
  config: fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : null,
  authCache: fs.existsSync(authPath) ? fs.readFileSync(authPath, 'utf8') : null,
  groupAgents: fs.existsSync(agentsPath) ? fs.readFileSync(agentsPath, 'utf8') : null,
};
fs.writeFileSync(recordPath, JSON.stringify(record, null, 2));

if (process.env.NANOCLAW_CODEX_STDOUT_EVENTS) {
  const events = JSON.parse(process.env.NANOCLAW_CODEX_STDOUT_EVENTS);
  for (const event of events) {
    console.log(JSON.stringify(event));
  }
  process.exit(0);
}

if (process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED === '1') {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'codex-session-next' }));
}

console.log(JSON.stringify({
  type: 'item.completed',
  item: {
    id: 'item_1',
    type: 'agent_message',
    text: process.env.NANOCLAW_CODEX_RESULT_TEXT || 'codex result',
  },
}));
console.log(JSON.stringify({
  type: 'turn.completed',
  usage: {
    input_tokens: 1,
    cached_input_tokens: 0,
    output_tokens: 1,
  },
}));
`,
    { mode: 0o755 },
  );
}

function resetFixture({
  groupAgents = '# Group Memory\n',
  globalAgents = null,
} = {}) {
  fs.rmSync(sharedGroupDir, { recursive: true, force: true });
  fs.rmSync(sharedGlobalDir, { recursive: true, force: true });
  fs.rmSync(sharedCodexHomeDir, { recursive: true, force: true });
  fs.rmSync(sharedRecordPath, { force: true });
  fs.mkdirSync(sharedGroupDir, { recursive: true });
  fs.mkdirSync(sharedGlobalDir, { recursive: true });
  fs.mkdirSync(sharedCodexHomeDir, { recursive: true });
  fs.writeFileSync(path.join(sharedGroupDir, 'AGENTS.md'), groupAgents);
  delete process.env.NANOCLAW_CODEX_STDOUT_EVENTS;
  delete process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED;
  delete process.env.NANOCLAW_CODEX_RESULT_TEXT;
  if (globalAgents != null) {
    fs.writeFileSync(path.join(sharedGlobalDir, 'AGENT.md'), globalAgents);
  }
}

writeFakeCodexBinary(sharedFakeCodexPath);
process.env.NANOCLAW_WORKSPACE_GROUP_DIR = sharedGroupDir;
process.env.NANOCLAW_WORKSPACE_GLOBAL_DIR = sharedGlobalDir;
process.env.NANOCLAW_CODEX_HOME_DIR = sharedCodexHomeDir;
process.env.NANOCLAW_CODEX_BIN = sharedFakeCodexPath;
process.env.NANOCLAW_CODEX_RECORD_FILE = sharedRecordPath;

test.after(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  fs.rmSync(sharedTempRoot, { recursive: true, force: true });
});

test('built-in Codex provider starts a new conversation with AGENTS memory, global memory, and MCP config', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\nUse the group instructions.\n',
    globalAgents: '# Global Memory\nUse the global instructions.\n',
  });
  process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED = '1';
  process.env.NANOCLAW_CODEX_RESULT_TEXT = 'codex scheduled result';

  const { dispatchProviderInput } = await loadRunnerModule();
  const { codexProvider } = await loadCodexProviderModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Run the scheduled task.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: false,
          isScheduledTask: true,
          providerData: {
            model: 'gpt-5-codex',
            reasoningEffort: 'high',
          },
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );
  const record = JSON.parse(fs.readFileSync(sharedRecordPath, 'utf8'));

  // Assert
  assert.deepEqual(codexProvider.capabilities, {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: false,
    agentTeams: false,
    providerSkills: true,
  });
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'codex scheduled result',
      newSessionId: 'codex-session-next',
    },
  ]);
  assert.equal(record.cwd, sharedGroupDir);
  assert.equal(record.codexHome, sharedCodexHomeDir);
  assert.equal(
    record.groupAgents,
    '# Group Memory\nUse the group instructions.\n',
  );
  assert.deepEqual(record.argv, [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '--add-dir',
    sharedGlobalDir,
    '[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\nRun the scheduled task.',
  ]);
  assert.equal(
    record.config,
    expectedCodexConfig({
      model: 'gpt-5-codex',
      reasoningEffort: 'high',
      instructionsPath: path.join(sharedGlobalDir, 'AGENT.md'),
    }),
  );
});

test('built-in Codex provider resumes an existing conversation with the same dispatcher path', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\n',
  });
  delete process.env.NANOCLAW_CODEX_EMIT_THREAD_STARTED;
  process.env.NANOCLAW_CODEX_RESULT_TEXT = 'codex resumed result';

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Continue the existing task.',
          sessionId: 'codex-session-existing',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
          providerData: {
            model: 'gpt-5-codex-resume',
            reasoningEffort: 'medium',
          },
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );
  const record = JSON.parse(fs.readFileSync(sharedRecordPath, 'utf8'));

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'codex resumed result',
      newSessionId: 'codex-session-existing',
    },
  ]);
  assert.deepEqual(record.argv, [
    'exec',
    'resume',
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    'codex-session-existing',
    'Continue the existing task.',
  ]);
  assert.equal(
    record.config,
    expectedCodexConfig({
      model: 'gpt-5-codex-resume',
      reasoningEffort: 'medium',
      isMain: true,
    }),
  );
});

test('built-in Codex provider keeps the default config byte-for-byte unchanged when canonical runtime data is absent', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\n',
  });
  process.env.NANOCLAW_CODEX_RESULT_TEXT = 'codex default result';

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Use the default config.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
          providerData: {
            profile: 'legacy-model-should-be-ignored',
            reasoning: 'high',
          },
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );
  const record = JSON.parse(fs.readFileSync(sharedRecordPath, 'utf8'));

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'codex default result',
      newSessionId: undefined,
    },
  ]);
  assert.equal(record.config, expectedCodexConfig({ isMain: true }));
});

test('built-in Codex provider rejects malformed canonical reasoning data before writing config.toml', async () => {
  // Arrange
  resetFixture({
    groupAgents: '# Group Memory\n',
  });
  const configPath = path.join(sharedCodexHomeDir, 'config.toml');
  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputsPromise = collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Reject invalid runtime data.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
          providerData: {
            model: 'gpt-5-codex',
            reasoningEffort: 'turbo',
          },
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  await assert.rejects(
    outputsPromise,
    /Invalid Codex reasoning effort "turbo"\. Expected one of: low, medium, high, xhigh\./,
  );
  assert.equal(fs.existsSync(configPath), false);
  assert.equal(fs.existsSync(sharedRecordPath), false);
});

test('built-in Codex provider emits only the completed agent message when Codex streams updates first', async () => {
  // Arrange
  resetFixture();
  process.env.NANOCLAW_CODEX_STDOUT_EVENTS = JSON.stringify([
    { type: 'thread.started', thread_id: 'codex-session-next' },
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'draft reply',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'final reply',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
    },
  ]);

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Answer once.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: false,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'final reply',
      newSessionId: 'codex-session-next',
    },
  ]);
});

test('built-in Codex provider collapses multiple agent_message updates into one final result', async () => {
  // Arrange
  resetFixture();
  process.env.NANOCLAW_CODEX_STDOUT_EVENTS = JSON.stringify([
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'draft reply',
      },
    },
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'better draft reply',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'final reply',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
    },
  ]);

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Continue the existing task.',
          sessionId: 'codex-session-existing',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'final reply',
      newSessionId: 'codex-session-existing',
    },
  ]);
});

test('built-in Codex provider reports a failed turn without emitting a streamed draft reply', async () => {
  // Arrange
  resetFixture();
  process.env.NANOCLAW_CODEX_STDOUT_EVENTS = JSON.stringify([
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'draft reply',
      },
    },
    {
      type: 'turn.failed',
      error: {
        message: 'Codex reported failure',
      },
    },
  ]);

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Continue the existing task.',
          sessionId: 'codex-session-existing',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: true,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'error',
      result: null,
      newSessionId: 'codex-session-existing',
      error: 'Codex reported failure',
    },
  ]);
});

test('built-in Codex provider falls back to the last streamed agent_message update when no completion event arrives', async () => {
  // Arrange
  resetFixture();
  process.env.NANOCLAW_CODEX_STDOUT_EVENTS = JSON.stringify([
    { type: 'thread.started', thread_id: 'codex-session-next' },
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'draft reply',
      },
    },
    {
      type: 'item.updated',
      item: {
        id: 'item_1',
        type: 'agent_message',
        text: 'latest draft reply',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 1,
        cached_input_tokens: 0,
        output_tokens: 1,
      },
    },
  ]);

  const { dispatchProviderInput } = await loadRunnerModule();

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'codex',
        runtimeInput: {
          prompt: 'Answer once.',
          groupFolder: 'codex-group',
          chatJid: 'codex@g.us',
          isMain: false,
        },
      },
      {
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'latest draft reply',
      newSessionId: 'codex-session-next',
    },
  ]);
});
