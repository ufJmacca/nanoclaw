import { queueMissionAttempt } from './attempt.js';
import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { validMissionChange, type MissionChange } from '../contracts/protocol.js';
import type { MissionRequest } from '../contracts/mission-protocol.js';
import type { KnowledgeStore, KnowledgeContext } from '../knowledge/store.js';
import { RESEARCH_TEMPLATE, sealResearchWorkOrder, type ResearchWorkOrder } from './work-order.js';

export type MissionAuthority = {
  bindingDigest: string;
  delegationDigest: string;
  contextGeneration: string;
  provider: ResearchWorkOrder['body']['provider'];
};
/** Host-only resolver must establish current private origin, explicit delegation and confined provider consent.
 * No resolver means disabled. A model request can never provide these values. */
export type MissionAuthorityResolver = (context: Context) => MissionAuthority | null;

export class MissionProposalStore {
  constructor(
    readonly knowledge?: KnowledgeStore,
    readonly authority?: MissionAuthorityResolver,
    readonly teamChildCapture?: (
      client: PoolClient,
      context: Context,
      change: MissionChange,
      execution: boolean,
    ) => Promise<ResearchWorkOrder | null>,
  ) {}

  private async seal(
    client: PoolClient,
    context: Context,
    missionId: string,
    request: MissionRequest,
    issuedAt: string,
    authority: MissionAuthority,
  ): Promise<ResearchWorkOrder | null> {
    if (!this.knowledge || context.origin) return null;
    const template = (
      await client.query(
        'SELECT body,digest,reviewed_by FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2 AND version=$3',
        [context.scopeId, RESEARCH_TEMPLATE.id, RESEARCH_TEMPLATE.version],
      )
    ).rows[0];
    if (
      !template ||
      !template.reviewed_by ||
      template.digest !== digest(RESEARCH_TEMPLATE) ||
      digest(template.body) !== template.digest
    )
      return null;
    const related: ResearchWorkOrder['body']['related'] = { goal: null, project: null };
    for (const kind of ['goal', 'project'] as const) {
      const id = request[`${kind}_id`];
      if (!id) continue;
      const row = (
        await client.query(
          "SELECT id,version FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind=$3 AND lifecycle='active' FOR SHARE",
          [context.scopeId, id, kind],
        )
      ).rows[0];
      if (!row) return null;
      related[kind] = row;
    }
    const sources = await this.knowledge.captureMissionSources(
      client,
      { ...context, provider: 'codex', generation: authority.contextGeneration },
      request.sources,
      request.limits.context_bytes,
    );
    if (!sources) return null;
    const order = sealResearchWorkOrder({
      missionId,
      request,
      origin: {
        scopeId: context.scopeId,
        ownerId: context.ownerId,
        sessionId: context.sessionId,
        agentGroupId: context.agentGroupId,
        ingressId: context.ingressId,
        bindingDigest: authority.bindingDigest,
        delegationDigest: authority.delegationDigest,
        contextGeneration: authority.contextGeneration,
      },
      related,
      sources,
      provider: authority.provider,
      reviewedTemplateDigest: template.digest,
      issuedAt,
    });
    if (digest(this.authority?.(context) ?? null) !== digest(authority)) return null;
    return order;
  }

  /** Called inside the existing proposal transaction, with an active scope and a serialized request identity. */
  async prepare(
    client: PoolClient,
    context: Context,
    requestId: string,
    request: MissionRequest,
  ): Promise<MissionChange | null> {
    const authority = this.authority?.(context);
    if (!authority || context.origin) return null;
    const missionId = 'mission-' + digest({ scopeId: context.scopeId, sessionId: context.sessionId, requestId });
    const issuedAt = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const order = await this.seal(client, context, missionId, request, issuedAt, authority);
    if (!order) return null;
    const change: MissionChange = {
      kind: 'research_mission',
      mission_id: missionId,
      work_order_digest: order.digest,
      work_order: order.body,
    };
    if (!validMissionChange(change)) return null;
    // Only locators/digests are immutable. Source bytes stay in the existing purgeable host artifacts.
    const manifest = {
      format: 'cos-mission-manifest/v1',
      sources: order.context.sources.map(({ chunks, ...source }) => ({
        ...source,
        chunks: chunks.map(({ text, ...locator }) => ({ ...locator, digest: digest(text) })),
      })),
    };
    const provenance = {
      request_id: requestId,
      session_id: context.sessionId,
      owner_id: context.ownerId,
      ingress_id: context.ingressId,
    };
    await client.query(
      'INSERT INTO cos.mission_context_manifests(scope_id,digest,body,provenance) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [context.scopeId, order.body.contextDigest, JSON.stringify(manifest), JSON.stringify(provenance)],
    );
    await client.query(
      'INSERT INTO cos.mission_work_orders(scope_id,id,body,digest,context_digest,template_id,template_version,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [
        context.scopeId,
        missionId,
        JSON.stringify(order.body),
        order.digest,
        order.body.contextDigest,
        RESEARCH_TEMPLATE.id,
        RESEARCH_TEMPLATE.version,
        JSON.stringify(provenance),
      ],
    );
    await client.query("INSERT INTO cos.missions(scope_id,id,state,provenance) VALUES($1,$2,'proposed',$3)", [
      context.scopeId,
      missionId,
      JSON.stringify(provenance),
    ]);
    return change;
  }

  /** Current authority is checked on request replay, preview and apply; a historical snapshot is no access grant. */
  async validateChange(client: PoolClient, context: Context, change: MissionChange): Promise<boolean> {
    return (await this.captureChange(client, context, change)) !== null;
  }
  async captureChange(client: PoolClient, context: Context, change: MissionChange): Promise<ResearchWorkOrder | null> {
    return this.captureExisting(client, context, change, true);
  }
  /** Review can outlive execution, but retains exact private origin, source and provider authority checks. */
  async captureReview(
    client: PoolClient,
    context: KnowledgeContext,
    change: MissionChange,
  ): Promise<ResearchWorkOrder | null> {
    if (context.provider !== 'codex') return null;
    const { provider: _provider, generation: _generation, ...origin } = context;
    const order = await this.captureExisting(client, origin, change, false);
    return order && order.body.origin.contextGeneration === context.generation ? order : null;
  }
  private async captureExisting(
    client: PoolClient,
    context: Context,
    change: MissionChange,
    execution: boolean,
  ): Promise<ResearchWorkOrder | null> {
    const authority = this.authority?.(context);
    if (!authority || context.origin || !validMissionChange(change)) return null;
    const row = (
      await client.query('SELECT body,digest FROM cos.mission_work_orders WHERE scope_id=$1 AND id=$2', [
        context.scopeId,
        change.mission_id,
      ])
    ).rows[0];
    if (
      !row ||
      row.digest !== change.work_order_digest ||
      digest(row.body) !== row.digest ||
      digest(row.body) !== digest(change.work_order)
    )
      return null;
    const body = row.body as ResearchWorkOrder['body'];
    if (body.format === 'cos-team-child-work-order/v1')
      return this.teamChildCapture?.(client, context, change, execution) ?? null;
    if (
      body.origin.scopeId !== context.scopeId ||
      body.origin.ownerId !== context.ownerId ||
      body.origin.sessionId !== context.sessionId ||
      body.origin.agentGroupId !== context.agentGroupId ||
      body.origin.bindingDigest !== authority.bindingDigest ||
      body.origin.delegationDigest !== authority.delegationDigest ||
      body.origin.contextGeneration !== authority.contextGeneration ||
      digest(body.provider) !== digest(authority.provider)
    )
      return null;
    if (
      execution &&
      !(await client.query('SELECT $1::timestamptz > clock_timestamp() AS current', [body.deadlineAt])).rows[0].current
    )
      return null;
    const current = await this.seal(
      client,
      { ...context, ingressId: body.origin.ingressId },
      change.mission_id,
      body.request,
      body.issuedAt,
      authority,
    );
    return current && current.digest === row.digest ? current : null;
  }

  async linkProposal(client: PoolClient, context: Context, change: MissionChange, proposalId: string): Promise<void> {
    const linked = await client.query(
      "UPDATE cos.missions SET proposal_id=$3 WHERE scope_id=$1 AND id=$2 AND state='proposed' AND proposal_id IS NULL RETURNING id",
      [context.scopeId, change.mission_id, proposalId],
    );
    if (linked.rowCount !== 1) throw new Error('mission_proposal_conflict');
  }

  /** Exact owner decision creates the attempt and root reservation atomically; no native wake is performed here. */
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: MissionChange,
  ): Promise<Result> {
    const mission = (
      await client.query(
        'SELECT state,proposal_id,generation FROM cos.missions WHERE scope_id=$1 AND id=$2 FOR UPDATE',
        [context.scopeId, change.mission_id],
      )
    ).rows[0];
    if (
      !mission ||
      mission.state !== 'proposed' ||
      mission.proposal_id !== proposal.id ||
      mission.generation !== 0 ||
      !proposal.decision_ingress_id ||
      !(await this.validateChange(client, context, change))
    )
      return { status: 'conflict' };
    await queueMissionAttempt(client, context.scopeId, change.mission_id, 1, change.work_order_digest, {
      proposal_id: proposal.id,
      owner_id: context.ownerId,
      decision_ingress_id: proposal.decision_ingress_id,
      work_order_digest: change.work_order_digest,
    });
    return { status: 'ok', record_id: change.mission_id };
  }
}
