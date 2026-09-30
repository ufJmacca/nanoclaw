import type Database from 'better-sqlite3';
import type { DeliveryActionHandler } from '../../../delivery.js';
import type { Session } from '../../../types.js';
import type { Context } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import { COS_PROTOCOL, validRequest, validResponse, type CosResponse } from '../contracts/protocol.js';
import type { Change, Result } from '../domain/contracts.js';
import type { PriorityStore } from '../store/priorities.js';

export function ensureRpcSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_rpc_responses (
    request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery_id TEXT NOT NULL, response TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(request_id,payload_hash,delivery_id))`);
}

export function createRpcHandler(dependencies: {
  resolveContext(session: Session, db: Database.Database): Promise<Context | null>;
  store: PriorityStore;
}): DeliveryActionHandler {
  return async (content, session, db) => {
    ensureRpcSchema(db);
    const request = content.request;
    if (
      !validRequest(request) ||
      typeof content.delivery_id !== 'string' ||
      !/^[0-9a-f-]{36}$/i.test(content.delivery_id) ||
      Object.keys(content).some((key) => !['action', 'request', 'delivery_id'].includes(key))
    )
      return;
    let result: Result;
    try {
      const context = await dependencies.resolveContext(session, db);
      if (!context) result = { status: 'denied' };
      else if (request.method === 'cos_context_get') result = await dependencies.store.context(context);
      else if (request.method === 'cos_change_propose')
        result = await dependencies.store.propose(context, request.request_id, request.params.change as Change);
      else result = await dependencies.store.status(context, String(request.params.request_id));
      if (result.status === 'ok' && !(await dependencies.resolveContext(session, db))) result = { status: 'denied' };
    } catch {
      result = { status: 'unavailable' };
    }
    // Tokens belong to the host-rendered private approval preview, not the model.
    const { status, confirmation_token: _token, ...safeResult } = result;
    let response: CosResponse = { protocol: COS_PROTOCOL, request_id: request.request_id, status, result: safeResult };
    if (!validResponse(response, request.request_id))
      response = { protocol: COS_PROTOCOL, request_id: request.request_id, status: 'unavailable' };
    db.prepare(
      `INSERT INTO cos_rpc_responses(request_id,payload_hash,delivery_id,response,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(request_id,payload_hash,delivery_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at`,
    ).run(request.request_id, digest(request), content.delivery_id, JSON.stringify(response), new Date().toISOString());
  };
}
