import type { Context, ProposalChange, Result } from '../domain/contracts.js';
import { digest, validProposalChange, validSourceChange } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import {
  validWorkChange,
  validWorkRead,
  validMissionChange,
  validTeamChange,
  validProactiveDispositionChange,
  type WorkRead,
} from '../contracts/protocol.js';
import { validTeamRequest, type TeamRequest } from '../contracts/team-protocol.js';
import { TeamProposalStore, type TeamAuthorityResolver } from '../missions/team-proposal-store.js';
import { TeamRunStore } from '../missions/team-run-store.js';
import { validMissionRequest, type MissionRequest } from '../contracts/mission-protocol.js';
import { MissionProposalStore, type MissionAuthorityResolver } from '../missions/proposal-store.js';
import { MissionRunStore } from '../missions/run-store.js';
import { MissionReviews } from '../missions/review-store.js';
import { MissionNotifications } from '../missions/notifications.js';
import { MissionReviewRuns } from '../missions/review-runs.js';
import { TeamFinalReviews } from '../missions/team-final-review.js';
import { WorkStore } from './work.js';
import { validScheduleChange } from '../contracts/schedule-protocol.js';
import { BriefScheduleStore } from '../automation/schedule-store.js';
import { BriefCollector } from '../automation/brief-collector.js';
import { BriefArtifacts } from '../automation/brief-artifacts.js';
import { BriefRunStore } from '../automation/brief-store.js';
import type { CalendarConnector } from '../calendar/connector.js';
import type { CalendarView } from '../calendar/view.js';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PoolClient } from 'pg';
import { BoundedDatabase, DatabaseUnavailable } from './client.js';
import type { CosBinding } from '../../../cos-boundary.js';
import {
  validProactivePolicyChange,
  validProactiveDisposition,
  type ProactiveDispositionRequest,
} from '../contracts/proactive-protocol.js';
import { ProactiveStore } from '../automation/proactive-store.js';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

async function authorised(client: PoolClient, context: Context): Promise<boolean> {
  const result = await client.query(
    `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2
    AND agent_group_id=$3 AND status='active' FOR SHARE`,
    [context.scopeId, context.ownerId, context.agentGroupId],
  );
  return result.rowCount === 1;
}

async function event(
  client: PoolClient,
  scope: string,
  kind: string,
  resource: string,
  provenance: unknown,
): Promise<void> {
  await client.query(
    'INSERT INTO cos.events(id,scope_id,kind,resource_id,version,provenance) VALUES($1,$2,$3,$4,1,$5)',
    [randomUUID(), scope, kind, resource, JSON.stringify(provenance)],
  );
}

export class PriorityStore {
  readonly work: WorkStore;
  readonly schedules = new BriefScheduleStore();
  readonly proactive: ProactiveStore;
  readonly briefs: BriefRunStore;
  readonly briefArtifacts?: BriefArtifacts;
  readonly missions: MissionProposalStore;
  readonly teams: TeamProposalStore;
  readonly teamRuns: TeamRunStore;
  readonly missionRuns: MissionRunStore;
  readonly missionReviews?: MissionReviews;
  readonly missionNotifications?: MissionNotifications;
  readonly missionReviewRuns?: MissionReviewRuns;
  readonly teamFinalReviews?: TeamFinalReviews;
  readonly teamNotifications?: MissionNotifications;
  constructor(
    readonly database: BoundedDatabase,
    readonly knowledge?: KnowledgeStore,
    readonly calendar?: CalendarConnector,
    readonly calendarView?: CalendarView,
    missionAuthority?: MissionAuthorityResolver,
    teamAuthority?: TeamAuthorityResolver,
  ) {
    this.teams = new TeamProposalStore(knowledge, teamAuthority);
    this.teamRuns = new TeamRunStore(database, this.teams, knowledge);
    this.missions = new MissionProposalStore(knowledge, missionAuthority, (...args) =>
      this.teamRuns.captureChild(...args),
    );
    this.missionRuns = new MissionRunStore(database, this.missions, knowledge?.artifacts);
    if (knowledge) {
      this.missionReviews = new MissionReviews(database, this.missions, knowledge);
      this.missionNotifications = new MissionNotifications(database, this.missionReviews);
      this.missionReviewRuns = new MissionReviewRuns(this.missionReviews);
      this.teamFinalReviews = new TeamFinalReviews(this.teamRuns);
      this.teamNotifications = new MissionNotifications(database, this.teamFinalReviews, 'team');
    }
    this.work = new WorkStore(knowledge);
    this.proactive = new ProactiveStore(
      knowledge
        ? {
            database,
            knowledge,
            collector: new BriefCollector({ database, work: this.work, knowledge, calendarView }),
            missions: this.missions,
          }
        : undefined,
    );
    this.briefs = new BriefRunStore(database);
    if (knowledge)
      this.briefArtifacts = new BriefArtifacts(
        new BriefCollector({ database, work: this.work, knowledge, calendarView }),
      );
  }
  private async workReceiptCurrent(client: PoolClient, context: Context, result: Result): Promise<boolean> {
    if (validProactiveDispositionChange(result.change)) {
      const stored = (
        await client.query(
          'SELECT work_context FROM cos.proposals WHERE scope_id=$1 AND id=$2 AND owner_id=$3 AND session_id=$4',
          [context.scopeId, result.proposal_id, context.ownerId, context.sessionId],
        )
      ).rows[0];
      return (
        !!stored && this.proactive.validateDisposition(client, context, result.change, stored.work_context ?? undefined)
      );
    }
    if (validProactivePolicyChange(result.change))
      return this.proactive.validatePolicyChange(client, context, result.change);
    if (validTeamChange(result.change)) return this.teams.validateChange(client, context, result.change);
    if (validMissionChange(result.change)) return this.missions.validateChange(client, context, result.change);
    if (!validWorkChange(result.change)) return true;
    const proposal = (
      await client.query(
        'SELECT change,work_context FROM cos.proposals WHERE scope_id=$1 AND id=$2 AND owner_id=$3 AND session_id=$4',
        [context.scopeId, result.proposal_id, context.ownerId, context.sessionId],
      )
    ).rows[0];
    return (
      !!proposal &&
      digest(proposal.change) === digest(result.change) &&
      (await this.work.validateChange(client, context, result.change, proposal.work_context ?? undefined))
    );
  }
  /** Rechecked immediately before each platform preview send, including retries. */
  async previewCurrent(binding: CosBinding, proposalId: string, change: ProposalChange): Promise<boolean> {
    const result = await this.transaction(async (client) => {
      const context = { ...binding, ingressId: '' };
      if (!(await authorised(client, context))) return { status: 'denied' };
      const proposal = (
        await client.query(
          "SELECT ingress_id,change FROM cos.proposals WHERE scope_id=$1 AND id=$2 AND owner_id=$3 AND session_id=$4 AND state='pending' AND expires_at>clock_timestamp()",
          [binding.scopeId, proposalId, binding.ownerId, binding.sessionId],
        )
      ).rows[0];
      if (!proposal || digest(proposal.change) !== digest(change)) return { status: 'denied' };
      return {
        status: (await this.workReceiptCurrent(
          client,
          { ...context, ingressId: proposal.ingress_id },
          { status: 'ok', proposal_id: proposalId, change },
        ))
          ? 'ok'
          : 'denied',
      };
    }, false);
    return result.status === 'ok';
  }
  /** Trusted setup only; deliberately absent from the agent RPC method table. */
  async bindScope(binding: CosBinding): Promise<Result> {
    return this.transaction(async (client) => {
      await client.query(
        `INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status)
        VALUES($1,$2,$3,$4,$5,'active') ON CONFLICT DO NOTHING`,
        [binding.scopeId, binding.ownerId, binding.instanceId, binding.channelId, binding.agentGroupId],
      );
      const row = (await client.query('SELECT * FROM cos.scopes WHERE id=$1 FOR SHARE', [binding.scopeId])).rows[0];
      const matching =
        row &&
        row.owner_id === binding.ownerId &&
        row.instance_id === binding.instanceId &&
        row.channel_id === binding.channelId &&
        row.agent_group_id === binding.agentGroupId &&
        row.status === 'active';
      return { status: matching ? 'ok' : 'conflict' };
    });
  }
  async pendingOutbox(scopeId: string): Promise<Result> {
    return this.transaction(async (client) => {
      const items = (
        await client.query(
          `SELECT o.id,o.kind,o.payload,p.session_id,p.expires_at,p.ingress_id,s.owner_id,s.agent_group_id
        FROM cos.outbox o JOIN cos.scopes s ON s.id=o.scope_id
        JOIN cos.proposals p ON p.id=o.payload->>'proposal_id' AND p.scope_id=o.scope_id
        WHERE o.scope_id=$1 AND s.status='active' AND o.delivered_at IS NULL
        AND ((o.kind='approval_preview' AND p.state='pending' AND p.expires_at>clock_timestamp())
          OR (o.kind='proposal_apply' AND p.state='approved'))
        ORDER BY o.created_at,o.id LIMIT 20`,
          [scopeId],
        )
      ).rows;
      const current = [];
      for (const item of items) {
        const { owner_id, agent_group_id, ingress_id, ...safe } = item;
        const context = {
          scopeId,
          ownerId: owner_id,
          agentGroupId: agent_group_id,
          ingressId: ingress_id,
          sessionId: item.session_id,
        };
        if (item.kind !== 'approval_preview' || (await this.workReceiptCurrent(client, context, item.payload)))
          current.push(safe);
      }
      return { status: 'ok', items: current };
    }, false);
  }
  async acknowledgePreview(scopeId: string, id: string): Promise<Result> {
    return this.transaction(async (client) => {
      const changed = await client.query(
        `UPDATE cos.outbox SET delivered_at=COALESCE(delivered_at,clock_timestamp())
        WHERE id=$1 AND scope_id=$2 AND kind='approval_preview' RETURNING id`,
        [id, scopeId],
      );
      return { status: changed.rowCount === 1 ? 'ok' : 'denied' };
    });
  }

  private async transaction(operation: (client: PoolClient) => Promise<Result>, mutation = true): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        const result = await operation(client);
        await client.query('COMMIT');
        return result;
      }, mutation);
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }

  async propose(
    context: Context,
    requestId: string,
    change: ProposalChange,
    retained?: KnowledgeContext,
  ): Promise<Result> {
    // Only requestMission may create the host-owned work order and its approval envelope.
    if (
      !uuid.test(requestId) ||
      !validProposalChange(change) ||
      validMissionChange(change) ||
      validTeamChange(change) ||
      validProactiveDispositionChange(change)
    )
      return { status: 'denied' };
    return this.proposal(context, requestId, change, retained);
  }

  async requestMission(context: Context, requestId: string, request: MissionRequest): Promise<Result> {
    if (!uuid.test(requestId) || !validMissionRequest(request) || context.origin) return { status: 'denied' };
    return this.proposal(context, requestId, undefined, undefined, request);
  }
  async requestTeam(context: Context, requestId: string, request: TeamRequest): Promise<Result> {
    if (!uuid.test(requestId) || !validTeamRequest(request) || context.origin) return { status: 'denied' };
    return this.proposal(context, requestId, undefined, undefined, undefined, request);
  }
  async requestProactiveDisposition(
    context: KnowledgeContext,
    requestId: string,
    request: ProactiveDispositionRequest,
  ): Promise<Result> {
    if (!uuid.test(requestId) || !validProactiveDisposition(request) || context.origin) return { status: 'denied' };
    return this.proposal(context, requestId, undefined, context, undefined, undefined, request);
  }

  private async proposal(
    context: Context,
    requestId: string,
    proposed?: ProposalChange,
    retained?: KnowledgeContext,
    mission?: MissionRequest,
    team?: TeamRequest,
    disposition?: ProactiveDispositionRequest,
  ): Promise<Result> {
    const change = proposed;
    const method = disposition
      ? 'cos_proactive_disposition_propose'
      : team
        ? 'cos_team_request'
        : mission
          ? 'cos_mission_request'
          : validSourceChange(change)
            ? 'cos_source_change_propose'
            : validWorkChange(change)
              ? 'cos_work_change_propose'
              : validScheduleChange(change)
                ? 'cos_brief_schedule_propose'
                : 'cos_change_propose';
    const hash = digest(
      disposition
        ? { method, request: disposition, retained }
        : team
          ? { method, request: team }
          : mission
            ? { method, request: mission }
            : validWorkChange(change)
              ? { method, change, retained: retained ?? null }
              : { method, change },
    );
    const result = await this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const inserted = await client.query(
        `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
        VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING request_id`,
        [context.sessionId, requestId, context.scopeId, method, hash],
      );
      if (inserted.rowCount === 0) {
        // Unique insertion waits for the original, even when its commit acknowledgement was lost.
        const existing = (
          await client.query(
            'SELECT scope_id,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
            [context.sessionId, requestId],
          )
        ).rows[0];
        if (existing?.scope_id !== context.scopeId || existing?.payload_hash !== hash) return { status: 'conflict' };
        if (existing.result && !(await this.workReceiptCurrent(client, context, existing.result)))
          return { status: 'denied' };
        return existing.result ?? { status: 'pending', request_id: requestId };
      }
      const change = disposition
        ? await this.proactive.prepareDisposition(client, context, requestId, disposition, retained)
        : team
          ? await this.teams.prepare(client, context, requestId, team)
          : mission
            ? await this.missions.prepare(client, context, requestId, mission)
            : proposed;
      if (
        !change ||
        (validSourceChange(change) &&
          (!this.knowledge || !(await this.knowledge.validateChange(client, context.scopeId, change)))) ||
        (validWorkChange(change) && !(await this.work.validateChange(client, context, change, retained))) ||
        (validProactivePolicyChange(change) && !(await this.proactive.validatePolicyChange(client, context, change)))
      ) {
        const receipt: Result = { status: 'denied' };
        await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
          context.sessionId,
          requestId,
          JSON.stringify(receipt),
        ]);
        return receipt;
      }
      const id = randomUUID();
      const token = randomBytes(24).toString('base64url');
      await client.query(
        `INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at,work_context)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'pending',clock_timestamp()+interval '15 minutes',$9)`,
        [
          id,
          context.scopeId,
          context.sessionId,
          context.ingressId,
          context.ownerId,
          JSON.stringify(change),
          digest(change),
          digest(token),
          (validWorkChange(change) || validProactiveDispositionChange(change)) && retained
            ? JSON.stringify(retained)
            : null,
        ],
      );
      if (validMissionChange(change)) await this.missions.linkProposal(client, context, change, id);
      if (validProactiveDispositionChange(change) && change.mission)
        await this.missions.linkProposal(client, context, change.mission, id);
      if (validTeamChange(change)) await this.teams.linkProposal(client, context, change, id);
      const receipt: Result = {
        status: 'ok',
        proposal_id: id,
        confirmation_token: token,
        change,
        request_id: requestId,
        ...(validMissionChange(change) ? { mission_id: change.mission_id } : {}),
        ...(validTeamChange(change) ? { team_id: change.team_id } : {}),
      };
      await client.query(`INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'approval_preview',$3)`, [
        'preview-' + id,
        context.scopeId,
        JSON.stringify(receipt),
      ]);
      await event(client, context.scopeId, 'proposed', id, {
        ingress_id: context.ingressId,
        owner_id: context.ownerId,
      });
      await client.query('UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2', [
        context.sessionId,
        requestId,
        JSON.stringify(receipt),
      ]);
      return receipt;
    });
    return result.status === 'pending' ? { ...result, request_id: requestId } : result;
  }

  async decide(context: Context, proposalId: string, token: string, decision: 'approve' | 'reject'): Promise<Result> {
    if (!uuid.test(proposalId) || token.length > 100 || !['approve', 'reject'].includes(decision))
      return { status: 'denied' };
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const proposal = (
        await client.query(
          `SELECT *,expires_at <= clock_timestamp() AS expired FROM cos.proposals
        WHERE id=$1 AND scope_id=$2 FOR UPDATE`,
          [proposalId, context.scopeId],
        )
      ).rows[0];
      if (!proposal || proposal.owner_id !== context.ownerId || !equal(proposal.challenge_hash, digest(token)))
        return { status: 'denied' };
      if (
        decision === 'approve' &&
        validTeamChange(proposal.change) &&
        !(await this.teams.validateChange(client, context, proposal.change))
      )
        return { status: 'denied' };
      if (proposal.state !== 'pending') {
        if (proposal.decision_ingress_id !== context.ingressId) return { status: 'denied' };
        const approved = ['approved', 'applied', 'conflict'].includes(proposal.state);
        return approved === (decision === 'approve')
          ? { status: 'ok', proposal_id: proposalId, decision }
          : { status: 'conflict' };
      }
      if (
        decision === 'approve' &&
        validProactiveDispositionChange(proposal.change) &&
        !(await this.proactive.validateDisposition(
          client,
          context,
          proposal.change,
          proposal.work_context ?? undefined,
        ))
      )
        return { status: 'denied' };
      if (proposal.expired) {
        await client.query("UPDATE cos.proposals SET state='expired',updated_at=clock_timestamp() WHERE id=$1", [
          proposalId,
        ]);
        return { status: 'denied' };
      }
      const reused = await client.query('SELECT id FROM cos.proposals WHERE decision_ingress_id=$1', [
        context.ingressId,
      ]);
      if (reused.rowCount) return { status: 'denied' };
      await client.query(
        'UPDATE cos.proposals SET state=$2,decision_ingress_id=$3,updated_at=clock_timestamp() WHERE id=$1',
        [proposalId, decision === 'approve' ? 'approved' : 'rejected', context.ingressId],
      );
      await event(client, context.scopeId, decision, proposalId, {
        owner_id: context.ownerId,
        ingress_id: context.ingressId,
        payload_hash: proposal.payload_hash,
      });
      if (decision === 'approve')
        await client.query(
          `INSERT INTO cos.outbox(id,scope_id,kind,payload) VALUES($1,$2,'proposal_apply',$3) ON CONFLICT DO NOTHING`,
          ['apply-' + proposalId, context.scopeId, JSON.stringify({ proposal_id: proposalId })],
        );
      return { status: 'ok', proposal_id: proposalId, decision };
    });
  }

  /** Trusted outbox consumer only; approval acceptance never applies effects inline. */
  async apply(scopeId: string, proposalId: string): Promise<Result> {
    return this.transaction(async (client) => {
      const scope = await client.query(
        "SELECT id,owner_id,agent_group_id FROM cos.scopes WHERE id=$1 AND status='active' FOR UPDATE",
        [scopeId],
      );
      if (!scope.rowCount) return { status: 'denied' };
      const proposal = (
        await client.query('SELECT * FROM cos.proposals WHERE id=$1 AND scope_id=$2 FOR UPDATE', [proposalId, scopeId])
      ).rows[0];
      if (!proposal || !['approved', 'applied', 'conflict'].includes(proposal.state)) return { status: 'denied' };
      if (proposal.state === 'applied') return { status: 'ok', record_id: proposal.applied_record_id };
      if (proposal.state === 'conflict') return { status: 'conflict' };
      const change = proposal.change as ProposalChange;
      if (!validProposalChange(change) || digest(change) !== proposal.payload_hash) return { status: 'denied' };
      if (
        validWorkChange(change) ||
        validScheduleChange(change) ||
        validMissionChange(change) ||
        validTeamChange(change) ||
        validProactivePolicyChange(change) ||
        validProactiveDispositionChange(change)
      ) {
        const context: Context = {
          scopeId,
          ownerId: scope.rows[0].owner_id,
          agentGroupId: scope.rows[0].agent_group_id,
          sessionId: proposal.session_id,
          ingressId: proposal.ingress_id,
        };
        if (proposal.owner_id !== context.ownerId) return { status: 'denied' };
        const result = validProactiveDispositionChange(change)
          ? await this.proactive.applyDisposition(client, context, proposal, change, proposal.work_context ?? undefined)
          : validProactivePolicyChange(change)
            ? await this.proactive.applyPolicy(client, context, proposal, change)
            : validTeamChange(change)
              ? await this.teams.applyApproved(client, context, proposal, change)
              : validMissionChange(change)
                ? await this.missions.applyApproved(client, context, proposal, change)
                : validScheduleChange(change)
                  ? await this.schedules.applyApproved(client, context, proposal, change)
                  : await this.work.applyApproved(
                      client,
                      context,
                      proposal,
                      change,
                      proposal.work_context ?? undefined,
                    );
        if (!['ok', 'conflict'].includes(result.status)) return result;
        const changed = result.status === 'ok';
        await client.query(
          'UPDATE cos.proposals SET state=$2,applied_record_id=$3,updated_at=clock_timestamp() WHERE id=$1',
          [proposalId, changed ? 'applied' : 'conflict', changed ? result.record_id : null],
        );
        await client.query('UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE id=$1', ['apply-' + proposalId]);
        await event(client, scopeId, changed ? 'applied' : 'conflict', proposalId, {
          owner_id: proposal.owner_id,
          ingress_id: proposal.decision_ingress_id,
        });
        return result;
      }
      if (validSourceChange(change)) {
        if (!this.knowledge) return { status: 'unavailable' };
        const result = await this.knowledge.applyApproved(client, scopeId, proposalId, change);
        if (!['ok', 'conflict'].includes(result.status)) return result;
        const changed = result.status === 'ok';
        await client.query(
          'UPDATE cos.proposals SET state=$2,applied_record_id=$3,updated_at=clock_timestamp() WHERE id=$1',
          [proposalId, changed ? 'applied' : 'conflict', changed ? change.source_id : null],
        );
        await client.query('UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE id=$1', ['apply-' + proposalId]);
        await event(client, scopeId, changed ? 'applied' : 'conflict', proposalId, {
          owner_id: proposal.owner_id,
          ingress_id: proposal.decision_ingress_id,
        });
        return result;
      }
      const recordId = change.record_id ?? randomUUID();
      const provenance = {
        proposal_id: proposalId,
        owner_id: proposal.owner_id,
        ingress_id: proposal.decision_ingress_id,
      };
      let changed = 0;
      if (change.record_id) {
        // The scope lock serializes applies. Treat a competing active charter like
        // a stale version so the proposal and its outbox work settle as a conflict.
        const update = await client.query(
          `UPDATE cos.records SET title=$3,description=$4,lifecycle=$5,version=version+1,
          provenance=$6,updated_at=clock_timestamp() WHERE id=$1 AND scope_id=$2 AND version=$7 AND kind=$8
          AND ($8 <> 'charter' OR $5 <> 'active' OR NOT EXISTS (
            SELECT 1 FROM cos.records other WHERE other.scope_id=$2 AND other.kind='charter'
            AND other.lifecycle='active' AND other.id<>$1
          ))`,
          [
            recordId,
            scopeId,
            change.title,
            change.description,
            change.lifecycle,
            JSON.stringify(provenance),
            change.expected_version,
            change.kind,
          ],
        );
        changed = update.rowCount ?? 0;
      } else {
        const insert = await client.query(
          `INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance)
          VALUES($1,$2,$3,$4,$5,$6,1,$7) ON CONFLICT DO NOTHING`,
          [
            recordId,
            scopeId,
            change.kind,
            change.title,
            change.description,
            change.lifecycle,
            JSON.stringify(provenance),
          ],
        );
        changed = insert.rowCount ?? 0;
      }
      await client.query(
        'UPDATE cos.proposals SET state=$2,applied_record_id=$3,updated_at=clock_timestamp() WHERE id=$1',
        [proposalId, changed ? 'applied' : 'conflict', changed ? recordId : null],
      );
      await client.query('UPDATE cos.outbox SET delivered_at=clock_timestamp() WHERE id=$1', ['apply-' + proposalId]);
      await event(client, scopeId, changed ? 'applied' : 'conflict', proposalId, provenance);
      return changed ? { status: 'ok', record_id: recordId } : { status: 'conflict' };
    });
  }

  async context(context: Context, retained?: KnowledgeContext): Promise<Result> {
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const records = (
        await client.query(
          `SELECT id,kind,title,description,version,provenance FROM cos.records
        WHERE scope_id=$1 AND lifecycle='active' ORDER BY kind,id LIMIT 100`,
          [context.scopeId],
        )
      ).rows;
      const work = await this.work.read(client, context, { view: 'open' }, retained);
      return {
        status: 'ok',
        records,
        work: work.items,
        work_withheld: work.withheld,
        work_next_offset: work.next_offset,
        work_truncated: work.truncated,
        brief_schedules: await this.schedules.read(client, context),
        ranking: 'advice',
        coverage: records.length ? ['approved_records_only'] : ['no_approved_priorities'],
      };
    }, false);
  }

  async readWork(context: Context, input: WorkRead, retained?: KnowledgeContext): Promise<Result> {
    if (!validWorkRead(input)) return { status: 'denied' };
    return this.transaction(
      async (client) =>
        (await authorised(client, context)) ? this.work.read(client, context, input, retained) : { status: 'denied' },
      false,
    );
  }

  async status(context: Context, requestId: string): Promise<Result> {
    if (!uuid.test(requestId)) return { status: 'denied' };
    return this.transaction(async (client) => {
      if (!(await authorised(client, context))) return { status: 'denied' };
      const row = (
        await client.query('SELECT result FROM cos.operations WHERE session_id=$1 AND request_id=$2 AND scope_id=$3', [
          context.sessionId,
          requestId,
          context.scopeId,
        ])
      ).rows[0];
      if (row?.result && !(await this.workReceiptCurrent(client, context, row.result))) return { status: 'denied' };
      return row?.result ?? { status: 'unavailable' };
    }, false);
  }
}
