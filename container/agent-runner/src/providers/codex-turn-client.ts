import http from 'node:http';
import { randomUUID } from 'node:crypto';
/** Not a model tool. The host binds this socket to its approved account, context and budget. */
export function createSubscriptionTurnClient(options: { socketPath?: string; signal?: AbortSignal } = {}) {
  let attemptId: string | undefined;
  async function request(operation: 'begin' | 'end', id: string) {
    try {
      await new Promise<void>((resolve, reject) => {
        const client = http.request(
          {
            socketPath: options.socketPath ?? '/run/cos/turn.sock',
            path: '/' + operation,
            method: 'POST',
            timeout: operation === 'begin' ? 10000 : 2000,
            ...(operation === 'begin' ? { signal: options.signal } : {}),
          },
          (response) => {
            let body = '',
              bytes = 0;
            response.on('data', (data: Buffer) => {
              bytes += data.length;
              if (bytes > 1024) response.destroy(new Error('subscription_turn_unavailable'));
              else body += data.toString();
            });
            response.on('error', reject);
            response.on('aborted', () => reject(new Error('subscription_turn_unavailable')));
            response.on('end', () => {
              try {
                const value = JSON.parse(body);
                if (response.statusCode !== 200 || value.version !== 1 || value.attemptId !== id)
                  throw new Error('subscription_turn_unavailable');
                resolve();
              } catch {
                reject(new Error('subscription_turn_unavailable'));
              }
            });
          },
        );
        client.on('timeout', () => client.destroy(new Error('subscription_turn_unavailable')));
        client.on('error', reject);
        client.end(JSON.stringify({ attemptId: id }));
      });
    } catch {
      throw new Error('subscription_turn_unavailable');
    }
  }
  return {
    async begin() {
      if (attemptId || options.signal?.aborted) throw new Error('subscription_turn_unavailable');
      attemptId = randomUUID();
      await request('begin', attemptId); // Never retry an uncertain reservation.
      if (options.signal?.aborted) throw new Error('subscription_turn_unavailable');
    },
    async end() {
      const id = attemptId;
      if (!id) return;
      try {
        await request('end', id);
      } catch {
        /* The host also fences revocation and enforces a fixed attempt deadline. */
      } finally {
        attemptId = undefined;
      }
    },
  };
}
