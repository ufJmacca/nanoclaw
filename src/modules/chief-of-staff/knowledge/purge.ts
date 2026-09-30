import type { PoolClient } from 'pg';
import type { Result } from '../domain/contracts.js';
import { isArtifactIdentity, type ArtifactLease, type KnowledgeArtifacts } from './artifacts.js';

export type RetentionContexts = {
  scopeId: string;
  sourceId: string;
  contexts: Array<{ sessionId: string; generation: string }>;
};
export type PurgeHooks = {
  afterPurgeMetadata?(): Promise<void>;
  afterPurgeUnlink?(): Promise<void>;
  purgeContexts?(job: RetentionContexts): Promise<Result>;
};

type Transaction = (operation: (client: PoolClient) => Promise<Result>, mutation?: boolean) => Promise<Result>;
type Job = {
  id: string;
  source_id: string;
  source_version: number;
  artifacts: string[];
  contexts: RetentionContexts['contexts'];
};
/** Host-only, restartable deletion. Remote denial commits before any filesystem removal. */
export async function purgeKnowledge(options: {
  scopeId: string;
  artifacts: KnowledgeArtifacts;
  lease: ArtifactLease;
  transaction: Transaction;
  hooks: PurgeHooks;
}): Promise<Result> {
  const { scopeId, transaction } = options;
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId)) return { status: 'denied' };
  let processed = 0;
  for (let count = 0; count < 5; count++) {
    const prepared = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      if (!(await client.query('SELECT id FROM cos.scopes WHERE id=$1 FOR UPDATE', [scopeId])).rowCount)
        return { status: 'denied' };
      const row = (
        await client.query(
          `SELECT o.id,o.payload,t.source_id,t.version AS source_version FROM cos.outbox o
        JOIN cos.revocation_tombstones t ON t.scope_id=o.scope_id AND t.source_id=o.payload->>'source_id'
        JOIN cos.sources s ON s.scope_id=t.scope_id AND s.id=t.source_id
        WHERE o.scope_id=$1 AND o.kind='knowledge_purge' AND o.delivered_at IS NULL AND t.kind='delete'
          AND t.purge_after<=clock_timestamp() AND s.status='revoked' AND s.version=t.version
          AND o.payload->>'source_version'=t.version::text
        ORDER BY o.created_at,o.id LIMIT 1 FOR UPDATE OF o,t,s`,
          [scopeId],
        )
      ).rows[0];
      if (!row) return { status: 'ok', job: null };
      const contexts = (
        await client.query(
          `SELECT DISTINCT session_id AS "sessionId",context_generation AS generation
        FROM cos.evidence_refs WHERE scope_id=$1 AND source_id=$2 ORDER BY session_id,context_generation LIMIT 1001`,
          [scopeId, row.source_id],
        )
      ).rows;
      if (contexts.length > 1000) return { status: 'unavailable' };
      if (row.payload.stage === 'metadata_removed') {
        const ids = row.payload.artifact_ids;
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string' || !isArtifactIdentity(id)))
          return { status: 'unavailable' };
        const kept = await client.query(
          "SELECT id FROM cos.artifacts WHERE scope_id=$1 AND id=ANY($2) AND lifecycle='deleted'",
          [scopeId, ids],
        );
        if (kept.rowCount !== ids.length) return { status: 'unavailable' };
        return {
          status: 'ok',
          job: { id: row.id, source_id: row.source_id, source_version: row.source_version, artifacts: ids, contexts },
        };
      }
      const candidates = (
        await client.query(
          `SELECT a.id FROM cos.artifacts a WHERE a.scope_id=$1 AND (
        (a.kind='source' AND EXISTS(SELECT 1 FROM cos.source_revisions r WHERE r.scope_id=a.scope_id AND r.artifact_id=a.id AND r.source_id=$2)
          AND NOT EXISTS(SELECT 1 FROM cos.source_revisions other LEFT JOIN cos.revocation_tombstones t
            ON t.scope_id=other.scope_id AND t.source_id=other.source_id
            WHERE other.scope_id=a.scope_id AND other.artifact_id=a.id AND other.source_id<>$2
            AND (t.kind IS DISTINCT FROM 'delete' OR COALESCE(t.provenance#>>'{content_purge,state}','') NOT IN ('metadata_removed','completed'))))
        OR (a.kind<>'source' AND EXISTS(SELECT 1 FROM cos.derivation_links d JOIN cos.evidence_refs e
          ON e.scope_id=d.scope_id AND e.id=d.evidence_id WHERE d.scope_id=a.scope_id AND d.artifact_id=a.id AND e.source_id=$2)))
        ORDER BY a.id`,
          [scopeId, row.source_id],
        )
      ).rows as Array<{ id: string }>;
      const ids = candidates.map((item) => item.id);
      if (ids.some((id) => !isArtifactIdentity(id))) return { status: 'unavailable' };
      const shared = (
        await client.query(
          'SELECT count(DISTINCT artifact_id)::int AS n FROM cos.source_revisions WHERE scope_id=$1 AND source_id=$2 AND NOT artifact_id=ANY($3)',
          [scopeId, row.source_id, ids],
        )
      ).rows[0].n;
      await client.query(
        "UPDATE cos.artifacts SET lifecycle='deleted',version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=ANY($2) AND lifecycle<>'deleted'",
        [scopeId, ids],
      );
      await client.query(
        'DELETE FROM cos.chunks c USING cos.source_revisions r WHERE c.scope_id=r.scope_id AND c.revision_id=r.id AND r.scope_id=$1 AND r.source_id=$2',
        [scopeId, row.source_id],
      );
      await client.query(
        "UPDATE cos.sources SET title='Deleted source',updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [scopeId, row.source_id],
      );
      await client.query(
        `UPDATE cos.revocation_tombstones SET provenance=jsonb_set(provenance,'{content_purge}',jsonb_build_object(
        'state','metadata_removed','metadata_at',clock_timestamp(),'retained_shared_artifacts',$3::int)),updated_at=clock_timestamp()
        WHERE scope_id=$1 AND source_id=$2`,
        [scopeId, row.source_id, shared],
      );
      await client.query(
        "UPDATE cos.outbox SET payload=payload || jsonb_build_object('stage','metadata_removed','artifact_ids',$3::jsonb) WHERE scope_id=$1 AND id=$2",
        [scopeId, row.id, JSON.stringify(ids)],
      );
      return {
        status: 'ok',
        job: { id: row.id, source_id: row.source_id, source_version: row.source_version, artifacts: ids, contexts },
      };
    }, true);
    if (prepared.status !== 'ok') return prepared;
    if (!prepared.job) return { status: 'ok', processed };
    const job = prepared.job as Job;
    await options.hooks.afterPurgeMetadata?.();
    for (const id of job.artifacts) options.artifacts.remove(id, options.lease);
    await options.hooks.afterPurgeUnlink?.();
    if (job.contexts.length) {
      if (!options.hooks.purgeContexts) return { status: 'pending', code: 'retained_history_requires_maintenance' };
      const history = await options.hooks.purgeContexts({ scopeId, sourceId: job.source_id, contexts: job.contexts });
      if (history.status !== 'ok') return history;
    }
    const completed = await transaction(async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      const changed = await client.query(
        `WITH completed AS (
          UPDATE cos.revocation_tombstones t SET provenance=jsonb_set(provenance,'{content_purge}',
            (provenance->'content_purge') || jsonb_build_object('state','completed','completed_at',clock_timestamp(),'local_history','purged_or_not_present','external_disclosures','not_retractable','backups','separate_retention')),updated_at=clock_timestamp()
          WHERE t.scope_id=$1 AND t.source_id=$3 AND t.kind='delete' AND t.version::text=$4
            AND t.provenance#>>'{content_purge,state}'='metadata_removed'
            AND EXISTS(SELECT 1 FROM cos.outbox o WHERE o.scope_id=$1 AND o.id=$2 AND o.kind='knowledge_purge'
              AND o.delivered_at IS NULL AND o.payload->>'stage'='metadata_removed'
              AND o.payload->>'source_id'=$3 AND o.payload->>'source_version'=$4)
          RETURNING source_id
        ) UPDATE cos.outbox SET delivered_at=clock_timestamp()
          WHERE scope_id=$1 AND id=$2 AND EXISTS(SELECT 1 FROM completed) RETURNING id`,
        [scopeId, job.id, job.source_id, String(job.source_version)],
      );
      if (!changed.rowCount) return { status: 'conflict' };
      return { status: 'ok' };
    }, true);
    if (completed.status !== 'ok') return completed;
    processed++;
  }
  return { status: 'ok', processed };
}
