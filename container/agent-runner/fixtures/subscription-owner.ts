/** Offline integration helper. Never use with real credentials or external networking. */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { createSubscriptionCredentialClient } from '../src/providers/codex-credential-client.js';
import { startSubscriptionRelay } from '../src/cos-subscription-relay.js';
import { spawnCodexAppServer } from '../src/providers/codex-app-server.js';
import { checkSubscriptionAccount, subscriptionProcessEnvironment } from '../src/providers/codex-subscription-check.js';
import { subscriptionConfig } from '../src/providers/codex-subscription-policy.js';

export async function startFixtureOwner(authJson: string) {
  if (process.env.NANOCLAW_COS_OFFLINE_FIXTURE !== '1') throw new Error('offline_fixture_required');
  fs.chmodSync('/run/nanoclaw', 0o700);
  const { createSubscriptionAuthStore } = await import('/fixture/codex-subscription-auth.ts');
  const { startSubscriptionBroker } = await import('/fixture/codex-subscription-broker.ts');
  const { startSubscriptionEgress } = await import('/fixture/subscription-egress.ts');
  const root = fs.mkdtempSync('/tmp/fixture-owner-');
  fs.mkdirSync(root + '/state', { mode: 0o700 });
  fs.mkdirSync(root + '/ordinary', { mode: 0o700 });
  fs.writeFileSync(root + '/auth.json', authJson, { mode: 0o600 });
  const gateway = await startSubscriptionEgress({
    socketPath: root + '/auth.sock',
    role: 'auth',
    authorize: async () => true,
    dependencies: {
      resolve: async () => [{ address: '8.8.8.8', family: 4 }],
      connect: () => net.createConnection({ host: '127.0.0.1', port: 8787 }),
    },
  });
  const relay = await startSubscriptionRelay(root + '/auth.sock');
  let checks = 0,
    concurrent: Promise<boolean> | undefined;
  const ordinary = createSubscriptionCredentialClient({
    socketPath: root + '/ordinary.sock',
    home: root + '/ordinary',
  });
  const store = createSubscriptionAuthStore({
    sourceFile: root + '/auth.json',
    stateDirectory: root + '/state',
    assertAuthority() {},
    async nativeCheck(directory: string, mode: 'check' | 'refresh') {
      checks++;
      // Simulate a second admitted session hitting the same expired generation
      // while CoS is already renewing it. It must join, not rotate again.
      concurrent = ordinary.refresh();
      void concurrent.catch(() => {});
      fs.writeFileSync(path.join(directory, 'config.toml'), subscriptionConfig('gpt-6-astra'), { mode: 0o600 });
      const server = spawnCodexAppServer([], {
        environment: { ...subscriptionProcessEnvironment(relay.proxyUrl), CODEX_HOME: directory },
        diagnostic: () => {},
      });
      // The fixture maps the staged HOME in-process. Production does this with
      // the separate restricted auth container; this is not its mount proof.
      await checkSubscriptionAccount(server, mode);
    },
  });
  const cosBroker = await startSubscriptionBroker({
    socket: '/run/nanoclaw/codex-credentials.sock',
    store,
    authorize: async () => true,
  });
  const ordinaryBroker = await startSubscriptionBroker({
    socket: root + '/ordinary.sock',
    store,
    authorize: async () => true,
  });
  await ordinary.prepare();
  fs.writeFileSync(root + '/ordinary/.codex/history-canary', 'ordinary retained history');
  return {
    async verify() {
      if (!concurrent || !(await concurrent) || checks !== 1) throw new Error('shared_renewal_not_verified');
      const source = JSON.parse(fs.readFileSync(root + '/auth.json', 'utf8'));
      const ordinaryAuth = JSON.parse(fs.readFileSync(root + '/ordinary/.codex/auth.json', 'utf8'));
      const cosAuth = JSON.parse(fs.readFileSync('/home/node/.codex/auth.json', 'utf8'));
      if (
        ordinaryAuth.tokens.refresh_token !== '' ||
        cosAuth.tokens.refresh_token !== '' ||
        ordinaryAuth.tokens.access_token !== source.tokens.access_token ||
        cosAuth.tokens.access_token !== source.tokens.access_token ||
        fs.readFileSync(root + '/ordinary/.codex/history-canary', 'utf8') !== 'ordinary retained history' ||
        fs.existsSync(root + '/state/operation.json')
      )
        throw new Error('shared_renewal_invariant_failed');
      return {
        nativeOwnerChecks: checks,
        concurrentClients: 2,
        sourceRefreshRetained: source.tokens.refresh_token === 'fixture-refresh-final',
      };
    },
    async close() {
      await Promise.all([cosBroker.close(), ordinaryBroker.close()]);
      await relay.close();
      await gateway.close();
    },
  };
}
