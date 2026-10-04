/** Packaged native-auth fixture: synthetic credentials, network-none Docker containers only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { zstdDecompressSync } from 'node:zlib';
import { WebSocketServer } from 'ws';
import Database from 'better-sqlite3';
import { CosController } from '../../modules/chief-of-staff/bridge/controller.js';
import { installCosBoundary, type CosBinding } from '../../cos-boundary.js';
import type { Session } from '../../types.js';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSubscriptionAuthStore } from '../../providers/codex-subscription-auth.js';
import { createSubscriptionNativeCheck } from '../../providers/codex-subscription-runner.js';
import { startSubscriptionEgress } from '../../modules/chief-of-staff/bridge/subscription-egress.js';
import { safeHostEnvironment } from '../../host-environment.js';
import { startSubscriptionBroker } from '../../providers/codex-subscription-broker.js';
import { startSubscriptionTurns } from '../../modules/chief-of-staff/bridge/subscription-turns.js';
import { randomUUID } from 'node:crypto';
import { restrictedLaunch } from '../../modules/chief-of-staff/bridge/restricted-launch.js';
import { sealResearchWorkOrder, RESEARCH_TEMPLATE } from '../../modules/chief-of-staff/missions/work-order.js';
import { MISSION_DEFAULT_LIMITS } from '../../modules/chief-of-staff/contracts/mission-protocol.js';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { ensureSchema, openInboundDb, openOutboundDb } from '../../db/session-db.js';
import { initTestDb, closeDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../cos-mission-boundary.js';
import { createMissionRpcHandler } from '../../modules/chief-of-staff/missions/rpc.js';
import { ensureRpcSchema } from '../../modules/chief-of-staff/bridge/rpc.js';
import { RestrictedExecutionProbe } from '../../modules/chief-of-staff/bridge/native-execution.js';
import { getInstallSlug } from '../../install-slug.js';

const execute = promisify(execFile);
const docker = (args: string[]) =>
  execute('docker', args, {
    env: safeHostEnvironment('docker'),
    timeout: 45000,
    killSignal: 'SIGKILL',
    maxBuffer: 16384,
  });
const jwt = (generation: number) =>
  Buffer.from('{}').toString('base64url') +
  '.' +
  Buffer.from(
    JSON.stringify({
      exp: 4102444800,
      email: 'fixture@example.invalid',
      jti: String(generation),
      'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' },
    }),
  ).toString('base64url') +
  '.fixture-signature';

async function fixture() {
  const image = process.env.COS_FIXTURE_IMAGE,
    base = process.env.COS_SUBSCRIPTION_ROOT,
    hostBase = process.env.COS_SUBSCRIPTION_HOST_ROOT;
  assert.match(image ?? '', /^sha256:[a-f0-9]{64}$/);
  assert.ok(base && hostBase && path.isAbsolute(base) && path.isAbsolute(hostBase));
  assert.ok(
    Object.values(os.networkInterfaces())
      .flat()
      .every((address) => !address || address.internal),
  );
  const root = fs.mkdtempSync(path.join(base, 'n-')),
    hostRoot = path.join(hostBase, path.basename(root));
  const source = path.join(root, 'auth.json'),
    state = path.join(root, 'state');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.writeFileSync(
    source,
    JSON.stringify({
      auth_mode: 'chatgpt',
      OPENAI_API_KEY: null,
      tokens: {
        id_token: jwt(0),
        access_token: jwt(0),
        refresh_token: 'fixture-refresh-0',
        account_id: 'fixture-account',
      },
      last_refresh: new Date().toISOString(),
    }),
    { mode: 0o600 },
  );
  const certificate = path.join(root, 'ca.pem'),
    key = path.join(root, 'key.pem');
  await execute('openssl', [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    certificate,
    '-days',
    '1',
    '-subj',
    '/CN=Offline subscription fixture',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'subjectAltName=DNS:chatgpt.com,DNS:auth.openai.com',
  ]);
  fs.renameSync(key, path.join(root, 'ca-key.pem'));
  await execute('openssl', [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    path.join(root, 'request.pem'),
    '-subj',
    '/CN=chatgpt.com',
  ]);
  fs.writeFileSync(
    path.join(root, 'extensions'),
    'basicConstraints=critical,CA:FALSE\nsubjectAltName=DNS:chatgpt.com,DNS:auth.openai.com\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
  );
  await execute('openssl', [
    'x509',
    '-req',
    '-in',
    path.join(root, 'request.pem'),
    '-CA',
    certificate,
    '-CAkey',
    path.join(root, 'ca-key.pem'),
    '-CAcreateserial',
    '-out',
    path.join(root, 'server.pem'),
    '-days',
    '1',
    '-extfile',
    path.join(root, 'extensions'),
  ]);
  let refreshes = 0,
    held: (() => void) | undefined,
    holdRefresh = false;
  let modelResponse: ((request: IncomingMessage, response: ServerResponse) => Promise<void>) | undefined;
  const backend = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(path.join(root, 'server.pem')) },
    async (request, response) => {
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url?.endsWith('/responses') && modelResponse) {
        await modelResponse(request, response);
      } else if (request.url === '/oauth/token') {
        let raw = '';
        for await (const chunk of request) raw += String(chunk);
        const body = request.headers['content-type']?.includes('application/json')
          ? JSON.parse(raw)
          : Object.fromEntries(new URLSearchParams(raw));
        if (body.grant_type !== 'refresh_token' || body.refresh_token !== 'fixture-refresh-0') {
          reply({ error: 'fixture-invalid' }, 400);
          return;
        }
        refreshes++;
        const send = () =>
          reply({
            access_token: jwt(refreshes),
            id_token: jwt(refreshes),
            refresh_token: 'fixture-refresh-' + refreshes,
            token_type: 'Bearer',
            expires_in: 3600,
          });
        if (holdRefresh) held = send;
        else send();
      } else if (request.url?.endsWith('/accounts/check'))
        reply({
          accounts: [
            {
              id: 'fixture-account',
              workspace_backend_origin: 'https://chatgpt.com',
              account_routing_override: 'NO_CONSTRAINT',
            },
          ],
        });
      else reply({}, 404);
    },
  );
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const port = (backend.address() as net.AddressInfo).port;
  const inspections: Array<{ network: string; readonly: boolean; mounts: string[]; image: string }> = [];
  const names = new Set<string>();
  let interrupt: 'in-flight' | 'after-exit' | undefined;
  const nativeCheck = createSubscriptionNativeCheck({
    image: async () => image!,
    model: 'gpt-6-astra',
    assertAuthority() {},
    egress: (options) =>
      startSubscriptionEgress({
        ...options,
        dependencies: {
          resolve: async () => [{ address: '8.8.8.8', family: 4 }],
          connect: () => net.createConnection({ host: '127.0.0.1', port }),
        },
      }),
    run: async (args) => {
      if (args[0] !== 'run') return docker(args);
      const translated = args.map((arg) =>
        arg.startsWith('type=bind,') ? arg.replace('src=' + root + '/', 'src=' + hostRoot + '/') : arg,
      );
      translated.splice(
        translated.indexOf(image!),
        0,
        '--mount',
        `type=bind,src=${hostRoot}/ca.pem,dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
      );
      const name = translated[translated.indexOf('--name') + 1];
      names.add(name);
      // Hold the synthetic OAuth response until the actual production helper's
      // container configuration has been inspected. No credential bytes are read.
      holdRefresh = true;
      const running = docker(translated);
      void running.catch(() => {});
      const deadline = Date.now() + 20000;
      while (!held && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(held, 'native helper did not reach the fixture OAuth endpoint');
      const inspected = JSON.parse((await docker(['inspect', name])).stdout)[0];
      inspections.push({
        network: inspected.HostConfig.NetworkMode,
        readonly: inspected.HostConfig.ReadonlyRootfs,
        mounts: inspected.Mounts.map((mount: { Destination: string }) => mount.Destination),
        image: inspected.Image,
      });
      assert.equal(inspected.HostConfig.NetworkMode, 'none');
      assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
      assert.equal(inspected.Image, image);
      assert.equal(inspected.Config.User, `${process.getuid!()}:${process.getgid!()}`);
      assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
      assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
      const binds = inspected.Mounts.filter((mount: { Type: string }) => mount.Type === 'bind');
      assert.deepEqual(binds.map((mount: { Destination: string }) => mount.Destination).sort(), [
        '/etc/ssl/certs/ca-certificates.crt',
        '/home/node/.codex/auth.json',
        '/run/cos/subscription.sock',
      ]);
      const auth = binds.find((mount: { Destination: string }) => mount.Destination === '/home/node/.codex/auth.json');
      assert.ok(auth.Source.startsWith(hostRoot + '/state/operation-') && auth.Source.endsWith('/auth.json'));
      assert.equal(auth.RW, true);
      assert.ok(
        binds
          .filter((mount: { Destination: string }) => mount.Destination !== '/home/node/.codex/auth.json')
          .every((mount: { RW: boolean }) => !mount.RW),
      );
      assert.equal(
        inspected.Mounts.some((mount: { Source: string }) => mount.Source === hostRoot + '/auth.json'),
        false,
      );
      assert.equal(
        inspected.Mounts.some((mount: { Destination: string }) => mount.Destination === '/var/run/docker.sock'),
        false,
      );
      if (interrupt === 'in-flight') await docker(['rm', '--force', name]);
      held();
      held = undefined;
      const result = await running;
      if (interrupt === 'after-exit') throw new Error('fixture publication interruption after native exit');
      return result;
    },
  });
  const create = () =>
    createSubscriptionAuthStore({ sourceFile: source, stateDirectory: state, assertAuthority() {}, nativeCheck });
  return {
    root,
    hostRoot,
    image: image!,
    backend,
    trackContainer(name: string) {
      names.add(name);
    },
    source,
    state,
    inspections,
    create,
    refreshes: () => refreshes,
    modelResponse(handler: (request: IncomingMessage, response: ServerResponse) => Promise<void>) {
      modelResponse = handler;
    },
    gateway(socketPath: string, authorize: () => Promise<boolean>) {
      return startSubscriptionEgress({
        socketPath,
        role: 'query',
        authorize,
        dependencies: {
          resolve: async () => [{ address: '8.8.8.8', family: 4 }],
          connect: () => net.createConnection({ host: '127.0.0.1', port }),
        },
      });
    },
    interrupt: (stage: 'in-flight' | 'after-exit') => {
      interrupt = stage;
    },
    async close() {
      for (const name of names) await docker(['rm', '--force', name]).catch(() => {});
      backend.closeAllConnections();
      await new Promise<void>((resolve) => backend.close(() => resolve()));
    },
  };
}

test(
  'production Docker auth helper rotates one staged credential for concurrent requests',
  { timeout: 60000 },
  async () => {
    const f = await fixture();
    try {
      const store = f.create(),
        original = store.cached();
      const replies = await Promise.all([store.refresh(original.generation), store.refresh(original.generation)]);
      assert.equal(f.refreshes(), 1);
      assert.equal(f.inspections.length, 1);
      assert.equal(replies[0].generation, replies[1].generation);
      assert.notEqual(replies[0].generation, original.generation);
      assert.equal(JSON.parse(replies[0].authJson).tokens.refresh_token, '');
      assert.equal(JSON.parse(fs.readFileSync(f.source, 'utf8')).tokens.refresh_token, 'fixture-refresh-1');
      assert.equal(fs.existsSync(path.join(f.state, 'operation.json')), false);
    } finally {
      await f.close();
    }
  },
);

for (const stage of ['in-flight', 'after-exit'] as const)
  test(
    `uncertain ${stage} Docker helper preserves the primary login and refuses another rotation after reconstruction`,
    { timeout: 60000 },
    async () => {
      const f = await fixture();
      try {
        const store = f.create(),
          original = fs.readFileSync(f.source, 'utf8'),
          generation = store.cached().generation;
        f.interrupt(stage);
        await assert.rejects(store.refresh(generation), /subscription_refresh_uncertain/);
        assert.equal(f.refreshes(), 1);
        assert.equal(fs.readFileSync(f.source, 'utf8'), original);
        assert.equal(JSON.parse(fs.readFileSync(path.join(f.state, 'operation.json'), 'utf8')).phase, 'checking');
        await assert.rejects(f.create().refresh(generation), /subscription_refresh_uncertain/);
        assert.equal(f.refreshes(), 1);
      } finally {
        await f.close();
      }
    },
  );

// Test driver only: providers and the pinned executable remain baked in /app/src.
// Each role gets a separate container, HOME, broker socket and continuation file.
// Ordinary networking is mapped to the fixture relay only in its native child;
// proxying Bun's parent HTTP client would also intercept the credential socket.
const providerDriver = `
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { CodexProvider } from '/app/src/providers/codex.ts';
import { CosCodexProvider } from '/app/src/providers/codex-cos.ts';
import { startSubscriptionRelay } from '/app/src/cos-subscription-relay.ts';
const [role, stage] = process.argv.slice(2);
fs.mkdirSync('/home/node/.codex', { recursive: true, mode: 0o700 });
const relay = await startSubscriptionRelay('/run/cos/subscription.sock');
if (role === 'ordinary') {
  const executable = Bun.which('codex');
  assert.ok(executable && /^[a-zA-Z0-9/_.-]+$/.test(executable));
  fs.mkdirSync('/home/node/fixture-bin', { recursive: true });
  fs.writeFileSync('/home/node/fixture-bin/codex', '#!/bin/sh\\nexport HTTPS_PROXY=' + relay.proxyUrl + ' HTTP_PROXY=' + relay.proxyUrl + ' ALL_PROXY=' + relay.proxyUrl + ' NO_PROXY=\\nexec ' + executable + ' "$@"\\n', { mode: 0o700 });
  process.env.PATH = '/home/node/fixture-bin:' + process.env.PATH;
  const version = Bun.spawnSync(['codex', '--version'], { env: { ...process.env }, stdout: 'pipe', stderr: 'pipe' });
  assert.equal(version.exitCode, 0, version.stderr.toString());
}
fs.mkdirSync('/workspace/agent', { recursive: true });
const saved = '/home/node/continuation';
const before = fs.existsSync(saved) ? fs.readFileSync(saved, 'utf8') : undefined;
assert.equal(!!before, stage !== 'initial');
const provider = role === 'cos'
  ? new CosCodexProvider({ model: 'gpt-6-astra', proxyUrl: relay.proxyUrl })
  : new CodexProvider({ env: { NANOCLAW_CODEX_SUBSCRIPTION: '1', CODEX_MODEL: 'gpt-6-astra' } });
const query = provider.query({
  prompt: stage === 'initial' ? 'Remember the ' + role + '-private-canary.' : stage + ' explicit follow-up.',
  cwd: '/workspace/agent', continuation: before,
  systemContext: { instructions: 'Offline fixture. Return one short answer. Do not call tools.' }
});
query.end();
const events = [];
try {
  for await (const event of query.events) {
    events.push(event);
    if (event.type === 'init') {
      if (before) assert.equal(event.continuation, before);
      fs.writeFileSync(saved, event.continuation, { mode: 0o600 });
    }
  }
  assert.ok(fs.existsSync(saved), JSON.stringify(events));
  fs.writeFileSync('/home/node/result-' + stage + '.json', JSON.stringify(events), { mode: 0o600 });
} finally {
  query.abort();
  await relay.close();
}
`;

test(
  'ordinary and CoS providers share renewal, retain separate history and stop on owner pause',
  { timeout: 180000 },
  async () => {
    const f = await fixture();
    const closers: Array<() => Promise<void>> = [];
    const boundary = new Database(':memory:');
    const binding: CosBinding = {
      scopeId: 'fixture',
      agentGroupId: 'group',
      messagingGroupId: 'messaging',
      sessionId: 'session',
      instanceId: 'fixture',
      channelId: 'private',
      ownerId: 'owner',
      botId: 'bot',
      provider: 'codex',
    };
    const session = {
      id: binding.sessionId,
      agent_group_id: binding.agentGroupId,
      messaging_group_id: binding.messagingGroupId,
      thread_id: null,
      status: 'active',
      agent_provider: 'codex',
    } as Session;
    installCosBoundary(binding, boundary);
    boundary.exec('UPDATE cos_identity_boundaries SET paused=0');
    const admitted = async () =>
      (boundary.prepare('SELECT paused FROM cos_identity_boundaries').get() as { paused: number }).paused === 0;
    try {
      const store = f.create();
      let renewals = 0;
      const shared = {
        ...store,
        refresh: async (generation: string) => {
          renewals++;
          return store.refresh(generation);
        },
      };
      let expired = false;
      const requests: Array<{ role: string; input: string; accepted: boolean }> = [];
      const firstReplies: Array<() => void> = [];
      let lateReply: (() => void) | undefined;
      const respond = (body: { input?: unknown; generate?: boolean }, send: (events: unknown[]) => void) => {
        if (body.generate === false) {
          send([
            {
              type: 'response.completed',
              response: { id: 'warmup', object: 'response', status: 'completed', output: [] },
            },
          ]);
          return;
        }
        const input = JSON.stringify(body.input);
        assert.equal(input.includes(jwt(0)) || input.includes(jwt(1)) || input.includes('fixture-refresh-'), false);
        const role = input.includes('ordinary-private-canary') ? 'ordinary' : 'cos';
        assert.ok(input.includes(role + '-private-canary'));
        assert.equal(input.includes((role === 'cos' ? 'ordinary' : 'cos') + '-private-canary'), false);
        requests.push({ role, input, accepted: true });
        const id = 'fixture-' + requests.length;
        const item = {
          id,
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Fixture answer', annotations: [] }],
        };
        const events = [
          { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id,
              object: 'response',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ];
        const reply = () => send(events);
        // Neither first query can finish until both native providers have reached
        // the synthetic endpoint, proving overlap rather than sequential clients.
        if (!expired) {
          firstReplies.push(reply);
          if (firstReplies.length === 2) firstReplies.forEach((send) => send());
        } else if (input.includes('cancelled explicit follow-up.')) lateReply = reply;
        else reply();
      };
      const accepted = (request: IncomingMessage) => !expired || request.headers.authorization === 'Bearer ' + jwt(1);
      const failure = JSON.stringify({
        error: { message: 'Synthetic expired access', type: 'invalid_request_error', code: 'invalid_api_key' },
      });
      f.modelResponse(async (request, response) => {
        if (!accepted(request)) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(failure);
          return;
        }
        if (request.method !== 'POST') {
          response.writeHead(400);
          response.end();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const raw = Buffer.concat(chunks);
        respond(
          JSON.parse((request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(raw) : raw).toString()),
          (events) => {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
          },
        );
      });
      const websocket = new WebSocketServer({ noServer: true });
      f.backend.on('upgrade', (request, socket, head) => {
        if (!accepted(request)) {
          socket.end(
            'HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: ' +
              Buffer.byteLength(failure) +
              '\r\nConnection: close\r\n\r\n' +
              failure,
          );
          return;
        }
        websocket.handleUpgrade(request, socket, head, (client) => {
          client.on('message', (message) =>
            respond(JSON.parse(message.toString()), (events) =>
              events.forEach((event) => client.send(JSON.stringify(event), () => {})),
            ),
          );
        });
      });
      closers.push(async () => {
        for (const client of websocket.clients) client.terminate();
        await new Promise<void>((resolve) => websocket.close(() => resolve()));
      });
      fs.writeFileSync(path.join(f.root, 'driver.ts'), providerDriver);
      const attempts = new Set<string>();
      const turns = await startSubscriptionTurns({
        socket: path.join(f.root, 'turns.sock'),
        authorize: admitted,
        reserve: (id) => {
          if (attempts.has(id) || attempts.size >= 4) return false;
          attempts.add(id);
          return true;
        },
      });
      closers.push(() => turns.close());
      for (const role of ['ordinary', 'cos']) {
        fs.mkdirSync(path.join(f.root, role), { mode: 0o700 });
        const broker = await startSubscriptionBroker({
          socket: path.join(f.root, role + '.sock'),
          store: shared,
          authorize: role === 'cos' ? admitted : async () => true,
        });
        closers.push(() => broker.close());
        const gateway = await f.gateway(
          path.join(f.root, role + '-egress.sock'),
          role === 'cos' ? turns.allowed : async () => true,
        );
        closers.push(() => gateway.close());
      }
      const run = async (role: string, stage: string) => {
        const mounts = [
          `src=${f.hostRoot}/${role},dst=/home/node`,
          `src=${f.hostRoot}/driver.ts,dst=/fixture/driver.ts,readonly`,
          `src=${f.hostRoot}/ca.pem,dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
          `src=${f.hostRoot}/${role}.sock,dst=/run/nanoclaw/codex-credentials.sock,readonly`,
          `src=${f.hostRoot}/${role}-egress.sock,dst=/run/cos/subscription.sock,readonly`,
          ...(role === 'cos' ? [`src=${f.hostRoot}/turns.sock,dst=/run/cos/turn.sock,readonly`] : []),
        ];
        const name = 'cos-provider-fixture-' + path.basename(f.root).toLowerCase() + '-' + role + '-' + stage;
        f.trackContainer(name);
        await docker([
          'run',
          '--rm',
          '--name',
          name,
          '--pull=never',
          '--network',
          'none',
          '--read-only',
          '--user',
          '1000:1000',
          '-w',
          '/tmp',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--tmpfs',
          '/tmp:rw,nosuid,nodev',
          '--tmpfs',
          '/workspace:rw,nosuid,nodev,uid=1000,gid=1000',
          ...(role === 'cos' ? ['--tmpfs', '/run/cos:rw,noexec,nosuid,nodev,size=1m,mode=0700,uid=1000,gid=1000'] : []),
          ...mounts.flatMap((mount) => ['--mount', 'type=bind,' + mount]),
          '-e',
          'HOME=/home/node',
          '--entrypoint',
          'bun',
          f.image,
          '/fixture/driver.ts',
          role,
          stage,
        ]);
        return JSON.parse(fs.readFileSync(path.join(f.root, role, 'result-' + stage + '.json'), 'utf8')) as Array<{
          type: string;
          text?: string;
        }>;
      };
      const initial = await Promise.all(['ordinary', 'cos'].map((role) => run(role, 'initial')));
      assert.equal(firstReplies.length, 2);
      initial.forEach((events) => {
        assert.equal(
          events.some((event) => event.type === 'error'),
          false,
        );
        assert.ok(events.some((event) => event.type === 'result' && event.text?.includes('Fixture answer')));
      });
      const identities = ['ordinary', 'cos'].map((role) =>
        fs.readFileSync(path.join(f.root, role, 'continuation'), 'utf8'),
      );
      assert.notEqual(identities[0].split(':').at(-1), identities[1].split(':').at(-1));
      expired = true;
      const interrupted = await Promise.all(['ordinary', 'cos'].map((role) => run(role, 'expired')));
      interrupted.forEach((events) => assert.ok(events.some((event) => event.type === 'error')));
      assert.equal(renewals, 2);
      assert.equal(f.refreshes(), 1);
      assert.equal(f.inspections.length, 1);
      assert.equal(requests.filter((request) => request.accepted).length, 2, 'failed turns must not be replayed');
      const resumed = await Promise.all(['ordinary', 'cos'].map((role) => run(role, 'resumed')));
      resumed.forEach((events) => {
        assert.equal(
          events.some((event) => event.type === 'error'),
          false,
        );
        assert.ok(events.some((event) => event.type === 'result' && event.text?.includes('Fixture answer')));
      });
      for (const [index, role] of ['ordinary', 'cos'].entries()) {
        assert.equal(fs.readFileSync(path.join(f.root, role, 'continuation'), 'utf8'), identities[index]);
        const cache = JSON.parse(fs.readFileSync(path.join(f.root, role, '.codex/auth.json'), 'utf8'));
        assert.equal(cache.tokens.refresh_token, '');
        assert.equal(cache.tokens.access_token, jwt(1));
        assert.ok(
          requests.some(
            (request) =>
              request.role === role && request.accepted && request.input.includes('resumed explicit follow-up.'),
          ),
        );
      }
      assert.equal(attempts.size, 3);
      assert.equal(requests.filter((request) => request.accepted).length, 4);
      assert.equal(fs.existsSync(path.join(f.state, 'operation.json')), false);

      const cancelled = run('cos', 'cancelled');
      void cancelled.catch(() => {});
      const deadline = Date.now() + 15000;
      while (!lateReply && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.ok(lateReply, 'native CoS turn did not reach the pending-response barrier');
      const container = 'cos-provider-fixture-' + path.basename(f.root).toLowerCase() + '-cos-cancelled';
      let stopped: Promise<unknown> | undefined;
      const unexpected = () => {
        throw new Error('pause attempted a model or database effect');
      };
      const controller = new CosController({
        db: boundary,
        enabled: () => false,
        facts: async () => ({
          id: 'private',
          type: 'P',
          delete_at: 0,
          members: ['owner', 'bot'],
          activeSubscription: true,
        }),
        session: () => session,
        decide: unexpected,
        acknowledge: unexpected,
        project: unexpected,
        wake: unexpected,
        stop: (id) => {
          assert.equal(id, binding.sessionId);
          stopped = docker(['stop', '--time', '2', container]);
          void stopped.catch(() => {});
        },
      });
      await controller.ingress(binding, {
        channelType: 'mattermost',
        platformId: 'mattermost:fixture:private',
        threadId: null,
        message: {
          id: 'pause-fixture',
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ senderId: 'mattermost:owner', text: 'cos pause automation' }),
        },
      });
      assert.ok(stopped, 'verified owner pause must stop the active native container');
      assert.equal(await admitted(), false);
      await stopped;
      await assert.rejects(cancelled);
      await assert.rejects(docker(['inspect', container]));
      lateReply();
      assert.equal(fs.existsSync(path.join(f.root, 'cos', 'result-cancelled.json')), false);
      assert.equal(fs.readFileSync(path.join(f.root, 'cos', 'continuation'), 'utf8'), identities[1]);
      const denied = await run('cos', 'paused');
      assert.ok(denied.some((event) => event.type === 'error'));
      assert.equal(requests.length, 5, 'pause must prevent a new model request or a replay');
      assert.equal(attempts.size, 4, 'cancelled outcome remains charged; refused attempts do not refill usage');
    } finally {
      await Promise.all(closers.map((close) => close()));
      await f.close();
      boundary.close();
    }
  },
);

/** Real research entry points and native RPC; synthetic admission/provider only, no PostgreSQL claim. */
for (const cancel of [false, true])
  test(
    'S05-T02/T03/T04/T12 two native specialists keep separate context, provider state and restricted mounts' +
      (cancel ? ' during exact-child stop' : ''),
    { timeout: 120000 },
    async () => {
      const f = await fixture(),
        closers: Array<() => Promise<void>> = [];
      const db = initTestDb();
      runMigrations(db);
      let stopped = false;
      let providerFailure: unknown;
      const pumps: Promise<void>[] = [],
        runs: Promise<unknown>[] = [];
      try {
        const store = f.create();
        const children: Array<{
          role: string;
          identity: CosMissionIdentity;
          canary: string;
          providerDirectory: string;
          base: string;
          inputId: string;
          outbound: Database.Database;
          launch: ReturnType<typeof restrictedLaunch>;
          reads(): number;
          reservations(): number;
          revoke(): void;
        }> = [];
        for (const role of ['alpha', 'bravo']) {
          const base = path.join(f.root, role),
            sessionDirectory = path.join(base, 'cos-v1'),
            providerDirectory = path.join(base, 'provider'),
            contextDirectory = path.join(base, 'context');
          for (const directory of [base, sessionDirectory, providerDirectory, contextDirectory])
            fs.mkdirSync(directory, { mode: 0o700 });
          const identity: CosMissionIdentity = {
            scopeId: 'fixture',
            missionId: 'mission-' + role,
            attemptId: randomUUID(),
            generation: 1,
            agentGroupId: 'group-' + role,
            sessionId: 'session-' + role,
            provider: 'codex',
          };
          const inputId = 'input-' + role,
            canary = 'SPECIALIST_' + role.toUpperCase() + '_PRIVATE_CANARY';
          const order = sealResearchWorkOrder({
            missionId: identity.missionId,
            request: {
              question: 'Compare the admitted note.',
              goal_id: null,
              project_id: null,
              sources: [{ source_id: 'note-' + role, revision_id: 'revision-' + role }],
              acceptance_criteria: [{ id: 'comparison', description: 'Cite the assigned source.' }],
              limits: { ...MISSION_DEFAULT_LIMITS },
            },
            origin: {
              scopeId: 'fixture',
              ownerId: 'owner',
              agentGroupId: 'main',
              sessionId: 'main',
              ingressId: 'ingress',
              bindingDigest: digest('fixture'),
              delegationDigest: digest('fixture-delegation'),
              contextGeneration: randomUUID(),
            },
            related: { goal: null, project: null },
            sources: [
              {
                source_id: 'note-' + role,
                revision_id: 'revision-' + role,
                source_version: 1,
                revision_digest: digest(canary),
                title: 'Assigned note',
                status: 'current',
                chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: canary }],
              },
            ],
            provider: {
              profile: RESEARCH_TEMPLATE.providerProfile,
              model: 'gpt-6-astra',
              policyDigest: digest('fixture-policy'),
            },
            reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
            issuedAt: new Date().toISOString(),
          });
          for (const [name, value] of Object.entries({
            'work-order.json': order.body,
            'context.json': order.context,
            'template.json': RESEARCH_TEMPLATE,
          }))
            fs.writeFileSync(path.join(contextDirectory, name), JSON.stringify(value), { mode: 0o400 });
          const mission = {
            missionId: identity.missionId,
            attemptId: identity.attemptId,
            inputId,
            generation: 1,
            workOrderDigest: order.digest,
            contextDigest: order.body.contextDigest,
            templateDigest: digest(RESEARCH_TEMPLATE),
          };
          const configurationFile = path.join(base, 'configuration.json');
          fs.writeFileSync(
            configurationFile,
            JSON.stringify({
              provider: 'codex',
              model: 'gpt-6-astra',
              runtime: 'codex-subscription/v1',
              profile: 'research',
              contextGeneration: identity.attemptId,
              agentGroupId: identity.agentGroupId,
              assistantName: 'CoS Research',
              groupName: 'CoS Research',
              maxMessagesPerPrompt: 1,
              mcpServers: {},
              mission,
            }),
            { mode: 0o600 },
          );
          for (const kind of ['inbound', 'outbound'] as const)
            ensureSchema(path.join(sessionDirectory, kind + '.db'), kind);
          const inbound = openInboundDb(path.join(sessionDirectory, 'inbound.db')),
            outbound = openOutboundDb(path.join(sessionDirectory, 'outbound.db'));
          closers.push(async () => {
            inbound.close();
            outbound.close();
          });
          ensureRpcSchema(inbound);
          inbound.prepare('INSERT INTO messages_in(id,seq,kind,timestamp,content) VALUES(?,1,?,?,?)').run(
            inputId,
            'task',
            new Date().toISOString(),
            JSON.stringify({
              text: 'Perform the approved read-only research work order using only its admitted context.',
              mission: {
                mission_id: identity.missionId,
                attempt_id: identity.attemptId,
                generation: 1,
                work_order_digest: order.digest,
              },
            }),
          );
          createAgentGroup({
            id: identity.agentGroupId,
            name: 'CoS research',
            folder: identity.agentGroupId,
            agent_provider: 'codex',
            created_at: new Date().toISOString(),
          });
          const session: Session = {
            id: identity.sessionId,
            agent_group_id: identity.agentGroupId,
            messaging_group_id: null,
            thread_id: null,
            agent_provider: 'codex',
            status: 'active',
            container_status: 'running',
            created_at: new Date().toISOString(),
            last_active: null,
          };
          createSession(session);
          installCosMissionBoundary(identity, db);
          let allowed = true,
            reads = 0,
            reservations = 0;
          const lease = { owner: 'fixture-host', fence: 1 };
          const handler = createMissionRpcHandler({
            resolve: async () => (allowed ? { identity, lease } : null),
            runs: {
              readContext: async (actual) => {
                assert.deepEqual(actual, identity);
                reads++;
                return { status: 'ok', work_order: order.body, context: order.context };
              },
            },
            submit: async () => {
              throw Error('fixture does not submit results');
            },
          });
          const seen = new Set<string>();
          pumps.push(
            (async () => {
              while (!stopped) {
                for (const row of outbound
                  .prepare('SELECT id,kind,content FROM messages_out ORDER BY seq')
                  .all() as Array<{ id: string; kind: string; content: string }>) {
                  if (seen.has(row.id)) continue;
                  assert.equal(row.kind, 'system');
                  await handler(JSON.parse(row.content), session, inbound);
                  seen.add(row.id);
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
              }
            })(),
          );
          // Surface asynchronous fixture failures in the test body so its cleanup still runs.
          void pumps.at(-1)!.catch((error) => {
            providerFailure ??= error;
          });
          const credentialSocket = path.join(f.root, role + '-credential.sock'),
            turnSocket = path.join(f.root, role + '-turn.sock'),
            gatewaySocket = path.join(f.root, role + '-gateway.sock');
          const broker = await startSubscriptionBroker({
            socket: credentialSocket,
            store,
            authorize: async () => allowed,
          });
          closers.push(() => broker.close());
          const turns = await startSubscriptionTurns({
            socket: turnSocket,
            authorize: async () => allowed,
            reserve: () => {
              reservations++;
              return reservations === 1;
            },
          });
          closers.push(() => turns.close());
          const gateway = await f.gateway(gatewaySocket, turns.allowed);
          closers.push(() => gateway.close());
          const launch = restrictedLaunch({
            image: f.image,
            sessionDirectory,
            configurationFile,
            gatewaySocket,
            uid: process.getuid!(),
            gid: process.getgid!(),
            entry: 'research',
            subscription: { providerDirectory, credentialSocket, turnSocket, contextGeneration: identity.attemptId },
            research: { contextDirectory, binding: mission },
          });
          launch.args = launch.args.map((arg) =>
            arg.startsWith('type=bind,') ? arg.replace('src=' + f.root + '/', 'src=' + f.hostRoot + '/') : arg,
          );
          launch.args.splice(
            launch.args.indexOf(f.image),
            0,
            '--mount',
            `type=bind,src=${f.hostRoot}/ca.pem,dst=/etc/ssl/certs/ca-certificates.crt,readonly`,
          );
          f.trackContainer(launch.containerName);
          children.push({
            role,
            identity,
            canary,
            base,
            providerDirectory,
            inputId,
            outbound,
            launch,
            reads: () => reads,
            reservations: () => reservations,
            revoke() {
              allowed = false;
            },
          });
        }
        const toolManifests: string[][] = [];
        const pending = new Map<string, () => void>(),
          requests: Array<{ role: string; input: string }> = [];
        const respondChecked = (
          body: { input?: unknown; generate?: boolean; tools?: unknown },
          send: (events: unknown[]) => void,
        ) => {
          // Astra declares its tools in additional_tools, through an isolated V8 wrapper.
          assert.equal(body.tools, undefined);
          for (const item of (body.input ?? []) as Array<{
            type: string;
            tools?: Array<{ name: string; tools: Array<{ name: string; description: string }> }>;
          }>) {
            if (item.type !== 'additional_tools') continue;
            assert.deepEqual(
              item.tools?.map((tool) => tool.name),
              ['functions'],
            );
            const functions = item.tools![0].tools;
            assert.deepEqual(functions.map((tool) => tool.name).sort(), [
              'exec',
              'request_user_input',
              'request_user_input_async',
              'wait',
            ]);
            const description = functions.find((tool) => tool.name === 'exec')!.description;
            const names = [...description.matchAll(/### `([^`]+)`/g)].map((match) => match[1]).sort();
            assert.deepEqual(names, ['clock__curr_time', 'cos_mission_context_get', 'cos_result_submit']);
            toolManifests.push(names);
          }
          if (body.generate === false) {
            send([
              {
                type: 'response.completed',
                response: { id: 'warmup', object: 'response', status: 'completed', output: [] },
              },
            ]);
            return;
          }
          const input = JSON.stringify(body.input),
            child = children.find((c) => input.includes(c.identity.missionId));
          assert.ok(child, 'model request must include the exact stable mission input');
          const other = children.find((c) => c !== child)!;
          assert.equal(input.includes(other.canary), false);
          requests.push({ role: child.role, input });
          const hasContext = input.includes(child.canary),
            id = 'response-' + randomUUID();
          const item = hasContext
            ? {
                id: 'msg-' + id,
                type: 'message',
                role: 'assistant',
                status: 'completed',
                content: [{ type: 'output_text', text: 'Synthetic specialist complete.', annotations: [] }],
              }
            : {
                id: 'fc-' + id,
                type: 'custom_tool_call',
                call_id: 'call-' + id,
                namespace: 'functions',
                name: 'exec',
                input: `if(typeof process!=='undefined'||typeof require!=='undefined'||typeof fetch!=='undefined')throw Error('ambient capability');
const names=ALL_TOOLS.map(tool=>tool.name).sort();if(JSON.stringify(names)!==JSON.stringify(['clock__curr_time','cos_mission_context_get','cos_result_submit']))throw Error('unexpected tools');text(await tools.cos_mission_context_get({}));`,
                status: 'completed',
              };
          const events = [
            { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
            { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress' } },
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id,
                object: 'response',
                status: 'completed',
                output: [item],
                usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
              },
            },
          ];
          if (hasContext) pending.set(child.role, () => send(events));
          else send(events);
        };
        const respond = (body: Parameters<typeof respondChecked>[0], send: Parameters<typeof respondChecked>[1]) => {
          try {
            respondChecked(body, send);
            // eslint-disable-next-line no-catch-all/no-catch-all -- Rethrown by the test body after its asynchronous barrier, preserving container cleanup.
          } catch (error) {
            providerFailure = error;
          }
        };
        f.modelResponse(async (request, response) => {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const raw = Buffer.concat(chunks);
          respond(
            JSON.parse((request.headers['content-encoding'] === 'zstd' ? zstdDecompressSync(raw) : raw).toString()),
            (events) => {
              response.writeHead(200, { 'content-type': 'text/event-stream' });
              response.end(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''));
            },
          );
        });
        const websocket = new WebSocketServer({ noServer: true });
        f.backend.on('upgrade', (request, socket, head) =>
          websocket.handleUpgrade(request, socket, head, (client) =>
            client.on('message', (message) =>
              respond(JSON.parse(message.toString()), (events) =>
                events.forEach((event) => client.send(JSON.stringify(event), () => {})),
              ),
            ),
          ),
        );
        closers.push(async () => {
          for (const client of websocket.clients) client.terminate();
          await new Promise<void>((resolve) => websocket.close(() => resolve()));
        });
        for (const child of children) {
          const running = docker(child.launch.args);
          void running.catch(() => {});
          runs.push(running);
        }
        const deadline = Date.now() + 30000;
        while (pending.size < 2 && !providerFailure && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (providerFailure) throw providerFailure;
        assert.ok(toolManifests.length >= 2, 'both native app servers must declare the specialist tools');
        assert.equal(
          pending.size,
          2,
          'both native specialists must read their context and overlap at the model barrier',
        );
        for (const child of children) {
          const other = children.find((c) => c !== child)!,
            inspected = JSON.parse((await docker(['inspect', child.launch.containerName])).stdout)[0];
          assert.equal(inspected.HostConfig.NetworkMode, 'none');
          assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
          assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
          assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
          assert.equal(inspected.Image, f.image);
          const mounts = inspected.Mounts.filter((m: { Type: string }) => m.Type === 'bind');
          assert.deepEqual(
            mounts.map((m: { Destination: string }) => m.Destination).sort(),
            [
              '/etc/ssl/certs/ca-certificates.crt',
              '/home/node/.codex',
              '/run/cos/mission/context.json',
              '/run/cos/mission/template.json',
              '/run/cos/mission/work-order.json',
              '/run/cos/subscription.sock',
              '/run/cos/turn.sock',
              '/run/nanoclaw/codex-credentials.sock',
              '/workspace',
              '/workspace/agent/container.json',
              '/workspace/inbound.db',
            ].sort(),
          );
          assert.equal(
            mounts.some((m: { Source: string }) => m.Source.includes('/' + other.role + '/')),
            false,
          );
          assert.deepEqual(
            mounts
              .filter((m: { RW: boolean }) => m.RW)
              .map((m: { Destination: string }) => m.Destination)
              .sort(),
            ['/home/node/.codex', '/workspace'],
          );
          assert.equal(
            mounts.some(
              (m: { Destination: string }) =>
                m.Destination.startsWith('/app') || m.Destination === '/var/run/docker.sock',
            ),
            false,
          );
          const probe = `import fs from 'node:fs';import net from 'node:net';import assert from 'node:assert/strict';
        assert.equal(fs.existsSync(${JSON.stringify(other.base)}),false);assert.equal(fs.existsSync('/var/run/docker.sock'),false);
        assert.equal(Object.keys(process.env).some(k=>/^(COS_(TEST_)?PG|PGPASSWORD|OPENAI_API_KEY|SSH_)/.test(k)),false);
        const context=fs.readFileSync('/run/cos/mission/context.json','utf8');assert.ok(context.includes(${JSON.stringify(child.canary)}));assert.equal(context.includes(${JSON.stringify(other.canary)}),false);
        for(const file of ['/workspace/inbound.db','/run/cos/mission/context.json','/app/src/forbidden-write']){assert.throws(()=>fs.writeFileSync(file,'FORBIDDEN'));}
        const denied=await new Promise(resolve=>{const socket=net.connect({host:'192.0.2.1',port:5432});socket.setTimeout(1000);socket.once('connect',()=>{socket.destroy();resolve(false)});socket.once('error',()=>resolve(true));socket.once('timeout',()=>{socket.destroy();resolve(true)});});assert.equal(denied,true);console.log('specialist-isolation-passed');`;
          assert.equal(
            (await docker(['exec', child.launch.containerName, 'bun', '-e', probe])).stdout.trim(),
            'specialist-isolation-passed',
          );
          assert.equal(child.reads(), 1);
          assert.equal(child.reservations(), 1);
        }
        if (cancel) {
          const child = children[0];
          child.revoke();
          const probe = new RestrictedExecutionProbe(getInstallSlug(process.cwd()));
          const workspace = path.join(f.hostRoot, child.role, 'cos-v1');
          assert.equal(probe.present(workspace), true);
          probe.stop(workspace);
          const end = Date.now() + 10000;
          while (probe.present(workspace) && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 50));
          assert.equal(probe.present(workspace), false);
          assert.equal(
            (
              await docker(['inspect', '--format', '{{.State.Running}}', children[1].launch.containerName])
            ).stdout.trim(),
            'true',
          );
        }
        for (const [role, send] of pending) if (!cancel || role !== children[0].role) send();
        const finished = await Promise.allSettled(runs);
        if (providerFailure) throw providerFailure;
        for (const child of children) {
          const status = (
            child.outbound.prepare('SELECT status FROM processing_ack WHERE message_id=?').get(child.inputId) as {
              status: string;
            }
          ).status;
          if (cancel && child === children[0]) assert.notEqual(status, 'completed');
          else {
            assert.equal(status, 'completed');
            assert.equal(finished[children.indexOf(child)].status, 'fulfilled');
          }
          const history = fs
            .readdirSync(child.providerDirectory, { recursive: true })
            .filter((name) => String(name).endsWith('.jsonl'))
            .map((name) => fs.readFileSync(path.join(child.providerDirectory, String(name)), 'utf8'))
            .join('\n');
          assert.ok(history.includes(child.canary));
          assert.equal(history.includes(children.find((c) => c !== child)!.canary), false);
          const cache = JSON.parse(fs.readFileSync(path.join(child.providerDirectory, 'auth.json'), 'utf8'));
          assert.equal(cache.tokens.refresh_token, '');
          assert.equal(cache.tokens.access_token, jwt(0));
          assert.equal(child.outbound.prepare("SELECT 1 FROM messages_out WHERE kind<>'system'").get(), undefined);
          assert.ok(requests.some((r) => r.role === child.role && r.input.includes(child.canary)));
        }
      } finally {
        stopped = true;
        await Promise.allSettled(pumps);
        for (const close of closers.reverse()) await close();
        await f.close();
        await Promise.allSettled(runs);
        closeDb();
      }
    },
  );
