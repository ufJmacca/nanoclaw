import type pg from 'pg';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';

export function createNativeFixtureDatabase(
  pool: pg.Pool,
  input: { mission?: unknown; strategy?: true; mailDrafts?: { review?: unknown } },
) {
  // Complex native conversations need room for real Docker and evidence checks.
  // Ordinary outage fixtures retain their short deadline; production is unchanged.
  return new BoundedDatabase(pool, input.mission || input.strategy === true || input.mailDrafts?.review ? 3000 : 600);
}
