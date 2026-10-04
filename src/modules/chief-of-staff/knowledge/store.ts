import type { Context, Result, SourceChange } from '../domain/contracts.js';
import { canonical, digest } from '../domain/contracts.js';
import type { MissionSource } from '../contracts/mission-protocol.js';
import type { MissionSourceSnapshot } from '../missions/work-order.js';
import { extractChunks } from './text.js';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import {
  KnowledgeArtifactsBusy,
  isArtifactIdentity,
  type ArtifactLease,
  type KnowledgeArtifacts,
} from './artifacts.js';
import { purgeKnowledge, type PurgeHooks } from './purge.js';
import { KnowledgeAnswers, type AnswerHooks } from './answer-store.js';
import { calendarSourceAccess } from '../calendar/source-access.js';
import { hasCalendarReadScope } from '../calendar/reader.js';
import { calendarAnswerNotice, checkCalendarContext, type CalendarAnswerNotice } from '../calendar/answer-notice.js';
export type KnowledgeContext = Context & { provider: string; generation: string };
export type ImportSource = {
  sourceKey: string;
  filename: string;
  title: string;
  processingProviders: string[];
  expectedVersion: number;
  projectId?: string;
};
export type Search = { query: string; limit?: number; offset?: number; sourceId?: string; projectId?: string };
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const providers = ['codex', 'claude'];
export type InventoryPage = { limit?: number; after?: string; status?: string };
export function validInventoryPage(page: unknown): page is InventoryPage {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
  const p = page as Record<string, unknown>;
  return (
    Object.keys(p).every((key) => ['limit', 'after', 'status'].includes(key)) &&
    (p.limit === undefined || (Number.isSafeInteger(p.limit) && Number(p.limit) >= 1 && Number(p.limit) <= 100)) &&
    (p.after === undefined || (typeof p.after === 'string' && uuid.test(p.after))) &&
    (p.status === undefined ||
      (typeof p.status === 'string' &&
        ['admitted', 'indexing', 'current', 'stale', 'revoked', 'failed', 'unsupported'].includes(p.status)))
  );
}
async function authorised(client: PoolClient, context: Context, mutation = false): Promise<boolean> {
  return (
    (
      await client.query(
        `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR ${mutation ? 'UPDATE' : 'SHARE'}`,
        [context.scopeId, context.ownerId, context.agentGroupId],
      )
    ).rowCount === 1
  );
}
type Candidate = {
  source_id: string;
  revision_id: string;
  revision_digest: string;
  source_version: number;
  title: string;
  status: string;
  ordinal: number;
  start_line: number;
  end_line: number;
  heading: string;
  text: string;
  artifact_id: string;
  score: number;
};
export type Evidence = Omit<Candidate, 'artifact_id'> & { evidence_id: string; locator_format: string };
const candidateSelect = `SELECT s.id AS source_id,s.title,s.status,s.version AS source_version,
  r.id AS revision_id,r.digest AS revision_digest,r.artifact_id,c.ordinal,c.start_line,c.end_line,c.heading,c.text`;
const candidateJoin = `FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id
  JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
  JOIN cos.chunks c ON c.scope_id=r.scope_id AND c.revision_id=r.id
  WHERE s.scope_id=$1 AND s.status IN ('current','stale') AND $2=ANY(s.processing_providers)
  AND a.lifecycle='published' AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)`;
export class KnowledgeStore {
  readonly retentionMs: number;
  readonly answers: KnowledgeAnswers;
  readonly retrievalEnabled: () => boolean;
  private readonly calendarAccess: (scopeId: string, bindingId: string) => boolean;
  private readonly calendarNotice: (client: PoolClient, context: KnowledgeContext) => Promise<CalendarAnswerNotice>;
  constructor(
    readonly database: BoundedDatabase,
    readonly artifacts: KnowledgeArtifacts,
    readonly hooks: { afterPublication?(): Promise<void>; beforeDisclosure?(): Promise<void> } & PurgeHooks &
      AnswerHooks = {},
    options: {
      retentionMs?: number;
      retrievalEnabled?(): boolean;
      calendarAccess?(scopeId: string, bindingId: string): boolean;
      calendarEnabled?(): boolean;
    } = {},
  ) {
    this.retrievalEnabled = options.retrievalEnabled ?? (() => true);
    this.calendarAccess = options.calendarAccess ?? (() => false);
    this.calendarNotice = (client, context) =>
      calendarAnswerNotice(client, context, {
        enabled: () => this.retrievalEnabled() && (options.calendarEnabled?.() ?? false),
        access: this.calendarAccess,
      });
    this.answers = new KnowledgeAnswers({
      artifacts,
      hooks,
      transaction: (operation, mutation) => this.transaction(operation, mutation),
      exclusive: (operation) => this.exclusive(operation),
      current: (client, context) => this.current(client, context),
      sourcesReadable: (client, context, ids) => this.sourcesReadable(client, context, ids),
      retrievalEnabled: this.retrievalEnabled,
      calendarNotice: this.calendarNotice,
      calendarContext: (client, context, register) =>
        checkCalendarContext(client, context, () => this.calendarNotice(client, context), register),
    });
    this.retentionMs = options.retentionMs ?? 30 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.retentionMs) || this.retentionMs < 0 || this.retentionMs > 365 * 24 * 60 * 60 * 1000)
      throw new Error('invalid_knowledge_retention');
  }
  private async transaction(operation: (client: PoolClient) => Promise<Result>, mutation = false): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      }, mutation);
    } catch (error) {
      if (error instanceof DatabaseUnavailable)
        return { status: mutation && error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async exclusive(operation: (lease: ArtifactLease) => Promise<Result>): Promise<Result> {
    try {
      return await this.artifacts.exclusive(operation);
    } catch (error) {
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
  }
  async purgeDue(scopeId: string): Promise<Result> {
    return this.exclusive((lease) =>
      purgeKnowledge({
        scopeId,
        lease,
        artifacts: this.artifacts,
        hooks: this.hooks,
        transaction: (operation, mutation) => this.transaction(operation, mutation),
        reconcileOrphans: () => this.reconcileWithLease(lease, null),
      }),
    );
  }
  /** Trusted host cleanup only. Preserve quarantined captures until their separate retention purge. */
  async reconcileArtifacts(graceMs = 24 * 60 * 60 * 1000): Promise<Result> {
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 365 * 24 * 60 * 60 * 1000)
      return { status: 'denied' };
    return this.exclusive((lease) => this.reconcileWithLease(lease, graceMs));
  }
  private async reconcileWithLease(lease: ArtifactLease, graceMs: number | null): Promise<Result> {
    const references = await this.transaction(async (client) => {
      // A timed-out metadata commit may still be resolving remotely. This barrier
      // waits for it before taking a READ COMMITTED snapshot of references.
      await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
      await client.query('SELECT pg_advisory_xact_lock(73101004)');
      const rows = (await client.query("SELECT id FROM cos.artifacts WHERE lifecycle<>'deleted'")).rows as Array<{
        id: string;
      }>;
      // Only this store's encoded filenames are eligible for filesystem cleanup.
      return { status: 'ok', references: rows.map((row) => row.id).filter(isArtifactIdentity) };
    });
    if (references.status !== 'ok') return { status: references.status };
    const retained = new Set(references.references as string[]);
    const removed =
      graceMs === null
        ? this.artifacts.purgeUnreferenced(retained, lease)
        : this.artifacts.reconcile(retained, Date.now() - graceMs, lease);
    return { status: 'ok', removed };
  }
  /** Trusted owner setup/import only. Paths and processing policy are never accepted through model RPC. */
  async importSource(context: Context, requestId: string, input: ImportSource): Promise<Result> {
    if (!this.retrievalEnabled()) return { status: 'unavailable' };
    if (
      !uuid.test(requestId) ||
      !input ||
      !idPattern.test(input.sourceKey) ||
      typeof input.title !== 'string' ||
      !input.title.trim() ||
      input.title.length > 200 ||
      !Number.isSafeInteger(input.expectedVersion) ||
      input.expectedVersion < 0 ||
      !Array.isArray(input.processingProviders) ||
      input.processingProviders.length > providers.length ||
      new Set(input.processingProviders).size !== input.processingProviders.length ||
      input.processingProviders.some((p) => !providers.includes(p)) ||
      (input.projectId !== undefined && !idPattern.test(input.projectId))
    )
      return { status: 'denied' };
    const access = await this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const revoked = await client.query(
        `SELECT s.id FROM cos.sources s WHERE s.scope_id=$1 AND s.source_key=$2 AND
        (s.status='revoked' OR EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id))`,
        [context.scopeId, input.sourceKey],
      );
      return { status: revoked.rowCount ? 'denied' : 'ok' };
    });
    if (access.status !== 'ok') return access;
    return this.exclusive(async (lease) => {
      if (!this.retrievalEnabled()) return { status: 'unavailable' };
      const inspected = this.artifacts.inspect(context.scopeId, input.filename, lease);
      const eligible = await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(73101004)');
        if (!(await authorised(client, context))) return { status: 'denied' };
        const deleted = await client.query(
          "SELECT id FROM cos.artifacts WHERE id=$1 AND (scope_id<>$2 OR lifecycle='deleted')",
          [inspected.id, context.scopeId],
        );
        return { status: deleted.rowCount ? 'conflict' : 'ok' };
      });
      if (eligible.status !== 'ok') return eligible;
      if (!this.retrievalEnabled()) return { status: 'unavailable' };
      const captured = this.artifacts.capture(context.scopeId, input.filename, lease, inspected.digest);
      await this.hooks.afterPublication?.();
      const hash = digest({ method: 'cos_source_import', input, content: captured.digest });
      const result = await this.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(73101004)');
        if (!this.retrievalEnabled()) return { status: 'unavailable' };
        if (!(await authorised(client, context, true))) return { status: 'denied' };
        const inserted = await client.query(
          `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
        VALUES($1,$2,$3,'cos_source_import',$4) ON CONFLICT DO NOTHING RETURNING request_id`,
          [context.sessionId, requestId, context.scopeId, hash],
        );
        if (!inserted.rowCount) {
          const old = (
            await client.query(
              'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
              [context.sessionId, requestId],
            )
          ).rows[0];
          return old?.scope_id === context.scopeId && old?.payload_hash === hash
            ? (old.result ?? { status: 'pending', request_id: requestId })
            : { status: 'conflict' };
        }
        const receipt: Result = await (async () => {
          if (
            input.projectId &&
            !(
              await client.query(
                "SELECT id FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind='project' AND lifecycle='active'",
                [context.scopeId, input.projectId],
              )
            ).rowCount
          )
            return { status: 'denied' };
          const previous = (
            await client.query(
              `SELECT s.*,r.digest AS current_digest FROM cos.sources s LEFT JOIN cos.source_revisions r ON r.id=s.current_revision_id AND r.scope_id=s.scope_id
          WHERE s.scope_id=$1 AND s.source_key=$2 FOR UPDATE OF s`,
              [context.scopeId, input.sourceKey],
            )
          ).rows[0];
          if (
            previous?.provenance?.origin === 'calendar_observation' ||
            Object.hasOwn(previous?.access_policy ?? {}, 'calendar_binding_id') ||
            previous?.status === 'revoked' ||
            (previous &&
              (
                await client.query('SELECT 1 FROM cos.revocation_tombstones WHERE scope_id=$1 AND source_id=$2', [
                  context.scopeId,
                  previous.id,
                ])
              ).rowCount)
          )
            return { status: 'denied' };
          if (
            previous?.current_digest === captured.digest &&
            previous.title === input.title &&
            previous.project_id === (input.projectId ?? null) &&
            digest([...previous.processing_providers].sort()) === digest([...input.processingProviders].sort())
          )
            return {
              status: 'ok',
              source_id: previous.id,
              revision_id: previous.current_revision_id,
              digest: captured.digest,
              version: previous.version,
            };
          if ((previous?.version ?? 0) !== input.expectedVersion) return { status: 'conflict' };
          const sourceId = previous?.id ?? randomUUID(),
            revisionId = randomUUID(),
            version = (previous?.version ?? 0) + 1;
          const provenance = {
            owner_id: context.ownerId,
            ingress_id: context.ingressId,
            request_id: requestId,
            processing_providers: input.processingProviders,
            origin: 'selected_staging_file',
          };
          await client.query(
            `INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'source',$3,$4,'published',$5) ON CONFLICT DO NOTHING`,
            [captured.id, context.scopeId, captured.digest, captured.byteLength, JSON.stringify(provenance)],
          );
          const artifact = (
            await client.query('SELECT lifecycle,digest,byte_length FROM cos.artifacts WHERE scope_id=$1 AND id=$2', [
              context.scopeId,
              captured.id,
            ])
          ).rows[0];
          if (
            artifact?.lifecycle !== 'published' ||
            artifact.digest !== captured.digest ||
            artifact.byte_length !== captured.byteLength
          )
            return { status: 'conflict' };
          if (!previous)
            await client.query(
              `INSERT INTO cos.sources(id,scope_id,source_key,title,project_id,status,processing_providers,access_policy,provenance)
          VALUES($1,$2,$3,$4,$5,'indexing',$6,$7,$8)`,
              [
                sourceId,
                context.scopeId,
                input.sourceKey,
                input.title,
                input.projectId ?? null,
                input.processingProviders,
                JSON.stringify({ scope_owner_only: true }),
                JSON.stringify(provenance),
              ],
            );
          await client.query(
            `INSERT INTO cos.source_revisions(id,scope_id,source_id,artifact_id,digest,version,supersedes,locator_format,provenance)
          VALUES($1,$2,$3,$4,$5,$6,$7,'normalized-utf8-lines/v1',$8)`,
            [
              revisionId,
              context.scopeId,
              sourceId,
              captured.id,
              captured.digest,
              version,
              previous?.current_revision_id ?? null,
              JSON.stringify(provenance),
            ],
          );
          for (const [ordinal, chunk] of captured.chunks.entries())
            await client.query(
              `INSERT INTO cos.chunks(scope_id,revision_id,ordinal,start_line,end_line,heading,text) VALUES($1,$2,$3,$4,$5,$6,$7)`,
              [context.scopeId, revisionId, ordinal, chunk.startLine, chunk.endLine, chunk.heading, chunk.text],
            );
          await client.query(
            `UPDATE cos.sources SET current_revision_id=$3,title=$4,project_id=$5,status='current',processing_providers=$6,version=$7,provenance=$8,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2`,
            [
              context.scopeId,
              sourceId,
              revisionId,
              input.title,
              input.projectId ?? null,
              input.processingProviders,
              version,
              JSON.stringify(provenance),
            ],
          );
          if (previous) {
            await client.query(
              `UPDATE cos.artifacts a SET lifecycle='quarantined',version=version+1,updated_at=clock_timestamp() WHERE a.scope_id=$1 AND a.kind<>'source' AND a.lifecycle='published' AND EXISTS(
            SELECT 1 FROM cos.derivation_links d JOIN cos.evidence_refs e ON e.scope_id=d.scope_id AND e.id=d.evidence_id WHERE d.scope_id=a.scope_id AND d.artifact_id=a.id AND e.source_id=$2)`,
              [context.scopeId, sourceId],
            );
            await client.query(
              `INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'knowledge_invalidate',$3)`,
              [
                'knowledge-' + requestId,
                context.scopeId,
                JSON.stringify({ source_id: sourceId, source_version: version }),
              ],
            );
          }
          return { status: 'ok', source_id: sourceId, revision_id: revisionId, digest: captured.digest, version };
        })();
        await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
          context.sessionId,
          requestId,
          JSON.stringify(receipt),
        ]);
        return receipt;
      }, true);
      return result.status === 'pending' ? { ...result, request_id: requestId } : result;
    });
  }
  private async openCalendarBindings(client: PoolClient, context: KnowledgeContext): Promise<string[]> {
    const rows = (
      await client.query(
        "SELECT id::text,permission_scopes FROM cos.calendar_bindings WHERE scope_id=$1 AND auth='ready' AND $2=ANY(processing_providers)",
        [context.scopeId, context.provider],
      )
    ).rows as Array<{ id: string; permission_scopes: string[] }>;
    return rows
      .filter(({ id, permission_scopes }) => {
        try {
          return hasCalendarReadScope(permission_scopes) && this.calendarAccess(context.scopeId, id) === true;
          // eslint-disable-next-line no-catch-all/no-catch-all -- Missing/corrupt journals and recorded access loss deny disclosure without revealing private paths.
        } catch {
          return false;
        }
      })
      .map(({ id }) => id);
  }
  private async sourcesReadable(client: PoolClient, context: KnowledgeContext, ids: string[]): Promise<boolean> {
    const unique = [...new Set(ids)];
    if (!unique.length) return true;
    const allowed = await this.openCalendarBindings(client, context);
    return (
      (
        await client.query(
          `SELECT s.id FROM cos.sources s WHERE s.scope_id=$1 AND s.id=ANY($2::text[]) AND ${calendarSourceAccess('$3')}`,
          [context.scopeId, unique, allowed],
        )
      ).rowCount === unique.length
    );
  }
  private async current(client: PoolClient, context: KnowledgeContext): Promise<boolean> {
    if (!providers.includes(context.provider) || !uuid.test(context.generation) || !(await authorised(client, context)))
      return false;
    const invalid = await client.query(
      `SELECT 1 FROM cos.evidence_refs e JOIN cos.sources s ON s.scope_id=e.scope_id AND s.id=e.source_id
      WHERE e.scope_id=$1 AND e.session_id=$2 AND e.context_generation=$3 AND
      (NOT $5::boolean OR s.version<>e.source_version OR s.current_revision_id<>e.revision_id OR s.status NOT IN ('current','stale')
        OR NOT $4=ANY(s.processing_providers) OR e.processing_provider<>$4 OR NOT ${calendarSourceAccess('$6')}
        OR EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)) LIMIT 1`,
      [
        context.scopeId,
        context.sessionId,
        context.generation,
        context.provider,
        this.retrievalEnabled(),
        await this.openCalendarBindings(client, context),
      ],
    );
    if (invalid.rowCount) return false;
    return (await checkCalendarContext(client, context, () => this.calendarNotice(client, context))).status === 'ok';
  }
  async contextReady(context: KnowledgeContext): Promise<Result> {
    return this.transaction(async (client) => ({ status: (await this.current(client, context)) ? 'ok' : 'denied' }));
  }
  private async missionSourceMetadata(client: PoolClient, context: KnowledgeContext, selection: MissionSource) {
    return (
      await client.query(
        `SELECT s.id AS source_id,s.version AS source_version,s.title,s.status,
      r.id AS revision_id,r.digest AS revision_digest,r.artifact_id
    FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.source_id=s.id AND r.id=s.current_revision_id
    JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
    WHERE s.scope_id=$1 AND s.id=$2 AND r.id=$3 AND s.status IN ('current','stale')
      AND $4=ANY(s.processing_providers) AND a.lifecycle='published' AND a.kind='source' AND a.digest=r.digest
      AND ((s.provenance->>'origin'='selected_staging_file' AND s.access_policy='{"scope_owner_only":true}'::jsonb)
        OR (s.provenance->>'origin'='calendar_observation' AND s.access_policy->>'scope_owner_only'='true' AND ${calendarSourceAccess('$5')}))
      AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
    FOR SHARE OF s,r,a`,
        [
          context.scopeId,
          selection.source_id,
          selection.revision_id,
          context.provider,
          await this.openCalendarBindings(client, context),
        ],
      )
    ).rows[0];
  }
  /** Trusted denial-only reconciliation shares the admission rules, without reading chunks or private artifact bytes. */
  async missionSourcesCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    selected: MissionSource[],
  ): Promise<boolean> {
    if (
      context.origin ||
      context.provider !== 'codex' ||
      !this.retrievalEnabled() ||
      !Array.isArray(selected) ||
      selected.length < 1 ||
      selected.length > 8 ||
      !selected.every((s) => s && Object.keys(s).length === 2 && uuid.test(s.source_id) && uuid.test(s.revision_id)) ||
      new Set(selected.map((s) => s.source_id)).size !== selected.length ||
      !(await this.current(client, context))
    )
      return false;
    for (const selection of selected) if (!(await this.missionSourceMetadata(client, context, selection))) return false;
    return this.retrievalEnabled();
  }
  /** Trusted mission admission only. Caller owns the transaction; no worker receives this client or artifact root. */
  async missionCalendarBindingCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    bindingId: string,
  ): Promise<boolean> {
    return (
      this.retrievalEnabled() &&
      (await this.current(client, context)) &&
      (await this.openCalendarBindings(client, context)).includes(bindingId)
    );
  }
  /** Trusted mission admission only. Caller owns the transaction; no worker receives this client or artifact root. */
  async captureMissionSources(
    client: PoolClient,
    context: KnowledgeContext,
    selected: MissionSource[],
    maxBytes: number,
  ): Promise<MissionSourceSnapshot[] | null> {
    if (
      context.origin ||
      context.provider !== 'codex' ||
      !this.retrievalEnabled() ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1024 ||
      maxBytes > 65536 ||
      !Array.isArray(selected) ||
      selected.length < 1 ||
      selected.length > 8 ||
      !selected.every((s) => s && Object.keys(s).length === 2 && uuid.test(s.source_id) && uuid.test(s.revision_id)) ||
      new Set(selected.map((s) => s.source_id)).size !== selected.length ||
      !(await this.current(client, context))
    )
      return null;
    const snapshots: MissionSourceSnapshot[] = [];
    for (const selection of selected) {
      const row = await this.missionSourceMetadata(client, context, selection);
      if (!row || !this.retrievalEnabled()) return null;
      const chunks = (
        await client.query(
          'SELECT ordinal,start_line,end_line,text FROM cos.chunks WHERE scope_id=$1 AND revision_id=$2 ORDER BY ordinal LIMIT 513',
          [context.scopeId, row.revision_id],
        )
      ).rows as MissionSourceSnapshot['chunks'];
      if (!chunks.length || chunks.length > 512) return null;
      const original = extractChunks(this.artifacts.read(row.artifact_id, row.revision_digest)).map(
        (chunk, ordinal) => ({
          ordinal,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          text: chunk.text,
        }),
      );
      if (digest(chunks) !== digest(original)) return null;
      const { artifact_id: _artifact, ...source } = row;
      snapshots.push({ ...source, chunks } as MissionSourceSnapshot);
      if (Buffer.byteLength(canonical({ format: 'cos-mission-context/v1', sources: snapshots })) > maxBytes)
        return null;
    }
    return this.retrievalEnabled() && (await this.current(client, context)) ? snapshots : null;
  }
  /** Record metadata exposure before returning a calendar view, including empty and unavailable views. */
  async recordCalendarContext(context: KnowledgeContext): Promise<Result> {
    return this.transaction(async (client) => {
      if (!(await this.current(client, context))) return { status: 'denied' };
      const result = await checkCalendarContext(client, context, () => this.calendarNotice(client, context), true);
      return { status: result.status };
    }, true);
  }
  /** Trusted host reconciliation, including paused scopes. No agent RPC exposes these methods. */
  async pendingInvalidations(scopeId: string): Promise<Result> {
    return this.transaction(async (client) => ({
      status: 'ok',
      items: (
        await client.query(
          "SELECT id FROM cos.outbox WHERE scope_id=$1 AND kind='knowledge_invalidate' AND delivered_at IS NULL ORDER BY created_at,id LIMIT 20",
          [scopeId],
        )
      ).rows,
    }));
  }
  async acknowledgeInvalidation(scopeId: string, id: string): Promise<Result> {
    return this.transaction(
      async (client) => ({
        status:
          (
            await client.query(
              "UPDATE cos.outbox SET delivered_at=COALESCE(delivered_at,clock_timestamp()) WHERE scope_id=$1 AND id=$2 AND kind='knowledge_invalidate' RETURNING id",
              [scopeId, id],
            )
          ).rowCount === 1
            ? 'ok'
            : 'denied',
      }),
      true,
    );
  }
  async search(context: KnowledgeContext, input: Search): Promise<Result> {
    if (!this.retrievalEnabled()) return { status: 'unavailable' };
    if (
      typeof input?.query !== 'string' ||
      input.query.length > 400 ||
      !Number.isInteger(input.limit ?? 5) ||
      (input.limit ?? 5) < 1 ||
      (input.limit ?? 5) > 5 ||
      !Number.isInteger(input.offset ?? 0) ||
      (input.offset ?? 0) < 0 ||
      (input.offset ?? 0) > 10000 ||
      (input.sourceId !== undefined && !idPattern.test(input.sourceId)) ||
      (input.projectId !== undefined && !idPattern.test(input.projectId))
    )
      return { status: 'denied' };
    const selected = await this.transaction(async (client) => {
      if (!(await this.current(client, context))) return { status: 'denied' };
      if (!input.query.trim()) return { status: 'ok', items: [] };
      const items = (
        await client.query(
          `${candidateSelect},ts_rank(c.search,plainto_tsquery('simple',$3)) AS score ${candidateJoin}
        AND c.search @@ plainto_tsquery('simple',$3) AND ($4::text IS NULL OR s.id=$4) AND ($5::text IS NULL OR s.project_id=$5)
        AND ${calendarSourceAccess('$8')}
        ORDER BY score DESC,s.id,c.ordinal LIMIT $6 OFFSET $7`,
          [
            context.scopeId,
            context.provider,
            input.query,
            input.sourceId ?? null,
            input.projectId ?? null,
            input.limit ?? 5,
            input.offset ?? 0,
            await this.openCalendarBindings(client, context),
          ],
        )
      ).rows;
      return { status: 'ok', items };
    });
    if (selected.status !== 'ok') return selected;
    return this.disclose(context, selected.items as Candidate[]);
  }
  async get(context: KnowledgeContext, sourceId: string, revisionId: string, ordinal: number): Promise<Result> {
    if (!this.retrievalEnabled()) return { status: 'unavailable' };
    if (
      !idPattern.test(sourceId) ||
      !uuid.test(revisionId) ||
      !Number.isInteger(ordinal) ||
      ordinal < 0 ||
      ordinal > 1000000
    )
      return { status: 'denied' };
    const selected = await this.transaction(async (client) => {
      if (!(await this.current(client, context))) return { status: 'denied' };
      const items = (
        await client.query(
          `${candidateSelect},0 AS score ${candidateJoin} AND s.id=$3 AND r.id=$4 AND c.ordinal=$5 AND ${calendarSourceAccess('$6')}`,
          [
            context.scopeId,
            context.provider,
            sourceId,
            revisionId,
            ordinal,
            await this.openCalendarBindings(client, context),
          ],
        )
      ).rows;
      return { status: items.length ? 'ok' : 'denied', items };
    });
    if (selected.status !== 'ok') return { status: selected.status };
    return this.disclose(context, selected.items as Candidate[]);
  }
  private async disclose(context: KnowledgeContext, candidates: Candidate[]): Promise<Result> {
    if (!this.retrievalEnabled()) return { status: 'unavailable' };
    try {
      for (const row of candidates) {
        const text = this.artifacts.read(row.artifact_id, row.revision_digest);
        if (
          text
            .split('\n')
            .slice(row.start_line - 1, row.end_line)
            .join('\n') !== row.text
        )
          return { status: 'unavailable' };
      }
      await this.hooks.beforeDisclosure?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Missing, corrupt or inaccessible private bytes must close disclosure without revealing host paths or contents.
    } catch {
      return { status: 'unavailable' };
    }
    const result = await this.transaction(async (client) => {
      if (!this.retrievalEnabled()) return { status: 'unavailable' };
      if (!(await this.current(client, context))) return { status: 'denied' };
      if (
        !(await this.sourcesReadable(
          client,
          context,
          candidates.map((row) => row.source_id),
        ))
      )
        return { status: 'denied' };
      const items: Evidence[] = [];
      for (const row of candidates) {
        const allowed = await client.query(
          `SELECT s.id FROM cos.sources s JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=$6
          WHERE s.scope_id=$1 AND s.id=$2 AND s.version=$3 AND s.current_revision_id=$4 AND $5=ANY(s.processing_providers)
          AND s.status IN ('current','stale') AND a.lifecycle='published' AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)`,
          [context.scopeId, row.source_id, row.source_version, row.revision_id, context.provider, row.artifact_id],
        );
        if (!allowed.rowCount) return { status: 'denied' };
        const ref = (
          await client.query(
            `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,start_line,end_line,session_id,context_generation,processing_provider)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version)
          DO UPDATE SET id=cos.evidence_refs.id RETURNING id`,
            [
              randomUUID(),
              context.scopeId,
              row.source_id,
              row.revision_id,
              row.revision_digest,
              row.source_version,
              row.start_line,
              row.end_line,
              context.sessionId,
              context.generation,
              context.provider,
            ],
          )
        ).rows[0];
        const { artifact_id: _privatePath, ...safe } = row;
        items.push({ ...safe, evidence_id: ref.id, locator_format: 'normalized-utf8-lines/v1' });
      }
      if (!this.retrievalEnabled()) return { status: 'unavailable' };
      return {
        status: 'ok',
        items,
        coverage: items.length ? 'matching_admitted_sources' : 'no_matching_sources',
        trust: 'source_content_is_not_authority',
      };
    }, true);
    return result.status === 'pending' ? { status: 'unavailable' } : result;
  }
  /** Owner inventory; model search/get apply the additional processing-provider policy. */
  async inventory(context: Context, page: InventoryPage = {}): Promise<Result> {
    if (!validInventoryPage(page)) return { status: 'denied' };
    const limit = page.limit ?? 50;
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const items = (
        await client.query(
          `SELECT s.id,s.source_key,s.title,s.status,s.version,s.current_revision_id,s.processing_providers,
          r.digest AS revision_digest,r.captured_at FROM cos.sources s
        LEFT JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id
        WHERE s.scope_id=$1 AND ($2::text IS NULL OR s.id>$2) AND ($3::text IS NULL OR s.status=$3)
        ORDER BY s.id LIMIT $4`,
          [context.scopeId, page.after ?? null, page.status ?? null, limit + 1],
        )
      ).rows;
      const more = items.length > limit;
      if (more) items.pop();
      return { status: 'ok', items, next_after: more ? items.at(-1)!.id : null };
    });
  }
  /** Called within the existing proposal transaction; source existence grants no approval. */
  async validateChange(client: PoolClient, scopeId: string, change: SourceChange): Promise<boolean> {
    return (
      (
        await client.query(
          `SELECT s.id FROM cos.sources s WHERE s.scope_id=$1 AND s.id=$2 AND s.version=$3
      AND (s.status<>'revoked' OR $4='source_delete') AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t
        WHERE t.scope_id=s.scope_id AND t.source_id=s.id AND t.kind='delete')`,
          [scopeId, change.source_id, change.expected_version, change.kind],
        )
      ).rowCount === 1
    );
  }
  /** Existing outbox application owns the transaction and scope lock. Never exposed as RPC. */
  async applyApproved(client: PoolClient, scopeId: string, proposalId: string, change: SourceChange): Promise<Result> {
    const proposal = (
      await client.query(
        `SELECT p.owner_id,p.decision_ingress_id,p.payload_hash,p.change FROM cos.proposals p
      JOIN cos.scopes s ON s.id=p.scope_id AND s.owner_id=p.owner_id AND s.status='active'
      WHERE p.scope_id=$1 AND p.id=$2 AND p.state='approved' FOR UPDATE OF p`,
        [scopeId, proposalId],
      )
    ).rows[0];
    if (!proposal || proposal.payload_hash !== digest(change) || digest(proposal.change) !== digest(change))
      return { status: 'denied' };
    if (!(await this.validateChange(client, scopeId, change))) return { status: 'conflict' };
    const updated = await client.query(
      `UPDATE cos.sources SET status='revoked',processing_providers='{}',version=version+1,updated_at=clock_timestamp()
      WHERE scope_id=$1 AND id=$2 AND version=$3 RETURNING version`,
      [scopeId, change.source_id, change.expected_version],
    );
    if (!updated.rowCount) return { status: 'conflict' };
    const version = updated.rows[0].version;
    const provenance = {
      proposal_id: proposalId,
      owner_id: proposal.owner_id,
      ingress_id: proposal.decision_ingress_id,
      reason: change.reason,
    };
    // Access closes immediately. Deletion keeps a tombstone and allows a bounded retention window for local bytes.
    await client.query(
      `INSERT INTO cos.revocation_tombstones(scope_id,source_id,kind,version,provenance,purge_after)
      VALUES($1,$2,$3,$4,$5,CASE WHEN $3='delete' THEN clock_timestamp()+$6*interval '1 millisecond' ELSE NULL END)
      ON CONFLICT(scope_id,source_id) DO UPDATE SET kind=excluded.kind,version=excluded.version,provenance=excluded.provenance,
        updated_at=clock_timestamp(),purge_after=excluded.purge_after`,
      [
        scopeId,
        change.source_id,
        change.kind === 'source_delete' ? 'delete' : 'revoke',
        version,
        JSON.stringify(provenance),
        this.retentionMs,
      ],
    );
    await client.query(
      `UPDATE cos.artifacts a SET lifecycle='quarantined',version=version+1,updated_at=clock_timestamp()
      WHERE a.scope_id=$1 AND a.kind<>'source' AND a.lifecycle='published' AND EXISTS(SELECT 1 FROM cos.derivation_links d
        JOIN cos.evidence_refs e ON e.scope_id=d.scope_id AND e.id=d.evidence_id
        WHERE d.scope_id=a.scope_id AND d.artifact_id=a.id AND e.source_id=$2)`,
      [scopeId, change.source_id],
    );
    const payload = JSON.stringify({ source_id: change.source_id, source_version: version });
    await client.query(
      `INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'knowledge_invalidate',$3) ON CONFLICT DO NOTHING`,
      ['knowledge-proposal-' + proposalId, scopeId, payload],
    );
    if (change.kind === 'source_delete')
      await client.query(
        `INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'knowledge_purge',$3) ON CONFLICT DO NOTHING`,
        ['knowledge-purge-' + proposalId, scopeId, payload],
      );
    return { status: 'ok', source_id: change.source_id, version };
  }
}
