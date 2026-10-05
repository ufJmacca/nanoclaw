import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { digest, type Context, type Result } from '../domain/contracts.js';
import { validActionId, validActionInstant } from '../contracts/action-protocol.js';
import type { ActionIntent } from './intent.js';
import { actionPreview, availabilityObservationDigest, type ActionStore, type StoredAction } from './store.js';
import { matchesActionEvent, safeCalendarEventLink } from './event.js';
import type { CalendarWriterInspection } from './writer.js';

export type ActionLease = {
  actionId: string;
  owner: string;
  fence: number;
  expiresAt: string;
  mode: 'create' | 'reconcile';
  intent: ActionIntent;
  approvedDigest: string;
  proposalId: string;
  decisionIngressId: string;
};
type Head = {
  state: string;
  lease_owner: string | null;
  fence: number;
  lease_expires_at: Date | null;
  cancel_requested: boolean;
  reconcile_count: number;
  next_reconcile_at: Date | null;
};
const uuid = (value: string) =>
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
export class ActionRunStore {
  constructor(readonly store: ActionStore) {}
  /** Bounded host discovery. Neither an old owner trigger nor a queue row grants a new send. */
  async pending(context: Context, after: string | null = null): Promise<Result> {
    if (context.origin || (after !== null && !validActionId(after))) return { status: 'denied' };
    return this.store.transaction(async (client) => {
      if (!(await this.store.scopeCurrent(client, context)) || !this.store.dependencies?.authority(context))
        return { status: 'denied' };
      const rows = (
        await client.query(
          `SELECT a.id FROM cos.actions a JOIN cos.action_intents i ON i.scope_id=a.scope_id AND i.id=a.id
        WHERE a.scope_id=$1 AND i.body->'context'->>'sessionId'=$2
        AND i.body->'context'->>'ownerId'=$3 AND i.body->'context'->>'agentGroupId'=$4
        AND ($5::text IS NULL OR a.id>$5) AND a.state IN ('queued','executing','outcome_uncertain')
        AND (a.lease_expires_at IS NULL OR a.lease_expires_at<=clock_timestamp())
        AND (a.next_reconcile_at IS NULL OR a.next_reconcile_at<=clock_timestamp()) AND a.reconcile_count<12
        ORDER BY a.id LIMIT 20`,
          [context.scopeId, context.sessionId, context.ownerId, context.agentGroupId, after],
        )
      ).rows;
      return {
        status: 'ok',
        action_ids: rows.map((row) => row.id),
        next_after: rows.length === 20 ? rows.at(-1)!.id : null,
      };
    });
  }
  private async scopeLock(client: PoolClient, context: Context) {
    return (
      !context.origin &&
      (
        await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR UPDATE",
          [context.scopeId, context.ownerId, context.agentGroupId],
        )
      ).rowCount === 1
    );
  }
  private async head(client: PoolClient, context: Context, id: string): Promise<Head | null> {
    return (
      (
        await client.query(
          'SELECT state,lease_owner,fence,lease_expires_at,cancel_requested,reconcile_count,next_reconcile_at FROM cos.actions WHERE scope_id=$1 AND id=$2 FOR UPDATE',
          [context.scopeId, id],
        )
      ).rows[0] ?? null
    );
  }
  private async proposal(client: PoolClient, context: Context, row: StoredAction) {
    const proposal = (
      await client.query(
        'SELECT id,owner_id,change,payload_hash,state,decision_ingress_id FROM cos.proposals WHERE scope_id=$1 AND id=$2 FOR SHARE',
        [context.scopeId, row.proposal_id],
      )
    ).rows[0];
    return proposal &&
      proposal.owner_id === context.ownerId &&
      proposal.state === 'applied' &&
      proposal.decision_ingress_id &&
      digest(proposal.change) === proposal.payload_hash &&
      digest(actionPreview(row.body, row.digest)) === proposal.payload_hash
      ? proposal
      : null;
  }
  private currentLease(head: Head | null, lease: ActionLease, now: Date) {
    return (
      !!head &&
      head.state === 'executing' &&
      head.lease_owner === lease.owner &&
      head.fence === lease.fence &&
      !!head.lease_expires_at &&
      head.lease_expires_at.getTime() > now.getTime() &&
      head.lease_expires_at.toISOString() === lease.expiresAt
    );
  }
  /** Repair lost projections from the independent target journal. Every imported action is GET-only.
   * A historical approval is recorded as expired, never replayed as current authority.
   */
  async recoverWitnesses(context: Context, offset = 0): Promise<Result> {
    const witness = this.store.dependencies?.witness;
    if (!witness || context.origin || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000)
      return { status: 'denied' };
    const { entries, nextOffset } = witness.page(context.scopeId, offset);
    return this.store.transaction(async (client) => {
      if (!(await this.scopeLock(client, context))) return { status: 'denied' };
      const authority = this.store.dependencies?.authority(context);
      if (!authority) return { status: 'denied' };
      const recovered: string[] = [];
      for (const entry of entries) {
        const { intent, approvedDigest, proposalId } = entry;
        if (
          intent.context.ownerId !== context.ownerId ||
          intent.context.sessionId !== context.sessionId ||
          intent.context.agentGroupId !== context.agentGroupId
        )
          return { status: 'denied' };
        const original = (
          await client.query(
            'SELECT body,digest,proposal_id,authority FROM cos.action_intents WHERE scope_id=$1 AND id=$2',
            [context.scopeId, intent.actionId],
          )
        ).rows[0];
        if (
          original &&
          (original.digest !== approvedDigest ||
            digest(original.body) !== approvedDigest ||
            original.proposal_id !== proposalId)
        )
          return { status: 'denied', reason: 'effect_identity_conflict' };
        if (await this.head(client, context, intent.actionId)) continue;
        const row: StoredAction = {
          body: intent,
          digest: approvedDigest,
          authority: original?.authority ?? authority,
          proposal_id: proposalId,
          state: 'outcome_uncertain',
        };
        if (!(await this.store.reconciliationCurrent(client, context, row)))
          return { status: 'denied', reason: 'action_authority_changed' };
        const preview = actionPreview(intent, approvedDigest),
          hash = digest(preview);
        const proposal = (
          await client.query('SELECT scope_id,session_id,owner_id,payload_hash,change FROM cos.proposals WHERE id=$1', [
            proposalId,
          ])
        ).rows[0];
        if (
          proposal &&
          (proposal.scope_id !== context.scopeId ||
            proposal.owner_id !== context.ownerId ||
            proposal.session_id !== context.sessionId ||
            proposal.payload_hash !== hash ||
            digest(proposal.change) !== hash)
        )
          return { status: 'denied', reason: 'effect_identity_conflict' };
        if (!proposal)
          await client.query(
            `INSERT INTO cos.proposals(id,scope_id,session_id,ingress_id,owner_id,change,payload_hash,challenge_hash,state,expires_at,decision_ingress_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,'expired',$9,$10)`,
            [
              proposalId,
              context.scopeId,
              context.sessionId,
              intent.context.ingressId,
              context.ownerId,
              JSON.stringify(preview),
              hash,
              digest({ kind: 'recovery_denial', intent: approvedDigest }),
              intent.expiresAt,
              entry.decisionIngressId,
            ],
          );
        if (!original)
          await client.query(
            `INSERT INTO cos.action_intents(scope_id,id,body,digest,authority,proposal_id,binding_id,calendar_id,event_id,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              context.scopeId,
              intent.actionId,
              JSON.stringify(intent),
              approvedDigest,
              JSON.stringify(authority),
              proposalId,
              intent.request.binding_id,
              intent.request.calendar_id,
              intent.eventId,
              intent.expiresAt,
            ],
          );
        await client.query(
          `INSERT INTO cos.actions(scope_id,id,state,cancel_requested,reason) VALUES($1,$2,'outcome_uncertain',$3,'effect_restored_from_target_witness')`,
          [context.scopeId, intent.actionId, witness.cancelled(intent.actionId)],
        );
        await client.query(
          `INSERT INTO cos.action_request_starts(scope_id,action_id,intent_digest,lease_owner,fence,started_at) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
          [context.scopeId, intent.actionId, approvedDigest, entry.leaseOwner, entry.fence, entry.recordedAt],
        );
        await client.query(
          `INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,'uncertain',$4)`,
          [
            context.scopeId,
            randomUUID(),
            intent.actionId,
            JSON.stringify({
              reason: 'effect_restored_from_target_witness',
              intentDigest: approvedDigest,
              eventId: intent.eventId,
            }),
          ],
        );
        recovered.push(intent.actionId);
      }
      return { status: 'ok', recovered, next_offset: nextOffset };
    }, true);
  }
  async claim(context: Context, id: string, owner: string): Promise<Result> {
    if (!validActionId(id) || !uuid(owner) || context.origin) return { status: 'denied' };
    return this.store.transaction(async (client) => {
      if (!(await this.scopeLock(client, context))) return { status: 'denied' };
      const row = await this.store.row(client, context, id),
        head = await this.head(client, context, id),
        now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      if (!row || !head) return { status: 'denied' };
      const witness = this.store.dependencies?.witness?.find(id),
        started = (
          await client.query('SELECT intent_digest FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2', [
            context.scopeId,
            id,
          ])
        ).rows[0];
      if (['verified', 'blocked', 'failed', 'cancelled'].includes(head.state))
        return { status: 'ok', finished: true, state: head.state };
      if (!['queued', 'executing', 'outcome_uncertain'].includes(head.state) && !witness && !started)
        return { status: 'denied' };
      if (head.lease_expires_at && head.lease_expires_at.getTime() > now.getTime())
        return { status: 'pending', reason: 'action_leased' };
      if (head.reconcile_count >= 12 || (head.next_reconcile_at && head.next_reconcile_at.getTime() > now.getTime()))
        return {
          status: 'pending',
          reason: head.reconcile_count >= 12 ? 'reconciliation_limit' : 'reconciliation_backoff',
        };
      if ((witness && witness.approvedDigest !== row.digest) || (started && started.intent_digest !== row.digest)) {
        await client.query(
          "UPDATE cos.actions SET state='blocked',reason='effect_identity_conflict',lease_owner=NULL,lease_expires_at=NULL WHERE scope_id=$1 AND id=$2",
          [context.scopeId, id],
        );
        return { status: 'denied', reason: 'effect_identity_conflict' };
      }
      const mode = started || witness || head.state !== 'queued' ? 'reconcile' : 'create';
      if (mode === 'create' && (head.cancel_requested || this.store.dependencies?.witness?.cancelled(id)))
        return { status: 'denied', reason: 'action_cancelled' };
      const denyCreate = async (reason: string): Promise<Result> => {
        // Only a never-started queued action can become terminal here. Unknown effects retain readback.
        if (mode === 'create') {
          await client.query(
            "UPDATE cos.actions SET state='blocked',reason=$3,lease_owner=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
            [context.scopeId, id, reason],
          );
          await client.query(
            "INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,'blocked',$4)",
            [
              context.scopeId,
              randomUUID(),
              id,
              JSON.stringify({ reason, fence: head.fence, intentDigest: row.digest, eventId: row.body.eventId }),
            ],
          );
        }
        return { status: 'denied', reason };
      };
      if (
        !(await (mode === 'create'
          ? this.store.current(client, context, row)
          : this.store.reconciliationCurrent(client, context, row)))
      )
        return denyCreate('action_authority_changed');
      const proposal = await this.proposal(client, context, row);
      if (mode === 'create' && (!proposal || Date.parse(row.body.expiresAt) <= now.getTime()))
        return denyCreate('action_approval_not_current');
      if (mode === 'create') {
        // Serialize overlapping host actions even when the provider's check-and-insert is not atomic.
        const competing = await client.query(
          `SELECT a.id FROM cos.actions a JOIN cos.action_intents i ON i.scope_id=a.scope_id AND i.id=a.id
          WHERE a.scope_id=$1 AND a.id<>$2 AND i.calendar_id=$3 AND a.state IN ('executing','outcome_uncertain','verified')
          AND (i.body->'request'->>'start')::timestamptz<$5::timestamptz AND (i.body->'request'->>'end')::timestamptz>$4::timestamptz LIMIT 1`,
          [context.scopeId, id, row.body.request.calendar_id, row.body.request.start, row.body.request.end],
        );
        if (competing.rowCount) return { status: 'pending', reason: 'calendar_action_in_flight' };
      }
      if (witness && !started)
        await client.query(
          'INSERT INTO cos.action_request_starts(scope_id,action_id,intent_digest,lease_owner,fence,started_at) VALUES($1,$2,$3,$4,$5,$6)',
          [context.scopeId, id, row.digest, witness.leaseOwner, witness.fence, witness.recordedAt],
        );
      const changed = (
        await client.query(
          `UPDATE cos.actions SET state='executing',lease_owner=$3,fence=fence+1,
        lease_expires_at=clock_timestamp()+interval '120 seconds',next_reconcile_at=NULL,updated_at=clock_timestamp()
        WHERE scope_id=$1 AND id=$2 RETURNING fence,lease_expires_at`,
          [context.scopeId, id, owner],
        )
      ).rows[0];
      const lease: ActionLease = {
        actionId: id,
        owner,
        fence: changed.fence,
        expiresAt: changed.lease_expires_at.toISOString(),
        mode,
        intent: row.body,
        approvedDigest: row.digest,
        proposalId: row.proposal_id,
        decisionIngressId: proposal?.decision_ingress_id ?? witness?.decisionIngressId ?? 'reconciliation-only',
      };
      return { status: 'ok', lease };
    }, true);
  }
  /** A successful return means COMMIT was acknowledged. An unknown commit never admits a POST. */
  async start(context: Context, lease: ActionLease, inspection: CalendarWriterInspection): Promise<Result> {
    if (lease.mode !== 'create' || !validActionId(lease.actionId) || !uuid(lease.owner)) return { status: 'denied' };
    return this.store.transaction(async (client) => {
      if (!(await this.scopeLock(client, context))) return { status: 'denied' };
      const row = await this.store.row(client, context, lease.actionId),
        head = await this.head(client, context, lease.actionId),
        now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      if (
        !row ||
        row.digest !== lease.approvedDigest ||
        !this.currentLease(head, lease, now) ||
        head!.cancel_requested ||
        Date.parse(row.body.expiresAt) <= now.getTime() ||
        !(await this.proposal(client, context, row)) ||
        !(await this.store.current(client, context, row))
      )
        return { status: 'denied' };
      const binding = await this.store.binding(client, context, row.body.request.binding_id);
      if (
        !binding ||
        inspection.complete !== true ||
        inspection.calendarId !== row.body.request.calendar_id ||
        inspection.busy.length ||
        inspection.generation !== binding.body.credentialGeneration ||
        inspection.accountFingerprint !== binding.body.accountFingerprint ||
        !validActionInstant(inspection.observedAt) ||
        Date.parse(inspection.observedAt) < now.getTime() - 10000 ||
        Date.parse(inspection.observedAt) > now.getTime() + 2000 ||
        row.body.resources.find((resource) => resource.kind === 'availability')?.digest !==
          availabilityObservationDigest(inspection)
      )
        return { status: 'denied', reason: 'action_observations_changed' };
      if (
        this.store.dependencies?.witness?.find(lease.actionId) ||
        this.store.dependencies?.witness?.cancelled(lease.actionId)
      )
        return { status: 'denied', reason: 'action_already_fenced' };
      const inserted = await client.query(
        'INSERT INTO cos.action_request_starts(scope_id,action_id,intent_digest,lease_owner,fence) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING action_id',
        [context.scopeId, lease.actionId, row.digest, lease.owner, lease.fence],
      );
      return inserted.rowCount === 1
        ? { status: 'ok', request_started: true }
        : { status: 'pending', reason: 'action_already_started' };
    }, true);
  }
  async settle(
    context: Context,
    lease: ActionLease,
    kind: 'blocked' | 'failed' | 'uncertain' | 'missing' | 'mismatch',
    reason: string,
  ): Promise<Result> {
    return this.store.transaction(async (client) => {
      if (!(await this.scopeLock(client, context))) return { status: 'denied' };
      const head = await this.head(client, context, lease.actionId),
        now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      if (!this.currentLease(head, lease, now)) return { status: 'pending', reason: 'action_lease_lost' };
      const uncertain = ['uncertain', 'missing'].includes(kind),
        state = uncertain ? 'outcome_uncertain' : kind === 'failed' ? 'failed' : 'blocked';
      const count = uncertain ? Math.min(12, head!.reconcile_count + 1) : head!.reconcile_count;
      const delay = Math.min(300, 5 * 2 ** Math.min(count, 6));
      await client.query(
        `UPDATE cos.actions SET state=$3,reason=$4,lease_owner=NULL,lease_expires_at=NULL,reconcile_count=$5,
        next_reconcile_at=CASE WHEN $6 THEN clock_timestamp()+$7::int*interval '1 second' ELSE NULL END,updated_at=clock_timestamp()
        WHERE scope_id=$1 AND id=$2`,
        [context.scopeId, lease.actionId, state, reason, count, uncertain && count < 12, delay],
      );
      await client.query('INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,$4,$5)', [
        context.scopeId,
        randomUUID(),
        lease.actionId,
        kind,
        JSON.stringify({
          reason,
          fence: lease.fence,
          intentDigest: lease.approvedDigest,
          eventId: lease.intent.eventId,
        }),
      ]);
      return { status: 'ok', action_id: lease.actionId, state, reason, event_id: lease.intent.eventId };
    }, true);
  }
  async complete(context: Context, lease: ActionLease, raw: unknown): Promise<Result> {
    if (!matchesActionEvent(lease.intent, lease.approvedDigest, lease.intent.request.calendar_id, raw))
      return this.settle(
        context,
        lease,
        raw === null ? 'missing' : 'mismatch',
        raw === null ? 'event_unresolved' : 'event_semantics_mismatch',
      );
    return this.store.transaction(async (client) => {
      if (!(await this.scopeLock(client, context))) return { status: 'denied' };
      const row = await this.store.row(client, context, lease.actionId),
        head = await this.head(client, context, lease.actionId),
        now = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      if (
        !row ||
        row.digest !== lease.approvedDigest ||
        !this.currentLease(head, lease, now) ||
        !(
          await client.query(
            'SELECT 1 FROM cos.action_request_starts WHERE scope_id=$1 AND action_id=$2 AND intent_digest=$3',
            [context.scopeId, lease.actionId, row.digest],
          )
        ).rowCount
      )
        return { status: 'pending', reason: 'action_lease_lost' };
      const event = raw as Record<string, unknown>,
        result = {
          event_id: row.body.eventId,
          calendar_id: row.body.request.calendar_id,
          start: row.body.request.start,
          end: row.body.request.end,
          time_zone: row.body.request.time_zone,
          link: safeCalendarEventLink(event.htmlLink),
          provider_version_digest: digest(event.etag),
          verified: true,
          deleted: false,
        };
      await client.query(
        "UPDATE cos.actions SET state='verified',result=$3,reason=NULL,lease_owner=NULL,lease_expires_at=NULL,next_reconcile_at=NULL,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2",
        [context.scopeId, lease.actionId, JSON.stringify(result)],
      );
      await client.query(
        "INSERT INTO cos.action_receipts(scope_id,id,action_id,kind,body) VALUES($1,$2,$3,'verified',$4)",
        [
          context.scopeId,
          randomUUID(),
          lease.actionId,
          JSON.stringify({ intentDigest: row.digest, fence: lease.fence, ...result }),
        ],
      );
      return { status: 'ok', action_id: lease.actionId, state: 'verified', result };
    }, true);
  }
}
