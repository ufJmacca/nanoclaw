import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import type { PoolConfig } from 'pg';

export class DatabaseConfigurationError extends Error {
  constructor(readonly variable: string) {
    super(`Invalid or missing ${variable}`);
    this.name = 'DatabaseConfigurationError';
  }
}

export function isPrivateAddress(address: string): boolean {
  if (net.isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return net.isIP(address) === 6 && /^f[cd]/i.test(address);
}

/** DNS names are admitted only after all resolved addresses pass the same target check. */
export async function verifyExternalHost(host: string): Promise<void> {
  const local = new Set(
    Object.values(networkInterfaces()).flatMap((entries) => entries?.map((entry) => entry.address) ?? []),
  );
  const addresses = await lookup(host, { all: true });
  if (!addresses.length || addresses.some(({ address }) => !isPrivateAddress(address) || local.has(address))) {
    throw new DatabaseConfigurationError('COS_PGHOST');
  }
}

export function parseDatabaseConfig(
  env: NodeJS.ProcessEnv,
  profile: 'runtime' | 'test',
  login: 'runtime' | 'migration' = 'runtime',
): PoolConfig {
  const prefix = profile === 'test' ? 'COS_TEST_PG' : 'COS_PG';
  const fail = (suffix: string): never => {
    throw new DatabaseConfigurationError(prefix + suffix);
  };
  const required = (suffix: string): string => {
    const value = env[prefix + suffix];
    if (!value || /^(?:REPLACE|CHANGE_ME|YOUR_|<)/i.test(value)) return fail(suffix);
    return value;
  };
  const integer = (suffix: string, fallback: number, min: number, max: number): number => {
    const raw = env[prefix + suffix];
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw)) return fail(suffix);
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= min && value <= max ? value : fail(suffix);
  };
  const host = required('HOST');
  if (
    net.isIP(host)
      ? !isPrivateAddress(host)
      : !/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host) ||
        /(?:^|\.)(?:localhost|example\.(?:com|org|net))\.?$/i.test(host)
  )
    fail('HOST');
  const database = required('DATABASE');
  const user = required(login === 'migration' ? '_MIGRATION_USER' : 'USER');
  const password = required(login === 'migration' ? '_MIGRATION_PASSWORD' : 'PASSWORD');
  const mode = env[prefix + 'SSLMODE'] ?? 'verify-full';
  if (mode !== 'verify-full' && !(mode === 'disable' && env[prefix + '_ALLOW_PLAINTEXT'] === 'true')) fail('SSLMODE');
  const caPath = env[prefix + 'SSLROOTCERT'];
  let ca: string | undefined;
  if (caPath !== undefined) {
    if (!path.isAbsolute(caPath)) fail('SSLROOTCERT');
    try {
      ca = fs.readFileSync(caPath, 'utf8');
    } catch {
      fail('SSLROOTCERT');
    }
    if (!ca?.includes('-----BEGIN CERTIFICATE-----')) fail('SSLROOTCERT');
  }
  const statementTimeout = integer('_STATEMENT_TIMEOUT_MS', 5000, 100, 60000);
  const queryTimeout = integer('_QUERY_TIMEOUT_MS', 7000, 200, 90000);
  if (queryTimeout <= statementTimeout) fail('_QUERY_TIMEOUT_MS');
  const applicationName = env[prefix + '_APPLICATION_NAME'] ?? 'nanoclaw-cos';
  if (!/^[a-zA-Z0-9_-]{1,63}$/.test(applicationName)) fail('_APPLICATION_NAME');
  return {
    host,
    port: integer('PORT', 5432, 1, 65535),
    database,
    user,
    password,
    // pg omits SNI for IP addresses. Node still needs the intended host for
    // its standard certificate-name check on the already connected socket.
    ssl: mode === 'disable' ? false : { host, rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    max: integer('_POOL_MAX', 5, 1, 10),
    connectionTimeoutMillis: integer('_CONNECT_TIMEOUT_MS', 3000, 100, 30000),
    statement_timeout: statementTimeout,
    query_timeout: queryTimeout,
    lock_timeout: integer('_LOCK_TIMEOUT_MS', 2000, 100, 10000),
    idleTimeoutMillis: integer('_IDLE_TIMEOUT_MS', 30000, 1000, 300000),
    idle_in_transaction_session_timeout: integer('_IDLE_TX_TIMEOUT_MS', 10000, 1000, 60000),
    application_name: applicationName,
    // Explicit non-secret settings prevent ambient PGOPTIONS/PGAPPNAME fallback.
    options: ' ',
    client_encoding: 'UTF8',
    keepAlive: true,
  };
}

export function runtimeDatabaseConfig(env: NodeJS.ProcessEnv): PoolConfig | null {
  return env.COS_ENABLED === 'true' ? parseDatabaseConfig(env, 'runtime') : null;
}
