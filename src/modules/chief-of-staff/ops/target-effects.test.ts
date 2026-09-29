import { expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ service: vi.fn(), docker: vi.fn(), database: vi.fn() }));
vi.mock('./target-host.js', async () => ({
  ...(await vi.importActual('./target-host.js')),
  targetCommands: () => ({ ...calls }),
  checkedTargetDatabase: calls.database,
}));
import { createTargetEffects } from './target-effects.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
it('cannot stop, migrate, activate or roll back without the current Pi-owned maintenance lease', async () => {
  const settings = {
    stateRoot: '/tmp/nonexistent-cos-target-fixture',
    releaseRoot: '/tmp/cos-release-fixture',
    stagingRoot: '/tmp/cos-staging-fixture',
    sourceRoot: '/tmp/cos-source-fixture',
    userHome: '/tmp',
    installationRoot: '/tmp/cos-install-fixture',
    dataRoot: '/tmp/cos-install-fixture/data',
    service: 'nano.service',
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
  } as DeploymentSettings;
  const effects = createTargetEffects(settings, fixtureRelease(), '3'.repeat(64));
  for (const action of [
    () => effects.quiesce(),
    () => effects.backup(),
    () => effects.migrate(),
    () => effects.activate(),
    () => effects.rollback(null),
  ])
    await expect(action()).rejects.toThrow();
  expect(calls.service).not.toHaveBeenCalled();
  expect(calls.docker).not.toHaveBeenCalled();
  expect(calls.database).not.toHaveBeenCalled();
});
