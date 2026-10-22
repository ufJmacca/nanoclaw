import { expect, it } from 'vitest';
import { parseOwnerAdminArguments, selectedOwnerAdminProfile, ownerDatabasePreflight } from './target-owner-admin.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { DatabasePreflightError } from '../store/preflight.js';
const request = ['owner-export', '--scope', 'fixture', '--request-id', '01234567-89ab-4def-8123-456789abcdef'];
it.each(['mail-setup', 'mail-link', 'mail-draft-setup', 'mail-draft-link'])(
  'admits %s only through the scoped retained helper, with selected runtime settings and no secret arguments',
  async (command) => {
    const admin = [
      command,
      '--scope',
      'fixture',
      '--request-id',
      '01234567-89ab-4def-8123-456789abcdef',
      ...(command === 'mail-draft-link'
        ? [
            '--reader-binding',
            '48f99256-b105-4ee3-848c-00140c98151d',
            '--writer-binding',
            '01234567-89ab-4def-8123-456789abcdea',
            '--manifest',
            '/private/selection.json',
          ]
        : command === 'mail-link'
          ? ['--binding', '48f99256-b105-4ee3-848c-00140c98151d', '--manifest', '/private/selection.json']
          : []),
    ];
    expect(parseOwnerAdminArguments(['--settings', '/private/settings.json', '--', ...admin])).toMatchObject({ admin });
    expect(() =>
      parseOwnerAdminArguments([
        '--settings',
        '/private/settings.json',
        '--database-environment',
        '/private/test.env',
        '--',
        ...admin,
      ]),
    ).toThrow();
    expect(() =>
      parseOwnerAdminArguments(['--settings', '/private/settings.json', '--', ...admin, '--token', 'PRIVATE']),
    ).toThrow();
    const env = { COS_PG_TARGET_ID: 'selected-runtime' };
    await expect(
      selectedOwnerAdminProfile(command, {
        runtime: () => env,
        test: () => {
          throw Error('test_not_selected');
        },
      }),
    ).resolves.toBe(env);
  },
);
it('admits isolated complete credential recovery with no database profile or arbitrary destination', async () => {
  const admin = [
    'backup-credentials-restore-check',
    '--scope',
    'fixture',
    '--request-id',
    '01234567-89ab-4def-8123-456789abcdef',
    '--capture-operation-id',
    '48f99256-b105-4ee3-848c-00140c98151d',
  ];
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...admin])).toMatchObject({ admin });
  for (const changed of [
    admin.slice(0, -2),
    [...admin, '--root', '/foreign'],
    [...admin, '--backup-release', 'release-old'],
    admin.map((value) => (value === admin[6] ? '../foreign' : value)),
  ])
    expect(() => parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...changed])).toThrow(
      'invalid_owner_admin_arguments',
    );
  expect(() =>
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/runtime.env',
      '--',
      ...admin,
    ]),
  ).toThrow('invalid_owner_admin_arguments');
  await expect(
    selectedOwnerAdminProfile(admin[0], {
      runtime() {
        throw Error('runtime_profile_forbidden');
      },
      test() {
        throw Error('test_profile_forbidden');
      },
    }),
  ).resolves.toEqual({});
});
it('admits complete encrypted recovery only with its explicit separate test environment', async () => {
  const admin = [
    'backup-restore-check',
    '--scope',
    'fixture',
    '--request-id',
    '01234567-89ab-4def-8123-456789abcdef',
    '--backup-operation-id',
    '48f99256-b105-4ee3-848c-00140c98151d',
    '--backup-release',
    'release-fixture',
    '--snapshot-digest',
    'a'.repeat(64),
  ];
  expect(
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/test.env',
      '--',
      ...admin,
    ]),
  ).toMatchObject({ admin, databaseEnvironment: '/home/pi/test.env' });
  expect(() => parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...admin])).toThrow();
  const test = { COS_TEST_TARGET_ID: 'fixture-test' };
  await expect(
    selectedOwnerAdminProfile('backup-restore-check', {
      runtime: () => {
        throw Error('runtime_must_not_be_forwarded');
      },
      test: () => test,
    }),
  ).resolves.toBe(test);
});
it.each([
  'backup-nas-configure',
  'backup-nas-recover-unmount',
  'backup-nas-inspect-initialization',
  'backup-nas-recover-initialization',
])('admits %s through the retained helper with only the selected runtime profile', async (command) => {
  const admin = [
    command,
    '--scope',
    'fixture',
    '--request-id',
    '48f99256-b105-4ee3-848c-00140c98151d',
    '--host',
    '192.168.56.12',
    '--credential-reference',
    '319c6740-24ba-4d68-9d3c-a4d53c9607d1',
  ];
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...admin])).toMatchObject({ admin });
  const runtime = { MATTERMOST_BOT_TOKEN: 'fixture-runtime' };
  await expect(
    selectedOwnerAdminProfile(admin[0], {
      runtime: () => runtime,
      test: () => {
        throw Error('test_profile_forbidden');
      },
    }),
  ).resolves.toBe(runtime);
});
it('admits credential installation only through the retained owner helper and selected runtime profile', async () => {
  const admin = [
    'backup-credentials-install',
    '--scope',
    'fixture',
    '--request-id',
    '48f99256-b105-4ee3-848c-00140c98151d',
    '--credential-reference',
    '319c6740-24ba-4d68-9d3c-a4d53c9607d1',
  ];
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...admin])).toMatchObject({ admin });
  const profile = { MATTERMOST_BOT_TOKEN: 'fixture-runtime' };
  await expect(
    selectedOwnerAdminProfile(admin[0], {
      runtime: () => profile,
      test: () => {
        throw Error('test profile must not be read');
      },
    }),
  ).resolves.toBe(profile);
  expect(() =>
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/foreign.env',
      '--',
      ...admin,
    ]),
  ).toThrow('invalid_owner_admin_arguments');
});
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
  expect(
    parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', 'vault-install', '--scope', 'fixture']),
  ).toMatchObject({ admin: ['vault-install', '--scope', 'fixture'] });
  expect(
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--',
      'vault-recovery-check',
      '--scope',
      'fixture',
    ]),
  ).toMatchObject({ admin: ['vault-recovery-check', '--scope', 'fixture'] });
  const runtime = { COS_PG_USER: 'owner-runtime-profile' };
  expect(
    await selectedOwnerAdminProfile('vault-provision', {
      runtime: () => runtime,
      test: () => {
        throw Error('test_profile_must_not_be_read');
      },
    }),
  ).toBe(runtime);
  expect(
    await selectedOwnerAdminProfile('vault-recovery-check', {
      runtime: () => runtime,
      test: () => {
        throw Error('test_profile_must_not_be_read');
      },
    }),
  ).toBe(runtime);
});

it('G02 admits the fixed encrypted checkpoint through the retained helper with only its runtime profile', async () => {
  const admin = [
    'backup-checkpoint',
    '--scope',
    'fixture',
    '--request-id',
    '48f99256-b105-4ee3-848c-00140c98151d',
    '--settings',
    '/home/pi/target.json',
  ];
  expect(parseOwnerAdminArguments(['--settings', '/home/pi/target.json', '--', ...admin])).toMatchObject({ admin });
  const runtime = { COS_PGPASSWORD: 'synthetic-runtime' };
  await expect(
    selectedOwnerAdminProfile('backup-checkpoint', {
      runtime: () => runtime,
      test: () => {
        throw Error('test_profile_forbidden');
      },
    }),
  ).resolves.toBe(runtime);
  expect(() =>
    parseOwnerAdminArguments([
      '--settings',
      '/home/pi/target.json',
      '--database-environment',
      '/home/pi/test.env',
      '--',
      ...admin,
    ]),
  ).toThrow('invalid_owner_admin_arguments');
});
