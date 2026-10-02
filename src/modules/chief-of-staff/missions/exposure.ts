import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import type { CosMissionIdentity } from '../../../cos-mission-boundary.js';
import type { ResearchWorkOrder } from './work-order.js';

/** Record every admitted source, including uncited influence, for revocation and provider-context purge. */
export async function recordMissionExposure(
  client: PoolClient,
  identity: CosMissionIdentity,
  order: ResearchWorkOrder,
) {
  const references = order.context.sources.flatMap((source) =>
    source.chunks.map((chunk) => ({
      id: randomUUID(),
      source_id: source.source_id,
      revision_id: source.revision_id,
      revision_digest: source.revision_digest,
      source_version: source.source_version,
      start_line: chunk.start_line,
      end_line: chunk.end_line,
    })),
  );
  await client.query(
    `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,
    start_line,end_line,session_id,context_generation,processing_provider)
    SELECT r.id,$1,r.source_id,r.revision_id,r.revision_digest,r.source_version,r.start_line,r.end_line,$2,$3,'codex'
    FROM jsonb_to_recordset($4::jsonb) AS r(id text,source_id text,revision_id text,revision_digest text,
      source_version integer,start_line integer,end_line integer)
    ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version) DO NOTHING`,
    [identity.scopeId, identity.sessionId, identity.attemptId, JSON.stringify(references)],
  );
}
