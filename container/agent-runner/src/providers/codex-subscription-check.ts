import {
  initializeCodexAppServer,
  sendCodexRequest,
  killCodexAppServer,
  type AppServer,
  type JsonRpcServerRequest,
} from './codex-app-server.js';

/** Fixed process environment for the pinned native binary in its network-none container. */
export function subscriptionProcessEnvironment(proxyUrl: string): NodeJS.ProcessEnv {
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(proxyUrl);
  if (!match || Number(match[1]) > 65535) throw new Error('invalid_subscription_proxy');
  return {
    HOME: '/home/node',
    CODEX_HOME: '/home/node/.codex',
    PATH: '/pnpm:/usr/local/bin:/usr/bin:/bin',
    LANG: 'C.UTF-8',
    TMPDIR: '/tmp',
    HTTPS_PROXY: proxyUrl,
    HTTP_PROXY: proxyUrl,
    ALL_PROXY: proxyUrl,
    NO_PROXY: '',
  };
}

/** Publishing staged credentials is allowed only after the native writer has exited. */
export async function stopSubscriptionAppServer(server: AppServer): Promise<void> {
  if (server.process.exitCode !== null || server.process.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const force = setTimeout(() => server.process.kill('SIGKILL'), 2000);
    const deadline = setTimeout(() => {
      cleanup();
      reject(new Error('subscription_native_exit_unconfirmed'));
    }, 5000);
    const cleanup = () => {
      clearTimeout(force);
      clearTimeout(deadline);
      server.process.removeListener('exit', exited);
    };
    const exited = () => {
      cleanup();
      resolve();
    };
    server.process.once('exit', exited);
    killCodexAppServer(server);
  });
}

/** Native account inspection only: no thread, turn, model request, tool or login operation. */
export async function checkSubscriptionAccount(server: AppServer, mode: 'check' | 'refresh'): Promise<void> {
  let invalid = false;
  let deny!: () => void;
  const denied = new Promise<never>((_, reject) => {
    deny = () => {
      invalid = true;
      reject(new Error('subscription_account_unavailable'));
    };
  });
  const rejectClientRequest = (_request: JsonRpcServerRequest) => deny();
  server.serverRequestHandlers.push(rejectClientRequest);
  const deadline = setTimeout(deny, 15000);
  try {
    await Promise.race([
      denied,
      (async () => {
        if (!['check', 'refresh'].includes(mode)) throw new Error('invalid_subscription_check');
        await initializeCodexAppServer(server);
        if (invalid) throw new Error('subscription_account_unavailable');
        const response = await sendCodexRequest(server, 'account/read', { refreshToken: mode === 'refresh' }, 15000);
        const result = response.result as { account?: { type?: string } } | undefined;
        if (response.error || result?.account?.type !== 'chatgpt') throw new Error('subscription_account_unavailable');
      })(),
    ]);
  } catch {
    // Provider errors may contain account/token details. The host retains the uncertain journal.
    throw new Error('subscription_account_unavailable');
  } finally {
    clearTimeout(deadline);
    await stopSubscriptionAppServer(server);
    const index = server.serverRequestHandlers.indexOf(rejectClientRequest);
    if (index !== -1) server.serverRequestHandlers.splice(index, 1);
  }
}
