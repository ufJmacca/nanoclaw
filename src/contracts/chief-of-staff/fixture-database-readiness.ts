import { setTimeout as delay } from 'node:timers/promises';
import type { PoolConfig } from 'pg';
import { DatabaseUnavailable, BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';

/** Complete read-only setup before a fixture installs faults or invokes domain behavior. */
export async function createFixtureDatabase(config: PoolConfig): Promise<BoundedDatabase> {
  const database = BoundedDatabase.fromConfig(config);
  try {
    await readyFixtureDatabase(database);
    return database;
  } catch (error) {
    await database.pool.end().catch(() => undefined);
    throw error;
  }
}

/** Keep the selected pool and connection policy for direct SQL or custom deadline fixtures. */
export async function createFixturePool(config: PoolConfig) {
  return (await createFixtureDatabase(config)).pool;
}

/** Establish the existing selected pool before fixture behavior or mutations. */
export async function readyFixtureDatabase(database: Pick<BoundedDatabase, 'run'>): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await database.run((client) => client.query('SELECT 1 AS fixture_ready'), false);
      if (result.rows.length !== 1 || result.rows[0].fixture_ready !== 1)
        throw new Error('fixture_database_readiness_unverified');
      return;
    } catch (error) {
      if (attempt !== 0 || !(error instanceof DatabaseUnavailable) || error.code !== 'unavailable') throw error;
      // Honor the existing pool's one-second cooldown. Never retry fixture mutations.
      await delay(1000);
    }
  }
}
