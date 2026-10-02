import type Database from 'better-sqlite3';
import type { DeliveryActionHandler } from '../../../delivery.js';
import type { Session } from '../../../types.js';
import type { Context } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import { COS_PROTOCOL, validRequest, validResponse, type CosResponse } from '../contracts/protocol.js';
import type { Change, SourceChange, Result } from '../domain/contracts.js';
import type { PriorityStore } from '../store/priorities.js';
import type { KnowledgeStore, KnowledgeContext } from '../knowledge/store.js';
import type { CalendarReadInput, WorkChange, WorkRead } from '../contracts/protocol.js';
import type { ScheduleChange } from '../contracts/schedule-protocol.js';
import type { MissionRequest } from '../contracts/mission-protocol.js';

export function ensureRpcSchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_rpc_responses (
    request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, delivery_id TEXT NOT NULL, response TEXT NOT NULL,
    updated_at TEXT NOT NULL, PRIMARY KEY(request_id,payload_hash,delivery_id));
    CREATE TABLE IF NOT EXISTS cos_rpc_contexts (
      request_id TEXT NOT NULL,payload_hash TEXT NOT NULL,delivery_id TEXT NOT NULL,
      scope_id TEXT NOT NULL,session_id TEXT NOT NULL,generation TEXT NOT NULL,
      PRIMARY KEY(request_id,payload_hash,delivery_id));`);
}

export function createRpcHandler(dependencies: {
  resolveContext(session: Session, db: Database.Database): Promise<Context | null>;
  store: PriorityStore;
  reserveTool?(context: Context, callId: string): Promise<Result>;
  cancelMission?(context: Context, missionId: string): Promise<Result>;
  knowledge?: KnowledgeStore;
  resolveKnowledgeContext?(session: Session, context: Context, db: Database.Database): Promise<KnowledgeContext | null>;
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
    let retainedContext: KnowledgeContext | null = null;
    try {
      const context = await dependencies.resolveContext(session, db);
      const knowledgeContext =
        context && dependencies.knowledge
          ? ((await dependencies.resolveKnowledgeContext?.(session, context, db)) ?? null)
          : null;
      retainedContext = knowledgeContext;
      const access =
        dependencies.knowledge && knowledgeContext ? await dependencies.knowledge.contextReady(knowledgeContext) : null;
      let reservation =
        context?.origin && (!dependencies.knowledge || knowledgeContext) && (!access || access.status === 'ok')
          ? ((await dependencies.reserveTool?.(
              context,
              'rpc-' + digest({ request_id: request.request_id, delivery_id: content.delivery_id }),
            )) ?? { status: 'denied' as const })
          : null;
      if (reservation?.status === 'ok') {
        const current = await dependencies.resolveContext(session, db);
        if (!current || digest(current) !== digest(context)) reservation = { status: 'denied' };
      }
      if (!context) result = { status: 'denied' };
      else if (dependencies.knowledge && !knowledgeContext) result = { status: 'denied' };
      else if (access && access.status !== 'ok') result = { status: access.status };
      else if (reservation && reservation.status !== 'ok') result = { status: reservation.status };
      else if (request.method.startsWith('cos_mission_') && context.origin) result = { status: 'denied' };
      else if (request.method === 'cos_mission_request')
        result = await dependencies.store.requestMission(
          context,
          request.request_id,
          request.params.request as MissionRequest,
        );
      else if (request.method === 'cos_mission_get')
        result = await dependencies.store.missionRuns.inspect(context, String(request.params.mission_id));
      else if (request.method === 'cos_mission_cancel')
        result = (await dependencies.cancelMission?.(context, String(request.params.mission_id))) ?? {
          status: 'denied',
        };
      else if (request.method === 'cos_context_get') {
        result = await dependencies.store.context(context, knowledgeContext ?? undefined);
        if (result.status === 'ok')
          result = {
            ...result,
            calendar:
              dependencies.store.calendarView && knowledgeContext
                ? await dependencies.store.calendarView.coverage(
                    knowledgeContext,
                    Number(request.params.calendar_offset ?? 0),
                  )
                : { status: 'unavailable', coverage: 'not_configured', items: [] },
          };
      } else if (request.method === 'cos_change_propose')
        result = await dependencies.store.propose(context, request.request_id, request.params.change as Change);
      else if (request.method === 'cos_brief_schedule_propose')
        result = await dependencies.store.propose(context, request.request_id, request.params.change as ScheduleChange);
      else if (request.method === 'cos_work_read')
        result = await dependencies.store.readWork(context, request.params as WorkRead, knowledgeContext ?? undefined);
      else if (request.method === 'cos_work_change_propose')
        result = await dependencies.store.propose(
          context,
          request.request_id,
          request.params.change as WorkChange,
          knowledgeContext ?? undefined,
        );
      else if (request.method === 'cos_request_status')
        result = await dependencies.store.status(context, String(request.params.request_id));
      else if (!dependencies.knowledge || !knowledgeContext) result = { status: 'unavailable' };
      else if (request.method === 'cos_brief_request') {
        result = dependencies.store.briefArtifacts
          ? typeof request.params.artifact_id === 'string'
            ? await dependencies.store.briefArtifacts.readHistory(knowledgeContext, request.params.artifact_id)
            : await dependencies.store.briefArtifacts.prepare(
                knowledgeContext,
                request.request_id,
                String(request.params.time_zone),
              )
          : { status: 'unavailable' };
        if (context.origin && request.params.artifact_id === undefined && result.status === 'ok') {
          const saved = await dependencies.store.briefs.prepare(
            context,
            context.origin.runId,
            context.origin.generation,
            {
              artifact_id: String(result.artifact_id),
              output_digest: digest(result.text),
              context_generation: knowledgeContext.generation,
              provider: knowledgeContext.provider,
            },
          );
          if (saved.status !== 'ok') result = { status: saved.status };
        }
      } else if (request.method === 'cos_calendar_read')
        result = dependencies.store.calendarView
          ? await dependencies.store.calendarView.read(knowledgeContext, request.params as CalendarReadInput)
          : { status: 'unavailable' };
      else if (request.method === 'cos_knowledge_search')
        result = await dependencies.knowledge.search(knowledgeContext, {
          query: String(request.params.query),
          limit: request.params.limit as number | undefined,
          offset: request.params.offset as number | undefined,
          sourceId: request.params.source_id as string | undefined,
          projectId: request.params.project_id as string | undefined,
        });
      else if (request.method === 'cos_source_get')
        result = await dependencies.knowledge.get(
          knowledgeContext,
          String(request.params.source_id),
          String(request.params.revision_id),
          Number(request.params.ordinal),
        );
      else if (request.method === 'cos_answer_prepare')
        result = await dependencies.knowledge.answers.prepare(
          knowledgeContext,
          request.request_id,
          request.params.draft,
        );
      else if (request.method === 'cos_answer_get')
        result = await dependencies.knowledge.answers.get(knowledgeContext, String(request.params.artifact_id));
      else if (request.method === 'cos_source_change_propose')
        result = await dependencies.store.propose(context, request.request_id, request.params.change as SourceChange);
      else result = { status: 'denied' };
      if (result.status === 'ok') {
        const fresh = await dependencies.resolveContext(session, db);
        if (!fresh || digest(fresh) !== digest(context)) result = { status: 'denied' };
        else if (dependencies.knowledge) {
          const current = await dependencies.resolveKnowledgeContext?.(session, fresh, db);
          if (!current || digest(current) !== digest(knowledgeContext)) result = { status: 'denied' };
          else {
            const checked = await dependencies.knowledge.contextReady(current);
            if (checked.status !== 'ok') result = { status: checked.status };
          }
        }
      }
    } catch {
      result = { status: 'unavailable' };
    }
    // Tokens belong to the host-rendered private approval preview, not the model.
    const { status, confirmation_token: _token, ...safeResult } = result;
    let response: CosResponse = { protocol: COS_PROTOCOL, request_id: request.request_id, status, result: safeResult };
    if (!validResponse(response, request.request_id))
      response = { protocol: COS_PROTOCOL, request_id: request.request_id, status: 'unavailable' };
    db.transaction(() => {
      const hash = digest(request);
      db.prepare(
        `INSERT INTO cos_rpc_responses(request_id,payload_hash,delivery_id,response,updated_at) VALUES(?,?,?,?,?)
        ON CONFLICT(request_id,payload_hash,delivery_id) DO UPDATE SET response=excluded.response,updated_at=excluded.updated_at`,
      ).run(request.request_id, hash, content.delivery_id, JSON.stringify(response), new Date().toISOString());
      db.prepare('DELETE FROM cos_rpc_contexts WHERE request_id=? AND payload_hash=? AND delivery_id=?').run(
        request.request_id,
        hash,
        content.delivery_id,
      );
      if (retainedContext)
        db.prepare('INSERT INTO cos_rpc_contexts VALUES(?,?,?,?,?,?)').run(
          request.request_id,
          hash,
          content.delivery_id,
          retainedContext.scopeId,
          retainedContext.sessionId,
          retainedContext.generation,
        );
    })();
  };
}
