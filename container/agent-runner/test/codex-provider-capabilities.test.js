import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const packageRoot = path.resolve(import.meta.dirname, '..');
const codexProviderModuleUrl = pathToFileURL(
  path.join(packageRoot, 'dist', 'providers', 'codex.js'),
).href;

test('built-in Codex provider keeps provider skills disabled until the launch gate flips', async () => {
  // Arrange
  const { codexProvider } = await import(
    `${codexProviderModuleUrl}?t=${Date.now()}-${Math.random()}`
  );

  // Act
  const providerSkills = codexProvider.capabilities.providerSkills;

  // Assert
  assert.equal(providerSkills, false);
});
