export type VaultAuthorityScope = { operationId: string; targetDigest: string; generation: number };
export type VaultAuthority = {
  socket: string;
  token: string;
  close(): Promise<void>;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function validScope(value: unknown): value is VaultAuthorityScope {
  return (
    object(value) &&
    Object.keys(value).sort().join(',') === 'generation,operationId,targetDigest' &&
    typeof value.operationId === 'string' &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.operationId) &&
    typeof value.targetDigest === 'string' &&
    /^[a-f0-9]{64}$/.test(value.targetDigest) &&
    Number.isSafeInteger(value.generation) &&
    Number(value.generation) > 0
  );
}
function privateDirectory(root: string, ownerId: number) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== ownerId ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('unsafe_authority_socket');
  return stat;
}
/** Live local authority channel. It carries no database, account, recovery or OS command material. */
export async function openVaultAuthority(
  root: string,
  scope: VaultAuthorityScope,
  check: () => Promise<void>,
): Promise<VaultAuthority> {
  let directory: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  try {
    if (process.platform !== 'linux' || !validScope(scope) || typeof check !== 'function')
      throw Error('unsafe_authority');
    const ownerId = process.getuid!();
    if (ownerId === 0) throw Error('owner_process_required');
    privateDirectory(root, ownerId);
    const fixed = Object.freeze({ ...scope }),
      token = randomBytes(32).toString('hex');
    directory = path.join(root, randomUUID());
    const socket = path.join(directory, 'authority.sock');
    if (Buffer.byteLength(socket) > 100) throw Error('authority_path_bounds');
    fs.mkdirSync(directory, { mode: 0o700 });
    let active = true;
    const connections = new Set<net.Socket>();
    const server = net.createServer({ allowHalfOpen: true }, (connection) => {
      connections.add(connection);
      connection.on('error', () => {});
      connection.once('close', () => connections.delete(connection));
      connection.setTimeout(3000, () => connection.destroy());
      void (async () => {
        try {
          let requests = 0;
          for await (const message of runtimeTestMessages(connection)) {
            if (
              ++requests !== 1 ||
              !active ||
              !object(message) ||
              Object.keys(message).sort().join(',') !== 'challenge,contract,scope,token' ||
              message.contract !== 'cos-vault-authority-request/v1' ||
              typeof message.challenge !== 'string' ||
              !/^[a-f0-9-]{36}$/.test(message.challenge) ||
              typeof message.token !== 'string' ||
              !/^[a-f0-9]{64}$/.test(message.token) ||
              !timingSafeEqual(Buffer.from(message.token, 'hex'), Buffer.from(token, 'hex')) ||
              !validScope(message.scope) ||
              digest(message.scope) !== digest(fixed)
            )
              throw Error('authority_request_denied');
            privateDirectory(directory!, ownerId);
            const stat = fs.lstatSync(socket);
            if (!stat.isSocket() || stat.uid !== ownerId || (stat.mode & 0o777) !== 0o600)
              throw Error('authority_socket_changed');
            await check();
            if (!active) throw Error('authority_ended');
            await writeRuntimeTestMessage(connection, {
              contract: 'cos-vault-authority-proof/v1',
              scope: fixed,
              challenge: message.challenge,
              status: 'verified',
            });
            connection.end();
          }
          // eslint-disable-next-line no-catch-all/no-catch-all -- Capability bytes and the parent's private lease diagnostics cannot enter output.
        } catch {
          connection.destroy();
        }
      })();
    });
    let closed = false;
    cleanup = async () => {
      if (closed) return;
      closed = true;
      active = false;
      for (const connection of connections) connection.destroy();
      if (server.listening)
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      if (directory && fs.existsSync(directory) && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
    };
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
    fs.chmodSync(socket, 0o600);
    server.on('error', () => {});
    const result = {
      socket,
      async close() {
        try {
          await cleanup!();
        } catch {
          // eslint-disable-next-line preserve-caught-error -- Cleanup cannot disclose private socket paths.
          throw Error('vault_authority_unavailable');
        }
      },
    } as VaultAuthority;
    // Accidental receipt serialization must not disclose the live capability.
    Object.defineProperty(result, 'token', { value: token, enumerable: false });
    return result;
  } catch {
    try {
      if (cleanup) await cleanup();
      else if (directory && fs.existsSync(directory) && !fs.readdirSync(directory).length) fs.rmdirSync(directory);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Failed private cleanup must not replace the sanitized failure or delete unrelated files.
    } catch {
      /* Leave any changed directory for owner reconciliation. */
    }
    // eslint-disable-next-line preserve-caught-error -- Socket and target paths are private; expose only the fixed unavailable result.
    throw Error('vault_authority_unavailable');
  }
}
export async function checkVaultAuthority(
  authority: Pick<VaultAuthority, 'socket' | 'token'>,
  scope: VaultAuthorityScope,
  ownerId: number,
): Promise<void> {
  let connection: net.Socket | undefined;
  try {
    if (
      process.platform !== 'linux' ||
      !validScope(scope) ||
      !Number.isSafeInteger(ownerId) ||
      ownerId < 1 ||
      typeof authority.token !== 'string' ||
      !/^[a-f0-9]{64}$/.test(authority.token)
    )
      throw Error('unsafe_authority');
    const directory = path.dirname(authority.socket),
      parent = privateDirectory(directory, ownerId),
      before = fs.lstatSync(authority.socket);
    if (
      !before.isSocket() ||
      before.uid !== ownerId ||
      (before.mode & 0o777) !== 0o600 ||
      fs.realpathSync(authority.socket) !== authority.socket
    )
      throw Error('unsafe_authority_socket');
    const challenge = randomUUID();
    connection = net.createConnection({ path: authority.socket, allowHalfOpen: true });
    connection.on('error', () => {});
    connection.setTimeout(3000, () => connection!.destroy());
    await writeRuntimeTestMessage(connection, {
      contract: 'cos-vault-authority-request/v1',
      scope,
      challenge,
      token: authority.token,
    });
    connection.end();
    let replies = 0;
    for await (const message of runtimeTestMessages(connection)) {
      if (
        ++replies !== 1 ||
        !object(message) ||
        Object.keys(message).sort().join(',') !== 'challenge,contract,scope,status' ||
        message.contract !== 'cos-vault-authority-proof/v1' ||
        message.status !== 'verified' ||
        message.challenge !== challenge ||
        !validScope(message.scope) ||
        digest(message.scope) !== digest(scope)
      )
        throw Error('authority_reply_unverified');
    }
    const after = fs.lstatSync(authority.socket),
      current = privateDirectory(directory, ownerId);
    if (
      replies !== 1 ||
      !after.isSocket() ||
      after.uid !== ownerId ||
      (after.mode & 0o777) !== 0o600 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      current.dev !== parent.dev ||
      current.ino !== parent.ino
    )
      throw Error('authority_socket_changed');
  } catch {
    // eslint-disable-next-line preserve-caught-error -- No capability, host path or parent diagnostics may escape this boundary.
    throw Error('vault_authority_unavailable');
  } finally {
    connection?.destroy();
  }
}
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from './runtime-test-wire.js';
