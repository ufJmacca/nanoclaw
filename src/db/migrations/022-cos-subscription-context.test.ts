import { expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from './index.js';
it('upgrades existing native state additively and preserves charged model usage across retries', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    db.exec(
      "DROP TABLE IF EXISTS cos_model_attempts; DROP TABLE IF EXISTS cos_conversation_states; DELETE FROM schema_version WHERE name='cos-subscription-context';",
    );
    const previous = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
    db.prepare('INSERT INTO cos_model_budgets(activation_id,policy_digest,used) VALUES(?,?,?)').run(
      'retained',
      'digest',
      7,
    );
    runMigrations(db);
    runMigrations(db);
    expect(db.prepare("SELECT count(*) AS n FROM schema_version WHERE name='cos-subscription-context'").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT used FROM cos_model_budgets WHERE activation_id='retained'").get()).toEqual({ used: 7 });
    expect(
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE name IN ('cos_conversation_states','cos_model_attempts') ORDER BY name",
        )
        .all(),
    ).toHaveLength(2);
    expect(db.prepare('SELECT MAX(version) AS v FROM schema_version').get()).toEqual({ v: previous.v + 1 });
  } finally {
    db.close();
  }
});
