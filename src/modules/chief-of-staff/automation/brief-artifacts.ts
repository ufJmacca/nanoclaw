import { briefRefreshCoverage } from './brief-refresh-coverage.js';
import type { PoolClient } from 'pg';
import type { KnowledgeContext } from '../knowledge/store.js';
import { digest, type Result } from '../domain/contracts.js';
import { isArtifactIdentity, KnowledgeArtifactsBusy } from '../knowledge/artifacts.js';
import type { BriefCollector } from './brief-collector.js';
import { renderBrief, type BriefSnapshot } from './brief-snapshot.js';
const ticket = (context: KnowledgeContext, text: string) =>
  'brief-read-' +
  digest({
    scope: context.scopeId,
    session: context.sessionId,
    generation: context.generation,
    ingress: context.ingressId,
    output: digest(text),
  });
type Metadata = {
  id: string;
  digest: string;
  provenance: {
    format: string;
    session_id: string;
    processing_provider: string;
    owner_id: string;
    snapshot_digest: string;
    output_digest: string;
    calendar_digest: string;
  };
};
/** Briefs use the existing private artifact, derivation, revocation and purge lifecycle. */
export class BriefArtifacts {
  constructor(readonly collector: BriefCollector) {}
  private get knowledge() {
    return this.collector.options.knowledge;
  }
  private async originAllowed(client: PoolClient, context: KnowledgeContext, timeZone: string): Promise<boolean> {
    return (await briefRefreshCoverage(client, context, timeZone)) !== null;
  }

  private async receipt(context: KnowledgeContext, request: string, hash: string, timeZone: string): Promise<Result> {
    const d = this.knowledge.answers.dependencies;
    return d.transaction(async (client) => {
      if (!(await d.current(client, context)) || !(await this.originAllowed(client, context, timeZone)))
        return { status: 'denied' };
      const old = (
        await client.query(
          'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
          [context.sessionId, request],
        )
      ).rows[0];
      return !old
        ? { status: 'ok' }
        : old.scope_id === context.scopeId && old.method === 'cos_brief_request' && old.payload_hash === hash
          ? (old.result ?? { status: 'pending' })
          : { status: 'conflict' };
    });
  }
  async prepare(context: KnowledgeContext, request: string, timeZone: string): Promise<Result> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(request))
      return { status: 'denied' };
    const d = this.knowledge.answers.dependencies,
      hash = digest({
        method: 'cos_brief_request',
        time_zone: timeZone,
        provider: context.provider,
        origin: context.origin ?? null,
      });
    const old = await this.receipt(context, request, hash, timeZone);
    if (old.status !== 'ok') return old;
    if (old.artifact_id) return this.get(context, String(old.artifact_id));
    const collected = await this.collector.collect(context, timeZone);
    if (collected.status !== 'ok') return collected;
    const snapshot = collected.snapshot as BriefSnapshot,
      text = String(collected.text),
      calendarDigest = String(collected.calendar_digest);
    const body = JSON.stringify({ format: 'cos-brief/v1', snapshot, text });
    if (Buffer.byteLength(body) > 65536) return { status: 'unavailable' };
    let result: Result;
    try {
      result = await d.artifacts.exclusive(async (lease) => {
        const captured = d.artifacts.publishText(
          digest({ scope: context.scopeId, session: context.sessionId, request, format: 'cos-brief/v1' }),
          body,
          lease,
        );
        return d.transaction(async (client) => {
          await client.query('SELECT pg_advisory_xact_lock(73101004)');
          if (
            !(await this.originAllowed(client, context, timeZone)) ||
            !(await this.collector.validateSnapshot(client, context, snapshot, calendarDigest))
          )
            return { status: 'denied' };
          const inserted = await client.query(
            "INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash) VALUES($1,$2,$3,'cos_brief_request',$4) ON CONFLICT DO NOTHING RETURNING request_id",
            [context.sessionId, request, context.scopeId, hash],
          );
          if (!inserted.rowCount) {
            const prior = (
              await client.query(
                'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
                [context.sessionId, request],
              )
            ).rows[0];
            return prior?.scope_id === context.scopeId &&
              prior.method === 'cos_brief_request' &&
              prior.payload_hash === hash
              ? (prior.result ?? { status: 'pending' })
              : { status: 'conflict' };
          }
          const provenance = {
            format: 'cos-brief/v1',
            origin_run: context.origin ? { id: context.origin.runId, generation: context.origin.generation } : null,
            owner_id: context.ownerId,
            session_id: context.sessionId,
            processing_provider: context.provider,
            context_generation: context.generation,
            ingress_id: context.ingressId,
            snapshot_digest: digest(snapshot),
            output_digest: digest(text),
            calendar_digest: calendarDigest,
          };
          await client.query(
            "INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,'summary',$3,$4,'published',$5)",
            [captured.id, context.scopeId, captured.digest, captured.byteLength, JSON.stringify(provenance)],
          );
          // Keep implicit context dependencies as well as the evidence shown in the brief.
          await client.query(
            `INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id) SELECT scope_id,$1,id FROM cos.evidence_refs WHERE scope_id=$2 AND session_id=$3 AND context_generation=$4 AND processing_provider=$5 ON CONFLICT DO NOTHING`,
            [captured.id, context.scopeId, context.sessionId, context.generation, context.provider],
          );
          const receipt = { status: 'ok', artifact_id: captured.id };
          await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
            context.sessionId,
            request,
            JSON.stringify(receipt),
          ]);
          return receipt;
        }, true);
      });
    } catch (error) {
      if (error instanceof KnowledgeArtifactsBusy) return { status: 'unavailable' };
      throw error;
    }
    return result.status === 'ok' ? this.get(context, String(result.artifact_id)) : result;
  }
  private async metadata(client: PoolClient, context: KnowledgeContext, id: string): Promise<Metadata | null> {
    const d = this.knowledge.answers.dependencies;
    if (!(await d.current(client, context))) return null;
    const row = (
      await client.query(
        "SELECT id,digest,provenance FROM cos.artifacts WHERE scope_id=$1 AND id=$2 AND kind='summary' AND lifecycle='published'",
        [context.scopeId, id],
      )
    ).rows[0] as Metadata | undefined;
    return row &&
      row.provenance.format === 'cos-brief/v1' &&
      row.provenance.owner_id === context.ownerId &&
      row.provenance.session_id === context.sessionId &&
      row.provenance.processing_provider === context.provider
      ? row
      : null;
  }
  private async dependencies(client: PoolClient, context: KnowledgeContext, id: string): Promise<boolean> {
    const refs = (
      await client.query(
        'SELECT evidence_id FROM cos.derivation_links WHERE scope_id=$1 AND artifact_id=$2 ORDER BY evidence_id LIMIT 1001',
        [context.scopeId, id],
      )
    ).rows;
    if (refs.length > 1000) return false;
    for (let offset = 0; offset < refs.length; offset += 10) {
      if (
        !(await this.knowledge.answers.validateWorkEvidence(
          client,
          context,
          refs.slice(offset, offset + 10).map((r) => ({ kind: 'source' as const, evidence_id: r.evidence_id })),
          true,
        ))
      )
        return false;
    }
    return true;
  }
  async readHistory(context: KnowledgeContext, id: string): Promise<Result> {
    return this.get(context, id, false, true);
  }
  async get(context: KnowledgeContext, id: string, publication = false, historicalLabel = false): Promise<Result> {
    if (!isArtifactIdentity(id)) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies;
    const before = await d.transaction(async (client) => {
      const metadata = await this.metadata(client, context, id);
      return metadata ? { status: 'ok', metadata } : { status: 'denied' };
    });
    if (before.status !== 'ok') return before;
    const metadata = before.metadata as Metadata;
    let snapshot: BriefSnapshot, text: string;
    try {
      const body = JSON.parse(d.artifacts.read(id, metadata.digest));
      if (
        body.format !== 'cos-brief/v1' ||
        body.snapshot?.format !== 'cos-brief/v1' ||
        digest(body.snapshot) !== metadata.provenance.snapshot_digest ||
        digest(body.text) !== metadata.provenance.output_digest ||
        renderBrief(body.snapshot) !== body.text
      )
        return { status: 'denied' };
      snapshot = body.snapshot;
      text = historicalLabel
        ? 'Historical brief — records may have changed since this was generated.\n\n' + body.text
        : body.text;
    } catch {
      return { status: 'unavailable' };
    }
    const final = await d.transaction(async (client) => {
      const current = await this.metadata(client, context, id);
      if (
        !current ||
        digest(current) !== digest(metadata) ||
        !(await this.collector.validateSnapshot(
          client,
          context,
          snapshot,
          metadata.provenance.calendar_digest,
          !publication,
        )) ||
        !(await this.dependencies(client, context, id))
      )
        return { status: 'denied' };
      const receipt = {
        status: 'ok',
        artifact_id: id,
        generation: context.generation,
        ingress_id: context.ingressId,
        output_digest: digest(text),
        historical: historicalLabel,
      };
      await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,'cos_brief_read',$4,$5) ON CONFLICT(session_id,request_id) DO UPDATE SET payload_hash=excluded.payload_hash,result=excluded.result WHERE cos.operations.scope_id=excluded.scope_id AND cos.operations.method='cos_brief_read'`,
        [context.sessionId, ticket(context, text), context.scopeId, digest(receipt), JSON.stringify(receipt)],
      );
      return { status: 'ok', artifact_id: id, snapshot, text };
    }, true);
    return final.status === 'pending' ? { status: 'unavailable' } : final;
  }
  async authorizePublication(context: KnowledgeContext, text: string): Promise<Result> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) return { status: 'denied' };
    const d = this.knowledge.answers.dependencies;
    const checked = await d.transaction(async (client) => {
      if (!(await d.current(client, context))) return { status: 'denied' };
      const row = (
          await client.query(
            "SELECT payload_hash,result FROM cos.operations WHERE scope_id=$1 AND session_id=$2 AND request_id=$3 AND method='cos_brief_read'",
            [context.scopeId, context.sessionId, ticket(context, text)],
          )
        ).rows[0],
        receipt = row?.result;
      if (
        !receipt ||
        digest(receipt) !== row.payload_hash ||
        receipt.generation !== context.generation ||
        receipt.ingress_id !== context.ingressId ||
        receipt.output_digest !== digest(text)
      )
        return { status: 'denied' };
      return { status: 'ok', artifact_id: receipt.artifact_id, historical: receipt.historical === true };
    });
    if (checked.status !== 'ok') return checked;
    const current = await this.get(
      context,
      String(checked.artifact_id),
      !checked.historical,
      checked.historical === true,
    );
    return current.status === 'ok' && current.text === text
      ? { status: 'ok', artifact_id: checked.artifact_id }
      : { status: current.status === 'ok' ? 'denied' : current.status };
  }
}
