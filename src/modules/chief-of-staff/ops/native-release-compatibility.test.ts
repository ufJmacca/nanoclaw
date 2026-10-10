import Database from 'better-sqlite3';
import { expect, it } from 'vitest';
import { assertNativeReleaseCompatibility } from './native-release-compatibility.js';
import { fixtureRelease, fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { validateReleaseManifest } from './release-manifest.js';
import { fenceLegacyCoordinators } from './legacy-rollback.js';

it.each([
  'cos_operator_denials',
  'cos_mission_boundaries',
  'cos_mission_allocations',
  'cos_mission_stop_attempts',
  'cos_mission_stop_families',
])('verified G01 preserves permanent S11 %s without admitting a legacy downgrade', (table) => {
  const db = new Database(':memory:');
  try {
    db.exec(
      `CREATE TABLE ${table}(opaque TEXT); INSERT INTO ${table} VALUES('retained'); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('KEEP')`,
    );
    const before = db.serialize();
    const candidate = validateReleaseManifest(fixtureVaultRelease());
    expect(() => assertNativeReleaseCompatibility(db, candidate)).not.toThrow();
    const denial =
      table === 'cos_operator_denials' ? 'operator_denial_release_required' : 'specialist_release_required';
    expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S04'))).toThrow(denial);
    expect(() => fenceLegacyCoordinators(db)).toThrow(denial);
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});

it.each([null, 'S01', 'S05', 'S09', 'S10'] as const)(
  'retained owner denials forbid downgrade to %s without changing native state',
  (slice) => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE cos_operator_denials(opaque TEXT); INSERT INTO cos_operator_denials VALUES('reconciled revocation'); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('KEEP')",
      );
      const before = db.serialize();
      expect(() => assertNativeReleaseCompatibility(db, slice ? fixtureRelease(slice) : null)).toThrow(
        'operator_denial_release_required',
      );
      expect(() => fenceLegacyCoordinators(db)).toThrow('operator_denial_release_required');
      expect(() => assertNativeReleaseCompatibility(db, validateReleaseManifest(fixtureRelease('S11')))).not.toThrow();
      expect(db.serialize()).toEqual(before);
    } finally {
      db.close();
    }
  },
);

it('an empty owner-denial journal permits S10 but a malformed catalog object denies downgrade', () => {
  const db = new Database(':memory:');
  try {
    db.exec('CREATE TABLE cos_operator_denials(opaque TEXT)');
    expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S10'))).not.toThrow();
    db.exec('DROP TABLE cos_operator_denials; CREATE VIEW cos_operator_denials AS SELECT 1 WHERE 0');
    const before = db.serialize();
    expect(() => assertNativeReleaseCompatibility(db, fixtureRelease('S10'))).toThrow(
      'operator_denial_release_required',
    );
    expect(db.serialize()).toEqual(before);
  } finally {
    db.close();
  }
});
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

it.each(['S08', 'S09', 'S10', 'S11'] as const)(
  '%s preserves permanent specialist identities when its verified release is selected',
  (slice) => {
    const db = new Database(':memory:');
    try {
      db.exec(
        "CREATE TABLE cos_mission_boundaries(opaque TEXT); INSERT INTO cos_mission_boundaries VALUES('retained')",
      );
      const before = db.serialize();
      const candidate = validateReleaseManifest(fixtureRelease(slice));
      expect(() => assertNativeReleaseCompatibility(db, candidate)).not.toThrow();
      expect(db.serialize()).toEqual(before);
    } finally {
      db.close();
    }
  },
);
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
