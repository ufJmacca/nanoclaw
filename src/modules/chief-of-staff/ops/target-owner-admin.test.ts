import { expect, it } from 'vitest';
import { parseOwnerAdminArguments, selectedOwnerAdminProfile, ownerDatabasePreflight } from './target-owner-admin.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { DatabasePreflightError } from '../store/preflight.js';
const request = ['owner-export', '--scope', 'fixture', '--request-id', '01234567-89ab-4def-8123-456789abcdef'];
it('G01 installed vault health uses no database or external account credentials', async () => {
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'vault-status'])).toMatchObject({
    admin: ['vault-status'],
  });
  expect(() =>
    parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'vault-status', '--root', '/private']),
  ).toThrow();
  await expect(
    selectedOwnerAdminProfile('vault-status', {
      runtime: () => {
        throw Error('runtime must not be read');
      },
      test: () => {
        throw Error('test must not be read');
      },
    }),
  ).resolves.toEqual({});
});
it('installed owner tooling accepts only existing inspection, deny, export and recovery commands with the selected profile', async () => {
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'database-check'])).toMatchObject({
    admin: ['database-check'],
  });
  expect(() =>
    parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'database-check', '--profile', 'test']),
  ).toThrow();
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...request])).toEqual({
    settings: '/home/pi/target.json',
    databaseEnvironment: undefined,
    admin: request,
  });
  await expect(
    selectedOwnerAdminProfile('owner-export', {
      runtime: () => ({ COS_PGPASSWORD: 'fixture-runtime' }),
      test: () => {
        throw Error('test must not be read');
      },
    }),
  ).resolves.toEqual({ COS_PGPASSWORD: 'fixture-runtime' });
  await expect(
    selectedOwnerAdminProfile('operations-restore-check', {
      runtime: () => {
        throw Error('runtime must not be read');
      },
      test: () => ({ COS_TEST_PGPASSWORD: 'fixture-test' }),
    }),
  ).resolves.toEqual({ COS_TEST_PGPASSWORD: 'fixture-test' });
  await expect(
    selectedOwnerAdminProfile('operator-control', {
      runtime: () => {
        throw Error('runtime must not be read');
      },
      test: () => {
        throw Error('test must not be read');
      },
    }),
  ).resolves.toEqual({});
  for (const command of [
    'model-activate',
    'context-resume',
    'action-link',
    'action-configure',
    'bind',
    'source-import',
  ])
    expect(() => parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', command])).toThrow(
      'invalid_owner_admin_arguments',
    );
  expect(() => parseOwnerAdminArguments(['--settings', 'relative', '--', ...request])).toThrow();
  expect(() =>
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/test.env',
      '--',
      ...request,
    ]),
  ).toThrow();
  const restore = [
    'operations-restore-check',
    '--scope',
    'fixture',
    '--request-id',
    '01234567-89ab-4def-8123-456789abcdef',
    '--backup-release',
    'release-fixture',
    '--settings',
    '/home/pi/target.json',
  ];
  expect(() => parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...restore])).toThrow();
  expect(
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/test.env',
      '--',
      ...restore,
    ]),
  ).toMatchObject({ databaseEnvironment: '/home/pi/test.env', admin: restore });
});
it('owner preflight classifies current schema and dependency failures without private diagnostics or execution consent', async () => {
  const manifest = fixtureRelease('S11');
  await expect(ownerDatabasePreflight(manifest, async () => 18)).resolves.toMatchObject({
    status: 'ready',
    schema_version: 18,
    model_activation: 'not_verified',
  });
  await expect(ownerDatabasePreflight(manifest, async () => 19)).resolves.toMatchObject({
    status: 'schema_incompatible',
  });
  for (const error of [
    new DatabasePreflightError('tls_rejected'),
    new DatabasePreflightError('authentication_denied'),
    new Error('PRIVATE_CANARY'),
  ]) {
    const result = await ownerDatabasePreflight(manifest, async () => {
      throw error;
    });
    expect(result.status).toBe('unavailable');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_CANARY');
  }
});
it('admits vault provisioning through the pinned owner helper with the selected runtime profile', async () => {
  expect(
    parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'vault-provision', '--scope', 'fixture']),
  ).toMatchObject({ admin: ['vault-provision', '--scope', 'fixture'] });
  const runtime = { COS_PG_USER: 'owner-runtime-profile' };
  expect(
    await selectedOwnerAdminProfile('vault-provision', {
      runtime: () => runtime,
      test: () => {
        throw Error('test_profile_must_not_be_read');
      },
    }),
  ).toBe(runtime);
});
