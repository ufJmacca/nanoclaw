import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { openVaultAuthority, checkVaultAuthority, type VaultAuthority } from './vault-authority.js';
const roots: string[] = [],
  servers: VaultAuthority[] = [];
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-authority-'));
  roots.push(root);
  const scope = { operationId: randomUUID(), targetDigest: 'a'.repeat(64), generation: 12 };
  const check = vi.fn(async () => {});
  const server = await openVaultAuthority(root, scope, check);
  servers.push(server);
  return { root, scope, check, server, ownerId: process.getuid!() };
}
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('revalidates live maintenance and host authority for each fixed provisioning check', async () => {
  const f = await fixture();
  expect(fs.statSync(f.server.socket).mode & 0o777).toBe(0o600);
  expect(JSON.stringify(f.server)).not.toContain(f.server.token);
  await checkVaultAuthority(f.server, f.scope, f.ownerId);
  await checkVaultAuthority(f.server, f.scope, f.ownerId);
  expect(f.check).toHaveBeenCalledTimes(2);
  f.check.mockImplementation(async () => {
    throw Error('PRIVATE_PARENT_FAILURE');
  });
  await expect(checkVaultAuthority(f.server, f.scope, f.ownerId)).rejects.toThrow('vault_authority_unavailable');
});
it.each(['command', 'oversize'])(
  'rejects %s requests without offering a general root command channel',
  async (reason) => {
    const f = await fixture();
    const connection = net.createConnection(f.server.socket);
    connection.on('error', () => {});
    connection.setTimeout(3000, () => connection.destroy());
    let replies = 0;
    connection.on('data', () => replies++);
    const ended = new Promise<void>((resolve) => connection.once('close', () => resolve()));
    connection.end(
      JSON.stringify({
        contract: 'cos-vault-authority-request/v1',
        scope: f.scope,
        token: f.server.token,
        challenge: randomUUID(),
        command: reason === 'oversize' ? 'x'.repeat(8192) : 'run_shell',
      }) + '\n',
    );
    await ended;
    expect(replies).toBe(0);
    expect(f.check).not.toHaveBeenCalled();
  },
);
it('does not publish a late proof after authority closes during an awaited check', async () => {
  const f = await fixture();
  let started!: () => void, release!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.check.mockImplementation(async () => {
    started();
    await pending;
  });
  const attempt = checkVaultAuthority(f.server, f.scope, f.ownerId);
  const denied = expect(attempt).rejects.toThrow('vault_authority_unavailable');
  await entered;
  await f.server.close();
  await denied;
  release();
});
it.each(['token', 'operation', 'target', 'generation', 'owner', 'permissions', 'socket-link'])(
  'denies mismatched or unsafe live authority: %s',
  async (reason) => {
    const f = await fixture(),
      grant = { socket: f.server.socket, token: f.server.token },
      scope = { ...f.scope };
    let uid = f.ownerId;
    if (reason === 'token') grant.token = 'b'.repeat(64);
    if (reason === 'operation') scope.operationId = randomUUID();
    if (reason === 'target') scope.targetDigest = 'b'.repeat(64);
    if (reason === 'generation') scope.generation++;
    if (reason === 'owner') uid++;
    if (reason === 'permissions') fs.chmodSync(grant.socket, 0o666);
    if (reason === 'socket-link') {
      fs.symlinkSync(grant.socket, f.root + '/link');
      grant.socket = f.root + '/link';
    }
    await expect(checkVaultAuthority(grant, scope, uid)).rejects.toThrow('vault_authority_unavailable');
    expect(f.check).not.toHaveBeenCalled();
  },
);
it('closes an issued capability when the owner ends the live operation', async () => {
  const f = await fixture();
  await f.server.close();
  await expect(checkVaultAuthority(f.server, f.scope, f.ownerId)).rejects.toThrow('vault_authority_unavailable');
});
it('denies exposed parent directories before opening any capability', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-vault-authority-'));
  roots.push(root);
  fs.chmodSync(root, 0o755);
  await expect(
    openVaultAuthority(
      root,
      { operationId: randomUUID(), targetDigest: 'a'.repeat(64), generation: 1 },
      async () => {},
    ),
  ).rejects.toThrow('vault_authority_unavailable');
  expect(fs.readdirSync(root)).toEqual([]);
});
