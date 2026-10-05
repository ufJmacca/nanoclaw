import { digest, type Context, type Result } from '../domain/contracts.js';
import { object } from '../calendar/normalization.js';
import { validWriterBinding } from './binding.js';
import { safeCalendarEventLink } from './event.js';
import { validActionId } from '../contracts/action-protocol.js';
import { ACTION_NOTICE_STATES, type ActionNoticeState, type ActionNotification } from './notification-protocol.js';
import type { ActionStore, StoredAction } from './store.js';

function render(row: StoredAction, state: ActionNoticeState, result: unknown): string | null {
  const request = row.body.request;
  if (state === 'verified') {
    if (
      !object(result) ||
      Object.keys(result).length !== 9 ||
      result.verified !== true ||
      result.deleted !== false ||
      result.event_id !== row.body.eventId ||
      result.calendar_id !== request.calendar_id ||
      result.start !== request.start ||
      result.end !== request.end ||
      result.time_zone !== request.time_zone ||
      typeof result.provider_version_digest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(result.provider_version_digest) ||
      (result.link !== null && safeCalendarEventLink(result.link) !== result.link)
    )
      return null;
  }
  const headings = {
    verified:
      'Calendar block verified. No guests were invited. Cancelling this action does not delete the created event.',
    blocked: 'Calendar action blocked. NanoClaw will not automatically send another create request.',
    failed: 'Calendar action failed. NanoClaw will not automatically send another create request.',
    outcome_uncertain:
      'Calendar creation outcome is uncertain. NanoClaw checks the original event ID without sending another create request. Cancellation does not delete an event already created.',
    cancelled: 'Calendar action cancelled before creation. No event deletion was requested.',
  };
  const details = {
    action_id: row.body.actionId,
    state,
    calendar_id: request.calendar_id,
    start: request.start,
    end: request.end,
    time_zone: request.time_zone,
    event_id: row.body.eventId,
    ...(state === 'verified' ? { link: (result as Record<string, unknown>).link } : {}),
  };
  const json = JSON.stringify(details, null, 2),
    fence = '`'.repeat(Math.max(3, ...[...json.matchAll(/`+/g)].map((match) => match[0].length + 1)));
  return headings[state] + '\n\n' + fence + 'json\n' + json + '\n' + fence;
}
/** Host-only result projection. No title, description, token, source excerpt or historical grant is published. */
export class ActionNotifications {
  constructor(readonly store: ActionStore) {}
  async pending(context: Context, after: string | null = null): Promise<Result> {
    if (context.origin || (after !== null && !validActionId(after))) return { status: 'denied' };
    return this.store.transaction(async (client) => {
      if (!(await this.store.scopeCurrent(client, context)) || !this.store.dependencies?.authority(context))
        return { status: 'denied' };
      const rows = (
        await client.query(
          `SELECT a.id FROM cos.actions a JOIN cos.action_intents i ON i.scope_id=a.scope_id AND i.id=a.id
        WHERE a.scope_id=$1 AND i.body->'context'->>'ownerId'=$2 AND i.body->'context'->>'sessionId'=$3
        AND i.body->'context'->>'agentGroupId'=$4 AND a.state=ANY($5::text[]) AND ($6::text IS NULL OR a.id>$6)
        ORDER BY a.id LIMIT 20`,
          [context.scopeId, context.ownerId, context.sessionId, context.agentGroupId, ACTION_NOTICE_STATES, after],
        )
      ).rows;
      return {
        status: 'ok',
        action_ids: rows.map((row) => row.id),
        next_after: rows.length === 20 ? rows.at(-1)!.id : null,
      };
    });
  }
  async read(context: Context, id: string): Promise<Result> {
    if (context.origin || !validActionId(id)) return { status: 'denied' };
    return this.store.transaction(async (client) => {
      const authority = this.store.dependencies?.authority(context);
      if (!authority || !(await this.store.scopeCurrent(client, context))) return { status: 'denied' };
      const row = await this.store.row(client, context, id);
      if (!row || !ACTION_NOTICE_STATES.includes(row.state as ActionNoticeState)) return { status: 'denied' };
      const revision = row.body.resources.find((resource) => resource.kind === 'writer_binding'),
        binding = (
          await client.query(
            'SELECT body,digest FROM cos.action_writer_revisions WHERE scope_id=$1 AND binding_id=$2 AND version=$3',
            [context.scopeId, row.body.request.binding_id, revision?.version],
          )
        ).rows[0];
      if (
        !binding ||
        !validWriterBinding(binding.body) ||
        digest(binding.body) !== binding.digest ||
        binding.body.bindingDigest !== authority.bindingDigest ||
        binding.body.instanceId !== row.body.destination.instanceId ||
        binding.body.channelId !== row.body.destination.channelId ||
        binding.body.calendarId !== row.body.request.calendar_id ||
        (this.store.knowledge &&
          !(await this.store.knowledge.actionContextCurrent(client, {
            ...context,
            provider: 'codex',
            generation: authority.contextGeneration,
          })))
      )
        return { status: 'denied' };
      const head = (
        await client.query('SELECT state,result FROM cos.actions WHERE scope_id=$1 AND id=$2', [context.scopeId, id])
      ).rows[0];
      if (!head || head.state !== row.state) return { status: 'pending' };
      if (head.state === 'verified') {
        const receipt = (
          await client.query(
            "SELECT body FROM cos.action_receipts WHERE scope_id=$1 AND action_id=$2 AND kind='verified' ORDER BY created_at DESC,id DESC LIMIT 1",
            [context.scopeId, id],
          )
        ).rows[0]?.body;
        if (!object(receipt) || receipt.intentDigest !== row.digest || !Number.isSafeInteger(receipt.fence))
          return { status: 'denied' };
        const { intentDigest: _intent, fence: _fence, ...verified } = receipt;
        if (digest(verified) !== digest(head.result)) return { status: 'denied' };
      }
      const text = render(row, head.state, head.result);
      if (text === null || digest(this.store.dependencies?.authority(context) ?? null) !== digest(authority))
        return { status: 'denied' };
      const notice: ActionNotification = {
        format: 'cos-action-notification/v1',
        scopeId: context.scopeId,
        ownerId: context.ownerId,
        sessionId: context.sessionId,
        agentGroupId: context.agentGroupId,
        instanceId: row.body.destination.instanceId,
        channelId: row.body.destination.channelId,
        actionId: id,
        intentDigest: row.digest,
        state: head.state,
        textDigest: digest(text),
      };
      return { status: 'ok', notice, text };
    });
  }
}
