import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext } from './store.js';
import { isArtifactIdentity, type ArtifactLease, type KnowledgeArtifacts } from './artifacts.js';
import type { CalendarAnswerNotice, CalendarContextCheck } from '../calendar/answer-notice.js';
import {
  citationKey,
  renderAnswer,
  validAnswerCitation,
  validAnswerDraft,
  type AnswerCitation,
  type AnswerDraft,
  type ResolvedCitation,
} from './answers.js';

export type AnswerHooks = { afterAnswerPublication?(): Promise<void>; beforeAnswerDisclosure?(): Promise<void> };
type Transaction = (operation: (client: PoolClient) => Promise<Result>, mutation?: boolean) => Promise<Result>;
type Metadata = {
  id: string;
  digest: string;
  kind: 'answer' | 'summary';
  version: number;
  provenance: {
    session_id: string;
    processing_provider: string;
    context_generation: string;
    ingress_id: string;
    draft_hash: string;
    citations: AnswerCitation[];
    calendar_notice_digest?: string;
  };
};
const references = (draft: AnswerDraft) => [
  ...new Map(draft.claims.flatMap((claim) => claim.citations).map((ref) => [citationKey(ref), ref])).values(),
];
const safeCitation = (value: ResolvedCitation) => {
  if (value.kind === 'source') {
    const { artifact_id: _artifact, text: _text, ...safe } = value;
    return safe;
  }
  const { description: _description, ...safe } = value;
  return safe;
};
const readTicket = (context: KnowledgeContext, text: string) =>
  'answer-read-' +
  digest({
    scope: context.scopeId,
    session: context.sessionId,
    generation: context.generation,
    ingress: context.ingressId,
    output: digest(text),
  });

/** Candidate answers are local artifacts with checked references, never approved strategic records. */
export class KnowledgeAnswers {
  constructor(
    readonly dependencies: {
      artifacts: KnowledgeArtifacts;
      transaction: Transaction;
      exclusive(operation: (lease: ArtifactLease) => Promise<Result>): Promise<Result>;
      current(client: PoolClient, context: KnowledgeContext): Promise<boolean>;
      sourcesReadable(client: PoolClient, context: KnowledgeContext, ids: string[]): Promise<boolean>;
      retrievalEnabled(): boolean;
      calendarNotice(client: PoolClient, context: KnowledgeContext): Promise<CalendarAnswerNotice>;
      calendarContext(client: PoolClient, context: KnowledgeContext, register?: boolean): Promise<CalendarContextCheck>;
      hooks: AnswerHooks;
    },
  ) {}
  private async resolve(
    client: PoolClient,
    context: KnowledgeContext,
    refs: AnswerCitation[],
    historical = false,
  ): Promise<ResolvedCitation[] | null> {
    if (!Array.isArray(refs) || refs.length > 10 || !refs.every(validAnswerCitation)) return null;
    if (!this.dependencies.retrievalEnabled() && refs.some((ref) => ref.kind === 'source')) return null;
    const rows: ResolvedCitation[] = [];
    for (const ref of refs) {
      const row =
        ref.kind === 'source'
          ? (
              await client.query(
                `SELECT 'source' AS kind,e.id AS evidence_id,e.source_id,e.revision_id,e.revision_digest,e.source_version,
        e.start_line,e.end_line,s.title,s.status,c.text,c.ordinal,r.artifact_id FROM cos.evidence_refs e
        JOIN cos.sources s ON s.scope_id=e.scope_id AND s.id=e.source_id
        JOIN cos.source_revisions r ON r.scope_id=e.scope_id AND r.id=e.revision_id AND r.source_id=e.source_id
        JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
        JOIN cos.chunks c ON c.scope_id=e.scope_id AND c.revision_id=e.revision_id AND c.start_line=e.start_line AND c.end_line=e.end_line
        WHERE e.id=$1 AND e.scope_id=$2 AND e.session_id=$3 AND e.processing_provider=$4
          AND ($5::boolean OR e.context_generation=$6) AND s.version=e.source_version AND s.current_revision_id=e.revision_id
          AND r.digest=e.revision_digest AND s.status IN ('current','stale') AND a.lifecycle='published' AND $4=ANY(s.processing_providers)
          AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)`,
                [ref.evidence_id, context.scopeId, context.sessionId, context.provider, historical, context.generation],
              )
            ).rows[0]
          : (
              await client.query(
                `SELECT 'record' AS kind,id AS record_id,version,title,kind AS record_kind,description FROM cos.records
          WHERE scope_id=$1 AND id=$2 AND version=$3 AND lifecycle='active'`,
                [context.scopeId, ref.record_id, ref.version],
              )
            ).rows[0];
      if (!row) return null;
      rows.push(row as ResolvedCitation);
    }
    return (await this.dependencies.sourcesReadable(
      client,
      context,
      rows.flatMap((row) => (row.kind === 'source' ? [row.source_id] : [])),
    ))
      ? rows
      : null;
  }
  private verifyBytes(rows: ResolvedCitation[]): void {
    for (const row of rows)
      if (row.kind === 'source') {
        const text = this.dependencies.artifacts.read(row.artifact_id, row.revision_digest);
        if (
          text
            .split('\n')
            .slice(row.start_line - 1, row.end_line)
            .join('\n') !== row.text
        )
          throw new Error('invalid_answer_evidence');
      }
  }
  async prepare(context: KnowledgeContext, requestId: string, draft: unknown): Promise<Result> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId) ||
      !validAnswerDraft(draft)
    )
      return { status: 'denied' };
    const d = this.dependencies,
      refs = references(draft),
      hash = digest({ method: 'cos_answer_prepare', generation: context.generation, draft });
    const result = await d.exclusive(async (lease) => {
      const before = await d.transaction(async (client) => {
        if (!(await d.current(client, context))) return { status: 'denied' };
        const old = (
          await client.query(
            'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
            [context.sessionId, requestId],
          )
        ).rows[0];
        if (old)
          return old.scope_id === context.scopeId && old.payload_hash === hash
            ? (old.result ?? { status: 'pending', request_id: requestId })
            : { status: 'conflict' };
        const resolved = await this.resolve(client, context, refs);
        if (!resolved) return { status: 'denied' };
        const dependency = await d.calendarContext(client, context, Boolean(draft.calendar));
        return dependency.status === 'ok'
          ? { status: 'ok', resolved, calendar: dependency.notice }
          : { status: 'denied' };
      }, Boolean(draft.calendar));
      if (before.status !== 'ok' || before.artifact_id) return before;
      const resolved = before.resolved as ResolvedCitation[],
        calendar = before.calendar as CalendarAnswerNotice | null;
      let text: string;
      try {
        this.verifyBytes(resolved);
        text = renderAnswer(draft, resolved) + (calendar ? '\n\n' + calendar.text : '');
        // eslint-disable-next-line no-catch-all/no-catch-all -- Invalid citations or inaccessible private files deny preparation without disclosing paths or bytes.
      } catch {
        return { status: 'denied' };
      }
      const body = JSON.stringify({ format: 'cos-answer/v1', draft, text, ...(calendar ? { calendar } : {}) });
      const namespace = digest({
        scope: context.scopeId,
        session: context.sessionId,
        generation: context.generation,
        request: requestId,
        kind: draft.kind,
      });
      const captured = d.artifacts.publishText(namespace, body, lease);
      await d.hooks.afterAnswerPublication?.();
      return d.transaction(async (client) => {
        await client.query('SELECT pg_advisory_xact_lock(73101004)');
        if (!(await d.current(client, context))) return { status: 'denied' };
        const current = await this.resolve(client, context, refs);
        if (!current || digest(current) !== digest(resolved)) return { status: 'denied' };
        if (calendar && digest(await d.calendarNotice(client, context)) !== digest(calendar))
          return { status: 'denied' };
        const inserted = await client.query(
          `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
          VALUES($1,$2,$3,'cos_answer_prepare',$4) ON CONFLICT DO NOTHING RETURNING request_id`,
          [context.sessionId, requestId, context.scopeId, hash],
        );
        if (!inserted.rowCount) {
          const old = (
            await client.query(
              'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
              [context.sessionId, requestId],
            )
          ).rows[0];
          return old?.scope_id === context.scopeId && old.payload_hash === hash
            ? (old.result ?? { status: 'pending', request_id: requestId })
            : { status: 'conflict' };
        }
        const provenance = {
          session_id: context.sessionId,
          context_generation: context.generation,
          processing_provider: context.provider,
          ingress_id: context.ingressId,
          owner_id: context.ownerId,
          draft_hash: digest(draft),
          citations: refs,
          output_digest: digest(text),
          ...(calendar ? { calendar_notice_digest: digest(calendar) } : {}),
        };
        await client.query(
          `INSERT INTO cos.artifacts(id,scope_id,kind,digest,byte_length,lifecycle,provenance) VALUES($1,$2,$3,$4,$5,'published',$6)`,
          [captured.id, context.scopeId, draft.kind, captured.digest, captured.byteLength, JSON.stringify(provenance)],
        );
        for (const ref of refs)
          if (ref.kind === 'source')
            await client.query('INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id) VALUES($1,$2,$3)', [
              context.scopeId,
              captured.id,
              ref.evidence_id,
            ]);
        // Any part of a reply can be influenced by previously seen evidence, including a question.
        // Keep those dependencies even when they are not displayed as explicit claim citations.
        await client.query(
          `INSERT INTO cos.derivation_links(scope_id,artifact_id,evidence_id)
          SELECT scope_id,$1,id FROM cos.evidence_refs
          WHERE scope_id=$2 AND session_id=$3 AND context_generation=$4 AND processing_provider=$5
          ON CONFLICT DO NOTHING`,
          [captured.id, context.scopeId, context.sessionId, context.generation, context.provider],
        );
        const receipt = { status: 'ok', artifact_id: captured.id };
        await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
          context.sessionId,
          requestId,
          JSON.stringify(receipt),
        ]);
        return receipt;
      }, true);
    });
    if (result.status !== 'ok') return result.status === 'pending' ? { ...result, request_id: requestId } : result;
    return this.get(context, String(result.artifact_id));
  }
  private async snapshot(
    client: PoolClient,
    context: KnowledgeContext,
    id: string,
  ): Promise<{ metadata: Metadata; resolved: ResolvedCitation[]; calendar: CalendarAnswerNotice | null } | null> {
    if (!(await this.dependencies.current(client, context))) return null;
    const metadata = (
      await client.query(
        `SELECT id,digest,kind,version,provenance FROM cos.artifacts WHERE scope_id=$1 AND id=$2 AND kind IN ('answer','summary') AND lifecycle='published'`,
        [context.scopeId, id],
      )
    ).rows[0] as Metadata | undefined;
    if (
      !metadata ||
      metadata.provenance.session_id !== context.sessionId ||
      metadata.provenance.processing_provider !== context.provider
    )
      return null;
    const invalid = await client.query(
      `SELECT 1 FROM cos.derivation_links d
      JOIN cos.evidence_refs e ON e.scope_id=d.scope_id AND e.id=d.evidence_id
      JOIN cos.sources s ON s.scope_id=e.scope_id AND s.id=e.source_id
      JOIN cos.source_revisions r ON r.scope_id=e.scope_id AND r.id=e.revision_id AND r.source_id=e.source_id
      JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
      WHERE d.scope_id=$1 AND d.artifact_id=$2 AND (
        NOT $5::boolean OR e.session_id<>$3 OR e.processing_provider<>$4 OR NOT $4=ANY(s.processing_providers)
        OR s.version<>e.source_version OR s.current_revision_id IS DISTINCT FROM e.revision_id
        OR r.digest<>e.revision_digest OR s.status NOT IN ('current','stale') OR a.lifecycle<>'published'
        OR EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)) LIMIT 1`,
      [context.scopeId, id, context.sessionId, context.provider, this.dependencies.retrievalEnabled()],
    );
    if (invalid.rowCount) return null;
    // An answer also depends on previously exposed context that was not explicitly cited.
    const dependencies = (
      await client.query(
        `SELECT DISTINCT e.source_id FROM cos.derivation_links d JOIN cos.evidence_refs e ON e.scope_id=d.scope_id AND e.id=d.evidence_id
      WHERE d.scope_id=$1 AND d.artifact_id=$2`,
        [context.scopeId, id],
      )
    ).rows as Array<{ source_id: string }>;
    if (
      !(await this.dependencies.sourcesReadable(
        client,
        context,
        dependencies.map((row) => row.source_id),
      ))
    )
      return null;
    const resolved = await this.resolve(client, context, metadata.provenance.citations, true);
    if (!resolved) return null;
    const calendar = metadata.provenance.calendar_notice_digest
      ? await this.dependencies.calendarNotice(client, context)
      : null;
    if (calendar && digest(calendar) !== metadata.provenance.calendar_notice_digest) return null;
    return { metadata, resolved, calendar };
  }
  async get(context: KnowledgeContext, id: string): Promise<Result> {
    if (!isArtifactIdentity(id)) return { status: 'denied' };
    const d = this.dependencies;
    const before = await d.transaction(async (client) => {
      const snapshot = await this.snapshot(client, context, id);
      return snapshot ? { status: 'ok', ...snapshot } : { status: 'denied' };
    });
    if (before.status !== 'ok') return before;
    const metadata = before.metadata as Metadata,
      resolved = before.resolved as ResolvedCitation[],
      calendar = before.calendar as CalendarAnswerNotice | null;
    let text: string;
    try {
      this.verifyBytes(resolved);
      const body = JSON.parse(d.artifacts.read(id, metadata.digest));
      if (
        !body ||
        Object.keys(body).some((key) => !['format', 'draft', 'text', 'calendar'].includes(key)) ||
        body.format !== 'cos-answer/v1' ||
        !validAnswerDraft(body.draft) ||
        digest(body.draft) !== metadata.provenance.draft_hash ||
        digest(references(body.draft)) !== digest(metadata.provenance.citations) ||
        (Boolean(body.draft.calendar) && !calendar) ||
        digest(body.calendar ?? null) !== digest(calendar)
      )
        return { status: 'denied' };
      text = renderAnswer(body.draft, resolved) + (calendar ? '\n\n' + calendar.text : '');
      if (text !== body.text) return { status: 'denied' };
      await d.hooks.beforeAnswerDisclosure?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- Unreadable or corrupt private artifacts cannot be redisplayed or leak diagnostic paths.
    } catch {
      return { status: 'unavailable' };
    }
    const final = await d.transaction(async (client) => {
      const fresh = await this.snapshot(client, context, id);
      if (!fresh || digest(fresh) !== digest({ metadata, resolved, calendar })) return { status: 'denied' };
      if (calendar) {
        const dependency = await d.calendarContext(client, context, true);
        if (dependency.status !== 'ok' || digest(dependency.notice) !== digest(calendar)) return { status: 'denied' };
      }
      // Historical redisplay is a new disclosure to this context, which must be fenced on later correction/revocation.
      for (const ref of resolved)
        if (ref.kind === 'source')
          await client.query(
            `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,start_line,end_line,session_id,context_generation,processing_provider)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version) DO NOTHING`,
            [
              randomUUID(),
              context.scopeId,
              ref.source_id,
              ref.revision_id,
              ref.revision_digest,
              ref.source_version,
              ref.start_line,
              ref.end_line,
              context.sessionId,
              context.generation,
              context.provider,
            ],
          );
      // Re-exposure includes implicit context dependencies, not only rendered footnotes.
      await client.query(
        `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,start_line,end_line,session_id,context_generation,processing_provider)
        SELECT gen_random_uuid()::text,e.scope_id,e.source_id,e.revision_id,e.revision_digest,e.source_version,e.start_line,e.end_line,$3,$4,$5
        FROM cos.derivation_links d JOIN cos.evidence_refs e ON e.scope_id=d.scope_id AND e.id=d.evidence_id
        WHERE d.scope_id=$1 AND d.artifact_id=$2
        ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version) DO NOTHING`,
        [context.scopeId, id, context.sessionId, context.generation, context.provider],
      );
      const receipt = {
        status: 'ok',
        artifact_id: id,
        generation: context.generation,
        ingress_id: context.ingressId,
        output_digest: digest(text),
      };
      await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result)
        VALUES($1,$2,$3,'cos_answer_read',$4,$5) ON CONFLICT(session_id,request_id)
        DO UPDATE SET payload_hash=excluded.payload_hash,result=excluded.result WHERE cos.operations.scope_id=excluded.scope_id AND cos.operations.method='cos_answer_read'`,
        [context.sessionId, readTicket(context, text), context.scopeId, digest(receipt), JSON.stringify(receipt)],
      );
      return { status: 'ok', artifact_id: id, kind: metadata.kind, text, citations: resolved.map(safeCitation) };
    }, true);
    return final.status === 'pending' ? { status: 'unavailable' } : final;
  }
  /** Final host publication gate. The model supplies text, never a permission token or destination. */
  async authorizePublication(context: KnowledgeContext, text: string): Promise<Result> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536) return { status: 'denied' };
    const ticket = await this.dependencies.transaction(async (client) => {
      if (!(await this.dependencies.current(client, context))) return { status: 'denied' };
      const row = (
        await client.query(
          "SELECT payload_hash,result FROM cos.operations WHERE scope_id=$1 AND session_id=$2 AND request_id=$3 AND method='cos_answer_read'",
          [context.scopeId, context.sessionId, readTicket(context, text)],
        )
      ).rows[0];
      const receipt = row?.result;
      if (
        !receipt ||
        digest(receipt) !== row.payload_hash ||
        receipt.generation !== context.generation ||
        receipt.ingress_id !== context.ingressId ||
        receipt.output_digest !== digest(text)
      )
        return { status: 'denied' };
      return { status: 'ok', artifact_id: receipt.artifact_id };
    });
    if (ticket.status !== 'ok') return ticket;
    const checked = await this.get(context, String(ticket.artifact_id));
    return checked.status === 'ok' && checked.text === text
      ? { status: 'ok', artifact_id: ticket.artifact_id }
      : { status: checked.status === 'ok' ? 'denied' : checked.status };
  }
}
