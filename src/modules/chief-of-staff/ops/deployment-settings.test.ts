import { describe, it, expect } from 'vitest';
import { deploymentSettings, shellArgument } from './deployment-settings.js';
const value = {
  version: 1,
  target: 'pi',
  sshAlias: 'fixture-pi',
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'nanoclaw-fixture.service',
  userHome: '/home/fixture',
  installationRoot: '/home/fixture/nanoclaw',
  dataRoot: '/home/fixture/nanoclaw/data',
  stateRoot: '/home/fixture/.local/state/nanoclaw-cos',
  releaseRoot: '/home/fixture/.local/share/nanoclaw-cos/releases',
  stagingRoot: '/home/fixture/.local/share/nanoclaw-cos/staging',
  sourceRoot: '/home/fixture/.local/share/nanoclaw-cos/source',
  runtimeEnvironment: '/home/fixture/.config/nanoclaw-cos/runtime.env',
  migrationEnvironment: '/home/fixture/.config/nanoclaw-cos/migration.env',
};
describe('S01-REL08 fixed private deployment target', () => {
  it('accepts one explicit target and separates protected installation data from release/admin roots', () =>
    expect(deploymentSettings(value)).toEqual(value));
  it('rejects shell syntax, traversal, overlapping roots, wrong state location and embedded credentials', () => {
    for (const change of [
      { sshAlias: 'fixture; whoami' },
      { service: 'foreign.service --user' },
      { releaseRoot: '/tmp/../etc' },
      { stateRoot: value.dataRoot + '/state' },
      { releaseRoot: value.stagingRoot },
      { runtimeEnvironment: value.dataRoot + '/secret' },
      { password: 'secret' },
    ])
      expect(() => deploymentSettings({ ...value, ...change })).toThrow('invalid_deployment_settings');
  });
  it('quotes a literal remote argument without allowing substitutions', () =>
    expect(shellArgument("literal ' $(uname)")).toBe("'literal '\"'\"' $(uname)'"));
});
