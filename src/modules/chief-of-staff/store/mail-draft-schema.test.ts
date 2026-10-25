import pg from 'pg';
import { expect, it, vi } from 'vitest';
import { migrate, MIGRATIONS, SCHEMA_VERSION } from './migrations.js';
import { MAIL_DRAFT_CHECKSUM } from './mail-draft-schema.js';
import { checkpointSchema } from '../ops/checkpoint-schema.js';
it('adds only writer policy bindings and immutable revisions without installing consent or letting runtime grant it', async () => {
  const query = vi.fn(async (sql: string) => {
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
    if (sql.startsWith('SELECT version,checksum'))
      return { rows: MIGRATIONS.slice(0, 19).map(({ version, checksum }) => ({ version, checksum })) };
    return { rows: [] };
  });
  expect(await migrate({ query } as unknown as pg.Client, 'fixture_runtime')).toBe(20);
  expect(SCHEMA_VERSION).toBe(20);
  expect(MIGRATIONS.at(-1)).toMatchObject({ version: 20, checksum: MAIL_DRAFT_CHECKSUM });
  const sql = query.mock.calls.map(([value]) => value).join('\n');
  expect(sql).toContain('CREATE TABLE cos.mail_draft_writer_bindings');
  expect(sql).toContain('CREATE TABLE cos.mail_draft_writer_revisions');
  expect(sql).toContain('GRANT SELECT ON cos.mail_draft_writer_bindings,cos.mail_draft_writer_revisions');
  expect(sql).toContain(
    'REVOKE INSERT,UPDATE,DELETE,TRUNCATE ON cos.mail_draft_writer_bindings,cos.mail_draft_writer_revisions',
  );
  expect(sql).not.toContain('INSERT INTO cos.mail_draft_writer_bindings');
  expect(sql).not.toMatch(/DROP TABLE|TRUNCATE TABLE|DELETE FROM cos\./);
});
it('keeps the reviewed schema19 history exact while registering a separate schema20 checkpoint epoch', () => {
  expect(checkpointSchema(19).digest).toBe('c8683aacc2b9d405060d9db7e7467f4b935f33bbab30abf4c86ac2bb58684276');
  expect(checkpointSchema(19).tables).toHaveLength(79);
  expect(checkpointSchema(20).tables).toHaveLength(81);
  expect(checkpointSchema(20).tables).toEqual(
    expect.arrayContaining(['mail_draft_writer_bindings', 'mail_draft_writer_revisions']),
  );
  expect(checkpointSchema(19).tables).not.toContain('mail_draft_writer_bindings');
});
