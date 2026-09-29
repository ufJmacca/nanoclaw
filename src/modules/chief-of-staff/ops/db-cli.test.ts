import { describe, expect, it } from 'vitest';
import { databaseCommand, parseDbArguments } from './db-cli.js';

describe('explicit CoS administration command boundary', () => {
  it.each(
    [
      [],
      ['reset'],
      ['check'],
      ['check', '--profile', 'unknown'],
      ['check', '--profile', 'test', '--profile', 'runtime'],
      ['migrate', '--profile', 'test', '--force'],
    ].map((args) => ({ args })),
  )('rejects missing, duplicate or unknown arguments $args', ({ args }) => {
    expect(() => parseDbArguments(args)).toThrow();
  });
  it('never borrows a runtime target when test is selected', async () => {
    await expect(databaseCommand(['check', '--profile', 'test'], { COS_PGHOST: '192.168.5.3' })).rejects.toThrow(
      'COS_TEST_PGHOST',
    );
  });
  it('requires the exact selected database before connecting for a migration', async () => {
    await expect(
      databaseCommand(['migrate', '--profile', 'test', '--confirm-database', 'foreign'], {
        COS_TEST_PGDATABASE: 'fixture',
      }),
    ).rejects.toThrow('database_confirmation_mismatch');
  });
});
