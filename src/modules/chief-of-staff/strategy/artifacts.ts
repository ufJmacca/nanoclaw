import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import { KnowledgeArtifactsBusy, type ArtifactLease } from '../knowledge/artifacts.js';
import {
  reviewId,
  reviewInteger,
  reviewUuid,
  validReviewRequest,
  type ReviewRequest,
  type ReviewDraft,
} from '../contracts/strategy-protocol.js';
import type { ReviewCollector, ReviewVersionRefs } from './collector.js';
import { assembleReview, renderReview, type ReviewArtifact, type ReviewSnapshot } from './review.js';

type SnapshotMetadata = {
  id: string;
  revision: number;
  artifact_id: string;
  artifact_digest: string;
  snapshot_digest: string;
  version_refs: ReviewVersionRefs;
  context: KnowledgeContext;
  expires_at: Date;
};
type ResultMetadata = { artifact_id: string; artifact_digest: string; draft_digest: string; output_digest: string };
const ticket = (context: KnowledgeContext, text: string) =>
  'review-read-' +
  digest({
    scope: context.scopeId,
    session: context.sessionId,
    generation: context.generation,
    ingress: context.ingressId,
    output: digest(text),
  });

/** Unapproved review prose lives only in private artifacts, under existing derivation/revocation/purge rules.
 * Files are accessed outside PostgreSQL leases; every disclosure and publication repeats remote authority checks. */
export class ReviewArtifacts {
  constructor(readonly collector: ReviewCollector) {}
  private get knowledge() {
    return this.collector.options.knowledge;
  }
  private async operation(
    client: PoolClient,
    context: KnowledgeContext,
    id: string,
    method: string,
    hash: string,
  ): Promise<Result> {
    if (context.origin || !(await this.knowledge.answers.dependencies.current(client, context)))
      return { status: 'denied' };
    const row = (
      await client.query(
        'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
        [context.sessionId, id],
      )
    ).rows[0];
    return !row
      ? { status: 'ok' }
      : row.scope_id === context.scopeId && row.method === method && row.payload_hash === hash
        ? (row.result ?? { status: 'pending' })
        : { status: 'conflict' };
  }
  private async saveOperation(
    client: PoolClient,
    context: KnowledgeContext,
    id: string,
    method: string,
    hash: string,
    result: Result,
  ): Promise<void> {
    await client.query(
      'INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,$4,$5,$6)',
      [context.sessionId, id, context.scopeId, method, hash, JSON.stringify(result)],
    );
  }
  private async snapshotMetadata(
    client: PoolClient,
    context: KnowledgeContext,
    id: string,
    revision: number,
  ): Promise<SnapshotMetadata | null> {
    const d = this.knowledge.answers.dependencies;
    if (context.origin || !(await d.current(client, context))) return null;
    const row = (
      await client.query(
        `SELECT s.id,s.revision,s.artifact_id,a.digest AS artifact_digest,s.snapshot_digest,s.version_refs,s.context,s.expires_at
       FROM cos.strategy_review_snapshots s JOIN cos.artifacts a ON a.scope_id=s.scope_id AND a.id=s.artifact_id
       WHERE s.scope_id=$1 AND s.id=$2 AND s.revision=$3 AND s.owner_id=$4 AND s.session_id=$5 AND s.processing_provider=$6
       AND a.kind='summary' AND a.lifecycle='published' AND a.provenance->>'format'='cos-strategy-snapshot/v1'`,
        [context.scopeId, id, revision, context.ownerId, context.sessionId, context.provider],
      )
    ).rows[0] as SnapshotMetadata | undefined;
    return row &&
      row.context.scopeId === context.scopeId &&
      row.context.ownerId === context.ownerId &&
      row.context.sessionId === context.sessionId &&
      row.context.agentGroupId === context.agentGroupId &&
      row.context.provider === context.provider
      ? row
      : null;
  }
  private async resultMetadata(
    client: PoolClient,
    context: KnowledgeContext,
    id: string,
    revision: number,
  ): Promise<ResultMetadata | null> {
    const row = (
      await client.query(
        `SELECT r.artifact_id,a.digest AS artifact_digest,r.draft_digest,r.output_digest
       FROM cos.strategy_review_results r JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
       WHERE r.scope_id=$1 AND r.review_id=$2 AND r.revision=$3 AND a.kind='summary' AND a.lifecycle='published'
       AND a.provenance->>'format'='cos-strategy-review/v1'`,
        [context.scopeId, id, revision],
      )
    ).rows[0] as ResultMetadata | undefined;
    return row ?? null;
  }
  private async dependencies(client: PoolClient, context: KnowledgeContext, artifact: string): Promise<boolean> {
    const rows = (
      await client.query(
        'SELECT evidence_id FROM cos.derivation_links WHERE scope_id=$1 AND artifact_id=$2 ORDER BY evidence_id LIMIT 1001',
        [context.scopeId, artifact],
      )
    ).rows;
    if (rows.length > 1000) return false;
    for (let i = 0; i < rows.length; i += 10)
      if (
        !(await this.knowledge.answers.validateWorkEvidence(
          client,
          context,
          rows.slice(i, i + 10).map((r) => ({ kind: 'source' as const, evidence_id: r.evidence_id })),
          true,
        ))
      )
        return false;
    return true;
  }
  private async registerArtifact(
    client: PoolClient,
    context: KnowledgeContext,
    captured: { id: string; digest: string; byteLength: number },
    format: string,
    snapshot: ReviewSnapshot,
  ): Promise<void> {
    await client.query(
      "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'summary',$3,$4,'published',$5)",
      [
        captured.id,
        context.scopeId,
        captured.digest,
        captured.byteLength,
        JSON.stringify({
          format,
          owner_id: context.ownerId,
          session_id: context.sessionId,
          processing_provider: context.provider,
          context_generation: context.generation,
          ingress_id: context.ingressId,
          snapshot_digest: digest(snapshot),
        }),
      ],
    );
    // Include uncited retained context as well as the displayed evidence; either can influence advice.
    await client.query(
      `INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id)
       SELECT scope_id,$1,id FROM cos.evidence_refs WHERE scope_id=$2 AND session_id=$3 AND context_generation=$4 AND processing_provider=$5
       ON CONFLICT DO NOTHING`,
      [captured.id, context.scopeId, context.sessionId, context.generation, context.provider],
    );
  }
  private async fence(
    client: PoolClient,
    context: KnowledgeContext,
    metadata: SnapshotMetadata,
    snapshot: ReviewSnapshot,
  ): Promise<boolean> {
    const current = await this.snapshotMetadata(client, context, metadata.id, metadata.revision);
    return (
      !!current &&
      digest(current) === digest(metadata) &&
      (await this.collector.validateSnapshot(client, context, snapshot, metadata.version_refs)) &&
      (await this.dependencies(client, context, metadata.artifact_id))
    );
  }
  private async readSnapshot(context: KnowledgeContext, id: string, revision: number): Promise<Result> {
    if (!reviewId(id) || !reviewInteger(revision)) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies;
    const before = await d.transaction(async (client) => {
      const metadata = await this.snapshotMetadata(client, context, id, revision);
      return metadata ? { status: 'ok', metadata } : { status: 'denied' };
    });
    if (before.status !== 'ok') return before;
    const metadata = before.metadata as SnapshotMetadata;
    let snapshot: ReviewSnapshot;
    try {
      const body = JSON.parse(d.artifacts.read(metadata.artifact_id, metadata.artifact_digest));
      if (
        body.format !== 'cos-strategy-snapshot/v1' ||
        digest(body.snapshot) !== metadata.snapshot_digest ||
        body.snapshot.review_id !== id ||
        body.snapshot.revision !== revision
      )
        return { status: 'denied' };
      snapshot = body.snapshot;
    } catch {
      return { status: 'unavailable' };
    }
    return d.transaction(
      async (client) =>
        (await this.fence(client, context, metadata, snapshot))
          ? { status: 'ok', review_id: id, revision, snapshot, metadata }
          : { status: 'denied' },
      true,
    );
  }
  async request(context: KnowledgeContext, id: string, input: ReviewRequest): Promise<Result> {
    if (!reviewUuid(id) || !validReviewRequest(input) || context.origin) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies,
      method = 'cos_review_request';
    const hash = digest({ method, input, provider: context.provider, generation: context.generation });
    const old = await d.transaction((client) => this.operation(client, context, id, method, hash));
    if (old.status !== 'ok') return old;
    if (old.review_id) {
      const read = await this.readSnapshot(context, String(old.review_id), Number(old.revision));
      if (read.status !== 'ok') return read;
      return { status: 'ok', review_id: read.review_id, revision: read.revision, snapshot: read.snapshot };
    }
    const review = 'review-' + digest({ scope: context.scopeId, session: context.sessionId, request: id });
    const collected = await this.collector.collect(context, input, { review_id: review, revision: 1, previous: null });
    if (collected.status !== 'ok') return collected;
    const snapshot = collected.snapshot as ReviewSnapshot,
      refs = collected.version_refs as ReviewVersionRefs;
    const body = JSON.stringify({ format: 'cos-strategy-snapshot/v1', snapshot });
    if (Buffer.byteLength(body) > 65536) return { status: 'unavailable' };
    let result: Result;
    try {
      result = await d.artifacts.exclusive(async (lease: ArtifactLease) => {
        const captured = d.artifacts.publishText(
          digest({ scope: context.scopeId, session: context.sessionId, request: id, method }),
          body,
          lease,
        );
        return d.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(73101004)');
          if (!(await this.collector.validateSnapshot(client, context, snapshot, refs))) return { status: 'denied' };
          const prior = await this.operation(client, context, id, method, hash);
          if (prior.status !== 'ok' || prior.review_id) return prior;
          await this.registerArtifact(client, context, captured, 'cos-strategy-snapshot/v1', snapshot);
          const retained: KnowledgeContext = {
            scopeId: context.scopeId,
            ownerId: context.ownerId,
            sessionId: context.sessionId,
            agentGroupId: context.agentGroupId,
            ingressId: context.ingressId,
            provider: context.provider,
            generation: context.generation,
          };
          await client.query(
            `INSERT INTO cos.strategy_review_snapshots(scope_id,id,revision,previous_revision,charter_version,owner_id,session_id,processing_provider,
             artifact_id,snapshot_digest,context,version_refs,as_of,expires_at) VALUES($1,$2,1,NULL,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
            [
              context.scopeId,
              review,
              snapshot.charter.version,
              context.ownerId,
              context.sessionId,
              context.provider,
              captured.id,
              digest(snapshot),
              JSON.stringify(retained),
              JSON.stringify(refs),
              snapshot.as_of,
              new Date(
                Math.min(Date.parse(snapshot.as_of) + 15 * 60000, Date.parse(snapshot.charter.definition.ends_at)),
              ).toISOString(),
            ],
          );
          const receipt: Result = { status: 'ok', review_id: review, revision: 1 };
          await this.saveOperation(client, context, id, method, hash, receipt);
          return receipt;
        }, true);
      });
    } catch (error) {
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
    if (result.status !== 'ok') return result;
    const read = await this.readSnapshot(context, String(result.review_id), Number(result.revision));
    return read.status === 'ok'
      ? { status: 'ok', review_id: read.review_id, revision: read.revision, snapshot: read.snapshot }
      : read;
  }
  async submit(
    context: KnowledgeContext,
    id: string,
    review: string,
    revision: number,
    draft: ReviewDraft,
  ): Promise<Result> {
    if (!reviewUuid(id) || context.origin) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies,
      read = await this.readSnapshot(context, review, revision);
    if (read.status !== 'ok') return read;
    const snapshot = read.snapshot as ReviewSnapshot,
      metadata = read.metadata as SnapshotMetadata;
    let artifact: ReviewArtifact, text: string;
    try {
      artifact = assembleReview(snapshot, draft);
      text = renderReview(artifact);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('review_')) return { status: 'denied' };
      throw error;
    }
    const method = 'cos_review_submit',
      hash = digest({ method, review, revision, draft, provider: context.provider, generation: context.generation });
    const old = await d.transaction((client) => this.operation(client, context, id, method, hash));
    if (old.status !== 'ok') return old;
    if (old.review_id) return this.get(context, review, revision);
    const body = JSON.stringify({ format: 'cos-strategy-review/v1', review: artifact, text });
    if (Buffer.byteLength(body) > 65536) return { status: 'unavailable' };
    let result: Result;
    try {
      result = await d.artifacts.exclusive(async (lease) => {
        const captured = d.artifacts.publishText(
          digest({ scope: context.scopeId, review, revision, method }),
          body,
          lease,
        );
        return d.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(73101004)');
          if (!(await this.fence(client, context, metadata, snapshot))) return { status: 'denied' };
          const prior = await this.operation(client, context, id, method, hash);
          if (prior.status !== 'ok' || prior.review_id) return prior;
          if (
            (
              await client.query(
                'SELECT 1 FROM cos.strategy_review_results WHERE scope_id=$1 AND review_id=$2 AND revision=$3',
                [context.scopeId, review, revision],
              )
            ).rowCount
          )
            return { status: 'conflict' };
          if (
            !(await client.query('SELECT clock_timestamp()<$1::timestamptz AS live', [metadata.expires_at])).rows[0]
              .live
          )
            return { status: 'denied' };
          await this.registerArtifact(client, context, captured, 'cos-strategy-review/v1', snapshot);
          await client.query(
            'INSERT INTO cos.strategy_review_results(scope_id,review_id,revision,artifact_id,draft_digest,output_digest) VALUES($1,$2,$3,$4,$5,$6)',
            [context.scopeId, review, revision, captured.id, digest(draft), digest(text)],
          );
          const receipt: Result = { status: 'ok', review_id: review, revision };
          await this.saveOperation(client, context, id, method, hash, receipt);
          return receipt;
        }, true);
      });
    } catch (error) {
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
    return result.status === 'ok' ? this.get(context, review, revision) : result;
  }
  async get(context: KnowledgeContext, review: string, revision: number): Promise<Result> {
    const d = this.knowledge.answers.dependencies,
      read = await this.readSnapshot(context, review, revision);
    if (read.status !== 'ok') return read;
    const snapshot = read.snapshot as ReviewSnapshot,
      snapshotMetadata = read.metadata as SnapshotMetadata;
    const before = await d.transaction(async (client) => {
      if (!(await this.fence(client, context, snapshotMetadata, snapshot))) return { status: 'denied' };
      const metadata = await this.resultMetadata(client, context, review, revision);
      return metadata ? { status: 'ok', metadata } : { status: 'denied' };
    }, true);
    if (before.status !== 'ok') return before;
    const metadata = before.metadata as ResultMetadata;
    let artifact: ReviewArtifact, text: string;
    try {
      const body = JSON.parse(d.artifacts.read(metadata.artifact_id, metadata.artifact_digest));
      if (
        body.format !== 'cos-strategy-review/v1' ||
        body.review.format !== body.format ||
        body.review.owner_disposition !== 'awaiting_decision' ||
        digest(body.review.snapshot) !== digest(snapshot) ||
        digest(body.review.draft) !== metadata.draft_digest ||
        digest(body.text) !== metadata.output_digest
      )
        return { status: 'denied' };
      artifact = assembleReview(snapshot, body.review.draft);
      text = renderReview(artifact);
      if (text !== body.text) return { status: 'denied' };
    } catch {
      return { status: 'unavailable' };
    }
    return d.transaction(async (client) => {
      const current = await this.resultMetadata(client, context, review, revision);
      if (
        !current ||
        digest(current) !== digest(metadata) ||
        !(await this.fence(client, context, snapshotMetadata, snapshot)) ||
        !(await this.dependencies(client, context, metadata.artifact_id))
      )
        return { status: 'denied' };
      const receipt = {
        status: 'ok',
        review_id: review,
        revision,
        generation: context.generation,
        ingress_id: context.ingressId,
        output_digest: digest(text),
      };
      await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,'cos_review_read',$4,$5)
         ON CONFLICT(session_id,request_id) DO UPDATE SET payload_hash=excluded.payload_hash,result=excluded.result
         WHERE cos.operations.scope_id=excluded.scope_id AND cos.operations.method='cos_review_read'`,
        [context.sessionId, ticket(context, text), context.scopeId, digest(receipt), JSON.stringify(receipt)],
      );
      return { status: 'ok', review_id: review, revision, review: artifact, text };
    }, true);
  }
  async authorizePublication(context: KnowledgeContext, text: string): Promise<Result> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 32768 || context.origin) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies;
    const checked = await d.transaction(async (client) => {
      if (!(await d.current(client, context))) return { status: 'denied' };
      const row = (
          await client.query(
            "SELECT result,payload_hash FROM cos.operations WHERE scope_id=$1 AND session_id=$2 AND request_id=$3 AND method='cos_review_read'",
            [context.scopeId, context.sessionId, ticket(context, text)],
          )
        ).rows[0],
        receipt = row?.result;
      return receipt &&
        digest(receipt) === row.payload_hash &&
        receipt.generation === context.generation &&
        receipt.ingress_id === context.ingressId &&
        receipt.output_digest === digest(text)
        ? (receipt as Result)
        : { status: 'denied' };
    });
    if (checked.status !== 'ok') return checked;
    const current = await this.get(context, String(checked.review_id), Number(checked.revision));
    return current.status !== 'ok' ? current : current.text === text ? { status: 'ok' } : { status: 'denied' };
  }
}
