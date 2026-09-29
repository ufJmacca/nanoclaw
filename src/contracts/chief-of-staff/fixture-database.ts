import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parseDatabaseConfig } from '../../modules/chief-of-staff/store/config.js';
import { connectChecked } from '../../modules/chief-of-staff/store/preflight.js';
import { databaseFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '../../modules/chief-of-staff/ops/runtime-test-wire.js';

export function fixtureProfile(env: NodeJS.ProcessEnv = process.env): 'test' | 'runtime' {
  const profile = env.COS_FIXTURE_DATABASE_PROFILE ?? 'test';
  if (profile === 'test') return 'test';
  if (profile === 'runtime-disposable') return 'runtime';
  throw new Error('explicit_fixture_profile_required');
}
export function selectedFixtureEnvironment(env: NodeJS.ProcessEnv, includeMigration: boolean): NodeJS.ProcessEnv {
  const profile = fixtureProfile(env),
    prefix = profile === 'test' ? 'COS_TEST_PG' : 'COS_PG';
  const suffixes = [
    'HOST',
    'PORT',
    'DATABASE',
    'USER',
    'PASSWORD',
    'SSLMODE',
    'SSLROOTCERT',
    '_ALLOW_PLAINTEXT',
    ...(includeMigration ? ['_MIGRATION_USER', '_MIGRATION_PASSWORD'] : []),
  ];
  const keys = [
    ...suffixes.map((suffix) => prefix + suffix),
    ...(profile === 'test' ? ['COS_TEST_TARGET_ID'] : ['COS_FIXTURE_GUARD_SOCKET', 'COS_FIXTURE_GUARD_TOKEN']),
  ];
  return {
    ...Object.fromEntries(keys.filter((key) => env[key] !== undefined).map((key) => [key, env[key]])),
    COS_FIXTURE_DATABASE_PROFILE: profile === 'test' ? 'test' : 'runtime-disposable',
  };
}
/** Only trusted fixture processes receive this private socket capability. Each request checks the live SSH session. */
export async function assertRuntimeFixtureGuard(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const file = env.COS_FIXTURE_GUARD_SOCKET,
    token = env.COS_FIXTURE_GUARD_TOKEN;
  if (!file || !path.isAbsolute(file) || !/^[a-f0-9]{64}$/.test(token ?? ''))
    throw new Error('live_runtime_fixture_guard_required');
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (
    !stat?.isSocket() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    fs.realpathSync(file) !== file
  )
    throw new Error('live_runtime_fixture_guard_required');
  const connection = net.createConnection(file),
    challenge = randomUUID();
  connection.on('error', () => {});
  const timer = setTimeout(() => connection.destroy(new Error('runtime_fixture_guard_deadline')), 10000);
  try {
    await writeRuntimeTestMessage(connection, { action: 'check', challenge, token });
    for await (const value of runtimeTestMessages(connection)) {
      const reply = value as { challenge?: string; status?: string; databaseFingerprint?: string };
      if (
        reply?.challenge !== challenge ||
        reply.status !== 'ready' ||
        !/^[a-f0-9]{64}$/.test(reply.databaseFingerprint ?? '')
      )
        throw new Error('live_runtime_fixture_guard_required');
      return reply.databaseFingerprint!;
    }
    throw new Error('live_runtime_fixture_guard_required');
  } finally {
    clearTimeout(timer);
    connection.destroy();
  }
}
export async function connectFixtureDatabase(
  env: NodeJS.ProcessEnv = process.env,
  login: 'runtime' | 'migration' = 'runtime',
) {
  const profile = fixtureProfile(env),
    expected = profile === 'runtime' ? await assertRuntimeFixtureGuard(env) : null;
  const client = await connectChecked(env, profile, login);
  if (expected) {
    try {
      if ((await databaseFingerprint(client, parseDatabaseConfig(env, profile, login))) !== expected)
        throw new Error('runtime_fixture_target_changed');
    } catch (error) {
      await client.end();
      throw error;
    }
  }
  return client;
}
export async function fixtureDatabaseConfig(
  env: NodeJS.ProcessEnv = process.env,
  login: 'runtime' | 'migration' = 'runtime',
) {
  const profile = fixtureProfile(env);
  if (profile === 'runtime') await assertRuntimeFixtureGuard(env);
  return parseDatabaseConfig(env, profile, login);
}
export function fixtureRuntimeUser(env: NodeJS.ProcessEnv = process.env): string {
  const name = env[fixtureProfile(env) === 'test' ? 'COS_TEST_PGUSER' : 'COS_PGUSER'];
  if (!name) throw new Error('fixture_runtime_user_required');
  return name;
}
