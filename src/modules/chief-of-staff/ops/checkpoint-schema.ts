import { digest } from '../domain/contracts.js';
import { MIGRATIONS, SCHEMA_VERSION } from '../store/migrations.js';

/** Reviewed checkpoint epochs. Reading a predecessor never admits its software,
 * permissions or schema to the current runtime. Writers select an epoch explicitly
 * and must prove that the database still has that exact migration history. */
export function checkpointSchema(version: number) {
  if (![18, 19].includes(version) || version > SCHEMA_VERSION) throw Error('checkpoint_schema_incompatible');
  const migrations = MIGRATIONS.filter((migration) => migration.version <= version);
  if (migrations.length !== version) throw Error('checkpoint_schema_incompatible');
  return {
    version,
    digest: digest(migrations.map(({ version, checksum }) => ({ version, checksum }))),
    tables: [
      ...new Set(
        migrations.flatMap((migration) =>
          [...migration.sql.matchAll(/CREATE TABLE cos\.([a-z_]+)\s*\(/g)].map((match) => match[1]),
        ),
      ),
    ].sort(),
  };
}
