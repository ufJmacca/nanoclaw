import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { McpFixture } from '../../../contracts/chief-of-staff/mcp-fixture.js';
import { ensureSchema, openInboundDb, openOutboundDb } from '../../../db/session-db.js';
import { safeHostEnvironment } from '../../../host-environment.js';
import type { Session } from '../../../types.js';
import type { PriorityStore } from '../store/priorities.js';
import { ensureRpcSchema, createRpcHandler } from '../bridge/rpc.js';
import { restrictedLaunch } from '../bridge/restricted-launch.js';
import { startModelGateway } from '../bridge/model-gateway.js';

/** Runs the real restricted launch and native SQLite RPC with synthetic records and no real adapters. */
export async function nativeFixtureSmoke(options: { root: string; hostRoot: string; image: string }) {
  for (const directory of [options.root, options.hostRoot])
    if (!path.isAbsolute(directory) || path.resolve(directory) !== directory || /[,\r\n\0]/.test(directory))
      throw new Error('unsafe_smoke_root');
  if (!/^sha256:[a-f0-9]{64}$/.test(options.image)) throw new Error('immutable_smoke_image_required');
  fs.mkdirSync(options.root, { recursive: true, mode: 0o700 });
  if (fs.realpathSync(options.root) !== options.root || (fs.statSync(options.root).mode & 0o777) !== 0o700)
    throw new Error('unsafe_smoke_root');
  const root = fs.mkdtempSync(path.join(options.root, 'probe-')),
    session = path.join(root, 'cos-v1');
  fs.mkdirSync(session, { mode: 0o700 });
  fs.mkdirSync(path.join(session, 'agent'), { mode: 0o700 });
  ensureSchema(path.join(session, 'inbound.db'), 'inbound');
  ensureSchema(path.join(session, 'outbound.db'), 'outbound');
  const inbound = openInboundDb(path.join(session, 'inbound.db')),
    outbound = openOutboundDb(path.join(session, 'outbound.db'));
  ensureRpcSchema(inbound);
  const config = path.join(root, 'config.json'),
    socket = path.join(root, 'model.sock');
  fs.writeFileSync(
    config,
    JSON.stringify({
      provider: 'codex',
      model: 'fixture-model',
      agentGroupId: 'fixture-smoke',
      assistantName: 'CoS',
      groupName: 'CoS',
      maxMessagesPerPrompt: 10,
      mcpServers: {},
    }),
    { mode: 0o600 },
  );
  const canary = path.join(root, 'host-only-canary');
  fs.writeFileSync(canary, 'synthetic-fixture-only', { mode: 0o600 });
  let gateway: Awaited<ReturnType<typeof startModelGateway>> | undefined;
  let providerRequests = 0;
  let client: McpFixture | undefined,
    stopped = false,
    pump: Promise<void> | undefined;
  const docker = async (args: string[], timeout = 10000) =>
    (
      await promisify(execFile)('docker', args, {
        env: safeHostEnvironment('docker'),
        timeout,
        maxBuffer: 1048576,
      })
    ).stdout;
  try {
    gateway = await startModelGateway({
      socket,
      model: 'fixture-model',
      apiKey: 'SYNTHETIC_FIXTURE_KEY',
      authorize: async () => true,
      upstream: async (body) => {
        providerRequests++;
        assert.equal(body.model, 'fixture-model');
        assert.equal(body.store, false);
        assert.equal(body.background, false);
        assert.equal(body.service_tier, 'default');
        const item = {
          id: 'msg_fixture',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'Fixture response.', annotations: [] }],
        };
        const events = [
          {
            type: 'response.created',
            response: { id: 'resp_fixture', object: 'response', status: 'in_progress', output: [] },
          },
          {
            type: 'response.output_item.added',
            output_index: 0,
            item: { ...item, status: 'in_progress', content: [] },
          },
          {
            type: 'response.output_text.delta',
            item_id: 'msg_fixture',
            output_index: 0,
            content_index: 0,
            delta: 'Fixture response.',
          },
          { type: 'response.output_item.done', output_index: 0, item },
          {
            type: 'response.completed',
            response: {
              id: 'resp_fixture',
              object: 'response',
              status: 'completed',
              output: [item],
              usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
            },
          },
        ];
        return {
          status: 200,
          body: (async function* () {
            for (const event of events) yield Buffer.from('data: ' + JSON.stringify(event) + '\n\n');
          })(),
        };
      },
    });
    const launch = restrictedLaunch({
      image: options.image,
      sessionDirectory: session,
      configurationFile: config,
      gatewaySocket: socket,
      uid: process.getuid!(),
      gid: process.getgid!(),
      entry: 'mcp',
    });
    launch.args = launch.args.map((arg) =>
      arg.startsWith('type=bind,') ? arg.replace('src=' + options.root + '/', 'src=' + options.hostRoot + '/') : arg,
    );
    client = new McpFixture(options.root, session, options.hostRoot, options.image, '', launch);
    await client.start();
    const tools = await client.request('tools/list', {});
    assert.deepEqual(tools.tools.map((tool: { name: string }) => tool.name).sort(), [
      'cos_answer_get',
      'cos_answer_prepare',
      'cos_brief_request',
      'cos_brief_schedule_propose',
      'cos_calendar_read',
      'cos_change_propose',
      'cos_context_get',
      'cos_knowledge_search',
      'cos_request_status',
      'cos_source_change_propose',
      'cos_source_get',
      'cos_work_change_propose',
      'cos_work_read',
    ]);
    const inspected = JSON.parse(await docker(['inspect', client.name]))[0];
    assert.equal(inspected.HostConfig.NetworkMode, 'none');
    assert.equal(inspected.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspected.Config.User, `${process.getuid!()}:${process.getgid!()}`);
    assert.deepEqual(inspected.HostConfig.CapDrop, ['ALL']);
    assert.ok(inspected.HostConfig.SecurityOpt.includes('no-new-privileges'));
    assert.equal(inspected.Image, options.image);
    assert.equal(inspected.Mounts.length, 4);
    assert.ok(inspected.Mounts.every((mount: { Destination: string }) => !mount.Destination.startsWith('/app')));
    assert.equal(
      inspected.Mounts.find((mount: { Destination: string }) => mount.Destination === '/workspace/inbound.db').RW,
      false,
    );
    const probe = `import fs from 'node:fs';
      if(fs.existsSync('/var/run/docker.sock')||fs.existsSync('/root/.ssh')||fs.existsSync(${JSON.stringify(canary)}))throw Error('host_mount_exposed');
      if(Object.keys(process.env).some(k=>/^(COS_(TEST_)?PG|COS_MODEL_|OPENAI_API_KEY|ANTHROPIC_API_KEY|SSH_)/.test(k)))throw Error('secret_environment');
      let denied=false;try{fs.writeFileSync('/workspace/inbound.db','must-not-write')}catch{denied=true}if(!denied)throw Error('inbound_writable');
      denied=false;try{fs.writeFileSync('/app/src/fixture-must-not-write','x')}catch{denied=true}if(!denied)throw Error('code_writable');
      let connected=false;try{await fetch('http://192.0.2.1:18080/',{signal:AbortSignal.timeout(1000)});connected=true}catch{}if(connected)throw Error('network_reachable');
      if(!fs.existsSync('/app/src/cos-mcp.ts')||!fs.existsSync('/app/skills')||!fs.existsSync('/app/deep-research-workflow'))throw Error('packaged_assets_missing');
      console.log('isolation-passed');`;
    assert.equal((await docker(['exec', client.name, 'bun', '-e', probe])).trim(), 'isolation-passed');
    const providerProbe = `import {CodexProvider} from '/app/src/providers/codex.ts';
      import {startCosRelay} from '/app/src/cos-relay.ts';
      const relay=await startCosRelay('/run/cos/model.sock');
      const provider=new CodexProvider({restrictedCos:true,env:{CODEX_MODEL:'fixture-model'},mcpServers:{}});
      const query=provider.query({prompt:'Reply with Fixture response.',cwd:'/workspace/agent'});query.end();
      const timer=setTimeout(()=>{query.abort();process.exit(2)},30000);
      try{let received='';for await(const event of query.events)received+=JSON.stringify(event);
        if(!received.includes('Fixture response.'))throw Error('fixture_provider_response_missing');console.log('provider-passed');}
      finally{clearTimeout(timer);await relay.close();}`;
    assert.ok((await docker(['exec', client.name, 'bun', '-e', providerProbe], 35000)).includes('provider-passed'));
    assert.equal(providerRequests, 1);
    const handler = createRpcHandler({
      resolveContext: async () => ({
        scopeId: 'fixture',
        ownerId: 'owner',
        sessionId: 'session',
        agentGroupId: 'group',
        ingressId: 'ingress',
      }),
      store: {
        context: async () => ({ status: 'ok', records: [{ id: 'fixture-approved', title: 'Synthetic native smoke' }] }),
      } as unknown as PriorityStore,
    });
    const seen = new Set<string>();
    pump = (async () => {
      while (!stopped) {
        const rows = outbound.prepare('SELECT id,kind,content FROM messages_out ORDER BY seq').all() as Array<{
          id: string;
          kind: string;
          content: string;
        }>;
        for (const row of rows)
          if (!seen.has(row.id)) {
            assert.equal(row.kind, 'system');
            await handler(JSON.parse(row.content), { id: 'fixture-session' } as Session, inbound);
            seen.add(row.id);
          }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    void pump.catch(() => {});
    const response = await client.call('cos_context_get', { view: 'today' });
    assert.equal(response.status, 'ok');
    assert.equal(response.result.records[0].id, 'fixture-approved');
    stopped = true;
    await pump;
    return {
      status: 'passed',
      rpc: 'passed',
      isolation: 'passed',
      provider: 'passed',
      model: 'fixture',
      messagesSent: 0,
    } as const;
  } finally {
    stopped = true;
    await pump?.catch(() => {});
    await client?.close();
    await gateway?.close();
    inbound.close();
    outbound.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
