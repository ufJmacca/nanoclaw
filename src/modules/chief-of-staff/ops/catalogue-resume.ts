import type { Client, PoolClient } from 'pg';
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest } from '../domain/contracts.js';
import { readPrivate, writeAtomic } from './target-state.js';

type Request = {
  binding: CosBinding;
  activationId: string;
  resumeId: string;
  expectedVersion: number;
  policyDigest: string;
  ownerControlsDigest: string;
  observeOnly?: boolean;
  check(): Promise<void>;
};
type Receipt = { status: 'catalogue_resumed'; scope_id: string; version: number };

function controlsDigest(db: Database.Database, binding: CosBinding): string {
  const rows = hasTable(db, 'cos_operator_denials')
    ? (db
        .prepare(
          'SELECT ingress_id,binding_digest,payload_digest,kind,target,state FROM cos_operator_denials WHERE scope_id=? ORDER BY ingress_id LIMIT 1001',
        )
        .all(binding.scopeId) as Array<{ binding_digest: string }>)
    : [];
  if (rows.length > 1000 || rows.some((r) => r.binding_digest !== digest(binding)))
    throw Error('catalogue_resume_denied');
  return digest(rows);
}
/** Freeze the independent native owner-control snapshot before the first remote mutation.
 * A restored remote receipt or retry cannot grant authority over a newer local owner pause. */
export function catalogueResumeGuard(
  root: string,
  db: Database.Database,
  request: Omit<Request, 'check' | 'ownerControlsDigest' | 'observeOnly'>,
) {
  const verifyDirectory = (directory: string) => {
    const stat = fs.lstatSync(directory);
    if (
      !path.isAbsolute(directory) ||
      fs.realpathSync(directory) !== directory ||
      !stat.isDirectory() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o700
    )
      throw Error('unsafe_activation_state');
  };
  verifyDirectory(root);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(request.resumeId))
    throw Error('invalid_resume_request');
  const directory = path.join(root, 'catalogue-resumptions');
  if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
  verifyDirectory(directory);
  const nativeRecord = path.join(root, 'context-resumptions', request.resumeId + '.json');
  const file = path.join(directory, request.resumeId + '.json');
  const ownerControlsDigest = controlsDigest(db, request.binding);
  const record = { contract: 'cos-owner-catalogue-resume/v1', ...request, ownerControlsDigest };
  const boundary = db
    .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
    .get(request.binding.scopeId) as { binding: string; paused: number } | undefined;
  if (!boundary || digest(JSON.parse(boundary.binding)) !== digest(request.binding))
    throw Error('catalogue_resume_denied');
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    if (digest(readPrivate(file)) !== digest(record)) throw Error('resume_conflict');
  } else {
    if (fs.lstatSync(nativeRecord, { throwIfNoEntry: false }) || boundary.paused !== 1) throw Error('resume_conflict');
    writeAtomic(directory, request.resumeId + '.json', record);
  }
  return {
    ownerControlsDigest,
    observeOnly: !!fs.lstatSync(nativeRecord, { throwIfNoEntry: false }),
    check: () => {
      if (controlsDigest(db, request.binding) !== ownerControlsDigest || digest(readPrivate(file)) !== digest(record))
        throw Error('resume_conflict');
    },
  };
}

/** Trusted owner administration only. The caller verifies current issued model authority,
 * native identity, private membership, denial journals, maintenance and host leases.
 * Grant and receipt commit together; a replay never reopens a later pause or revocation. */
export async function resumeCatalogueScope(client: Pick<Client | PoolClient, 'query'>, request: Request) {
  const { binding, activationId, resumeId, expectedVersion, policyDigest, ownerControlsDigest, check } = request;
  if (
    !Number.isSafeInteger(expectedVersion) ||
    expectedVersion < 1 ||
    expectedVersion >= 2147483647 ||
    !/^[a-f0-9]{32}$/.test(activationId) ||
    !/^[a-f0-9]{64}$/.test(policyDigest) ||
    !/^[a-f0-9]{64}$/.test(ownerControlsDigest) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(resumeId)
  )
    throw Error('invalid_resume_request');
  const requestId = 'owner-catalogue-resume-' + resumeId;
  const payloadHash = digest({ binding, activationId, resumeId, expectedVersion, policyDigest, ownerControlsDigest });
  await check();
  await client.query('BEGIN');
  try {
    const scope = (
      await client.query(
        'SELECT owner_id,instance_id,channel_id,agent_group_id,status,version FROM cos.scopes WHERE id=$1 FOR UPDATE',
        [binding.scopeId],
      )
    ).rows[0];
    if (
      !scope ||
      scope.owner_id !== binding.ownerId ||
      scope.instance_id !== binding.instanceId ||
      scope.channel_id !== binding.channelId ||
      scope.agent_group_id !== binding.agentGroupId ||
      !['active', 'paused'].includes(scope.status)
    )
      throw Error('catalogue_resume_denied');
    const previous = (
      await client.query(
        'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
        [binding.sessionId, requestId],
      )
    ).rows[0];
    if (previous) {
      const receipt = previous.result as Receipt;
      if (
        previous.scope_id !== binding.scopeId ||
        previous.method !== 'owner.catalogue.resume' ||
        previous.payload_hash !== payloadHash ||
        !receipt ||
        Object.keys(receipt).sort().join(',') !== 'scope_id,status,version' ||
        receipt?.status !== 'catalogue_resumed' ||
        receipt.scope_id !== binding.scopeId ||
        !Number.isSafeInteger(receipt.version)
      )
        throw Error('resume_conflict');
      if (scope.status !== 'active' || scope.version !== receipt.version) throw Error('catalogue_resume_superseded');
      await check();
      await client.query('COMMIT');
      return { ...receipt, status: 'catalogue_resume_replayed' as const };
    }
    if (request.observeOnly) throw Error('catalogue_resume_superseded');
    if (scope.version !== expectedVersion) throw Error('catalogue_resume_stale_version');
    await check();
    let version = scope.version as number;
    if (scope.status === 'paused') {
      const changed = await client.query(
        "UPDATE cos.scopes SET status='active',version=version+1,updated_at=clock_timestamp() WHERE id=$1 AND status='paused' AND version=$2 RETURNING version",
        [binding.scopeId, expectedVersion],
      );
      if (changed.rowCount !== 1) throw Error('catalogue_resume_stale_version');
      version = changed.rows[0].version;
    }
    const result: Receipt = { status: 'catalogue_resumed', scope_id: binding.scopeId, version };
    await client.query(
      'INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
      [binding.sessionId, requestId, binding.scopeId, 'owner.catalogue.resume', payloadHash, JSON.stringify(result)],
    );
    if (scope.status === 'paused')
      await client.query(
        'INSERT INTO cos.events(id,scope_id,kind,resource_id,version,provenance) VALUES($1,$2,$3,$2,$4,$5)',
        [
          requestId,
          binding.scopeId,
          'owner_scope_resume',
          version,
          JSON.stringify({
            owner_id: binding.ownerId,
            session_id: binding.sessionId,
            activation_id: activationId,
            resume_id: resumeId,
            policy_digest: policyDigest,
          }),
        ],
      );
    await check();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
