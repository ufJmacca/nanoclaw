import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { safeHostEnvironment } from '../../host-environment.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { selectRuntimeEnvironment } from '../../modules/chief-of-staff/ops/mac-release.js';
import { readPrivate, writeAtomic } from '../../modules/chief-of-staff/ops/target-state.js';
import { RuntimeTestClient } from '../../modules/chief-of-staff/ops/runtime-test-client.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '../../modules/chief-of-staff/ops/runtime-test-wire.js';
import { databaseFingerprint } from '../../modules/chief-of-staff/ops/target-identity.js';
import { connectChecked } from '../../modules/chief-of-staff/store/preflight.js';
import { parseDatabaseConfig } from '../../modules/chief-of-staff/store/config.js';
import { guardedFixtureOperation, type FixtureRunReceipt } from './guarded-fixture-operation.js';
import { stopFixtureWorkers } from './fixture-workers.js';
import { sourceFixtureEnvironment, validatePreparedFixtureSource } from './source-fixture.js';
import { startFixtureProcess } from './fixture-process.js';

export type RuntimeFixtureRequest = {
  version: 1;
  owner: string;
  execution: 'source' | 'packaged';
  mode: 'slice' | 'demo';
  /** Absent only in historical S01 requests; never normalize their replay identity. */
  slice?: 'S01' | 'S02' | 'S03' | 'S04' | 'S05';
  sourceCommit: string;
  sourceTree: string;
  hostImage: string;
  workerImage: string;
  hostRoot: string;
  runnerVolume: string;
  databaseFingerprint: string;
  bindingDigest: string;
};
export function validateRuntimeFixtureRequest(value: unknown): RuntimeFixtureRequest {
  const request = value as RuntimeFixtureRequest;
  const keys = [
    'version',
    'owner',
    'execution',
    'mode',
    'sourceCommit',
    'sourceTree',
    'hostImage',
    'workerImage',
    'hostRoot',
    'runnerVolume',
    'databaseFingerprint',
    'bindingDigest',
  ];
  const explicitSlice = !!request && typeof request === 'object' && Object.hasOwn(request, 'slice');
  if (explicitSlice) keys.push('slice');
  if (
    !request ||
    typeof request !== 'object' ||
    Object.keys(request).length !== keys.length ||
    Object.keys(request).some((key) => !keys.includes(key)) ||
    request.version !== 1 ||
    !/^[a-zA-Z0-9_-]{1,100}$/.test(request.owner ?? '') ||
    !['source', 'packaged'].includes(request.execution) ||
    !['slice', 'demo'].includes(request.mode) ||
    (explicitSlice && !['S01', 'S02', 'S03', 'S04', 'S05'].includes(request.slice ?? '')) ||
    ![request.sourceCommit, request.sourceTree].every((v) => /^[a-f0-9]{40}$/.test(v ?? '')) ||
    ![request.hostImage, request.workerImage].every((v) => /^sha256:[a-f0-9]{64}$/.test(v ?? '')) ||
    ![request.databaseFingerprint, request.bindingDigest].every((v) => /^[a-f0-9]{64}$/.test(v ?? '')) ||
    typeof request.hostRoot !== 'string' ||
    !/^\/[a-zA-Z0-9_./-]+$/.test(request.hostRoot) ||
    request.hostRoot === '/' ||
    path.resolve(request.hostRoot) !== request.hostRoot ||
    (request.execution === 'source'
      ? !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,100}$/.test(request.runnerVolume ?? '')
      : request.runnerVolume !== '')
  )
    throw new Error('invalid_runtime_fixture_request');
  return request;
}

/** The socket is a private capability for trusted fixture children, never an agent mount. */
export async function startRuntimeFixtureGuard(control: Pick<RuntimeTestClient, 'request'>) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cos-guard-')));
  fs.chmodSync(root, 0o700);
  const socket = path.join(root, 'guard.sock'),
    token = randomBytes(32).toString('hex');
  const connections = new Set<net.Socket>();
  const server = net.createServer((connection) => {
    connections.add(connection);
    connection.on('close', () => connections.delete(connection));
    connection.on('error', () => {});
    connection.setTimeout(10000, () => connection.destroy());
    void (async () => {
      try {
        for await (const value of runtimeTestMessages(connection)) {
          const message = value as { action: string; challenge: string; token: string };
          if (
            !message ||
            Object.keys(message).sort().join(',') !== 'action,challenge,token' ||
            message.action !== 'check' ||
            message.token !== token ||
            !/^[a-f0-9-]{36}$/.test(message.challenge ?? '')
          )
            throw new Error('runtime_fixture_guard_denied');
          const reply = await control.request('check');
          if (reply.status !== 'ready') throw new Error('runtime_fixture_guard_denied');
          await writeRuntimeTestMessage(connection, {
            challenge: message.challenge,
            status: 'ready',
            databaseFingerprint: reply.databaseFingerprint,
          });
          return;
        }
      } catch {
        /* Denial closes the capability without exposing target or credential details. */
      } finally {
        connection.destroy();
      }
    })();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
    });
    fs.chmodSync(socket, 0o600);
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return {
    socket,
    token,
    close: async () => {
      for (const connection of connections) connection.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

export async function runRuntimeFixtureDriver(file: string) {
  if (process.platform !== 'linux' || !path.isAbsolute(file) || fs.realpathSync(file) !== file)
    throw new Error('private_container_fixture_required');
  const root = path.dirname(file),
    stat = fs.lstatSync(root);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())
    throw new Error('private_container_fixture_required');
  const request = validateRuntimeFixtureRequest(readPrivate(file));
  const source = import.meta.url.endsWith('.ts');
  if (source !== (request.execution === 'source')) throw new Error('fixture_execution_mismatch');
  const env = selectRuntimeEnvironment(
    readPrivate<NodeJS.ProcessEnv>(path.join(root, 'runtime.json')),
    path.join(root, 'ca.pem'),
  );
  if (source && process.env.COS_FIXTURE_WORK_ROOT) {
    sourceFixtureEnvironment(request.hostRoot, process.env);
    validatePreparedFixtureSource(JSON.parse(fs.readFileSync('build-info.json', 'utf8')), request);
  } else if (source) {
    const git = (args: string[]) =>
      execFileSync('git', args, { env: safeHostEnvironment('docker'), encoding: 'utf8' }).trim();
    if (
      git(['rev-parse', 'HEAD']) !== request.sourceCommit ||
      git(['rev-parse', 'HEAD^{tree}']) !== request.sourceTree ||
      git(['status', '--porcelain'])
    )
      throw new Error('fixture_source_changed');
  } else {
    const info = JSON.parse(fs.readFileSync('build-info.json', 'utf8')) as {
      commit: string;
      tree: string;
      workerAssetsDigest: string;
    };
    if (info.commit !== request.sourceCommit || info.tree !== request.sourceTree)
      throw new Error('fixture_source_changed');
    const images = JSON.parse(
      execFileSync('docker', ['image', 'inspect', request.hostImage, request.workerImage], {
        env: safeHostEnvironment('docker'),
        encoding: 'utf8',
      }),
    ) as Array<{ Id: string; Os: string; Architecture: string; Config: { Labels: Record<string, string> } }>;
    if (
      images.length !== 2 ||
      images.some(
        (image, index) =>
          image.Id !== [request.hostImage, request.workerImage][index] ||
          image.Os !== 'linux' ||
          image.Architecture !== 'arm64' ||
          image.Config.Labels['org.opencontainers.image.revision'] !== info.commit ||
          image.Config.Labels['nanoclaw.worker-assets'] !== info.workerAssetsDigest ||
          image.Config.Labels['nanoclaw.release-role'] !== ['host', 'agent'][index],
      )
    )
      throw new Error('fixture_image_changed');
  }
  let child: ReturnType<typeof startFixtureProcess> | undefined,
    failed = false;
  let rejectLost!: (error: Error) => void;
  const lost = new Promise<never>((_, reject) => {
    rejectLost = reject;
  });
  void lost.catch(() => {});
  const onLost = () => {
    failed = true;
    rejectLost(new Error('runtime_test_control_lost'));
  };
  const control = new RuntimeTestClient(process.stdin, process.stdout, request, onLost);
  const guard = await startRuntimeFixtureGuard(control);
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  const stop = async () => {
    if (heartbeat) clearInterval(heartbeat);
    await child?.stop();
    if (request.slice === 'S05') {
      const location = source
        ? sourceFixtureEnvironment(request.hostRoot, process.env).COS_FIXTURE_HOST_ROOT!
        : request.hostRoot;
      await stopFixtureWorkers(location, request.workerImage);
    }
  };
  try {
    return await guardedFixtureOperation({
      requestDigest: digest(request),
      control,
      lost,
      read: () =>
        fs.existsSync(path.join(root, 'result.json'))
          ? readPrivate<FixtureRunReceipt>(path.join(root, 'result.json'))
          : undefined,
      save: async (receipt) => {
        writeAtomic(root, 'result.json', receipt);
      },
      acquireFence: async (reply) => {
        const client = await connectChecked(env, 'runtime', 'migration');
        client.on('error', onLost);
        try {
          if (
            (await databaseFingerprint(client, parseDatabaseConfig(env, 'runtime', 'migration'))) !==
              reply.databaseFingerprint ||
            (await client.query('SELECT pg_try_advisory_lock(73101003) AS locked')).rows[0]?.locked !== true
          )
            throw new Error('runtime_fixture_fence_unavailable');
          return async () => {
            await client.end();
          };
        } catch (error) {
          await client.end();
          throw error;
        }
      },
      run: async () => {
        if (failed) throw new Error('runtime_test_control_lost');
        heartbeat = setInterval(() => {
          if (checking) return;
          checking = true;
          void control
            .request('check')
            .catch(onLost)
            .finally(() => {
              checking = false;
            });
        }, 2000);
        child = startFixtureProcess(
          [
            ...(source ? ['--import', 'tsx'] : []),
            (source ? 'src' : 'dist') + '/contracts/chief-of-staff/run.' + (source ? 'ts' : 'js'),
            '--slice',
            request.slice ?? 'S01',
            '--db-profile',
            'runtime-disposable',
            ...(request.mode === 'demo' ? ['--demo', '--fixture'] : []),
          ],
          {
            ...safeHostEnvironment('docker'),
            ...env,
            COS_FIXTURE_DATABASE_PROFILE: 'runtime-disposable',
            COS_FIXTURE_GUARD_SOCKET: guard.socket,
            COS_FIXTURE_GUARD_TOKEN: guard.token,
            ...(source
              ? sourceFixtureEnvironment(request.hostRoot, process.env)
              : { COS_FIXTURE_HOST_ROOT: request.hostRoot }),
            COS_FIXTURE_IMAGE: request.workerImage,
            COS_FIXTURE_RUNNER_VOLUME: request.runnerVolume,
          },
        );
        await child.finished;
      },
      stop,
    });
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await guard.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.env.NANOCLAW_LOG_STDERR = 'true';
  runRuntimeFixtureDriver(process.argv[2]).catch(() => {
    process.stderr.write('{"status":"blocked","code":"runtime_fixture_failed_target_stays_paused"}\n');
    process.exitCode = 1;
  });
}
