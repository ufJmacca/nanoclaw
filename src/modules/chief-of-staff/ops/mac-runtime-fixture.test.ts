import { expect, it } from 'vitest';
import { runtimeFixtureTarget } from './mac-runtime-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
const settings: DeploymentSettings = {
  version: 1,
  target: 'pi',
  sshAlias: 'fixture-pi',
  hostFingerprint: '1'.repeat(64),
  databaseFingerprint: '2'.repeat(64),
  service: 'nano.service',
  userHome: '/home/fixture',
  installationRoot: '/home/fixture/nano',
  dataRoot: '/home/fixture/nano/data',
  stateRoot: '/home/fixture/state',
  releaseRoot: '/home/fixture/releases',
  stagingRoot: '/home/fixture/staging',
  sourceRoot: '/home/fixture/source',
  runtimeEnvironment: '/home/fixture/.config/runtime.env',
  migrationEnvironment: '/home/fixture/.config/migration.env',
};
const binding = {
  hostFingerprint: settings.hostFingerprint,
  databaseFingerprint: settings.databaseFingerprint,
  service: settings.service,
  installationRoot: settings.installationRoot,
  dataRoot: settings.dataRoot,
};
const observation = {
  fingerprint: settings.hostFingerprint,
  platform: 'linux',
  architecture: 'arm64',
  dockerArchitecture: 'arm64',
  dockerOS: 'linux',
  service: 'active',
  cwd: settings.installationRoot,
  state: {
    version: 1,
    binding,
    lifecycle: 'implementation_disposable',
    generation: 1,
    maintenance: false,
    releaseId: 'release-fixture',
  },
};
it('selects only the installed target helper and never bootstraps or silently resets a runtime test target', () => {
  const target = runtimeFixtureTarget(settings, observation, 'fixture-owner');
  expect(target.command).toContain(
    '/home/fixture/releases/release-fixture/payload/dist/modules/chief-of-staff/ops/target-helper.js',
  );
  expect(target.command).toContain("'runtime-test'");
  expect(target.bindingDigest).toMatch(/^[a-f0-9]{64}$/);
  for (const state of [
    null,
    { ...observation.state, releaseId: null },
    { ...observation.state, lifecycle: 'protected' },
  ])
    expect(() => runtimeFixtureTarget(settings, { ...observation, state }, 'fixture-owner')).toThrow(
      'runtime_fixture_installed_disposable_target_required',
    );
  expect(() => runtimeFixtureTarget(settings, observation, 'bad;command')).toThrow();
});
