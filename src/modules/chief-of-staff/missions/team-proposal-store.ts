import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { validTeamChange, type TeamChange } from '../contracts/protocol.js';
import { validTeamRequest, teamOrder, type TeamRequest } from '../contracts/team-protocol.js';
import { TEAM_TEMPLATES } from '../contracts/team-templates.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { MissionAuthority } from './proposal-store.js';
import type { MissionOrigin, ResearchWorkOrder } from './work-order.js';
import { teamParentLimits } from './team-budget.js';

/** Separate host-owned team admission; enabling single-worker delegation does not enable teams. */
export type TeamAuthority = MissionAuthority & { templateBundleDigest: string; teamPolicyDigest: string };
export type TeamAuthorityResolver = (context: Context) => TeamAuthority | null;
export type TeamWorkOrderBody = {
  format: 'cos-team-work-order/v1';
  teamId: string;
  request: TeamRequest;
  origin: MissionOrigin;
  related: ResearchWorkOrder['body']['related'];
  templates: Array<{ id: string; version: number; digest: string }>;
  provider: MissionAuthority['provider'];
  issuedAt: string;
  deadlineAt: string;
  contextDigest: string;
  authorityDigest: string;
};
export class TeamProposalStore {
  constructor(
    readonly knowledge?: KnowledgeStore,
    readonly authority?: TeamAuthorityResolver,
  ) {}
  private async seal(client: PoolClient, context: Context, teamId: string, request: TeamRequest, issuedAt: string) {
    const authority = this.authority?.(context);
    if (
      !this.knowledge ||
      !authority ||
      context.origin ||
      !validTeamRequest(request) ||
      authority.templateBundleDigest !== digest(TEAM_TEMPLATES) ||
      !/^[a-f0-9]{64}$/.test(authority.teamPolicyDigest) ||
      authority.provider.profile !== 'codex-subscription/research-v1'
    )
      return null;
    const templates: TeamWorkOrderBody['templates'] = [];
    for (const id of [...new Set(request.steps.map((s) => s.template_id))].sort()) {
      const expected = TEAM_TEMPLATES[id];
      const row = (
        await client.query(
          'SELECT body,digest,reviewed_by FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2 AND version=$3',
          [context.scopeId, id, expected.version],
        )
      ).rows[0];
      if (
        !row ||
        row.reviewed_by !== context.ownerId ||
        row.digest !== digest(expected) ||
        digest(row.body) !== row.digest
      )
        return null;
      templates.push({ id, version: expected.version, digest: row.digest });
    }
    const related: TeamWorkOrderBody['related'] = { goal: null, project: null };
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
    const contextSnapshot = { format: 'cos-mission-context/v1', sources };
    const origin: MissionOrigin = {
      scopeId: context.scopeId,
      ownerId: context.ownerId,
      sessionId: context.sessionId,
      agentGroupId: context.agentGroupId,
      ingressId: context.ingressId,
      bindingDigest: authority.bindingDigest,
      delegationDigest: authority.delegationDigest,
      contextGeneration: authority.contextGeneration,
    };
    const body: TeamWorkOrderBody = {
      format: 'cos-team-work-order/v1',
      teamId,
      request: JSON.parse(JSON.stringify(request)),
      origin,
      related,
      templates,
      provider: authority.provider,
      issuedAt,
      deadlineAt: new Date(Date.parse(issuedAt) + request.limits.wall_seconds * 1000).toISOString(),
      contextDigest: digest(contextSnapshot),
      authorityDigest: digest(authority),
    };
    if (digest(this.authority?.(context) ?? null) !== digest(authority)) return null;
    return { body, digest: digest(body), context: contextSnapshot };
  }
  async prepare(
    client: PoolClient,
    context: Context,
    requestId: string,
    request: TeamRequest,
  ): Promise<TeamChange | null> {
    const id = 'team-' + digest({ scopeId: context.scopeId, sessionId: context.sessionId, requestId });
    const at = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.toISOString();
    const order = await this.seal(client, context, id, request, at);
    if (!order) return null;
    const change: TeamChange = {
      kind: 'specialist_team',
      team_id: id,
      work_order: order.body,
      work_order_digest: order.digest,
    };
    if (!validTeamChange(change)) return null;
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
      'INSERT INTO cos.mission_team_work_orders(scope_id,id,body,digest,context_digest,provenance) VALUES($1,$2,$3,$4,$5,$6)',
      [
        context.scopeId,
        id,
        JSON.stringify(order.body),
        order.digest,
        order.body.contextDigest,
        JSON.stringify(provenance),
      ],
    );
    await client.query("INSERT INTO cos.mission_team_roots(scope_id,id,state,provenance) VALUES($1,$2,'proposed',$3)", [
      context.scopeId,
      id,
      JSON.stringify(provenance),
    ]);
    return change;
  }
  async captureChange(client: PoolClient, context: Context, change: TeamChange, execution = true) {
    if (context.origin || !validTeamChange(change)) return null;
    const row = (
      await client.query('SELECT body,digest FROM cos.mission_team_work_orders WHERE scope_id=$1 AND id=$2', [
        context.scopeId,
        change.team_id,
      ])
    ).rows[0];
    if (
      !row ||
      row.digest !== change.work_order_digest ||
      digest(row.body) !== row.digest ||
      digest(change.work_order) !== row.digest
    )
      return null;
    const b = row.body as TeamWorkOrderBody;
    if (
      b.origin.scopeId !== context.scopeId ||
      b.origin.ownerId !== context.ownerId ||
      b.origin.sessionId !== context.sessionId ||
      b.origin.agentGroupId !== context.agentGroupId ||
      (execution &&
        !(await client.query('SELECT $1::timestamptz>clock_timestamp() AS current', [b.deadlineAt])).rows[0].current)
    )
      return null;
    const order = await this.seal(
      client,
      { ...context, ingressId: b.origin.ingressId },
      change.team_id,
      b.request,
      b.issuedAt,
    );
    return order?.digest === row.digest ? order : null;
  }
  async validateChange(client: PoolClient, context: Context, change: TeamChange): Promise<boolean> {
    return (await this.captureChange(client, context, change)) !== null;
  }
  /** Metadata-only loss detection for already-approved roots. A true result cannot authorise any disclosure or launch. */
  async metadataCurrent(client: PoolClient, context: Context, body: TeamWorkOrderBody): Promise<boolean> {
    const authority = this.authority?.(context);
    if (
      !authority ||
      !this.knowledge ||
      context.origin ||
      body.format !== 'cos-team-work-order/v1' ||
      !validTeamRequest(body.request) ||
      body.origin.scopeId !== context.scopeId ||
      body.origin.ownerId !== context.ownerId ||
      body.origin.agentGroupId !== context.agentGroupId ||
      body.origin.sessionId !== context.sessionId ||
      digest(authority) !== body.authorityDigest
    )
      return false;
    const templates = [];
    for (const templateId of [...new Set(body.request.steps.map((s) => s.template_id))].sort()) {
      const expected = TEAM_TEMPLATES[templateId],
        row = (
          await client.query(
            'SELECT body,digest,reviewed_by FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2 AND version=$3',
            [context.scopeId, templateId, expected.version],
          )
        ).rows[0];
      if (
        !row ||
        row.reviewed_by !== context.ownerId ||
        row.digest !== digest(expected) ||
        digest(row.body) !== row.digest
      )
        return false;
      templates.push({ id: templateId, version: expected.version, digest: row.digest });
    }
    if (digest(templates) !== digest(body.templates)) return false;
    for (const kind of ['goal', 'project'] as const) {
      const selected = body.request[`${kind}_id`],
        pinned = body.related[kind];
      if (!selected) {
        if (pinned !== null) return false;
        continue;
      }
      const row = (
        await client.query(
          "SELECT id,version FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind=$3 AND lifecycle='active' FOR SHARE",
          [context.scopeId, selected, kind],
        )
      ).rows[0];
      if (!row || digest(row) !== digest(pinned)) return false;
    }
    return (
      (await this.knowledge.missionSourcesCurrent(
        client,
        { ...context, provider: 'codex', generation: authority.contextGeneration },
        body.request.sources,
      )) && digest(this.authority?.(context) ?? null) === digest(authority)
    );
  }
  async linkProposal(client: PoolClient, context: Context, change: TeamChange, proposalId: string) {
    const row = await client.query(
      "UPDATE cos.mission_team_roots SET proposal_id=$3 WHERE scope_id=$1 AND id=$2 AND state='proposed' AND proposal_id IS NULL RETURNING id",
      [context.scopeId, change.team_id, proposalId],
    );
    if (row.rowCount !== 1) throw Error('team_proposal_conflict');
  }
  /** Approval commits the whole bounded graph and escrow before any native allocation or provider wait. */
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; decision_ingress_id: string },
    change: TeamChange,
  ): Promise<Result> {
    const row = (
      await client.query('SELECT * FROM cos.mission_team_roots WHERE scope_id=$1 AND id=$2 FOR UPDATE', [
        context.scopeId,
        change.team_id,
      ])
    ).rows[0];
    const order = await this.captureChange(client, context, change);
    if (
      !row ||
      row.state !== 'proposed' ||
      row.generation !== 0 ||
      row.proposal_id !== proposal.id ||
      !proposal.decision_ingress_id ||
      !order
    )
      return { status: 'conflict' };
    const provenance = {
      proposal_id: proposal.id,
      decision_ingress_id: proposal.decision_ingress_id,
      owner_id: context.ownerId,
      work_order_digest: order.digest,
    };
    const parentLimits = teamParentLimits(order.body.request);
    await client.query(
      "INSERT INTO cos.mission_team_root_reservations(scope_id,team_id,max_attempts,max_turns,max_tool_calls,state) VALUES($1,$2,$3,$4,$5,'reserved')",
      [context.scopeId, change.team_id, parentLimits.attempt, parentLimits.model, parentLimits.tool],
    );
    await client.query(
      "INSERT INTO cos.mission_team_root_budget_events(scope_id,team_id,id,kind,body) VALUES($1,$2,$3,'reserved',$4)",
      [
        context.scopeId,
        change.team_id,
        'team-parent-reserve-' + change.team_id,
        JSON.stringify({ limits: parentLimits, ...provenance }),
      ],
    );
    for (const id of teamOrder(order.body.request)!) {
      const step = order.body.request.steps.find((s) => s.step_id === id)!;
      await client.query(
        'INSERT INTO cos.mission_team_steps(scope_id,team_id,step_id,definition,state,provenance) VALUES($1,$2,$3,$4,$5,$6)',
        [
          context.scopeId,
          change.team_id,
          id,
          JSON.stringify(step),
          step.depends_on.length ? 'blocked' : 'ready',
          JSON.stringify(provenance),
        ],
      );
      const caps = {
        max_attempts: step.limits.max_attempts + step.max_rework_count,
        max_turns: step.limits.max_turns,
        max_tool_calls: step.limits.max_tool_calls,
      };
      await client.query(
        "INSERT INTO cos.mission_team_reservations(scope_id,team_id,step_id,max_attempts,max_turns,max_tool_calls,state) VALUES($1,$2,$3,$4,$5,$6,'reserved')",
        [context.scopeId, change.team_id, id, caps.max_attempts, caps.max_turns, caps.max_tool_calls],
      );
      await client.query(
        "INSERT INTO cos.mission_team_budget_events(scope_id,team_id,step_id,id,kind,body) VALUES($1,$2,$3,$4,'reserved',$5)",
        [
          context.scopeId,
          change.team_id,
          id,
          'team-reserve-' + digest({ team: change.team_id, step: id }),
          JSON.stringify({ ...caps, ...provenance }),
        ],
      );
    }
    for (const step of order.body.request.steps)
      for (const dependency of step.depends_on) {
        await client.query(
          'INSERT INTO cos.mission_team_dependencies(scope_id,team_id,step_id,depends_on) VALUES($1,$2,$3,$4)',
          [context.scopeId, change.team_id, step.step_id, dependency],
        );
      }
    await client.query(
      "UPDATE cos.mission_team_roots SET state='queued',generation=1,version=version+1,provenance=provenance||$3::jsonb,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
      [context.scopeId, change.team_id, JSON.stringify(provenance)],
    );
    return { status: 'ok', record_id: change.team_id };
  }
}
