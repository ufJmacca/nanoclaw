import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(__dirname, '..');
const runnerModulePath = path.join(packageRoot, 'dist', 'index.js');

async function collectOutputs(iterable) {
  const outputs = [];
  for await (const output of iterable) {
    outputs.push(output);
  }
  return outputs;
}

test('dispatchProviderInput routes by providerId and maps provider result events into container outputs', async () => {
  // Arrange
  const { dispatchProviderInput } = await import(runnerModulePath);
  const calls = [];
  const fakeProvider = {
    id: 'fake-provider',
    displayName: 'Fake Provider',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: false,
    },
    providerHomeDir: '/home/node/.fake',
    prepareWorkspace(context) {
      calls.push({ type: 'prepare', context });
      return {
        files: [],
      };
    },
    async *run(context) {
      calls.push({ type: 'run', context });
      yield { type: 'session_started', sessionId: 'session-123' };
      yield { type: 'result', text: 'provider result' };
      yield { type: 'result', text: null };
    },
  };

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'fake-provider',
        runtimeInput: {
          prompt: 'Hello from the host',
          groupFolder: 'dispatch-group',
          chatJid: 'dispatch@g.us',
          isMain: false,
        },
      },
      {
        providers: [fakeProvider],
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.equal(calls[0].type, 'prepare');
  assert.equal(calls[0].context.providerHomeDir, '/home/node/.fake');
  assert.equal(calls[0].context.workspaceDir, '/workspace/group');
  assert.equal(calls[0].context.globalMemoryDir, '/workspace/global');
  assert.equal(calls[1].type, 'run');
  assert.equal(calls[1].context.input.prompt, 'Hello from the host');
  assert.deepEqual(outputs, [
    {
      status: 'success',
      result: 'provider result',
      newSessionId: 'session-123',
    },
    {
      status: 'success',
      result: null,
      newSessionId: 'session-123',
    },
  ]);
});

test('dispatchProviderInput maps provider error events into container error outputs', async () => {
  // Arrange
  const { dispatchProviderInput } = await import(runnerModulePath);
  const fakeProvider = {
    id: 'failing-provider',
    displayName: 'Failing Provider',
    capabilities: {
      persistentSessions: true,
      projectMemory: true,
      remoteControl: false,
      agentTeams: false,
      providerSkills: false,
    },
    providerHomeDir: '/home/node/.failing',
    prepareWorkspace() {
      return {
        files: [],
      };
    },
    async *run() {
      yield { type: 'session_started', sessionId: 'session-456' };
      yield { type: 'error', message: 'provider exploded' };
    },
  };

  // Act
  const outputs = await collectOutputs(
    dispatchProviderInput(
      {
        providerId: 'failing-provider',
        runtimeInput: {
          prompt: 'Hello from the host',
          groupFolder: 'dispatch-group',
          chatJid: 'dispatch@g.us',
          isMain: true,
        },
      },
      {
        providers: [fakeProvider],
        mcpServerPath: '/app/dist/ipc-mcp-stdio.js',
      },
    ),
  );

  // Assert
  assert.deepEqual(outputs, [
    {
      status: 'error',
      result: null,
      newSessionId: 'session-456',
      error: 'provider exploded',
    },
  ]);
});
