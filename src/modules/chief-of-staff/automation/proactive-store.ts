import type { PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { digest, type Context, type Result } from '../domain/contracts.js';
import {
  validProactiveDraft,
  validProactiveDisposition,
  type ProactivePolicyChange,
  type ProactiveDraft,
  type ProactiveDispositionRequest,
} from '../contracts/proactive-protocol.js';
import { validProactivePolicy, type ProactivePolicy } from '../contracts/proactive-policy.js';
import type { ProactiveDispositionChange } from '../contracts/protocol.js';
import type { KnowledgeStore, KnowledgeContext } from '../knowledge/store.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { BriefCollector } from './brief-collector.js';
import type { BriefRecord, BriefSnapshot } from './brief-snapshot.js';
import {
  selectProactiveCandidates,
  semanticProposalKey,
  type ProactiveCandidate,
  type ProactiveObservation,
} from './proactive-policy.js';
import type { MissionProposalStore } from '../missions/proposal-store.js';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const iso = (date: Date | string) => (date instanceof Date ? date.toISOString() : date);
type BatchBody = {
  snapshot: BriefSnapshot;
  records: BriefRecord[];
  observations: ProactiveObservation[];
  candidates: ProactiveCandidate[];
  calendar_digest: string;
  max_proposals: number;
};
type RevisionBody = {
  candidate: ProactiveCandidate;
  draft: ProactiveDraft;
  goal_version: number;
  policy_version: number;
};
/** Used within the host approval transaction; models cannot approve configuration or dispositions. */
export class ProactiveStore {
  constructor(
    readonly options?: {
      database: BoundedDatabase;
      knowledge: KnowledgeStore;
      collector: BriefCollector;
      missions: MissionProposalStore;
    },
  ) {}
  private async transaction(context: Context, operation: (client: PoolClient) => Promise<Result>): Promise<Result> {
    if (!this.options) return { status: 'unavailable' };
    try {
      return await this.options.database.run(async (client) => {
        await client.query('BEGIN');
        const scope = await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR UPDATE",
          [context.scopeId, context.ownerId, context.agentGroupId],
        );
        const result = scope.rowCount ? await operation(client) : { status: 'denied' as const };
        await client.query('COMMIT');
        return result;
      }, true);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async policy(client: PoolClient, context: Context) {
    const row = (
      await client.query(
        "SELECT version,policy FROM cos.proactive_policies WHERE scope_id=$1 AND owner_id=$2 AND state='active'",
        [context.scopeId, context.ownerId],
      )
    ).rows[0];
    return row && validProactivePolicy(row.policy) ? (row as { version: number; policy: ProactivePolicy }) : null;
  }
  private async operation(
    client: PoolClient,
    context: KnowledgeContext,
    requestId: string,
    method: string,
    payload: unknown,
    run: () => Promise<Result>,
  ): Promise<Result> {
    const hash = digest({ method, payload, context });
    const inserted = await client.query(
      'INSERT INTO cos.operations(scope_id,session_id,request_id,method,payload_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING request_id',
      [context.scopeId, context.sessionId, requestId, method, hash],
    );
    if (!inserted.rowCount) {
      const old = (
        await client.query(
          'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
          [context.sessionId, requestId],
        )
      ).rows[0];
      return old?.scope_id === context.scopeId && old.method === method && old.payload_hash === hash
        ? (old.result ?? { status: 'pending', request_id: requestId })
        : { status: 'conflict' };
    }
    const result = await run();
    await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
      context.sessionId,
      requestId,
      JSON.stringify(result),
    ]);
    return result;
  }
  private async recordsCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    records: BriefRecord[],
  ): Promise<boolean> {
    for (const record of records)
      if (
        !(
          await client.query(
            "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND version=$3 AND lifecycle='active'",
            [context.scopeId, record.id, record.version],
          )
        ).rowCount
      )
        return false;
    return true;
  }
  /** Only trusted host collection normalises observations; there is deliberately no observation-write RPC. */
  private async observations(
    client: PoolClient,
    context: KnowledgeContext,
    snapshot: BriefSnapshot,
  ): Promise<ProactiveObservation[]> {
    const rows: ProactiveObservation[] = [];
    for (const work of [...snapshot.commitments, ...snapshot.decisions]) {
      const current = (
        await client.query(
          'SELECT updated_at,provenance FROM cos.work_items WHERE scope_id=$1 AND id=$2 AND version=$3',
          [context.scopeId, work.id, work.version],
        )
      ).rows[0];
      if (!current) continue;
      rows.push({
        event_id: 'work-' + work.id + '-' + work.version,
        kind: 'commitment_transition',
        resource_id: work.id,
        resource_version: work.version,
        project_id: work.project_id,
        observed_at: iso(current.updated_at),
        material_digest: digest({
          kind: work.kind,
          state: work.state,
          project_id: work.project_id,
          due: work.due,
          evidence: work.evidence,
        }),
        provenance: { table: 'work_revisions', version: work.version, ...current.provenance },
      });
    }
    const sources = this.options!.knowledge.retrievalEnabled()
      ? (
          await client.query(
            `SELECT s.id,s.version,s.project_id,r.id AS revision_id,r.digest,r.captured_at FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.lifecycle='published' WHERE s.scope_id=$1 AND s.status='current' AND $2=ANY(s.processing_providers) AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id) ORDER BY s.id LIMIT 101 FOR SHARE OF s`,
            [context.scopeId, context.provider],
          )
        ).rows
      : [];
    if (sources.length > 100) snapshot.coverage.truncated = true;
    for (const source of sources.slice(0, 100)) {
      if (!(await this.options!.knowledge.answers.dependencies.sourcesReadable(client, context, [source.id]))) continue;
      // Disclosing a version/digest also exposes a source dependency in this native generation.
      const chunk = (
        await client.query(
          'SELECT start_line,end_line FROM cos.chunks WHERE scope_id=$1 AND revision_id=$2 ORDER BY ordinal LIMIT 1',
          [context.scopeId, source.revision_id],
        )
      ).rows[0];
      if (!chunk) continue;
      await client.query(
        `INSERT INTO cos.evidence_refs(id,scope_id,source_id,revision_id,revision_digest,source_version,start_line,end_line,session_id,context_generation,processing_provider) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT(scope_id,session_id,context_generation,revision_id,start_line,end_line,source_version) DO NOTHING`,
        [
          randomUUID(),
          context.scopeId,
          source.id,
          source.revision_id,
          source.digest,
          source.version,
          chunk.start_line,
          chunk.end_line,
          context.sessionId,
          context.generation,
          context.provider,
        ],
      );
      rows.push({
        event_id: 'source-' + source.id + '-' + source.version,
        kind: 'source_revision',
        resource_id: source.id,
        resource_version: source.version,
        project_id: source.project_id,
        observed_at: iso(source.captured_at),
        material_digest: source.digest,
        provenance: { table: 'source_revisions', revision_id: source.revision_id },
      });
    }
    for (const calendar of snapshot.calendar_coverage) {
      if (calendar.coverage !== 'complete' || !calendar.snapshot_id) continue;
      const capture = (
        await client.query(
          "SELECT content_digest,completed_at FROM cos.calendar_snapshots WHERE scope_id=$1 AND binding_id=$2 AND id=$3 AND status='complete'",
          [context.scopeId, calendar.binding_id, calendar.snapshot_id],
        )
      ).rows[0];
      if (!capture?.content_digest || !capture.completed_at) continue;
      const resource = digest({ binding: calendar.binding_id, calendar: calendar.calendar_id });
      const old = (
        await client.query(
          "SELECT resource_version,provenance FROM cos.proactive_observations WHERE scope_id=$1 AND kind='calendar_snapshot' AND resource_id=$2 ORDER BY resource_version DESC LIMIT 1",
          [context.scopeId, resource],
        )
      ).rows[0];
      const version =
        old?.provenance.snapshot_id === calendar.snapshot_id ? old.resource_version : (old?.resource_version ?? 0) + 1;
      rows.push({
        event_id: 'calendar-' + calendar.snapshot_id,
        kind: 'calendar_snapshot',
        resource_id: resource,
        resource_version: version,
        project_id: null,
        observed_at: iso(capture.completed_at),
        material_digest: capture.content_digest,
        provenance: {
          table: 'calendar_snapshots',
          binding_id: calendar.binding_id,
          calendar_id: calendar.calendar_id,
          snapshot_id: calendar.snapshot_id,
        },
      });
    }
    const missions = (
      await client.query(
        `SELECT m.mission_id,m.generation,m.digest,m.created_at,w.body->'request'->>'project_id' AS project_id FROM cos.mission_reviews v JOIN cos.mission_result_submissions m ON m.scope_id=v.scope_id AND m.id=v.result_id JOIN cos.mission_work_orders w ON w.scope_id=m.scope_id AND w.id=m.mission_id WHERE v.scope_id=$1 AND v.decision IN ('accept','partial') ORDER BY m.mission_id,m.generation LIMIT 101`,
        [context.scopeId],
      )
    ).rows;
    if (missions.length > 100) snapshot.coverage.truncated = true;
    for (const mission of missions.slice(0, 100))
      rows.push({
        event_id: 'mission-' + mission.mission_id + '-' + mission.generation,
        kind: 'mission_outcome',
        resource_id: mission.mission_id,
        resource_version: mission.generation,
        project_id: mission.project_id,
        observed_at: iso(mission.created_at),
        material_digest: mission.digest,
        provenance: { table: 'mission_result_submissions', reviewed: true },
      });
    for (const row of rows)
      await client.query(
        'INSERT INTO cos.proactive_observations(scope_id,event_id,kind,resource_id,resource_version,project_id,observed_at,material_digest,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING',
        [
          context.scopeId,
          row.event_id,
          row.kind,
          row.resource_id,
          row.resource_version,
          row.project_id,
          row.observed_at,
          row.material_digest,
          JSON.stringify(row.provenance),
        ],
      );
    return rows;
  }
  private async batchCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    row: { context: KnowledgeContext; body: BatchBody; digest: string; policy_version: number; expires_at: Date },
  ): Promise<boolean> {
    const p = await this.policy(client, context),
      body = row.body;
    return (
      !!p &&
      p.version === row.policy_version &&
      row.expires_at.getTime() > Date.now() &&
      digest(body) === row.digest &&
      digest(row.context) === digest(context) &&
      (await this.recordsCurrent(client, context, body.records)) &&
      (await this.options!.collector.validateSnapshot(client, context, body.snapshot, body.calendar_digest)) &&
      (await this.observationsCurrent(client, context, body.observations))
    );
  }
  private async observationsCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    observations: ProactiveObservation[],
  ): Promise<boolean> {
    for (const observation of observations) {
      if (observation.kind === 'source_revision') {
        const row = (
          await client.query(
            "SELECT current_revision_id,version FROM cos.sources WHERE scope_id=$1 AND id=$2 AND status='current'",
            [context.scopeId, observation.resource_id],
          )
        ).rows[0];
        if (
          !row ||
          row.version !== observation.resource_version ||
          row.current_revision_id !== observation.provenance.revision_id ||
          !(await this.options!.knowledge.answers.dependencies.sourcesReadable(client, context, [
            observation.resource_id,
          ]))
        )
          return false;
      } else if (observation.kind === 'calendar_snapshot') {
        if (
          !(
            await client.query(
              'SELECT 1 FROM cos.calendar_states WHERE scope_id=$1 AND binding_id=$2 AND calendar_id=$3 AND current_snapshot=$4',
              [
                context.scopeId,
                observation.provenance.binding_id,
                observation.provenance.calendar_id,
                observation.provenance.snapshot_id,
              ],
            )
          ).rowCount
        )
          return false;
      }
    }
    return true;
  }
  async batch(context: KnowledgeContext, requestId: string): Promise<Result> {
    if (!uuid.test(requestId) || !this.options || context.origin?.kind === 'mission_review')
      return { status: 'denied' };
    const id = 'batch-' + digest({ scope: context.scopeId, session: context.sessionId, request: requestId });
    const before = await this.transaction(context, async (client) => {
      if (!(await this.options!.knowledge.answers.dependencies.current(client, context))) return { status: 'denied' };
      const p = await this.policy(client, context);
      if (!p) return { status: 'denied' };
      const old = (
        await client.query('SELECT * FROM cos.proactive_batches WHERE scope_id=$1 AND id=$2', [context.scopeId, id])
      ).rows[0];
      if (old)
        return (await this.batchCurrent(client, context, old))
          ? {
              status: 'ok',
              batch_id: id,
              candidates: old.body.candidates,
              goals: old.body.records.filter((r: BriefRecord) => r.kind === 'goal'),
              max_proposals: old.body.max_proposals,
            }
          : { status: 'denied' };
      return { status: 'ok', policy: p };
    });
    if (before.status !== 'ok' || before.batch_id) return before;
    const p = before.policy as { version: number; policy: ProactivePolicy },
      collected = await this.options.collector.collect(context, p.policy.time_zone);
    if (collected.status !== 'ok') return collected;
    return this.transaction(context, async (client) => {
      const current = await this.policy(client, context);
      const snapshot = collected.snapshot as BriefSnapshot,
        records = collected.records as BriefRecord[];
      if (
        !current ||
        current.version !== p.version ||
        !(await this.options!.collector.validateSnapshot(client, context, snapshot, String(collected.calendar_digest)))
      )
        return { status: 'denied' };
      const observations = await this.observations(client, context, snapshot);
      const dispositions = (
        await client.query(
          `SELECT r.body->'candidate'->>'semantic_key' AS semantic_key,s.state AS status,s.review_at FROM cos.proactive_suggestions s JOIN cos.proactive_revisions r ON r.scope_id=s.scope_id AND r.suggestion_id=s.id AND r.version=s.version WHERE s.scope_id=$1 ORDER BY s.updated_at DESC LIMIT 1001`,
          [context.scopeId],
        )
      ).rows.map((row) => ({ ...row, review_at: row.review_at ? iso(row.review_at) : null }));
      if (dispositions.length > 1000) return { status: 'unavailable' };
      const candidates = selectProactiveCandidates({
        snapshot,
        records,
        observations,
        dispositions,
        policy: p.policy,
        now: snapshot.generated_at,
      });
      const body: BatchBody = {
        snapshot,
        records,
        observations,
        candidates,
        calendar_digest: String(collected.calendar_digest),
        max_proposals: p.policy.max_proposals,
      };
      const inserted = await client.query(
        `INSERT INTO cos.proactive_batches(scope_id,id,session_id,policy_version,body,digest,context,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+interval '2 minutes') ON CONFLICT DO NOTHING RETURNING id`,
        [
          context.scopeId,
          id,
          context.sessionId,
          p.version,
          JSON.stringify(body),
          digest(body),
          JSON.stringify(context),
        ],
      );
      if (!inserted.rowCount) {
        const old = (
          await client.query('SELECT * FROM cos.proactive_batches WHERE scope_id=$1 AND id=$2', [context.scopeId, id])
        ).rows[0];
        if (!old || !(await this.batchCurrent(client, context, old))) return { status: 'denied' };
        return {
          status: 'ok',
          batch_id: id,
          candidates: old.body.candidates,
          goals: old.body.records.filter((r: BriefRecord) => r.kind === 'goal'),
          max_proposals: old.body.max_proposals,
        };
      }
      return {
        status: 'ok',
        batch_id: id,
        candidates,
        goals: records.filter((r) => r.kind === 'goal'),
        max_proposals: body.max_proposals,
      };
    });
  }
  async submit(context: KnowledgeContext, requestId: string, batchId: string, draft: ProactiveDraft): Promise<Result> {
    if (!uuid.test(requestId) || !/^batch-[a-f0-9]{64}$/.test(batchId) || !validProactiveDraft(draft) || !this.options)
      return { status: 'denied' };
    return this.transaction(context, async (client) => {
      const batch = (
        await client.query('SELECT * FROM cos.proactive_batches WHERE scope_id=$1 AND id=$2', [
          context.scopeId,
          batchId,
        ])
      ).rows[0];
      if (!batch || !(await this.batchCurrent(client, context, batch))) return { status: 'denied' };
      return this.operation(
        client,
        context,
        requestId,
        'cos_proactive_submit',
        { batch_id: batchId, draft },
        async () => {
          const candidate = (batch.body as BatchBody).candidates.find((c) => c.semantic_key === draft.candidate_key),
            goal = (batch.body as BatchBody).records.find((r) => r.id === draft.goal_id && r.kind === 'goal');
          if (
            !candidate ||
            !goal ||
            Date.parse(draft.review_at) < Date.now() ||
            Date.parse(draft.expires_at) > Date.now() + 7 * 86400000
          )
            return { status: 'denied' };
          if (
            draft.work_order &&
            (draft.work_order.goal_id !== goal.id ||
              draft.work_order.project_id !== candidate.project_id ||
              draft.work_order.sources.some(
                (s) =>
                  !(batch.body as BatchBody).observations.some(
                    (o) =>
                      o.kind === 'source_revision' &&
                      o.resource_id === s.source_id &&
                      o.provenance.revision_id === s.revision_id &&
                      (o.project_id === candidate.project_id || o.project_id === null),
                  ),
              ))
          )
            return { status: 'denied' };
          const key = semanticProposalKey({ ...candidate, action_class: draft.action_class }),
            id = 'suggestion-' + key;
          const old = (
            await client.query(
              "SELECT s.*,r.body FROM cos.proactive_suggestions s JOIN cos.proactive_revisions r ON r.scope_id=s.scope_id AND r.suggestion_id=s.id AND r.version=s.version WHERE s.scope_id=$1 AND (s.id=$2 OR r.body->'candidate'->>'semantic_key'=$3) ORDER BY s.created_at LIMIT 1",
              [context.scopeId, id, candidate.semantic_key],
            )
          ).rows[0];
          const count = (
            await client.query(
              'SELECT count(*)::int AS n FROM cos.proactive_revisions WHERE scope_id=$1 AND batch_id=$2',
              [context.scopeId, batchId],
            )
          ).rows[0].n;
          if (old && !(old.state === 'deferred' && old.review_at && old.review_at.getTime() <= Date.now()))
            return { status: 'ok', suggestion_id: old.id, version: old.version, deduplicated: true };
          if (count >= batch.body.max_proposals) return { status: 'denied' };
          const prior = old
            ? null
            : (
                await client.query(
                  'SELECT id FROM cos.proactive_suggestions WHERE scope_id=$1 AND family_key=$2 ORDER BY created_at DESC,id DESC LIMIT 1',
                  [context.scopeId, candidate.family_key],
                )
              ).rows[0];
          const version = old ? old.version + 1 : 1,
            suggestionId = old?.id ?? id;
          const body: RevisionBody = {
            candidate,
            draft,
            goal_version: goal.version,
            policy_version: batch.policy_version,
          };
          if (old)
            await client.query(
              "UPDATE cos.proactive_suggestions SET version=$3,state='open',review_at=NULL,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
              [context.scopeId, suggestionId, version],
            );
          else
            await client.query(
              "INSERT INTO cos.proactive_suggestions(scope_id,id,semantic_key,family_key,version,state,prior_id) VALUES($1,$2,$3,$4,1,'open',$5)",
              [context.scopeId, suggestionId, key, candidate.family_key, prior?.id ?? null],
            );
          await client.query(
            'INSERT INTO cos.proactive_revisions(scope_id,suggestion_id,version,batch_id,body,digest,context) VALUES($1,$2,$3,$4,$5,$6,$7)',
            [
              context.scopeId,
              suggestionId,
              version,
              batchId,
              JSON.stringify(body),
              digest(body),
              JSON.stringify(context),
            ],
          );
          return { status: 'ok', suggestion_id: suggestionId, version, prior_id: old?.prior_id ?? prior?.id ?? null };
        },
      );
    });
  }
  private async revision(client: PoolClient, context: Context, request: ProactiveDispositionRequest) {
    return (
      await client.query(
        `SELECT s.state,s.review_at,s.version,r.body,r.digest,r.context,b.body AS batch_body FROM cos.proactive_suggestions s JOIN cos.proactive_revisions r ON r.scope_id=s.scope_id AND r.suggestion_id=s.id AND r.version=s.version JOIN cos.proactive_batches b ON b.scope_id=r.scope_id AND b.id=r.batch_id WHERE s.scope_id=$1 AND s.id=$2 AND s.version=$3 FOR UPDATE OF s`,
        [context.scopeId, request.suggestion_id, request.expected_version],
      )
    ).rows[0];
  }
  private async revisionCurrent(
    client: PoolClient,
    context: KnowledgeContext,
    row: { body: RevisionBody; digest: string; batch_body: BatchBody },
  ): Promise<boolean> {
    if (
      !this.options ||
      digest(row.body) !== row.digest ||
      !(await this.options.knowledge.answers.dependencies.current(client, context))
    )
      return false;
    const body = row.body,
      p = await this.policy(client, context);
    if (!p || p.version !== body.policy_version || Date.parse(body.draft.expires_at) <= Date.now()) return false;
    const goal = (
      await client.query(
        "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND version=$3 AND kind='goal' AND lifecycle='active'",
        [context.scopeId, body.draft.goal_id, body.goal_version],
      )
    ).rowCount;
    if (!goal) return false;
    const target = body.candidate;
    if (
      target.project_id &&
      !(
        await client.query(
          "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind='project' AND lifecycle='active'",
          [context.scopeId, target.project_id],
        )
      ).rowCount
    )
      return false;
    for (const ref of target.evidence) {
      if (ref.kind === 'work') {
        if (
          !(
            await client.query('SELECT 1 FROM cos.work_items WHERE scope_id=$1 AND id=$2 AND version=$3', [
              context.scopeId,
              ref.work_id,
              ref.version,
            ])
          ).rowCount
        )
          return false;
      } else if (!(await this.options.collector.options.work.evidenceAllowed(client, context, [ref], context, true)))
        return false;
    }
    return this.observationsCurrent(
      client,
      context,
      row.batch_body.observations.filter((o) => target.observation_ids.includes(o.event_id)),
    );
  }
  async prepareDisposition(
    client: PoolClient,
    context: Context,
    requestId: string,
    request: ProactiveDispositionRequest,
    retained?: KnowledgeContext,
  ): Promise<ProactiveDispositionChange | null> {
    if (context.origin || !validProactiveDisposition(request)) return null;
    const row = await this.revision(client, context, request);
    if (!row || row.state !== 'open') return null;
    if (request.decision === 'defer' && Date.parse(request.review_at!) <= Date.now()) return null;
    let mission = null;
    if (request.decision === 'accept') {
      if (!retained || !(await this.revisionCurrent(client, retained, row))) return null;
      if (row.body.draft.work_order) {
        mission = await this.options!.missions.prepare(client, context, requestId, row.body.draft.work_order);
        if (!mission) return null;
      }
    }
    return { kind: 'proactive_disposition', request, mission };
  }
  async validateDisposition(
    client: PoolClient,
    context: Context,
    change: ProactiveDispositionChange,
    retained?: KnowledgeContext,
  ): Promise<boolean> {
    if (context.origin || !this.options) return false;
    const row = await this.revision(client, context, change.request);
    if (!row || row.state !== 'open') return false;
    if (change.request.decision === 'defer') return Date.parse(change.request.review_at!) > Date.now();
    if (change.request.decision === 'dismiss') return change.mission === null;
    return (
      !!retained &&
      retained.scopeId === context.scopeId &&
      retained.ownerId === context.ownerId &&
      retained.sessionId === context.sessionId &&
      retained.agentGroupId === context.agentGroupId &&
      (await this.revisionCurrent(client, retained, row)) &&
      (row.body.draft.work_order
        ? !!change.mission &&
          digest(change.mission.work_order.request) === digest(row.body.draft.work_order) &&
          (await this.options.missions.validateChange(client, context, change.mission))
        : change.mission === null)
    );
  }
  async applyDisposition(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: ProactiveDispositionChange,
    retained?: KnowledgeContext,
  ): Promise<Result> {
    if (!(await this.validateDisposition(client, context, change, retained))) return { status: 'conflict' };
    const r = change.request;
    if (change.mission) {
      const result = await this.options!.missions.applyApproved(client, context, proposal, change.mission);
      if (result.status !== 'ok') return result;
    }
    await client.query(
      'INSERT INTO cos.proactive_feedback(scope_id,suggestion_id,version,proposal_id,decision,review_at,reason,usefulness,review_seconds,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [
        context.scopeId,
        r.suggestion_id,
        r.expected_version,
        proposal.id,
        r.decision,
        r.review_at,
        r.reason,
        r.usefulness,
        r.review_seconds,
        JSON.stringify({
          owner_id: context.ownerId,
          ingress_id: proposal.decision_ingress_id,
          mission_id: change.mission?.mission_id ?? null,
        }),
      ],
    );
    await client.query(
      'UPDATE cos.proactive_suggestions SET state=$3,review_at=$4,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
      [
        context.scopeId,
        r.suggestion_id,
        { accept: 'accepted', defer: 'deferred', dismiss: 'dismissed' }[r.decision],
        r.review_at,
      ],
    );
    return {
      status: 'ok',
      record_id: r.suggestion_id,
      mission_id: change.mission?.mission_id ?? null,
      clarification_required: r.decision === 'accept' && !change.mission,
    };
  }
  async validatePolicyChange(client: PoolClient, context: Context, change: ProactivePolicyChange): Promise<boolean> {
    const current = (
      await client.query('SELECT owner_id,version FROM cos.proactive_policies WHERE scope_id=$1', [context.scopeId])
    ).rows[0];
    return (
      !context.origin &&
      (current
        ? current.owner_id === context.ownerId && current.version === change.expected_version
        : change.expected_version === 0)
    );
  }
  async applyPolicy(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: ProactivePolicyChange,
  ): Promise<Result> {
    if (!(await this.validatePolicyChange(client, context, change))) return { status: 'conflict' };
    const version = change.expected_version + 1;
    const provenance = {
      owner_id: context.ownerId,
      ingress_id: proposal.decision_ingress_id,
      proposal_id: proposal.id,
    };
    await client.query(
      `INSERT INTO cos.proactive_policies(scope_id,owner_id,version,state,policy,provenance) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope_id) DO UPDATE SET version=excluded.version,state=excluded.state,policy=excluded.policy,provenance=excluded.provenance,updated_at=clock_timestamp()`,
      [
        context.scopeId,
        context.ownerId,
        version,
        change.state,
        JSON.stringify(change.policy),
        JSON.stringify(provenance),
      ],
    );
    await client.query(
      'INSERT INTO cos.proactive_policy_revisions(scope_id,version,body,proposal_id) VALUES($1,$2,$3,$4)',
      [context.scopeId, version, JSON.stringify({ ...change, provenance }), proposal.id],
    );
    return { status: 'ok', record_id: 'proactive-policy', version };
  }
}
