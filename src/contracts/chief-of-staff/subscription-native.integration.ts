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
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSubscriptionAuthStore } from '../../providers/codex-subscription-auth.js';
import { createSubscriptionNativeCheck } from '../../providers/codex-subscription-runner.js';
import { startSubscriptionEgress } from '../../modules/chief-of-staff/bridge/subscription-egress.js';
import { safeHostEnvironment } from '../../host-environment.js';
import { startSubscriptionBroker } from '../../providers/codex-subscription-broker.js';
import { startSubscriptionTurns } from '../../modules/chief-of-staff/bridge/subscription-turns.js';

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
  'ordinary and CoS native providers share one renewal and retain separate conversations',
  { timeout: 180000 },
  async () => {
    const f = await fixture();
    const closers: Array<() => Promise<void>> = [];
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
        } else reply();
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
              events.forEach((event) => client.send(JSON.stringify(event))),
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
        authorize: async () => true,
        reserve: (id) => {
          if (attempts.has(id) || attempts.size >= 3) return false;
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
          authorize: async () => true,
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
    } finally {
      await Promise.all(closers.map((close) => close()));
      await f.close();
    }
  },
);
