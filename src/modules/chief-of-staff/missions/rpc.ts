import type { DeliveryActionHandler } from '../../../delivery.js';
import { getDb } from '../../../db/connection.js';
import { getSession } from '../../../db/sessions.js';
import { missionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import type { Session } from '../../../types.js';
import { ensureRpcSchema } from '../bridge/rpc.js';
import { digest, type Result } from '../domain/contracts.js';
import {
  MISSION_WORKER_PROTOCOL,
  validMissionRpcEnvelope,
  validMissionWorkerResponse,
  type MissionWorkerResponse,
} from '../contracts/mission-worker-protocol.js';
import type { MissionWorkerResult } from '../contracts/mission-worker-protocol.js';
import type { MissionWorkerGrant } from './dispatch.js';
import type { MissionRunStore, MissionDispatchLease } from './run-store.js';

/** Dedicated native transport. Caller identity comes only from the host; no channel route is created. */
export function createMissionRpcHandler(dependencies: {
  resolve(session: Session): Promise<MissionWorkerGrant | null>;
  runs: Pick<MissionRunStore, 'readContext'>;
  submit(
    identity: CosMissionIdentity,
    lease: MissionDispatchLease,
    requestId: string,
    callId: string,
    result: MissionWorkerResult,
  ): Promise<Result>;
}): DeliveryActionHandler {
  function native(session: Session): CosMissionIdentity | null {
    const db = getDb(),
      passed = missionBoundary(session, db),
      actual = getSession(session.id);
    if (!passed.restricted || !passed.identity || !actual || isCosMissionStopped(passed.identity, db)) return null;
    const stored = missionBoundary(actual, db);
    return stored.restricted && stored.identity && digest(passed.identity) === digest(stored.identity)
      ? stored.identity
      : null;
  }
  async function resolve(session: Session): Promise<MissionWorkerGrant | null> {
    const before = native(session);
    if (!before) return null;
    const grant = await dependencies.resolve(session),
      after = native(session);
    return grant && after && digest(before) === digest(after) && digest(grant.identity) === digest(after)
      ? grant
      : null;
  }
  return async (content, session, db) => {
    ensureRpcSchema(db);
    if (!validMissionRpcEnvelope(content)) return;
    const { request, delivery_id: deliveryId } = content;
    let result: Result = { status: 'denied' },
      retained: CosMissionIdentity | null = null;
    try {
      const grant = await resolve(session);
      if (grant) {
        retained = grant.identity;
        const callId = 'worker-' + digest({ request_id: request.request_id, delivery_id: deliveryId });
        result =
          request.method === 'cos_mission_context_get'
            ? await dependencies.runs.readContext(grant.identity, grant.lease, callId)
            : await dependencies.submit(grant.identity, grant.lease, request.request_id, callId, request.params.result);
        const fresh = await resolve(session);
        if (!fresh || digest(fresh) !== digest(grant)) result = { status: 'denied' };
      }
    } catch {
      result = { status: 'unavailable' };
    }
    const { status, confirmation_token: _token, ...safeResult } = result;
    let response: MissionWorkerResponse = {
      protocol: MISSION_WORKER_PROTOCOL,
      request_id: request.request_id,
      status,
      ...(status === 'ok' ? { result: safeResult } : {}),
    };
    if (!validMissionWorkerResponse(response, request.request_id))
      response = { protocol: MISSION_WORKER_PROTOCOL, request_id: request.request_id, status: 'unavailable' };
    // No asynchronous work between final admission and the response/context retention transaction.
    db.transaction(() => {
      const hash = digest(request);
      db.prepare(
        `INSERT INTO cos_rpc_responses(request_id,payload_hash,delivery_id,response,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(request_id,payload_hash,delivery_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at`,
      ).run(request.request_id, hash, deliveryId, JSON.stringify(response), new Date().toISOString());
      db.prepare('DELETE FROM cos_rpc_contexts WHERE request_id=? AND payload_hash=? AND delivery_id=?').run(
        request.request_id,
        hash,
        deliveryId,
      );
      if (retained)
        db.prepare('INSERT INTO cos_rpc_contexts VALUES(?,?,?,?,?,?)').run(
          request.request_id,
          hash,
          deliveryId,
          retained.scopeId,
          retained.sessionId,
          retained.attemptId,
        );
    })();
  };
}
