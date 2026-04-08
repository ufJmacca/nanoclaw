import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const codexProviderModuleUrl = pathToFileURL(
  path.join(packageRoot, 'dist', 'providers', 'codex.js'),
).href;

test('built-in Codex provider exposes launched capabilities without enabling remote control or agent teams', async () => {
  // Arrange
  const { codexProvider } = await import(
    `${codexProviderModuleUrl}?t=${Date.now()}-${Math.random()}`
  );

  // Act
  const capabilities = codexProvider.capabilities;

  // Assert
  assert.deepEqual(capabilities, {
    persistentSessions: true,
    projectMemory: true,
    remoteControl: false,
    agentTeams: false,
    providerSkills: true,
  });
});
