import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { assertNativeReleaseCompatibility } from './native-release-compatibility.js';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { validateReleaseManifest } from './release-manifest.js';
import { fenceLegacyCoordinators } from './legacy-rollback.js';
it.each([
  'cos_mission_boundaries',
  'cos_mission_allocations',
  'cos_mission_stop_attempts',
  'cos_mission_stop_families',
])('S05 refuses older and legacy code when %s retains any permanent specialist state', (table) => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${table}(opaque TEXT)`);
    expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S04'))).not.toThrow();
    db.prepare(`INSERT INTO ${table} VALUES(?)`).run('malformed metadata must still deny downgrade');
    const before = db.serialize();
    for (const manifest of [null, fixtureRelease('S01'), fixtureRelease('S04')])
      expect(() => assertNativeReleaseCompatibility(db, manifest)).toThrow('specialist_release_required');
    expect(() => fenceLegacyCoordinators(db)).toThrow('specialist_release_required');
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});

it('S08 preserves permanent specialist identities when its verified release is selected', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE cos_mission_boundaries(opaque TEXT); INSERT INTO cos_mission_boundaries VALUES('retained')");
    const before = db.serialize();
    const candidate = validateReleaseManifest(fixtureRelease('S08'));
    expect(() => assertNativeReleaseCompatibility(db, candidate)).not.toThrow();
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
it.each(['S05', 'S06'] as const)(
  '%s compatible code preserves specialist state while malformed catalog objects deny old code',
  (slice) => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE cos_mission_boundaries(opaque TEXT); INSERT INTO cos_mission_boundaries VALUES('retained')",
      );
      expect(() => assertNativeReleaseCompatibility(db, fixtureRelease(slice))).not.toThrow();
      db.exec('DROP TABLE cos_mission_boundaries; CREATE VIEW cos_mission_boundaries AS SELECT 1');
      expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S04'))).toThrow('specialist_release_required');
    } finally {
      db.close();
    }
  },
);

it.each([
  'cos_mission_boundaries',
  'cos_mission_allocations',
  'cos_mission_stop_attempts',
  'cos_mission_stop_families',
])('S07 preserves retained %s and still denies older code', (table) => {
  const db = new Database(':memory:');
  try {
    db.exec(`CREATE TABLE ${table}(opaque TEXT); INSERT INTO ${table} VALUES('retained')`);
    const before = db.serialize();
    expect(() => assertNativeReleaseCompatibility(db, { ...fixtureRelease('S06'), slice: 'S07' })).not.toThrow();
    expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S04'))).toThrow('specialist_release_required');
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
