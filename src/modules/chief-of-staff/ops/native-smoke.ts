import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
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
  const server = net.createServer((connection) => connection.destroy());
  let client: McpFixture | undefined,
    stopped = false,
    pump: Promise<void> | undefined;
  const docker = async (args: string[]) =>
    (
      await promisify(execFile)('docker', args, {
        env: safeHostEnvironment('docker'),
        timeout: 10000,
        maxBuffer: 1048576,
      })
    ).stdout;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, resolve);
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
      'cos_change_propose',
      'cos_context_get',
      'cos_request_status',
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
    return { status: 'passed', rpc: 'passed', isolation: 'passed', model: 'fixture', messagesSent: 0 } as const;
  } finally {
    stopped = true;
    await pump?.catch(() => {});
    await client?.close();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    inbound.close();
    outbound.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
