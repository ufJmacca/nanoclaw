import net from 'node:net';

/** Loopback transport in the network-none native runtime. The host enforces CONNECT policy. */
export async function startSubscriptionRelay(socketPath = '/run/cos/subscription.sock') {
  const sockets = new Set<net.Socket>();
  let closed = false;
  const server = net.createServer((client) => {
    const upstream = net.createConnection(socketPath);
    const stop = () => {
      client.destroy();
      upstream.destroy();
    };
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on('error', stop);
      socket.once('close', () => {
        sockets.delete(socket);
        stop();
      });
    }
    // Also bounds a native client that connects without ever sending a request.
    const deadline = setTimeout(stop, 180000);
    client.once('close', () => clearTimeout(deadline));
    // net.Socket buffers until connected; pipe supplies backpressure immediately.
    client.pipe(upstream);
    upstream.pipe(client);
  });
  server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    proxyUrl: `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`,
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
