import { describe, expect, it } from 'vitest';
import { parseDatabaseConfig, runtimeDatabaseConfig } from './config.js';
import pg from 'pg';

const fixture = {
  COS_PGHOST: '192.168.20.40',
  COS_PGDATABASE: 'cos_fixture',
  COS_PGUSER: 'cos_runtime',
  COS_PGPASSWORD: '  opaque ! password  ',
};

describe('S01-PG01 explicit database configuration', () => {
  it('S01-T01 disabled runtime does not need a database', () => {
    expect(runtimeDatabaseConfig({})).toBeNull();
    expect(runtimeDatabaseConfig({ COS_ENABLED: 'false', COS_PGHOST: 'invalid' })).toBeNull();
  });

  it('enabled runtime rejects absent explicit values instead of ambient defaults', () => {
    expect(() => runtimeDatabaseConfig({ COS_ENABLED: 'true', PGHOST: '192.168.1.2', DATABASE_URL: 'secret' })).toThrow(
      'COS_PGHOST',
    );
  });

  it('preserves opaque passwords and enables chain and hostname verification', () => {
    expect(parseDatabaseConfig(fixture, 'runtime')).toMatchObject({
      host: fixture.COS_PGHOST,
      database: fixture.COS_PGDATABASE,
      user: fixture.COS_PGUSER,
      password: fixture.COS_PGPASSWORD,
      port: 5432,
      ssl: { rejectUnauthorized: true },
      max: 5,
      connectionTimeoutMillis: 3000,
      statement_timeout: 5000,
      query_timeout: 7000,
      lock_timeout: 2000,
      idleTimeoutMillis: 30000,
      idle_in_transaction_session_timeout: 10000,
    });
  });

  it('S01-PG03 binds TLS name verification to a configured IP as well as DNS', () => {
    expect(parseDatabaseConfig(fixture, 'runtime').ssl).toMatchObject({ host: fixture.COS_PGHOST });
  });

  it('does not inherit ambient PGOPTIONS from the host', () => {
    const previous = process.env.PGOPTIONS;
    process.env.PGOPTIONS = '-c search_path=foreign';
    try {
      const client = new pg.Client(parseDatabaseConfig(fixture, 'runtime'));
      expect(
        (client as unknown as { connectionParameters: { options: string } }).connectionParameters.options.trim(),
      ).toBe('');
    } finally {
      if (previous === undefined) delete process.env.PGOPTIONS;
      else process.env.PGOPTIONS = previous;
    }
  });

  it('does not borrow runtime values for a partial test profile', () => {
    expect(() => parseDatabaseConfig({ ...fixture, COS_TEST_PGHOST: fixture.COS_PGHOST }, 'test')).toThrow(
      'COS_TEST_PGDATABASE',
    );
  });

  it('migration login is explicit and does not require the runtime password', () => {
    const env = {
      ...fixture,
      COS_PGPASSWORD: undefined,
      COS_PG_MIGRATION_USER: 'cos_migrate',
      COS_PG_MIGRATION_PASSWORD: 'admin-fixture',
    };
    expect(parseDatabaseConfig(env, 'runtime', 'migration')).toMatchObject({
      user: 'cos_migrate',
      password: 'admin-fixture',
    });
    expect(() => parseDatabaseConfig(fixture, 'runtime', 'migration')).toThrow('COS_PG_MIGRATION_USER');
  });

  it.each([
    'localhost',
    '127.0.0.1',
    '127.2.3.4',
    '0.0.0.0',
    '::1',
    '/run/postgresql',
    'postgres://secret@db',
    '8.8.8.8',
    'example.com',
    '::ffff:127.0.0.1',
  ])('rejects local, public or non-host endpoint %s', (host) => {
    expect(() => parseDatabaseConfig({ ...fixture, COS_PGHOST: host }, 'runtime')).toThrow('COS_PGHOST');
  });

  it.each(['0', '-1', '65536', '5432x', '1.2', ''])('rejects invalid port %s', (port) => {
    expect(() => parseDatabaseConfig({ ...fixture, COS_PGPORT: port }, 'runtime')).toThrow('COS_PGPORT');
  });

  it.each(['prefer', 'require', 'allow', 'disable'])('S01-PG03 refuses unapproved TLS mode %s', (mode) => {
    expect(() => parseDatabaseConfig({ ...fixture, COS_PGSSLMODE: mode }, 'runtime')).toThrow('COS_PGSSLMODE');
  });

  it('accepts only the explicit two-part plaintext exception', () => {
    expect(
      parseDatabaseConfig({ ...fixture, COS_PGSSLMODE: 'disable', COS_PG_ALLOW_PLAINTEXT: 'true' }, 'runtime').ssl,
    ).toBe(false);
  });

  it('bounds capacity and deadlines, keeping the client deadline above statement timeout', () => {
    for (const change of [
      { COS_PG_POOL_MAX: '1000' },
      { COS_PG_QUERY_TIMEOUT_MS: '4000' },
      { COS_PG_CONNECT_TIMEOUT_MS: '0' },
    ]) {
      expect(() => parseDatabaseConfig({ ...fixture, ...change }, 'runtime')).toThrow();
    }
  });

  it('errors disclose variable names, never credentials or endpoint values', () => {
    const env = { ...fixture, COS_PGHOST: 'postgres://secret-host-canary', COS_PGPASSWORD: 'password-canary' };
    try {
      parseDatabaseConfig(env, 'runtime');
      expect.fail('must reject');
    } catch (error) {
      expect(String(error)).not.toMatch(/secret-host-canary|password-canary/);
    }
  });
});
