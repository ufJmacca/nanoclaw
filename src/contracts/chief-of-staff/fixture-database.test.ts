import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({ connect: vi.fn(), fingerprint: vi.fn(), end: vi.fn() }));
vi.mock('../../modules/chief-of-staff/store/preflight.js', () => ({ connectChecked: calls.connect }));
vi.mock('../../modules/chief-of-staff/ops/target-identity.js', () => ({ databaseFingerprint: calls.fingerprint }));
import { connectFixtureDatabase, selectedFixtureEnvironment } from './fixture-database.js';
const roots: string[] = [],
  servers: net.Server[] = [];
beforeEach(() => {
  vi.resetAllMocks();
  calls.connect.mockResolvedValue({ end: calls.end });
  calls.fingerprint.mockResolvedValue('1'.repeat(64));
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('preserves protected test-profile admission and strips credentials for every other profile', async () => {
  const env = { COS_TEST_PGUSER: 'fixture', COS_PGPASSWORD: 'never-export', OPENAI_API_KEY: 'never-export' };
  await connectFixtureDatabase(env);
  expect(calls.connect).toHaveBeenCalledWith(env, 'test', 'runtime');
  expect(selectedFixtureEnvironment(env, false)).toEqual({
    COS_FIXTURE_DATABASE_PROFILE: 'test',
    COS_TEST_PGUSER: 'fixture',
  });
});
it('refuses runtime credentials before database access unless a live private fixture guard answers', async () => {
  await expect(
    connectFixtureDatabase({ COS_FIXTURE_DATABASE_PROFILE: 'runtime-disposable', COS_PGPASSWORD: 'synthetic' }),
  ).rejects.toThrow('live_runtime_fixture_guard_required');
  expect(calls.connect).not.toHaveBeenCalled();
});
it('checks the actual database against the live guard and closes a mismatched connection', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-fixture-guard-'));
  roots.push(root);
  const socket = path.join(root, 'guard.sock'),
    token = 'a'.repeat(64);
  const server = net.createServer((connection) => {
    connection.once('data', (bytes) => {
      const request = JSON.parse(bytes.toString());
      expect(request.token).toBe(token);
      connection.end(
        JSON.stringify({ challenge: request.challenge, status: 'ready', databaseFingerprint: '1'.repeat(64) }) + '\n',
      );
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(socket, resolve));
  fs.chmodSync(socket, 0o600);
  const env = {
    COS_FIXTURE_DATABASE_PROFILE: 'runtime-disposable',
    COS_FIXTURE_GUARD_SOCKET: socket,
    COS_FIXTURE_GUARD_TOKEN: token,
    COS_PGHOST: '192.168.50.10',
    COS_PGPORT: '5432',
    COS_PGDATABASE: 'fixture',
    COS_PGUSER: 'runtime',
    COS_PGPASSWORD: 'synthetic',
    COS_PGSSLMODE: 'disable',
    COS_PG_ALLOW_PLAINTEXT: 'true',
  };
  await connectFixtureDatabase(env);
  expect(calls.connect).toHaveBeenCalledWith(env, 'runtime', 'runtime');
  calls.fingerprint.mockResolvedValue('9'.repeat(64));
  await expect(connectFixtureDatabase(env)).rejects.toThrow('runtime_fixture_target_changed');
  expect(calls.end).toHaveBeenCalledOnce();
});
