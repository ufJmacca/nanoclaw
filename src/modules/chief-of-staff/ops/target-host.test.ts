import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  readTargetDatabaseEnvironment,
  readTargetTestEnvironment,
  serviceObservation,
  verifyInstalledProfiles,
} from './target-host.js';
import Database from 'better-sqlite3';
import { imageProfile } from '../../../release-runtime.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('separate restore credentials reject a mixed runtime/foreign profile and unsafe file permissions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-test-env-'));
  roots.push(root);
  const file = path.join(root, 'test.env');
  fs.writeFileSync(
    file,
    'COS_TEST_PGUSER=fixture-test\nCOS_TEST_PGPASSWORD=fixture-secret\nCOS_TEST_TARGET_ID=fixture-protected\n',
    { mode: 0o600 },
  );
  expect(Object.keys(readTargetTestEnvironment(file)).sort()).toEqual([
    'COS_TEST_PGPASSWORD',
    'COS_TEST_PGUSER',
    'COS_TEST_TARGET_ID',
  ]);
  fs.appendFileSync(file, 'COS_PGPASSWORD=fixture-runtime\n');
  expect(() => readTargetTestEnvironment(file)).toThrow('unsafe_target_credentials');
  fs.writeFileSync(file, 'COS_TEST_PGPASSWORD=fixture-test\n');
  fs.chmodSync(file, 0o644);
  expect(() => readTargetTestEnvironment(file)).toThrow('unsafe_target_credentials');
});
it('selects only Pi-owned runtime fields and adds migration credentials only for the migration process', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-env-'));
  roots.push(root);
  const runtimeEnvironment = path.join(root, 'runtime.env'),
    migrationEnvironment = path.join(root, 'migration.env');
  fs.writeFileSync(
    runtimeEnvironment,
    'COS_PGHOST=192.168.1.2\nCOS_PGUSER=runtime\nCOS_PGPASSWORD="synthetic runtime"\n',
    { mode: 0o600 },
  );
  fs.writeFileSync(
    migrationEnvironment,
    'COS_PGHOST=192.168.1.2\nCOS_PG_MIGRATION_USER=migration\nCOS_PG_MIGRATION_PASSWORD="synthetic migration"\n',
    { mode: 0o600 },
  );
  const settings = { runtimeEnvironment, migrationEnvironment };
  expect(readTargetDatabaseEnvironment(settings, 'runtime')).toEqual({
    COS_PGHOST: '192.168.1.2',
    COS_PGUSER: 'runtime',
    COS_PGPASSWORD: 'synthetic runtime',
  });
  expect(readTargetDatabaseEnvironment(settings, 'migration')).toMatchObject({
    COS_PGUSER: 'runtime',
    COS_PG_MIGRATION_USER: 'migration',
  });
  fs.appendFileSync(runtimeEnvironment, 'OPENAI_API_KEY=foreign\n');
  expect(() => readTargetDatabaseEnvironment(settings, 'runtime')).toThrow('unsafe_target_credentials');
  fs.writeFileSync(runtimeEnvironment, 'COS_PGHOST=192.168.1.3\n');
  expect(() => readTargetDatabaseEnvironment(settings, 'migration')).toThrow('target_credential_profile_mismatch');
  fs.chmodSync(runtimeEnvironment, 0o644);
  expect(() => readTargetDatabaseEnvironment(settings, 'runtime')).toThrow('unsafe_target_credentials');
});
it('rejects partial, conflicting or malformed service observations', () => {
  expect(
    serviceObservation('ActiveState=active\nSubState=running\nMainPID=123\nWorkingDirectory=/home/pi/nano\n'),
  ).toEqual({ activeState: 'active', subState: 'running', pid: 123, cwd: '/home/pi/nano' });
  for (const text of [
    'ActiveState=active\n',
    'MainPID=1\nMainPID=2\n',
    'ActiveState=active\nSubState=running\nMainPID=-1\nWorkingDirectory=/x\n',
  ])
    expect(() => serviceObservation(text)).toThrow('invalid_service_observation');
});

it('requires the packaged dependencies and provider used by every existing active session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-profiles-'));
  roots.push(root);
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  const db = new Database(path.join(dataRoot, 'v2.db'));
  db.exec(
    "CREATE TABLE agent_groups(id,folder,agent_provider); CREATE TABLE sessions(agent_group_id,agent_provider,status); INSERT INTO agent_groups VALUES('group','documents','codex'); INSERT INTO sessions VALUES('group','claude','active')",
  );
  db.close();
  fs.mkdirSync(path.join(root, 'groups/documents'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'groups/documents/container.json'),
    JSON.stringify({ packages: { apt: ['python3'], npm: [] } }),
  );
  const settings = { installationRoot: root, dataRoot } as DeploymentSettings;
  const manifest = fixtureRelease();
  manifest.images[1].profile = imageProfile('codex', { apt: ['python3'], npm: [] });
  expect(() => verifyInstalledProfiles(settings, manifest)).toThrow('installed_profile_unavailable');
  manifest.images.push({ ...manifest.images[1], profile: imageProfile('claude', { apt: ['python3'], npm: [] }) });
  expect(() => verifyInstalledProfiles(settings, manifest)).not.toThrow();
  fs.writeFileSync(path.join(root, 'groups/documents/container.json'), '{corrupt');
  expect(() => verifyInstalledProfiles(settings, manifest)).toThrow();
});
