import { expect, it } from 'vitest';
import { fixtureVaultRelease } from './release-fixture.js';
import {
  validateReleaseManifest,
  requiredReleaseChecks,
  supportsReleaseSchema,
} from '../../modules/chief-of-staff/ops/release-manifest.js';
it('builds synthetic G06 admin metadata with schema21 and all32 bound gates while preserving historical G05 compatibility', () => {
  const manifest = validateReleaseManifest(fixtureVaultRelease('G06'));
  expect(manifest.slice).toBe('G06');
  expect(manifest.migrations).toHaveLength(21);
  expect(requiredReleaseChecks(manifest.slice)).toHaveLength(32);
  expect(supportsReleaseSchema(manifest, 21, 22)).toBe(true);
  expect(supportsReleaseSchema(validateReleaseManifest(fixtureVaultRelease('G05')), 21, 22)).toBe(false);
  expect(manifest.previousReleaseIds).toEqual(['release-reviewed-g05']);
});
