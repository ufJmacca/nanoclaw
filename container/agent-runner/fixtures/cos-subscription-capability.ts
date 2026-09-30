import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { CosCodexProvider } from '../src/providers/codex-cos.js';
import { initTestSessionDb, closeSessionDb } from '../src/db/connection.js';
import { setContinuation, getContinuation } from '../src/db/session-state.js';
import { digest } from '../src/mcp-tools/generated/cos-protocol.js';
import { subscriptionConfig, subscriptionThreadParams } from '../src/providers/codex-subscription-policy.js';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { startSubscriptionRelay } from '../src/cos-subscription-relay.js';
import { checkSubscriptionAccount, subscriptionProcessEnvironment } from '../src/providers/codex-subscription-check.js';
import assert from 'node:assert/strict';
import {
  spawnCodexAppServer,
  initializeCodexAppServer,
  sendCodexRequest,
  sendCodexResponse,
  killCodexAppServer,
} from '../src/providers/codex-app-server.js';

/** Offline native-protocol fixture. Run only in a disposable --network none container.
 * Synthetic auth shape follows upstream rust-v0.158.0 app-server/tests/common/auth_fixtures.rs.
 * Never load this fixture into a real provider process or mount real authentication.
 */
if (
  process.env.NANOCLAW_COS_OFFLINE_FIXTURE !== '1' ||
  process.env.HOME !== '/home/node' ||
  fs.existsSync('/home/node/.codex/auth.json') ||
  Object.values(os.networkInterfaces())
    .flat()
    .some((address) => address && !address.internal)
)
  throw new Error('disposable_offline_fixture_required');
fs.mkdirSync('/workspace/agent', { recursive: true });
fs.mkdirSync('/home/node/.codex', { recursive: true });
const jwt = (claims: object) =>
  Buffer.from('{}').toString('base64url') +
  '.' +
  Buffer.from(JSON.stringify(claims)).toString('base64url') +
  '.fixture-signature';
const token = jwt({
  exp: 4102444800,
  email: 'fixture@example.invalid',
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' },
});
const rotatedToken = jwt({
  exp: 4102444800,
  email: 'fixture@example.invalid',
  jti: 'rotated',
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture-account', chatgpt_plan_type: 'plus' },
});
let refreshCalls = 0;
fs.writeFileSync(
  '/home/node/.codex/auth.json',
  JSON.stringify({
    auth_mode: 'chatgpt',
    OPENAI_API_KEY: null,
    tokens: { id_token: token, access_token: token, refresh_token: 'fixture-refresh', account_id: 'fixture-account' },
    last_refresh: new Date().toISOString(),
  }),
  { mode: 0o600 },
);
const requests: any[] = [];
const dispatched: string[] = [];
const proxied = process.env.NANOCLAW_COS_FIXTURE_EGRESS_MODULE;
const systemTrust = process.env.NANOCLAW_COS_FIXTURE_SYSTEM_TRUST === '1';
const productionQuery = process.env.NANOCLAW_COS_FIXTURE_PRODUCTION_QUERY === '1';
if (productionQuery && !systemTrust) throw new Error('production_query_requires_system_trust');
if (systemTrust && !proxied) throw new Error('system_trust_requires_offline_proxy');
const destinations: Array<{ role: string; host: string }> = [];
execFileSync(
  'openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    '/tmp/fixture-ca-key.pem',
    '-out',
    '/tmp/fixture-ca.pem',
    '-days',
    '1',
    '-subj',
    '/CN=Offline fixture CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
  ],
  { stdio: 'ignore' },
);
execFileSync(
  'openssl',
  [
    'req',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    '/tmp/fixture-key.pem',
    '-out',
    '/tmp/fixture.csr',
    '-subj',
    '/CN=127.0.0.1',
  ],
  { stdio: 'ignore' },
);
fs.writeFileSync(
  '/tmp/fixture-extensions',
  'basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1,DNS:chatgpt.com,DNS:auth.openai.com\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n',
);
execFileSync(
  'openssl',
  [
    'x509',
    '-req',
    '-in',
    '/tmp/fixture.csr',
    '-CA',
    '/tmp/fixture-ca.pem',
    '-CAkey',
    '/tmp/fixture-ca-key.pem',
    '-CAcreateserial',
    '-out',
    '/tmp/fixture-cert.pem',
    '-days',
    '1',
    '-extfile',
    '/tmp/fixture-extensions',
  ],
  { stdio: 'ignore' },
);
if (systemTrust) {
  // This optional final-entry proof runs with an empty, writable fixture-only
  // /etc/ssl/certs mount. The production process receives no CA override.
  fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt', fs.readFileSync('/tmp/fixture-ca.pem'));
} else process.env.CODEX_CA_CERTIFICATE = '/tmp/fixture-ca.pem';
if (!proxied) process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = 'https://127.0.0.1:8787/fixture/oauth/token';
function respond(body: any, send: (text: string) => void) {
  if (body.generate !== false) requests.push(body);
  console.log(
    JSON.stringify({
      generating: body.generate !== false,
      toolOutputs: body.input?.filter((item: any) => item.type.includes('call_output')),
    }),
  );
  let item: any = {
    id: 'msg_fixture_' + requests.length,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'Fixture answer ' + requests.length, annotations: [] }],
  };
  if (body.generate !== false) {
    const calls: any[] = [
      {
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input: 'text(await tools.cos_context_get({}));',
      },
      {
        type: 'function_call',
        name: 'exec_command',
        arguments: JSON.stringify({ cmd: 'cat /home/node/.codex/auth.json; touch /tmp/escaped' }),
      },
      {
        type: 'custom_tool_call',
        name: 'apply_patch',
        input: '*** Begin Patch\n*** Add File: /tmp/escaped\n+pwned\n*** End Patch',
      },
      {
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input:
          'text({process:typeof process,fetch:typeof fetch,require:typeof require}); try {text(await tools.exec_command({cmd:"cat /home/node/.codex/auth.json"}));} catch {text("shell-unavailable");}',
      },
    ];
    if (requests.length <= calls.length)
      item = {
        id: 'call_' + requests.length,
        call_id: 'call_' + requests.length,
        status: 'completed',
        ...calls[requests.length - 1],
      };
  }
  for (const event of [
    {
      type: 'response.created',
      response: { id: 'resp_' + requests.length, object: 'response', status: 'in_progress', output: [] },
    },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: 'resp_' + requests.length,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      },
    },
  ])
    send(JSON.stringify(event));
}
const upstream = Bun.serve({
  hostname: '127.0.0.1',
  port: 8787,
  tls: { key: fs.readFileSync('/tmp/fixture-key.pem'), cert: fs.readFileSync('/tmp/fixture-cert.pem') },
  async fetch(req, server) {
    const url = new URL(req.url);
    console.log(
      JSON.stringify({
        path: url.pathname,
        method: req.method,
        authFixture: [token, rotatedToken].some((value) => req.headers.get('authorization') === `Bearer ${value}`),
      }),
    );
    if (server.upgrade(req)) return;
    if (url.pathname === '/fixture/oauth/token' || url.pathname === '/oauth/token') {
      const raw = await req.text();
      const body = req.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, 'fixture-refresh');
      refreshCalls++;
      return Response.json({
        access_token: rotatedToken,
        id_token: rotatedToken,
        refresh_token: 'fixture-refresh-rotated',
        token_type: 'Bearer',
        expires_in: 3600,
      });
    }
    if (url.pathname.endsWith('/accounts/check'))
      return Response.json({
        accounts: [
          {
            id: 'fixture-account',
            workspace_backend_origin: proxied ? 'https://chatgpt.com' : 'https://127.0.0.1:8787',
            account_routing_override: 'NO_CONSTRAINT',
          },
        ],
      });
    if (req.method === 'POST') {
      const events: string[] = [];
      respond(await req.json(), (text) => events.push('data: ' + text + '\n\n'));
      return new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({}, { status: 404 });
  },
  websocket: {
    message(ws, message) {
      respond(JSON.parse(String(message)), (text) => ws.send(text));
    },
  },
});
// Direct mode uses fixture-only endpoints. Proxied mode retains native URLs;
// the offline gateway redirects validated destinations to this TLS fixture.
fs.writeFileSync(
  '/home/node/.codex/config.toml',
  (proxied
    ? ''
    : 'chatgpt_base_url = "https://127.0.0.1:8787"\n' +
      'openai_base_url = "https://127.0.0.1:8787/backend-api/codex"\n') +
    subscriptionConfig('gpt-6-astra', 'low') +
    'enable_request_compression = false\n',
);
let server: any;
let gateway: ReturnType<typeof spawn> | undefined;
let relay: Awaited<ReturnType<typeof startSubscriptionRelay>> | undefined;
let credentialBroker: http.Server | undefined;
let rpcPoll: ReturnType<typeof setInterval> | undefined;
const watchdog = setTimeout(() => {
  console.error('probe_timeout');
  process.exit(2);
}, 45000);
async function switchGateway(role: 'auth' | 'query') {
  await relay?.close();
  if (gateway) {
    const exited = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await exited;
  }
  if (!proxied) return;
  fs.mkdirSync('/tmp/fixture-egress', { recursive: true, mode: 0o700 });
  // Exercise the actual Node host module. Only this offline fixture replaces
  // DNS and the TCP dial target; Codex itself uses its native production URLs.
  gateway = spawn(
    'node',
    [
      '--experimental-strip-types',
      '--input-type=module',
      '-e',
      `
    import net from 'node:net';
    const {startSubscriptionEgress} = await import(${JSON.stringify(proxied)});
    const gateway = await startSubscriptionEgress({
      socketPath:'/tmp/fixture-egress/proxy.sock',role:${JSON.stringify(role)},authorize:async()=>true,
      dependencies:{resolve:async host=>{console.log(JSON.stringify({destination:host}));return [{address:'8.8.8.8',family:4}]},
        connect:()=>net.createConnection({host:'127.0.0.1',port:8787})}
    });
    process.once('SIGTERM',()=>{void gateway.close().then(()=>process.exit(0))});
    console.log('fixture_egress_ready');
  `,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    let output = '';
    gateway!.once('error', reject);
    gateway!.once('exit', () => reject(new Error('fixture_egress_exited')));
    gateway!.stdout!.on('data', (data) => {
      process.stdout.write(data);
      output += String(data);
      const lines = output.split('\n');
      output = lines.pop()!;
      for (const line of lines) {
        if (line === 'fixture_egress_ready') resolve();
        else if (line.startsWith('{')) destinations.push({ role, host: JSON.parse(line).destination });
      }
    });
  });
  relay = await startSubscriptionRelay('/tmp/fixture-egress/proxy.sock');
  if (!productionQuery) {
    process.env.HTTPS_PROXY = relay.proxyUrl;
    process.env.HTTP_PROXY = relay.proxyUrl;
    process.env.ALL_PROXY = relay.proxyUrl;
    process.env.NO_PROXY = '';
  }
}
async function connect() {
  server = spawnCodexAppServer([], { environment: nativeEnvironment() });
  server.serverRequestHandlers.push((req: any) => {
    dispatched.push(req.params.tool ?? req.method);
    console.log(JSON.stringify({ serverRequest: req.method, tool: req.params.tool }));
    sendCodexResponse(server, req.id, {
      success: req.method === 'item/tool/call' && req.params.tool === 'cos_context_get',
      contentItems: [
        {
          type: 'inputText',
          text: req.params.tool === 'cos_context_get' ? 'Approved fixture priority' : 'Fixture denied',
        },
      ],
    });
  });
  await initializeCodexAppServer(server);
}
function nativeEnvironment() {
  // The only addition to the production environment is the offline fixture CA.
  return relay
    ? {
        ...subscriptionProcessEnvironment(relay.proxyUrl),
        ...(systemTrust ? {} : { CODEX_CA_CERTIFICATE: '/tmp/fixture-ca.pem' }),
      }
    : undefined;
}
const params = {
  ...subscriptionThreadParams('gpt-6-astra', 'You are a CoS fixture.'),
  dynamicTools: [
    {
      type: 'function',
      name: 'cos_context_get',
      description: 'Read admitted CoS records.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
};
async function turn(threadId: string, text: string) {
  const finished = new Promise<void>((resolve, reject) => {
    server.notificationHandlers.push((n: any) => {
      if (n.method === 'turn/completed') {
        console.log(JSON.stringify({ completed: n.params.turn?.status }));
        if (n.params.turn?.status === 'completed') resolve();
        else reject(new Error('fixture_turn_failed'));
      }
      if (n.method === 'error') console.log(JSON.stringify({ error: n.params }));
    });
  });
  const start = await sendCodexRequest(server, 'turn/start', {
    threadId,
    input: [{ type: 'text', text }],
    environments: [],
  });
  if (start.error) throw Error(JSON.stringify(start.error));
  await finished;
}
try {
  await switchGateway('auth');
  if (systemTrust) {
    fs.symlinkSync('/tmp/fixture-egress/proxy.sock', '/run/cos/subscription.sock');
    const config = fs.readFileSync('/home/node/.codex/config.toml');
    fs.unlinkSync('/home/node/.codex/config.toml');
    const child = Bun.spawn(['bun', '/app/src/codex-auth.ts', 'refresh', 'gpt-6-astra'], {
      env: { HOME: '/home/node', PATH: process.env.PATH, NANOCLAW_NATIVE_AUTH: 'codex-subscription/v1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), '{"status":"native_check_completed"}');
    fs.writeFileSync('/home/node/.codex/config.toml', config);
  } else {
    const accountServer = spawnCodexAppServer([], { environment: nativeEnvironment(), diagnostic: () => {} });
    await checkSubscriptionAccount(accountServer, 'refresh');
  }
  const refreshed = JSON.parse(fs.readFileSync('/home/node/.codex/auth.json', 'utf8'));
  assert.equal(refreshed.tokens.refresh_token, 'fixture-refresh-rotated');
  assert.equal(refreshed.tokens.access_token, rotatedToken);
  await switchGateway('query');
  // The native refresh owner retains the rotating credential. Query runtimes
  // consume an access-only native cache and never receive a refresh credential.
  refreshed.tokens.refresh_token = '';
  fs.writeFileSync('/home/node/.codex/auth.json', JSON.stringify(refreshed));
  if (productionQuery) {
    fs.chmodSync('/home/node/.codex', 0o700);
    process.env.NANOCLAW_COS_PROTOCOL = 'cos-rpc/v1';
    const { inbound, outbound } = initTestSessionDb();
    inbound.exec(
      'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
    );
    const deliveries = new Set<string>();
    rpcPoll = setInterval(() => {
      for (const row of outbound.query("SELECT content FROM messages_out WHERE kind='system'").all() as {
        content: string;
      }[]) {
        const { request, delivery_id } = JSON.parse(row.content);
        if (deliveries.has(delivery_id)) continue;
        deliveries.add(delivery_id);
        dispatched.push(request.method);
        assert.equal(request.method, 'cos_context_get');
        const response = {
          protocol: 'cos-rpc/v1',
          request_id: request.request_id,
          status: 'ok',
          result: { records: ['Approved fixture priority'] },
        };
        inbound
          .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
          .run(request.request_id, digest(request), delivery_id, JSON.stringify(response), 'fixture');
      }
    }, 10);
    credentialBroker = http.createServer((request, response) => {
      assert.equal(request.url, '/cached');
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ version: 1, authJson: JSON.stringify(refreshed), generation: 'a'.repeat(64) }));
    });
    await new Promise<void>((resolve) => credentialBroker!.listen('/run/nanoclaw/codex-credentials.sock', resolve));
    const run = async (prompt: string) => {
      const provider = new CosCodexProvider({ model: 'gpt-6-astra', proxyUrl: relay!.proxyUrl });
      const query = provider.query({
        prompt,
        cwd: '/workspace/agent',
        continuation: getContinuation('cos-codex'),
        systemContext: { instructions: 'You are a CoS fixture.' },
      });
      query.end();
      let completed = false;
      for await (const event of query.events) {
        if (event.type === 'init') setContinuation('cos-codex', event.continuation);
        if (event.type === 'error') throw new Error('production_provider_failed: ' + event.message);
        if (event.type === 'result') {
          assert.ok(event.text?.includes('Fixture answer'));
          completed = true;
        }
      }
      assert.ok(completed);
    };
    await run('Remember the synthetic colour is amber.');
    const original = getContinuation('cos-codex');
    assert.ok(original?.startsWith('cos-codex-subscription-v1:'));
    await run('Which synthetic colour did I mention?');
    assert.equal(getContinuation('cos-codex'), original);
  } else {
    await connect();
    const created = await sendCodexRequest(server, 'thread/start', params);
    if (created.error) throw Error(JSON.stringify(created.error));
    const threadId = (created.result as any).thread.id;
    await turn(threadId, 'Remember the synthetic colour is amber.');
    killCodexAppServer(server);
    await new Promise((r) => setTimeout(r, 500));
    await connect();
    const { dynamicTools, ...resumeParams } = params;
    const resumed = await sendCodexRequest(server, 'thread/resume', { threadId, ...resumeParams });
    if (resumed.error) throw Error(JSON.stringify(resumed.error));
    await turn(threadId, 'Which synthetic colour did I mention?');
  }
  assert.equal(requests.length, 6);
  assert.ok(JSON.stringify(requests.at(-1).input).includes('amber'));
  assert.deepEqual(dispatched, ['cos_context_get']);
  assert.equal(fs.existsSync('/tmp/escaped'), false);
  assert.equal(JSON.stringify(requests).includes(token), false);
  assert.equal(JSON.stringify(requests).includes(rotatedToken), false);
  assert.equal(JSON.stringify(requests).includes('fixture-refresh'), false);
  assert.equal(refreshCalls, 1);
  if (proxied) {
    assert.ok(destinations.some(({ role, host }) => role === 'auth' && host === 'auth.openai.com'));
    assert.ok(destinations.some(({ role, host }) => role === 'query' && host === 'chatgpt.com'));
    assert.ok(
      destinations.every(({ role, host }) => host === 'chatgpt.com' || (role === 'auth' && host === 'auth.openai.com')),
    );
    assert.equal(process.env.CODEX_REFRESH_TOKEN_URL_OVERRIDE, undefined);
    assert.ok(!fs.readFileSync('/home/node/.codex/config.toml', 'utf8').includes('base_url'));
  }
  const outputs = requests
    .flatMap((request) => request.input ?? [])
    .filter((item: any) => item.type.includes('call_output'));
  const outputText = JSON.stringify(outputs);
  assert.ok(outputText.includes('shell-unavailable'));
  assert.ok(outputText.includes('Approved fixture priority'));
  assert.ok(outputText.includes('unsupported call: exec_command'));
  assert.ok(outputText.includes('unsupported custom tool call: apply_patch'));
  const runtimeOutput = outputs.filter((item: any) => item.call_id === 'call_4').flatMap((item: any) => item.output);
  assert.ok(
    runtimeOutput.some(
      (item: any) => item.text === JSON.stringify({ process: 'undefined', fetch: 'undefined', require: 'undefined' }),
    ),
  );
  const advertised = requests[0].input
    .filter((item: any) => item.type === 'additional_tools')
    .flatMap((item: any) => item.tools);
  const names = advertised.flatMap((tool: any) =>
    tool.type === 'namespace' ? tool.tools.map((child: any) => `${tool.name}.${child.name}`) : [tool.name],
  );
  assert.deepEqual(names.sort(), [
    'functions.exec',
    'functions.request_user_input',
    'functions.request_user_input_async',
    'functions.wait',
  ]);
  const declarations = advertised
    .flatMap((tool: any) => tool.tools ?? [])
    .flatMap((tool: any) =>
      [...(tool.description ?? '').matchAll(/declare const tools: \{ (\w+)\(/g)].map((match: any) => match[1]),
    );
  assert.deepEqual(
    declarations.sort(),
    productionQuery
      ? ['clock__curr_time', 'cos_change_propose', 'cos_context_get', 'cos_request_status']
      : ['clock__curr_time', 'cos_context_get'],
  );
  console.log(
    JSON.stringify({
      probe: 'passed',
      requests: requests.length,
      contextRetained: true,
      dispatched,
      escapeFile: false,
      credentialCanariesAbsent: true,
      nativeRefreshCalls: refreshCalls,
      accessOnlyQueryCache: true,
      fixedDestinationEgress: Boolean(proxied),
      productionAuthEntry: systemTrust,
      productionQueryProvider: productionQuery,
    }),
  );
} finally {
  clearInterval(rpcPoll);
  if (productionQuery) closeSessionDb();
  if (credentialBroker) {
    credentialBroker.closeAllConnections();
    await new Promise<void>((resolve) => credentialBroker!.close(() => resolve()));
  }
  if (server) killCodexAppServer(server);
  await relay?.close();
  if (gateway) {
    const exited = once(gateway, 'exit');
    gateway.kill('SIGTERM');
    await exited;
  }
  upstream.stop(true);
  clearTimeout(watchdog);
}
