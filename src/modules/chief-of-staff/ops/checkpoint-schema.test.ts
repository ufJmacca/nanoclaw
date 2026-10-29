import { expect, it } from 'vitest';
import { checkpointSchema } from './checkpoint-schema.js';
import { MIGRATIONS } from '../store/migrations.js';
import { digest } from '../domain/contracts.js';

it('G06 checkpoints include both owner review policy tables and the complete schema-21 history', () => {
  const current = checkpointSchema(21),
    previous = checkpointSchema(20);
  expect(current.version).toBe(21);
  expect(current.digest).toBe(
    digest(MIGRATIONS.filter((m) => m.version <= 21).map(({ version, checksum }) => ({ version, checksum }))),
  );
  expect(current.tables.filter((table) => !previous.tables.includes(table))).toEqual([
    'mail_review_policies',
    'mail_review_policy_revisions',
  ]);
  expect(previous.tables.every((table) => current.tables.includes(table))).toBe(true);
  expect(previous.tables).not.toContain('mail_review_policies');
});
it.each([18, 19, 20])('keeps predecessor epoch %i distinct without relabeling its schema', (version) => {
  const epoch = checkpointSchema(version);
  expect(epoch.digest).toBe(
    digest(MIGRATIONS.filter((m) => m.version <= version).map(({ version, checksum }) => ({ version, checksum }))),
  );
  expect(epoch.tables).not.toContain('mail_review_policies');
});
it.each([17, 22, 99, 20.5, NaN])('refuses unsupported checkpoint epoch %s', (version) => {
  expect(() => checkpointSchema(version)).toThrow('checkpoint_schema_incompatible');
});
