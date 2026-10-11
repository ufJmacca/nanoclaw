import { beforeEach, expect, it, vi } from 'vitest';
import { verifyResticBinary } from '../../modules/chief-of-staff/ops/restic-artifact.js';
import { selectedBackupFixtureEnvironment } from './backup-fixture-environment.js';

vi.mock('../../modules/chief-of-staff/ops/restic-artifact.js', () => ({ verifyResticBinary: vi.fn() }));
beforeEach(() => {
  vi.mocked(verifyResticBinary).mockReset();
});

it('admits only the explicitly verified public executable for G02', () => {
  expect(
    selectedBackupFixtureEnvironment('G02', {
      COS_BACKUP_FIXTURE_BINARY: '/backup-artifact/restic',
      COS_RUNTIME_PGPASSWORD: 'unselected-runtime',
      COS_BACKUP_PASSWORD: 'unselected-owner',
    }),
  ).toEqual({ COS_BACKUP_FIXTURE_BINARY: '/backup-artifact/restic' });
  expect(verifyResticBinary).toHaveBeenCalledExactlyOnceWith('/backup-artifact/restic');
});
it('requires an explicit executable without a source or runtime fallback', () => {
  expect(() => selectedBackupFixtureEnvironment('G02', {})).toThrow('backup_fixture_artifact_required');
  expect(verifyResticBinary).not.toHaveBeenCalled();
});
it('refuses an unverified executable before any fixture is started', () => {
  vi.mocked(verifyResticBinary).mockImplementation(() => {
    throw Error('backup_artifact_unverified');
  });
  expect(() => selectedBackupFixtureEnvironment('G02', { COS_BACKUP_FIXTURE_BINARY: '/unexpected/restic' })).toThrow(
    'backup_artifact_unverified',
  );
});
it.each(['S11', 'G01'])('does not forward a backup selector into the predecessor %s', (slice) => {
  expect(selectedBackupFixtureEnvironment(slice, { COS_BACKUP_FIXTURE_BINARY: '/backup-artifact/restic' })).toEqual({});
  expect(verifyResticBinary).not.toHaveBeenCalled();
});
