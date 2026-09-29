import net from 'node:net';
import type { PoolConfig } from 'pg';

/** Test-only TCP relay to the already admitted external target; no local database server. */
export async function connectionFault(config: PoolConfig) {
  const sockets = new Set<net.Socket>();
  let partitioned = false;
  const server = net.createServer((downstream) => {
    sockets.add(downstream);
    const upstream = net.connect({ host: config.host!, port: config.port! });
    sockets.add(upstream);
    downstream.on('error', () => {});
    upstream.on('error', () => downstream.destroy());
    downstream.on('close', () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on('close', () => sockets.delete(upstream));
    downstream.on('data', (bytes) => {
      if (!partitioned) upstream.write(bytes);
    });
    upstream.on('data', (bytes) => {
      if (!partitioned) downstream.write(bytes);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = (server.address() as net.AddressInfo).port;
  class RelayedSocket extends net.Socket {
    connect(..._args: unknown[]): this {
      return super.connect({ host: '127.0.0.1', port });
    }
  }
  return {
    // Preserve the selected host and TLS verification policy. Only this test connection's TCP route changes.
    config: { ...config, stream: () => new RelayedSocket() },
    partition() {
      partitioned = true;
    },
    restore() {
      partitioned = false;
      for (const socket of sockets) socket.destroy();
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
