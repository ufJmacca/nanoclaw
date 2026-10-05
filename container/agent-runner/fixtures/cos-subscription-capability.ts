import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { CosCodexProvider } from '../src/providers/codex-cos.js';
import { cosDynamicTools } from '../src/providers/codex-cos-tools.js';
import { createSubscriptionTurnClient } from '../src/providers/codex-turn-client.js';
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
const finalToken = jwt({
  exp: 4102444800,
  email: 'fixture@example.invalid',
  jti: 'final',
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
const runnerEntry = process.env.NANOCLAW_COS_FIXTURE_RUNNER_ENTRY === '1';
const compaction = process.env.NANOCLAW_COS_FIXTURE_COMPACTION === '1';
const toolRefresh = process.env.NANOCLAW_COS_FIXTURE_TOOL_REFRESH === '1';
const mandateRefresh = process.env.NANOCLAW_COS_FIXTURE_MANDATE_REFRESH === '1';
const cancellation = process.env.NANOCLAW_COS_FIXTURE_CANCELLATION;
const sharedOwner = process.env.NANOCLAW_COS_FIXTURE_SHARED_OWNER === '1';
if (toolRefresh && (!runnerEntry || cancellation || compaction || sharedOwner))
  throw new Error('invalid_tool_refresh_fixture');
if (mandateRefresh && (!runnerEntry || cancellation || compaction || sharedOwner || toolRefresh))
  throw new Error('invalid_mandate_refresh_fixture');
const s01Tools = ['cos_change_propose', 'cos_context_get', 'cos_request_status'];
const legacyCoordinatorTools = cosDynamicTools
  .filter((tool) => !tool.name.startsWith('cos_mandate_') && !tool.name.startsWith('cos_action_'))
  .map((tool) => tool.name);
const mandateMcpTools = [
  'mcp__nanoclaw_cos_mandates__cos_mandate_activity',
  'mcp__nanoclaw_cos_mandates__cos_mandate_propose',
  'mcp__nanoclaw_cos_mandates__cos_action_propose',
  'mcp__nanoclaw_cos_mandates__cos_action_get',
  'mcp__nanoclaw_cos_mandates__cos_action_cancel',
];
const mcpResourceTools = ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'];
if (sharedOwner && (!runnerEntry || cancellation || compaction)) throw new Error('invalid_shared_owner_fixture');
let owner: Awaited<ReturnType<typeof import('./subscription-owner.js').startFixtureOwner>> | undefined;
let ownerReceipt: { nativeOwnerChecks: number; concurrentClients: number; sourceRefreshRetained: boolean } | undefined;
let rejectOldQuery = false;
let rejectedQueries = 0;
if (cancellation && (!['shutdown', 'membership', 'rpc'].includes(cancellation) || !runnerEntry || compaction))
  throw new Error('invalid_cancellation_fixture');
let releaseLateResponse: (() => void) | undefined;
let cancellationChecked = false;
const compactionRequests: any[] = [];
const compactedSummary = 'fixture-opaque-compacted-history-v1';
if (compaction && !runnerEntry) throw new Error('compaction_requires_runner_entry');
if (runnerEntry && !productionQuery) throw new Error('runner_entry_requires_production_query');
let reservedAttempts = 0;
if (productionQuery && !systemTrust) throw new Error('production_query_requires_system_trust');
if (productionQuery) fs.chmodSync('/run/cos', 0o700);
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
  const compacting = body.generate !== false && body.input?.some((item: any) => item.type === 'compaction_trigger');
  if (compacting) compactionRequests.push(body);
  else if (body.generate !== false) requests.push(body);
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
    if (compaction && requests.length === 6) calls[5] = calls[0];
    if (compaction && requests.length === 7) calls[6] = calls[1];
    if (cancellation === 'rpc' && requests.length === 7) calls[6] = calls[0];
    if (toolRefresh && requests.length === 7)
      calls[6] = {
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input: 'text(await tools.cos_knowledge_search({query:"replacement"}));',
      };
    if (mandateRefresh && (requests.length === 6 || requests.length === 7))
      calls[requests.length - 1] = {
        type: 'custom_tool_call',
        namespace: 'functions',
        name: 'exec',
        input:
          requests.length === 6
            ? `text({mandateCatalogue:ALL_TOOLS.filter(t=>t.name.startsWith("mcp__nanoclaw_cos_mandates__")).map(t=>t.name).sort()});text(await tools.${mandateMcpTools[0]}({mandate_id:"mandate-${'a'.repeat(64)}"}));`
            : `try{text(await tools.list_mcp_resources({server:"nanoclaw_cos_mandates"}));}catch{text("resource-list-unavailable");}try{text(await tools.list_mcp_resource_templates({server:"nanoclaw_cos_mandates"}));}catch{text("resource-templates-unavailable");}try{text(await tools.read_mcp_resource({server:"nanoclaw_cos_mandates",uri:"file:///home/node/.codex/auth.json"}));}catch{text("resource-unavailable");}try{text(await tools.read_mcp_resource({server:"unconfigured",uri:"file:///home/node/.codex/auth.json"}));}catch{text("unconfigured-server-unavailable");}text(await tools.${mandateMcpTools[0]}({mandate_id:"mandate-${'a'.repeat(64)}",scope_id:"scope-authority-canary"}));`,
      };
    if (calls[requests.length - 1])
      item = {
        id: 'call_' + requests.length,
        call_id: 'call_' + requests.length,
        status: 'completed',
        ...calls[requests.length - 1],
      };
  }
  if (compacting) {
    assert.ok(compaction);
    item = { type: 'compaction', encrypted_content: compactedSummary };
  }
  // Provider-reported usage triggers native auto-compaction without changing the
  // production CoS policy or supplying a model-controlled configuration override.
  const inputTokens = compaction && !compacting && body.generate !== false && requests.length === 5 ? 10_000_000 : 10;
  const responseId = compacting ? 'compact_' + compactionRequests.length : 'resp_' + requests.length;
  const events = [
    {
      type: 'response.created',
      response: { id: responseId, object: 'response', status: 'in_progress', output: [] },
    },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_item.done', output_index: 0, item },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        output: [item],
        usage: { input_tokens: inputTokens, output_tokens: 3, total_tokens: inputTokens + 3 },
      },
    },
  ];
  const publish = () => {
    for (const event of events) send(JSON.stringify(event));
  };
  if (cancellation && cancellation !== 'rpc' && body.generate !== false && requests.length === 7)
    releaseLateResponse = publish;
  else publish();
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
        authFixture: [token, rotatedToken, finalToken].some(
          (value) => req.headers.get('authorization') === `Bearer ${value}`,
        ),
      }),
    );
    if (
      rejectOldQuery &&
      url.pathname.endsWith('/responses') &&
      req.headers.get('authorization') === `Bearer ${rotatedToken}`
    ) {
      rejectedQueries++;
      return Response.json(
        { error: { message: 'Synthetic expired access', type: 'invalid_request_error', code: 'invalid_api_key' } },
        { status: 401 },
      );
    }
    if (server.upgrade(req)) return;
    if (url.pathname === '/fixture/oauth/token' || url.pathname === '/oauth/token') {
      const raw = await req.text();
      const body = req.headers.get('content-type')?.includes('application/json')
        ? JSON.parse(raw)
        : Object.fromEntries(new URLSearchParams(raw));
      assert.equal(body.grant_type, 'refresh_token');
      assert.equal(body.refresh_token, refreshCalls === 0 ? 'fixture-refresh' : 'fixture-refresh-rotated');
      assert.ok(refreshCalls === 0 || (sharedOwner && refreshCalls === 1));
      refreshCalls++;
      return Response.json({
        access_token: refreshCalls === 1 ? rotatedToken : finalToken,
        id_token: refreshCalls === 1 ? rotatedToken : finalToken,
        refresh_token: refreshCalls === 1 ? 'fixture-refresh-rotated' : 'fixture-refresh-final',
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
let rpcFailure: unknown;
let stopRunner: (() => Promise<void>) | undefined;
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
    import fs from 'node:fs';
    const {startSubscriptionEgress} = await import(${JSON.stringify(proxied)});
    let turns;
    if (${productionQuery && role === 'query'}) {
      const {startSubscriptionTurns} = await import('file:///fixture/subscription-turns.ts');
      const attempts = new Set();
      turns = await startSubscriptionTurns({socket:'/run/cos/turn.sock',authorize:async()=>!fs.existsSync('/tmp/fixture-revoked'),reserve:id=>{
        if(attempts.has(id)||attempts.size>=${toolRefresh || sharedOwner ? 4 : compaction || cancellation || mandateRefresh ? 3 : 2})return false;
        attempts.add(id);console.log(JSON.stringify({turnReserved:true}));return true;
      }});
    }
    const gateway = await startSubscriptionEgress({
      socketPath:'/tmp/fixture-egress/proxy.sock',role:${JSON.stringify(role)},authorize:async()=>turns?turns.allowed():true,
      dependencies:{resolve:async host=>{console.log(JSON.stringify({destination:host}));return [{address:'8.8.8.8',family:4}]},
        connect:()=>net.createConnection({host:'127.0.0.1',port:8787})}
    });
    process.once('SIGTERM',()=>{void gateway.close().then(()=>turns?.close()).then(()=>process.exit(0))});
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
        else if (line.startsWith('{')) {
          const event = JSON.parse(line);
          if (event.turnReserved) reservedAttempts++;
          else destinations.push({ role, host: event.destination });
        }
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
  if (sharedOwner) owner = await (await import('./subscription-owner.js')).startFixtureOwner(JSON.stringify(refreshed));
  // The native refresh owner retains the rotating credential. Query runtimes
  // consume an access-only native cache and never receive a refresh credential.
  refreshed.tokens.refresh_token = '';
  fs.writeFileSync('/home/node/.codex/auth.json', JSON.stringify(refreshed));
  if (productionQuery) {
    fs.chmodSync('/home/node/.codex', 0o700);
    process.env.NANOCLAW_COS_PROTOCOL = 'cos-rpc/v1';
    const { inbound, outbound } = initTestSessionDb();
    // This fixture has separate host/runner processes. Use the same bounded
    // SQLite lock wait as production rather than the single-process test default.
    inbound.exec('PRAGMA busy_timeout = 5000');
    outbound.exec('PRAGMA busy_timeout = 5000');
    inbound.exec(
      'CREATE TABLE cos_rpc_responses(request_id TEXT,payload_hash TEXT,delivery_id TEXT,response TEXT,updated_at TEXT)',
    );
    const deliveries = new Set<string>();
    rpcPoll = setInterval(() => {
      try {
        for (const row of outbound.query("SELECT content FROM messages_out WHERE kind='system'").all() as {
          content: string;
        }[]) {
          const { request, delivery_id } = JSON.parse(row.content);
          if (deliveries.has(delivery_id)) continue;
          deliveries.add(delivery_id);
          dispatched.push(request.method);
          assert.ok(
            request.method === 'cos_context_get' ||
              (toolRefresh && request.method === 'cos_knowledge_search') ||
              (mandateRefresh && request.method === 'cos_mandate_activity'),
          );
          const response = {
            protocol: 'cos-rpc/v1',
            request_id: request.request_id,
            status: 'ok',
            result: { records: ['Approved fixture priority'] },
          };
          const complete = () =>
            inbound
              .prepare('INSERT INTO cos_rpc_responses VALUES(?,?,?,?,?)')
              .run(request.request_id, digest(request), delivery_id, JSON.stringify(response), 'fixture');
          if (cancellation === 'rpc' && deliveries.size === 2) releaseLateResponse = complete;
          else complete();
        }
      } catch (error) {
        rpcFailure = error;
        clearInterval(rpcPoll);
      }
    }, 10);
    if (!sharedOwner) {
      credentialBroker = http.createServer((request, response) => {
        assert.equal(request.url, '/cached');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ version: 1, authJson: JSON.stringify(refreshed), generation: 'a'.repeat(64) }));
      });
      await new Promise<void>((resolve) => credentialBroker!.listen('/run/nanoclaw/codex-credentials.sock', resolve));
    }
    const contextGeneration = '11111111-1111-4111-8111-111111111111';
    let continuationKey = runnerEntry ? 'cos-codex-subscription:' + contextGeneration : 'cos-codex';
    if (runnerEntry) {
      for (const [db, destination] of [
        [inbound, '/workspace/inbound.db'],
        [outbound, '/workspace/outbound.db'],
      ] as const) {
        const file = (db.query('PRAGMA database_list').all() as { name: string; file: string }[]).find(
          (row) => row.name === 'main',
        )!.file;
        fs.symlinkSync(file, destination);
      }
      fs.writeFileSync(
        '/workspace/agent/container.json',
        JSON.stringify({
          provider: 'codex',
          model: 'gpt-6-astra',
          runtime: 'codex-subscription/v1',
          contextGeneration,
          agentGroupId: 'fixture',
          assistantName: 'CoS',
          groupName: 'CoS',
          maxMessagesPerPrompt: 10,
          mcpServers: {},
        }),
      );
      setContinuation('codex', 'ordinary-context-canary');
      outbound
        .prepare(
          "INSERT INTO session_state(key,value,updated_at) VALUES('sdk_session_id','legacy-context-canary','fixture')",
        )
        .run();
    }
    let inputNumber = 0;
    const run = async (prompt: string, cancel = false, renewed = false) => {
      if (runnerEntry) {
        inputNumber++;
        const previous = (
          outbound.query("SELECT count(*) AS n FROM messages_out WHERE kind='chat'").get() as { n: number }
        ).n;
        inbound
          .prepare(
            "INSERT INTO messages_in(id,seq,kind,timestamp,status,trigger,platform_id,channel_type,thread_id,content) VALUES(?,?,'chat',?,'pending',1,'mattermost:fixture:private','mattermost',?,?)",
          )
          .run(
            'input-' + inputNumber,
            inputNumber * 2,
            new Date().toISOString(),
            'visual-thread-' + inputNumber,
            JSON.stringify({ sender: 'Owner', text: prompt }),
          );
        const child = Bun.spawn(['bun', '/app/src/cos-runner.ts'], {
          env: { HOME: '/home/node', PATH: process.env.PATH, NANOCLAW_COS_PROTOCOL: 'cos-rpc/v1' },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const stdout = new Response(child.stdout).text(),
          stderr = new Response(child.stderr).text();
        stopRunner = async () => {
          child.kill('SIGTERM');
          const code = await child.exited;
          assert.equal(code, 0, await stderr);
          await stdout;
        };
        const until = Date.now() + 20000;
        while (Date.now() < until) {
          if (rpcFailure) throw rpcFailure;
          if (cancel && releaseLateResponse) {
            const nativePids = fs.readdirSync('/proc').filter((pid) => {
              if (!/^\d+$/.test(pid)) return false;
              try {
                return fs
                  .readFileSync('/proc/' + pid + '/cmdline', 'utf8')
                  .split('\0')
                  .includes('app-server');
              } catch {
                return false;
              }
            });
            assert.ok(nativePids.length > 0, 'native process must be running at cancellation');
            fs.writeFileSync('/tmp/fixture-revoked', 'fixture authority withdrawn');
            if (cancellation === 'membership') {
              const { guardConversationAccess } = await import('/fixture/conversation-access.ts');
              let revoked = false;
              const guard = guardConversationAccess({
                active: () => true,
                facts: async () => ({
                  id: 'private',
                  type: 'P',
                  delete_at: 0,
                  members: ['owner', 'bot', 'other'],
                  activeSubscription: true,
                }),
                revoke: () => {
                  revoked = true;
                  child.kill('SIGTERM');
                },
              });
              await assert.rejects(
                guard({
                  scopeId: 'fixture',
                  ownerId: 'owner',
                  botId: 'bot',
                  channelId: 'private',
                  instanceId: 'fixture',
                  agentGroupId: 'fixture',
                  messagingGroupId: 'fixture',
                  sessionId: 'fixture',
                  provider: 'codex',
                }),
              );
              assert.equal(revoked, true);
            } else child.kill('SIGTERM');
            releaseLateResponse();
            releaseLateResponse = undefined;
            assert.equal(await child.exited, 0, await stderr);
            await stdout;
            stopRunner = undefined;
            for (const pid of nativePids) {
              const stat = fs.existsSync('/proc/' + pid + '/stat')
                ? fs.readFileSync('/proc/' + pid + '/stat', 'utf8')
                : '';
              assert.ok(!stat || stat.split(') ')[1]?.startsWith('Z '), 'native process survived cancellation');
            }
            await new Promise((resolve) => setTimeout(resolve, 250));
            assert.equal(
              (outbound.query("SELECT count(*) AS n FROM messages_out WHERE kind='chat'").get() as { n: number }).n,
              previous,
              'late reply after cancellation',
            );
            assert.equal(requests.length, 7, 'cancelled turn must not retry');
            const denied = await new Promise<number>((resolve, reject) => {
              const request = http.request(
                { socketPath: '/run/cos/turn.sock', path: '/begin', method: 'POST' },
                (response) => {
                  response.resume();
                  response.once('end', () => resolve(response.statusCode!));
                },
              );
              request.once('error', reject);
              request.end(JSON.stringify({ attemptId: randomUUID() }));
            });
            assert.equal(denied, 403);
            cancellationChecked = true;
            return;
          }
          const replies = outbound.query("SELECT content FROM messages_out WHERE kind='chat' ORDER BY seq").all() as {
            content: string;
          }[];
          if (replies.length > previous) {
            assert.ok(
              JSON.parse(replies.at(-1)!.content).text.includes(
                renewed ? 'credentials were renewed' : 'Fixture answer',
              ),
              JSON.parse(replies.at(-1)!.content).text,
            );
            await stopRunner();
            stopRunner = undefined;
            assert.equal(getContinuation('codex'), 'ordinary-context-canary');
            assert.deepEqual(outbound.query("SELECT value FROM session_state WHERE key='sdk_session_id'").get(), {
              value: 'legacy-context-canary',
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        throw new Error('runner_entry_reply_timeout');
      }
      const provider = new CosCodexProvider({ model: 'gpt-6-astra', proxyUrl: relay!.proxyUrl });
      const query = provider.query({
        prompt,
        cwd: '/workspace/agent',
        continuation: getContinuation(continuationKey),
        systemContext: { instructions: 'You are a CoS fixture.' },
      });
      query.end();
      let completed = false;
      for await (const event of query.events) {
        if (event.type === 'init') setContinuation(continuationKey, event.continuation);
        if (event.type === 'error') throw new Error('production_provider_failed: ' + event.message);
        if (event.type === 'result') {
          assert.ok(event.text?.includes('Fixture answer'));
          completed = true;
        }
      }
      assert.ok(completed);
    };
    if (toolRefresh || mandateRefresh) {
      // Seed a native S01 conversation through the offline model fixture.
      // Subsequent turns all use the actual current production runner.
      const seed = createSubscriptionTurnClient();
      await seed.begin();
      try {
        await connect();
        const created = await sendCodexRequest(server, 'thread/start', {
          ...params,
          dynamicTools: cosDynamicTools.filter((tool) =>
            (mandateRefresh ? legacyCoordinatorTools : s01Tools).includes(tool.name),
          ),
        });
        assert.equal(created.error, undefined);
        const legacyThread = (created.result as any).thread.id;
        setContinuation(continuationKey, 'cos-codex-subscription-v1:' + legacyThread);
        await turn(legacyThread, 'Remember the synthetic colour is amber.');
      } finally {
        killCodexAppServer(server);
        await seed.end();
      }
    } else await run('Remember the synthetic colour is amber.');
    const original = getContinuation(continuationKey);
    assert.ok(original?.startsWith('cos-codex-subscription-v1:'));
    await run('Which synthetic colour did I mention?');
    assert.equal(getContinuation(continuationKey), original);
    if (mandateRefresh) {
      // Continuations within one native turn can send only its incremental tool output.
      assert.ok(JSON.stringify(requests[5].input).includes('amber'));
      await run('Continue the retained conversation after the fixed mandate adapter is installed.');
      assert.equal(getContinuation(continuationKey), original);
    }
    if (toolRefresh) {
      const oldKey = continuationKey;
      assert.ok(JSON.stringify(requests.at(-1).input).includes('amber'));
      // The guarded host recovery is tested by subscription-operator.integration.
      // Here exercise its runner-facing result: a new host-bound generation.
      // Keep the old native files present to prove they are never auto-adopted.
      const replacementGeneration = '22222222-2222-4222-8222-222222222222';
      const configPath = '/workspace/agent/container.json';
      fs.writeFileSync(
        configPath,
        JSON.stringify({
          ...JSON.parse(fs.readFileSync(configPath, 'utf8')),
          contextGeneration: replacementGeneration,
        }),
      );
      continuationKey = 'cos-codex-subscription:' + replacementGeneration;
      assert.equal(getContinuation(continuationKey), undefined);
      await run('Start with current admitted knowledge after explicit recovery.');
      const replacement = getContinuation(continuationKey);
      assert.ok(replacement?.startsWith('cos-codex-subscription-v1:'));
      assert.notEqual(replacement, original, 'recovery must create a fresh native thread');
      assert.equal(getContinuation(oldKey), original, 'old retained history must not be rewritten');
      await run('Continue the replacement conversation.');
      assert.equal(getContinuation(continuationKey), replacement);
      assert.ok(requests.slice(6).every((request) => !JSON.stringify(request.input).includes('amber')));
    }
    if (compaction) {
      await run('Continue the same synthetic conversation after another runner restart.');
      assert.equal(getContinuation(continuationKey), original);
    }
    if (cancellation) {
      await run('This synthetic turn must be cancelled before its answer arrives.', true);
      assert.equal(getContinuation(continuationKey), original);
      assert.equal(cancellationChecked, true);
    }
    if (sharedOwner) {
      rejectOldQuery = true;
      await run('This interrupted synthetic turn must never be replayed.', false, true);
      assert.equal(requests.length, 6, 'renewal must not replay the interrupted turn');
      assert.equal(getContinuation(continuationKey), original);
      ownerReceipt = await owner!.verify();
      assert.equal(ownerReceipt.sourceRefreshRetained, true);
      assert.ok(rejectedQueries > 0);
      await run('A new explicit turn after renewal.');
      assert.equal(getContinuation(continuationKey), original);
    }
    assert.equal(
      reservedAttempts,
      toolRefresh || sharedOwner ? 4 : compaction || cancellation || mandateRefresh ? 3 : 2,
    );
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
  assert.equal(requests.length, compaction || toolRefresh || mandateRefresh ? 9 : cancellation || sharedOwner ? 7 : 6);
  if (compaction) {
    assert.equal(compactionRequests.length, 1);
    assert.ok(
      requests
        .at(-1)
        .input.some((item: any) => item.type === 'compaction' && item.encrypted_content === compactedSummary),
    );
    assert.ok(
      requests
        .at(-1)
        .input.some(
          (item: any) => item.call_id === 'call_7' && String(item.output).includes('unsupported call: exec_command'),
        ),
    );
  } else if (!toolRefresh) assert.ok(JSON.stringify(requests.at(-1).input).includes('amber'));
  assert.deepEqual(
    dispatched,
    mandateRefresh
      ? ['cos_context_get', 'cos_mandate_activity']
      : toolRefresh
        ? ['cos_context_get', 'cos_knowledge_search']
        : compaction || cancellation === 'rpc'
          ? ['cos_context_get', 'cos_context_get']
          : ['cos_context_get'],
  );
  assert.equal(fs.existsSync('/tmp/escaped'), false);
  const allModelRequests = JSON.stringify([...requests, ...compactionRequests]);
  assert.equal(allModelRequests.includes(token), false);
  assert.equal(allModelRequests.includes(rotatedToken), false);
  assert.equal(allModelRequests.includes(finalToken), false);
  assert.equal(allModelRequests.includes('fixture-refresh'), false);
  assert.equal(refreshCalls, sharedOwner ? 2 : 1);
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
    mandateRefresh
      ? ['clock__curr_time', ...legacyCoordinatorTools].sort()
      : toolRefresh
        ? ['clock__curr_time', ...s01Tools]
        : productionQuery
          ? [
              'clock__curr_time',
              'cos_action_cancel',
              'cos_action_get',
              'cos_action_propose',
              'cos_answer_get',
              'cos_answer_prepare',
              'cos_brief_request',
              'cos_brief_schedule_propose',
              'cos_calendar_read',
              'cos_change_propose',
              'cos_context_get',
              'cos_knowledge_search',
              'cos_mandate_activity',
              'cos_mandate_propose',
              'cos_mission_cancel',
              'cos_mission_get',
              'cos_mission_request',
              'cos_mission_result_get',
              'cos_mission_review',
              'cos_proactive_batch',
              'cos_proactive_disposition_propose',
              'cos_proactive_history',
              'cos_proactive_policy_propose',
              'cos_proactive_submit',
              'cos_request_status',
              'cos_source_change_propose',
              'cos_source_get',
              'cos_team_cancel',
              'cos_team_get',
              'cos_team_request',
              'cos_work_change_propose',
              'cos_work_read',
              ...mcpResourceTools,
            ].sort()
          : ['clock__curr_time', 'cos_context_get'],
  );
  if (toolRefresh) {
    const declared = (request: any) =>
      request.input
        .filter((item: any) => item.type === 'additional_tools')
        .flatMap((item: any) => item.tools)
        .flatMap((tool: any) => tool.tools ?? [])
        .flatMap((tool: any) =>
          [...(tool.description ?? '').matchAll(/declare const tools: \{ (\w+)\(/g)].map((match: any) => match[1]),
        )
        .sort();
    assert.deepEqual(declared(requests[5]), ['clock__curr_time', ...s01Tools, ...mcpResourceTools].sort());
    const expected = ['clock__curr_time', ...cosDynamicTools.map((tool) => tool.name), ...mcpResourceTools].sort();
    assert.equal(expected.length, 35);
    assert.deepEqual(declared(requests[6]), expected);
    assert.deepEqual(declared(requests.at(-1)), expected);
  }
  if (mandateRefresh) {
    const declared = (request: any) =>
      request.input
        .filter((item: any) => item.type === 'additional_tools')
        .flatMap((item: any) => item.tools)
        .flatMap((tool: any) => tool.tools ?? [])
        .flatMap((tool: any) =>
          [...(tool.description ?? '').matchAll(/declare const tools: \{ (\w+)\(/g)].map((match: any) => match[1]),
        )
        .sort();
    const expected = ['clock__curr_time', ...legacyCoordinatorTools, ...mcpResourceTools].sort();
    assert.deepEqual(declared(requests[5]), expected);
    assert.deepEqual(declared(requests.at(-1)), expected);
    for (const tool of mandateMcpTools) assert.ok(outputText.includes(tool));
    assert.ok(outputText.includes('resource-list-unavailable'));
    assert.ok(outputText.includes('resource-templates-unavailable'));
    assert.ok(outputText.includes('resource-unavailable'));
    assert.ok(outputText.includes('unconfigured-server-unavailable'));
    assert.equal(outputText.includes('scope-authority-canary'), false);
  }
  clearInterval(rpcPoll);
  if (rpcFailure) throw rpcFailure;
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
      reservedAttempts,
      runnerEntry,
      ...(mandateRefresh
        ? {
            retainedThreadMandateTools: true,
            contextGenerationUnchanged: true,
            noHistoryRewrite: true,
            resourcesUnavailable: true,
            resourceCredentialReadDenied: true,
            unconfiguredServerDenied: true,
          }
        : {}),
      ...(toolRefresh
        ? {
            legacyToolsRetainedOnResume: true,
            recoveredThreadHasKnowledgeTools: true,
            retiredHistoryAbsent: true,
            replacementResumed: true,
          }
        : {}),
      ...(sharedOwner
        ? { sharedOwner: ownerReceipt, native401Observed: rejectedQueries, interruptedTurnNotReplayed: true }
        : {}),
      ...(cancellation
        ? { cancellation, nativeProcessStopped: cancellationChecked, lateReplyAbsent: true, newAttemptDenied: true }
        : {}),
      ...(compaction
        ? {
            nativeCompactions: compactionRequests.length,
            compactedHistoryResumed: true,
            postCompactionToolsChecked: true,
          }
        : {}),
    }),
  );
} finally {
  await stopRunner?.();
  clearInterval(rpcPoll);
  if (productionQuery) closeSessionDb();
  if (credentialBroker) {
    credentialBroker.closeAllConnections();
    await new Promise<void>((resolve) => credentialBroker!.close(() => resolve()));
  }
  await owner?.close();
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

// Optional development proof against the history left by the stopped native runners.
// Run after teardown: copying a live native SQLite/WAL tree would not prove a valid backup.
if (process.env.NANOCLAW_COS_FIXTURE_BACKUP_MODULE) {
  assert.ok(runnerEntry);
  const cache = JSON.parse(fs.readFileSync('/home/node/.codex/auth.json', 'utf8'));
  assert.equal(cache.tokens.account_id, 'fixture-account');
  assert.equal(cache.tokens.refresh_token, '');
  const { backupConversations, verifyConversationBackup } = await import(
    process.env.NANOCLAW_COS_FIXTURE_BACKUP_MODULE
  );
  const root = fs.mkdtempSync('/home/node/cos-history-proof-');
  const source = root + '/conversations',
    receipt = root + '/receipt';
  fs.mkdirSync(source, { mode: 0o700 });
  fs.mkdirSync(receipt, { mode: 0o700 });
  fs.renameSync('/home/node/.codex', source + '/11111111-1111-4111-8111-111111111111');
  const result = await backupConversations(source, receipt);
  assert.deepEqual(await verifyConversationBackup(source, receipt), result);
  assert.ok(result.files > 0 && result.bytes > 0);
  console.log(JSON.stringify({ nativeHistoryBackup: 'passed', files: result.files, bytes: result.bytes }));
}
