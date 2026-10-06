import type Database from 'better-sqlite3';
import type { ReleaseManifest } from './release-manifest.js';
const specialistTables = [
  'cos_mission_boundaries',
  'cos_mission_allocations',
  'cos_mission_stop_attempts',
  'cos_mission_stop_families',
] as const;
/** Candidate manifests are verified by the release path. Never erase identity records to make old code compatible. */
export function assertNativeReleaseCompatibility(db: Database.Database, candidate: ReleaseManifest | null): void {
  if (candidate && ['S05', 'S06', 'S07', 'S08', 'S09', 'S10'].includes(candidate.slice)) return;
  for (const name of specialistTables) {
    const entry = db.prepare('SELECT type FROM sqlite_master WHERE name=?').get(name) as { type: string } | undefined;
    if (entry && (entry.type !== 'table' || db.prepare(`SELECT 1 FROM ${name} LIMIT 1`).get()))
      throw new Error('specialist_release_required');
  }
}
