import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { validMandateChange, type MandateChange, type MandateDefinition } from '../contracts/mandate-protocol.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import type { MissionAuthority, MissionAuthorityResolver } from '../missions/proposal-store.js';
import { RESEARCH_TEMPLATE } from '../missions/work-order.js';
import { hasCalendarReadScope } from '../calendar/reader.js';

export type MandateRevisionBody = {
  format: 'cos-standing-mandate/v1';
  action: MandateChange['action'];
  definition: MandateDefinition;
  origin: Context;
  authority: MissionAuthority;
  decision_ingress_id: string;
};

/** Only a verified owner proposal grants standing authority. This store never accepts model trigger calls. */
export class MandateStore {
  constructor(
    readonly knowledge?: KnowledgeStore,
    readonly authority?: MissionAuthorityResolver,
  ) {}
  private async current(client: PoolClient, context: Context, id: string) {
    return (
      await client.query(
        `SELECT m.*,r.body,r.digest,r.proposal_id FROM cos.mandates m JOIN cos.mandate_revisions r
       ON r.scope_id=m.scope_id AND r.mandate_id=m.id AND r.version=m.version
       WHERE m.scope_id=$1 AND m.id=$2 AND m.owner_id=$3 AND m.session_id=$4 FOR UPDATE OF m`,
        [context.scopeId, id, context.ownerId, context.sessionId],
      )
    ).rows[0];
  }
  private async sourcesCurrent(
    client: PoolClient,
    context: Context,
    definition: MandateDefinition,
    authority: MissionAuthority,
  ): Promise<boolean> {
    if (!this.knowledge || !this.knowledge.retrievalEnabled()) return false;
    if (
      !(await this.knowledge.missionCalendarBindingCurrent(
        client,
        { ...context, provider: 'codex', generation: authority.contextGeneration },
        definition.calendar.binding_id,
      ))
    )
      return false;
    const binding = (
      await client.query(
        "SELECT selected_calendar_ids,permission_scopes,processing_providers FROM cos.calendar_bindings WHERE scope_id=$1 AND id=$2 AND auth='ready' FOR SHARE",
        [context.scopeId, definition.calendar.binding_id],
      )
    ).rows[0];
    if (
      !binding ||
      !hasCalendarReadScope(binding.permission_scopes) ||
      !binding.processing_providers.includes('codex') ||
      !definition.calendar.calendar_ids.every((id) => binding.selected_calendar_ids.includes(id))
    )
      return false;
    const template = (
      await client.query(
        'SELECT body,digest,reviewed_by FROM cos.mission_template_versions WHERE scope_id=$1 AND id=$2 AND version=$3',
        [context.scopeId, RESEARCH_TEMPLATE.id, RESEARCH_TEMPLATE.version],
      )
    ).rows[0];
    if (
      !template?.reviewed_by ||
      template.digest !== digest(RESEARCH_TEMPLATE) ||
      digest(template.body) !== template.digest
    )
      return false;
    for (const kind of ['goal', 'project'] as const) {
      const id = definition[`${kind}_id`];
      if (
        id &&
        !(
          await client.query(
            "SELECT 1 FROM cos.records WHERE scope_id=$1 AND id=$2 AND kind=$3 AND lifecycle='active' FOR SHARE",
            [context.scopeId, id, kind],
          )
        ).rowCount
      )
        return false;
    }
    if (definition.trigger.kind === 'commitment_due') {
      const selected = await client.query(
        "SELECT id FROM cos.work_items WHERE scope_id=$1 AND id=ANY($2) AND kind='commitment'",
        [context.scopeId, definition.trigger.commitment_ids],
      );
      if (selected.rowCount !== definition.trigger.commitment_ids.length) return false;
    }
    const rows = (
      await client.query(
        'SELECT id AS source_id,current_revision_id AS revision_id FROM cos.sources WHERE scope_id=$1 AND id=ANY($2)',
        [context.scopeId, definition.source_ids],
      )
    ).rows;
    if (rows.length !== definition.source_ids.length || rows.some((row) => !row.revision_id)) return false;
    return !!(await this.knowledge.captureMissionSources(
      client,
      { ...context, provider: 'codex', generation: authority.contextGeneration },
      rows,
      definition.limits.context_bytes,
    ));
  }
  async validateChange(client: PoolClient, context: Context, change: MandateChange): Promise<boolean> {
    if (!validMandateChange(change) || context.origin) return false;
    if (change.mandate_id) {
      const old = await this.current(client, context, change.mandate_id);
      if (!old || old.version !== change.expected_version || old.state === 'revoked' || digest(old.body) !== old.digest)
        return false;
      if (
        ['pause', 'resume', 'revoke'].includes(change.action) &&
        digest(change.definition) !== digest(old.body.definition)
      )
        return false;
      if (change.action === 'pause' || change.action === 'revoke') return true;
      if (change.action === 'resume' && !['paused', 'suspended'].includes(old.state)) return false;
    }
    const authority = this.authority?.(context);
    if (!authority) return false;
    const clock = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
    if (Date.parse(change.definition.review_at) <= clock || Date.parse(change.definition.expires_at) <= clock)
      return false;
    return (
      (await this.sourcesCurrent(client, context, change.definition, authority)) &&
      digest(this.authority?.(context) ?? null) === digest(authority)
    );
  }
  async applyApproved(
    client: PoolClient,
    context: Context,
    proposal: { id: string; owner_id: string; decision_ingress_id: string },
    change: MandateChange,
  ): Promise<Result> {
    if (!proposal.decision_ingress_id || proposal.owner_id !== context.ownerId || !validMandateChange(change))
      return { status: 'denied' };
    if (change.mandate_id) {
      const old = await this.current(client, context, change.mandate_id);
      if (!old || old.version !== change.expected_version) return { status: 'conflict' };
    }
    if (!(await this.validateChange(client, context, change))) return { status: 'denied' };
    const id = change.mandate_id ?? 'mandate-' + digest({ scopeId: context.scopeId, proposalId: proposal.id });
    const version = change.expected_version + 1;
    const old = change.mandate_id ? await this.current(client, context, id) : null;
    const state = change.action === 'revoke' ? 'revoked' : change.action === 'pause' ? 'paused' : 'active';
    const authority =
      change.action === 'pause' || change.action === 'revoke' ? old.body.authority : this.authority?.(context);
    if (!authority) return { status: 'denied' };
    const body: MandateRevisionBody = {
      format: 'cos-standing-mandate/v1',
      action: change.action,
      definition: structuredClone(change.definition),
      origin: { ...context },
      authority,
      decision_ingress_id: proposal.decision_ingress_id,
    };
    if (!old)
      await client.query(
        'INSERT INTO cos.mandates(scope_id,id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,$5,$6)',
        [context.scopeId, id, context.ownerId, context.sessionId, version, state],
      );
    else
      await client.query(
        'UPDATE cos.mandates SET version=$3,state=$4,suspension_reason=NULL,last_local_date=NULL,activated_at=clock_timestamp(),updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
        [context.scopeId, id, version, state],
      );
    await client.query(
      'INSERT INTO cos.mandate_revisions(scope_id,mandate_id,version,body,digest,proposal_id) VALUES($1,$2,$3,$4,$5,$6)',
      [context.scopeId, id, version, JSON.stringify(body), digest(body), proposal.id],
    );
    await client.query(
      'INSERT INTO cos.mandate_activity(scope_id,id,mandate_id,revision,body) VALUES($1,$2,$3,$4,$5)',
      [
        context.scopeId,
        randomUUID(),
        id,
        version,
        JSON.stringify({
          kind: 'owner_decision',
          action: change.action,
          proposal_id: proposal.id,
          decision_ingress_id: proposal.decision_ingress_id,
        }),
      ],
    );
    await client.query(
      "UPDATE cos.mandate_native_bindings SET state='paused',updated_at=clock_timestamp() WHERE scope_id=$1 AND mandate_id=$2",
      [context.scopeId, id],
    );
    return { status: 'ok', record_id: id };
  }
}
