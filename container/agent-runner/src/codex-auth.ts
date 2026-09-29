/** Trusted native-auth container entry. It never starts a model thread or loads agent tools. */
import fs from 'node:fs';
import os from 'node:os';
import { startSubscriptionRelay } from './cos-subscription-relay.js';
import { spawnCodexAppServer } from './providers/codex-app-server.js';
import { subscriptionConfig } from './providers/codex-subscription-policy.js';
import { checkSubscriptionAccount, subscriptionProcessEnvironment } from './providers/codex-subscription-check.js';

async function main() {
  const [mode, model, ...extra] = process.argv.slice(2);
  if (
    !['check', 'refresh'].includes(mode) ||
    extra.length !== 0 ||
    process.env.HOME !== '/home/node' ||
    process.env.NANOCLAW_NATIVE_AUTH !== 'codex-subscription/v1' ||
    Object.values(os.networkInterfaces())
      .flat()
      .some((address) => address && !address.internal)
  )
    throw new Error('invalid_native_auth_boundary');
  fs.writeFileSync('/home/node/.codex/config.toml', subscriptionConfig(model), { mode: 0o600, flag: 'wx' });
  const relay = await startSubscriptionRelay();
  try {
    const server = spawnCodexAppServer([], {
      environment: subscriptionProcessEnvironment(relay.proxyUrl),
      diagnostic: () => {},
    });
    await checkSubscriptionAccount(server, mode as 'check' | 'refresh');
    process.stdout.write(JSON.stringify({ status: 'native_check_completed' }) + '\n');
  } finally {
    await relay.close();
  }
}

if (import.meta.main) {
  main().catch(() => {
    process.stderr.write('subscription_native_check_failed\n');
    process.exitCode = 1;
  });
}
