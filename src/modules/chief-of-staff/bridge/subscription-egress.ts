/** Fixed-destination TLS transport for the trusted native Codex client, not a model HTTP tool. */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';

type Address = { address: string; family: number };
const privateAddresses = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['2001::', 32],
  ['2001:db8::', 32],
  ['2002::', 16],
] as const)
  privateAddresses.addSubnet(address, prefix, 'ipv6');
const globalV6 = new net.BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function publicModelAddress(address: string): boolean {
  const family = net.isIP(address);
  return family === 4
    ? !privateAddresses.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !privateAddresses.check(address, 'ipv6');
}
function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('egress_deadline')), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function startSubscriptionEgress(options: {
  socketPath: string;
  role: 'query' | 'auth';
  authorize(): Promise<boolean>;
  limits?: { authorizationIntervalMs?: number; maxDurationMs?: number; maxBytes?: number; maxConnections?: number };
  /** Trusted test seams. Production always resolves and dials a validated public IP. */
  dependencies?: { resolve(host: string): Promise<Address[]>; connect(address: Address, port: number): net.Socket };
}) {
  const parent = path.dirname(options.socketPath),
    stat = fs.lstatSync(parent);
  if (
    !path.isAbsolute(options.socketPath) ||
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    fs.realpathSync(parent) !== parent ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0 ||
    fs.lstatSync(options.socketPath, { throwIfNoEntry: false }) ||
    !['query', 'auth'].includes(options.role)
  )
    throw new Error('unsafe_subscription_egress');
  const limits = {
    authorizationIntervalMs: 1000,
    maxDurationMs: 120000,
    maxBytes: 64 * 1024 * 1024,
    maxConnections: 8,
    ...options.limits,
  };
  if (
    Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0) ||
    limits.authorizationIntervalMs > 1000 ||
    limits.maxDurationMs > 180000 ||
    limits.maxBytes > 64 * 1024 * 1024 ||
    limits.maxConnections > 8
  )
    throw new Error('invalid_subscription_egress_limits');
  const dependencies = options.dependencies ?? {
    resolve: (host: string) => dns.lookup(host, { all: true, verbatim: true }),
    connect: (address: Address, port: number) =>
      net.createConnection({ host: address.address, family: address.family, port }),
  };
  const hosts = new Set(options.role === 'auth' ? ['chatgpt.com', 'auth.openai.com'] : ['chatgpt.com']);
  const clients = new Set<net.Socket>();
  const active = new Set<{ client: net.Socket; upstream?: net.Socket }>();
  let closed = false,
    checking = false;
  const server = http.createServer(
    { maxHeaderSize: 8192, headersTimeout: 5000, requestTimeout: 5000, keepAliveTimeout: 1000 },
    (request, response) => {
      response.writeHead(405, { 'content-length': '0', connection: 'close' });
      response.end();
      request.resume();
    },
  );
  server.maxConnections = limits.maxConnections;
  server.on('connection', (client) => {
    clients.add(client);
    client.on('error', () => client.destroy());
    client.once('close', () => clients.delete(client));
  });
  server.on('upgrade', (_request, client) => client.destroy());
  const authorized = async () => !closed && (await bounded(options.authorize(), 2500));
  server.on('connect', (request, rawClient, head) => {
    const client = rawClient as net.Socket;
    const deny = () => {
      if (!client.destroyed) client.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    };
    const host = request.url?.endsWith(':443') ? request.url.slice(0, -4) : '';
    if (
      closed ||
      !hosts.has(host) ||
      request.headers.host !== request.url ||
      head.length > 65536 ||
      active.size >= limits.maxConnections
    ) {
      deny();
      return;
    }
    client.pause();
    const connection: { client: net.Socket; upstream?: net.Socket } = { client };
    active.add(connection);
    let bytes = head.length;
    const stop = () => {
      client.destroy();
      connection.upstream?.destroy();
    };
    const lifetime = setTimeout(stop, limits.maxDurationMs);
    client.once('close', () => {
      clearTimeout(lifetime);
      active.delete(connection);
      connection.upstream?.destroy();
    });
    void (async () => {
      try {
        if (!(await authorized())) {
          deny();
          return;
        }
        const addresses = await bounded(dependencies.resolve(host), 2500);
        if (
          !addresses.length ||
          addresses.some(
            (address) => net.isIP(address.address) !== address.family || !publicModelAddress(address.address),
          ) ||
          !(await authorized()) ||
          client.destroyed
        ) {
          deny();
          return;
        }
        const address = addresses.find((candidate) => candidate.family === 4) ?? addresses[0];
        const upstream = dependencies.connect(address, 443);
        connection.upstream = upstream;
        upstream.on('error', () => stop());
        upstream.once('close', () => client.destroy());
        await bounded(
          new Promise<void>((resolve, reject) => {
            upstream.once('connect', resolve);
            upstream.once('error', reject);
          }),
          2500,
        );
        if (!(await authorized()) || client.destroyed) {
          upstream.destroy();
          deny();
          return;
        }
        const count = (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > limits.maxBytes) stop();
        };
        client.on('data', count);
        upstream.on('data', count);
        if (bytes > limits.maxBytes) {
          stop();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        // eslint-disable-next-line no-catch-all/no-catch-all -- All transport/auth failures close this boundary; raw endpoint details must not be returned.
      } catch {
        deny();
        connection.upstream?.destroy();
      }
    })();
  });
  const interval = setInterval(() => {
    if (checking || closed || active.size === 0) return;
    checking = true;
    void authorized()
      .then((allowed) => {
        if (!allowed)
          for (const connection of active) {
            connection.client.destroy();
            connection.upstream?.destroy();
          }
      })
      .catch(() => {
        for (const connection of active) {
          connection.client.destroy();
          connection.upstream?.destroy();
        }
      })
      .finally(() => {
        checking = false;
      });
  }, limits.authorizationIntervalMs);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.socketPath, () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    fs.chmodSync(options.socketPath, 0o600);
  } catch (error) {
    clearInterval(interval);
    server.close();
    throw error;
  }
  return {
    async close() {
      if (closed) return;
      closed = true;
      clearInterval(interval);
      for (const connection of active) connection.upstream?.destroy();
      for (const client of clients) client.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
