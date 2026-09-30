import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { randomUUID } from 'node:crypto';

/** Runtime-only credential transport. It is not registered as a model tool or persisted in the RPC databases. */
export function createSubscriptionCredentialClient(
  options: { socketPath?: string; home?: string; signal?: AbortSignal } = {},
) {
  const socketPath = options.socketPath ?? '/run/nanoclaw/codex-credentials.sock';
  const home = options.home ?? '/home/node';
  let generation: string | undefined;
  async function request(operation: 'cached' | 'refresh') {
    if (options.signal?.aborted || (operation === 'refresh' && !generation))
      throw new Error('subscription_credentials_unavailable');
    try {
      const raw = await new Promise<string>((resolve, reject) => {
        const request = http.request(
          { socketPath, path: '/' + operation, method: 'POST', timeout: 35000, signal: options.signal },
          (response) => {
            if (response.statusCode !== 200) {
              response.resume();
              reject(new Error('subscription_credentials_unavailable'));
              return;
            }
            let body = '',
              bytes = 0;
            response.on('data', (data: Buffer) => {
              bytes += data.length;
              if (bytes > 262144) {
                response.destroy();
                reject(new Error('subscription_credentials_unavailable'));
              } else body += data.toString();
            });
            response.on('end', () => resolve(body));
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('subscription_credentials_unavailable')));
          },
        );
        request.on('timeout', () => request.destroy(new Error('subscription_credentials_unavailable')));
        request.on('error', reject);
        request.end(JSON.stringify(operation === 'refresh' ? { generation } : {}));
      });
      const snapshot = JSON.parse(raw),
        auth = JSON.parse(snapshot.authJson),
        tokens = auth?.tokens;
      if (
        options.signal?.aborted ||
        snapshot.version !== 1 ||
        !/^[a-f0-9]{64}$/.test(snapshot.generation ?? '') ||
        auth?.auth_mode !== 'chatgpt' ||
        auth.OPENAI_API_KEY != null ||
        tokens?.refresh_token !== '' ||
        !['access_token', 'id_token', 'account_id'].every(
          (key) => typeof tokens[key] === 'string' && tokens[key].length > 0 && tokens[key].length <= 65536,
        ) ||
        Object.keys(tokens).some((key) => !['access_token', 'id_token', 'account_id', 'refresh_token'].includes(key)) ||
        Object.keys(auth).some((key) => !['auth_mode', 'OPENAI_API_KEY', 'tokens', 'last_refresh'].includes(key))
      )
        throw new Error('subscription_credentials_unavailable');
      const directory = path.join(home, '.codex');
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (
        fs.realpathSync(directory) !== directory ||
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0
      )
        throw new Error('subscription_credentials_unavailable');
      const temporary = path.join(directory, '.auth-' + randomUUID());
      try {
        fs.writeFileSync(temporary, snapshot.authJson, { mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, path.join(directory, 'auth.json'));
      } finally {
        fs.rmSync(temporary, { force: true });
      }
      const changed = generation !== snapshot.generation;
      generation = snapshot.generation;
      return changed;
    } catch {
      throw new Error('subscription_credentials_unavailable');
    }
  }
  return { prepare: () => request('cached'), refresh: () => request('refresh') };
}
