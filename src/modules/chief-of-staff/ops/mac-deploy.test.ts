import { expect, it } from 'vitest';
import {
  validateTargetObservation,
  validateBuildTargetObservation,
  targetPreflightCommand,
  validateDeliveryReceipt,
} from './mac-deploy.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
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
const observation = {
  fingerprint: settings.hostFingerprint,
  platform: 'linux',
  architecture: 'arm64',
  dockerArchitecture: 'aarch64',
  dockerOS: 'linux',
  service: 'active',
  cwd: settings.installationRoot,
  state: null,
};
it('requires the bound Pi, installed service directory and native ARM64 Docker before staging', () => {
  expect(validateTargetObservation(settings, observation)).toBeNull();
  for (const patch of [
    { fingerprint: '3'.repeat(64) },
    { architecture: 'x64' },
    { dockerOS: 'windows' },
    { cwd: '/wrong/data/root' },
    { service: 'inactive' },
    { state: { version: 1 } },
  ])
    expect(() => validateTargetObservation(settings, { ...observation, ...patch })).toThrow();
});
it('preflight never starts a service, reads credential files or selects a moving Git branch', () => {
  const command = targetPreflightCommand(settings);
  expect(command).toContain('ActiveState');
  expect(command).not.toMatch(/readFileSync\(s\.(runtime|migration)Environment/);
  expect(command).not.toMatch(/restart|git pull|docker build|docker load/);
});
it('allows a corrective build for a stopped target only with existing closed maintenance authority', () => {
  const state = {
    version: 1,
    binding: {
      hostFingerprint: settings.hostFingerprint,
      databaseFingerprint: settings.databaseFingerprint,
      service: settings.service,
      installationRoot: settings.installationRoot,
      dataRoot: settings.dataRoot,
    },
    lifecycle: 'implementation_disposable',
    generation: 3,
    maintenance: true,
    maintenanceId: '11111111-1111-4111-8111-111111111111',
    releaseId: 'release-failed',
  };
  expect(validateBuildTargetObservation(settings, { ...observation, service: 'inactive', state })).toEqual(state);
  for (const altered of [null, { ...state, maintenance: false }, { ...state, maintenanceId: null }])
    expect(() =>
      validateBuildTargetObservation(settings, { ...observation, service: 'inactive', state: altered }),
    ).toThrow();
});
it('reconciles the real source-bootstrap and deployment receipt formats without accepting another release', () => {
  const manifest = fixtureRelease();
  const source = {
    status: 'source_verified',
    releaseId: manifest.releaseId,
    commit: manifest.source.commit,
    tree: manifest.source.tree,
  };
  expect(() => validateDeliveryReceipt('source_verified', manifest, source)).not.toThrow();
  const healthy = {
    status: 'healthy',
    releaseId: manifest.releaseId,
    sourceCommit: manifest.source.commit,
    sourceTree: manifest.source.tree,
  };
  expect(() => validateDeliveryReceipt('healthy', manifest, healthy)).not.toThrow();
  for (const altered of [
    { ...healthy, releaseId: 'release-foreign' },
    { ...healthy, sourceCommit: '0'.repeat(40) },
    { ...healthy, status: 'failed' },
  ])
    expect(() => validateDeliveryReceipt('healthy', manifest, altered)).toThrow('target_receipt_mismatch');
});
