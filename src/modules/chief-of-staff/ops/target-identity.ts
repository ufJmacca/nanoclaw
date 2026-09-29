import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type pg from 'pg';
import type { PoolConfig } from 'pg';
import { isPrivateAddress } from '../store/config.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, type TargetState } from './target-state.js';

export function machineFingerprint(): string {
  if (process.platform !== 'linux' || process.arch !== 'arm64') throw new Error('unsupported_target');
  const id = fs.readFileSync('/etc/machine-id', 'utf8').trim();
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('target_identity_unavailable');
  return createHash('sha256')
    .update('linux-machine-id:' + id)
    .digest('hex');
}
export function localTarget(root: string, installationRoot: string, dataRoot: string): TargetState {
  if (!root || !path.isAbsolute(root)) throw new Error('target_binding_required');
  const value = readPrivate<TargetState>(path.join(root, 'state.json'));
  return readTarget(root, { ...value.binding, hostFingerprint: machineFingerprint(), installationRoot, dataRoot });
}
/** Stable across login roles and password rotation. The actual server/database must match, too. */
export async function databaseFingerprint(client: Pick<pg.Client, 'query'>, config: PoolConfig): Promise<string> {
  const { rows } = await client.query(`SELECT current_database() AS database,
    (SELECT oid::text FROM pg_database WHERE datname=current_database()) AS database_oid,
    host(inet_server_addr()) AS server_address, inet_server_port() AS server_port`);
  const value = rows[0];
  if (
    !value ||
    rows.length !== 1 ||
    value.database !== config.database ||
    !/^\d+$/.test(value.database_oid) ||
    typeof value.server_address !== 'string' ||
    !isPrivateAddress(value.server_address) ||
    !Number.isInteger(value.server_port)
  )
    throw new Error('database_identity_unavailable');
  const tls = config.ssl && typeof config.ssl === 'object' ? config.ssl : null;
  return digest({
    host: config.host,
    port: config.port,
    identity: value,
    transport: tls
      ? { rejectUnauthorized: tls.rejectUnauthorized, ca: tls.ca ?? 'system-trust' }
      : 'explicit-plaintext',
  });
}
