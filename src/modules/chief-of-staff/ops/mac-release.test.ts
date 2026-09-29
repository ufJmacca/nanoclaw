import { expect, it } from 'vitest';
import { completeLocalRelease, selectTestEnvironment } from './mac-release.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';

it('cannot produce a transferable manifest from failed, missing or differently built checks', () => {
  const manifest = fixtureRelease();
  expect(completeLocalRelease(manifest, manifest.checks)).toEqual(manifest);
  const failed = structuredClone(manifest.checks);
  failed.slice.status = 'failed';
  expect(() => completeLocalRelease(manifest, failed)).toThrow('release_not_transferable');
  const stale = structuredClone(manifest.checks);
  stale.host_image.sourceCommit = '9'.repeat(40);
  expect(() => completeLocalRelease(manifest, stale)).toThrow('release_not_transferable');
  const rebuilt = structuredClone(manifest.checks);
  rebuilt.agent_image.imageIds[0] = 'sha256:' + '9'.repeat(64);
  expect(() => completeLocalRelease(manifest, rebuilt)).toThrow('release_not_transferable');
  expect(() => completeLocalRelease(manifest, {})).toThrow('release_not_transferable');
});

it('exports only the explicitly selected test profile and refuses unsafe env-file values', () => {
  const input = {
    COS_TEST_PGHOST: 'db.example.test',
    COS_TEST_PGPORT: '5432',
    COS_TEST_PGDATABASE: 'fixture',
    COS_TEST_PGUSER: 'fixture_user',
    COS_TEST_PGPASSWORD: 'fixture-pass$with`literal`quotes',
    COS_TEST_PGSSLMODE: 'verify-full',
    COS_TEST_PGSSLROOTCERT: '/private/local/ca.pem',
    COS_TEST_PG_MIGRATION_USER: 'fixture_migration',
    COS_TEST_PG_MIGRATION_PASSWORD: 'fixture-admin',
    COS_TEST_TARGET_ID: 'fixture-marker',
    COS_TEST_PGUNRECOGNIZED: 'must-not-export',
    COS_PGPASSWORD: 'runtime-must-not-export',
    MATTERMOST_TOKEN: 'bot-must-not-export',
    OPENAI_API_KEY: 'model-must-not-export',
  };
  const selected = selectTestEnvironment(input, '/fixture/certificate.pem');
  expect(Object.keys(selected).sort()).toEqual(
    Object.keys(input)
      .filter(
        (key) => !['COS_TEST_PGUNRECOGNIZED', 'COS_PGPASSWORD', 'MATTERMOST_TOKEN', 'OPENAI_API_KEY'].includes(key),
      )
      .sort(),
  );
  expect(selected.COS_TEST_PGSSLROOTCERT).toBe('/fixture/certificate.pem');
  expect(selected.COS_TEST_PGPASSWORD).toBe(input.COS_TEST_PGPASSWORD);
  expect(() =>
    selectTestEnvironment({ ...input, COS_TEST_PGPASSWORD: 'line\nbreak' }, '/fixture/certificate.pem'),
  ).toThrow('unsafe_test_environment');
  expect(() => selectTestEnvironment({}, '/fixture/certificate.pem')).toThrow('test_profile_incomplete');
});
