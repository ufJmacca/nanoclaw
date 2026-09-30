/** Packaged native-auth fixture: synthetic credentials, network-none Docker containers only. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import https from 'node:https';
import net from 'node:net';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createSubscriptionAuthStore } from '../../providers/codex-subscription-auth.js';
import { createSubscriptionNativeCheck } from '../../providers/codex-subscription-runner.js';
import { startSubscriptionEgress } from '../../modules/chief-of-staff/bridge/subscription-egress.js';
import { safeHostEnvironment } from '../../host-environment.js';

const execute = promisify(execFile);
const docker = (args: string[]) =>
  execute('docker', args, { env: safeHostEnvironment('docker'), timeout: 45000, maxBuffer: 16384 });
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
  const backend = https.createServer(
    { key: fs.readFileSync(key), cert: fs.readFileSync(path.join(root, 'server.pem')) },
    async (request, response) => {
      const reply = (value: unknown, status = 200) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(value));
      };
      if (request.url === '/oauth/token') {
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
    source,
    state,
    inspections,
    create,
    refreshes: () => refreshes,
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
