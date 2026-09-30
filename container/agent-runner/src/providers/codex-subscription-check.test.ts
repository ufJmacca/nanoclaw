import { describe, test, expect } from 'bun:test';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkSubscriptionAccount, subscriptionProcessEnvironment } from './codex-subscription-check.js';
import { spawnCodexAppServer, type AppServer, type JsonRpcResponse } from './codex-app-server.js';

function fakeServer(response: JsonRpcResponse['result'] = { account: { type: 'chatgpt' } }) {
  const writes: Array<{ method: string; params: unknown }> = [];
  const process = new EventEmitter() as any;
  process.exitCode = null;
  process.signalCode = null;
  process.kill = () => {
    queueMicrotask(() => {
      process.exitCode = 0;
      process.emit('exit', 0, null);
    });
    return true;
  };
  let server: AppServer;
  process.stdin = {
    write(line: string) {
      const request = JSON.parse(line);
      writes.push(request);
      queueMicrotask(() => {
        const pending = server.pending.get(request.id);
        server.pending.delete(request.id);
        pending?.resolve({ id: request.id, result: request.method === 'initialize' ? {} : response });
      });
      return true;
    },
  };
  server = {
    process,
    readline: { close() {} },
    pending: new Map(),
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
  return { server, writes };
}

describe('trusted native subscription account check', () => {
  test('sends only initialize/account inspection and waits for native process exit', async () => {
    const { server, writes } = fakeServer();
    await checkSubscriptionAccount(server, 'refresh');
    expect(writes.map((x) => x.method)).toEqual(['initialize', 'account/read']);
    expect(writes[1].params).toEqual({ refreshToken: true });
    expect(server.process.exitCode).toBe(0);
    expect(server.serverRequestHandlers).toHaveLength(0);
  });
  test('a cached check never requests proactive refresh and rejects other authentication modes', async () => {
    const { server, writes } = fakeServer({ account: { type: 'apiKey', key: 'credential-canary' } });
    await expect(checkSubscriptionAccount(server, 'check')).rejects.toThrow('subscription_account_unavailable');
    expect(writes[1].params).toEqual({ refreshToken: false });
    expect(server.process.exitCode).toBe(0);
  });
  test('refuses unexpected native client requests instead of approving them', async () => {
    const { server, writes } = fakeServer();
    const check = checkSubscriptionAccount(server, 'check');
    for (const handler of server.serverRequestHandlers)
      handler({ id: 900, method: 'item/commandExecution/requestApproval', params: {} });
    await expect(check).rejects.toThrow('subscription_account_unavailable');
    expect(writes.some((x) => !x.method)).toBe(false);
    expect(server.process.exitCode).toBe(0);
  });
  test('selects a fixed environment without ambient keys, custom endpoints, CA overrides or proxy bypasses', () => {
    const env = subscriptionProcessEnvironment('http://127.0.0.1:12345');
    expect(env).toEqual({
      HOME: '/home/node',
      CODEX_HOME: '/home/node/.codex',
      PATH: '/pnpm:/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TMPDIR: '/tmp',
      HTTPS_PROXY: 'http://127.0.0.1:12345',
      HTTP_PROXY: 'http://127.0.0.1:12345',
      ALL_PROXY: 'http://127.0.0.1:12345',
      NO_PROXY: '',
    });
    for (const proxy of [
      'http://example.com:12345',
      'http://127.0.0.1:12345/path',
      'https://127.0.0.1:12345',
      'http://user@127.0.0.1:12345',
      'http://127.0.0.1:0',
    ])
      expect(() => subscriptionProcessEnvironment(proxy)).toThrow('invalid_subscription_proxy');
  });
  test('the transport uses the selected environment and can suppress native diagnostics', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'native-check-'));
    fs.writeFileSync(
      path.join(directory, 'codex'),
      `#!${process.execPath}
import readline from 'node:readline';
process.stderr.write('synthetic-private-diagnostic');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 const result=request.method==='initialize'?{}:{account:{type:process.env.FIXTURE_SELECTED==='yes'&&!process.env.FIXTURE_AMBIENT?'chatgpt':'apiKey'}};
 process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`,
      { mode: 0o700 },
    );
    const previous = process.env.FIXTURE_AMBIENT;
    process.env.FIXTURE_AMBIENT = 'must-not-inherit';
    try {
      const server = spawnCodexAppServer([], {
        environment: { PATH: directory, FIXTURE_SELECTED: 'yes' },
        diagnostic: () => {},
      });
      await checkSubscriptionAccount(server, 'check');
      expect(server.process.exitCode !== null || server.process.signalCode !== null).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.FIXTURE_AMBIENT;
      else process.env.FIXTURE_AMBIENT = previous;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
