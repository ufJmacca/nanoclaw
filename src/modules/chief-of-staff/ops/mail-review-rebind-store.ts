import type { PoolClient } from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { validMailDraftBinding } from '../mail-drafts/binding.js';
import type { MailReviewPolicyHead } from '../mail-drafts/journal.js';
import { parseMailReviewHostProfile, type MailReviewHostProfile } from '../automation/mail-review-profile.js';
import { mailReviewSchedulePolicy } from '../automation/mail-review-policy.js';
import { parseMailReviewRebindManifest, planMailReviewRebind } from './mail-review-rebind-plan.js';

const limits = { max_turns: 3, max_tool_calls: 16, deadline_seconds: 300, refresh_seconds: 30 };
const staticSchedule = (row: Record<string, unknown>) =>
  Object.fromEntries(
    [
      'id',
      'version',
      'owner_id',
      'session_id',
      'agent_group_id',
      'title',
      'policy',
      'limits',
      'provenance',
      'purpose',
      'mail_review_policy_id',
      'mail_review_policy_version',
      'mail_review_slot',
    ].map((key) => [key, row[key]]),
  );
function need(value: unknown, code: string): asserts value {
  if (!value) throw Error('mail_review_rebind_' + code);
}

/** Migration-role SQL only. The publisher separately verifies fresh consent, retained context,
 * recovery and the real independent pin. A SQL acknowledgement never publishes host authority. */
export async function writeMailReviewReboundPolicy(
  client: Pick<PoolClient, 'query'>,
  binding: CosBinding,
  previous: MailReviewHostProfile,
  manifest: unknown,
  previousHead: MailReviewPolicyHead,
  requestId: string,
  ready: () => Promise<void>,
): Promise<void> {
  const inputs = { binding, previous, manifest, previousHead, requestId },
    original = digest(inputs);
  binding = structuredClone(binding);
  previous = parseMailReviewHostProfile(previous);
  const parsed = parseMailReviewRebindManifest(manifest),
    profile = parsed.profile;
  planMailReviewRebind({
    binding,
    previous,
    manifest: parsed,
    previousHead,
    requestId,
    currentGeneration: profile.binding.contextGeneration,
  });
  previousHead = structuredClone(previousHead);
  const check = async () => {
    need(digest(inputs) === original, 'inputs_changed');
    await ready();
    need(digest(inputs) === original, 'inputs_changed');
  };
  const ownerConfig = digest({
    format: 'cos-mail-review-rebind-owner-config/v1',
    requestId,
    previousProfileDigest: digest(previous),
    profileDigest: digest(profile),
    previousPinDigest: digest(previousHead),
  });
  const state = previousHead.enabled ? 'enabled' : 'disabled';
  await check();
  await client.query('BEGIN');
  let transaction = true;
  try {
    need((await client.query('SELECT pg_try_advisory_xact_lock(73101021) AS locked')).rows[0]?.locked, 'busy');
    need(
      (
        await client.query(
          "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND instance_id=$4 AND channel_id=$5 AND status IN ('active','paused') FOR UPDATE",
          [binding.scopeId, binding.ownerId, binding.agentGroupId, binding.instanceId, binding.channelId],
        )
      ).rowCount === 1,
      'scope_changed',
    );
    const body = profile.binding;
    const writer = (
      await client.query(
        `SELECT w.owner_id,w.session_id,w.reader_binding_id,w.version,w.state,r.body,r.digest,r.consent_ref,
      mb.provider,mb.mailbox_email,mb.auth,mb.permission_scopes,mb.processing_providers
      FROM cos.mail_draft_writer_bindings w JOIN cos.mail_draft_writer_revisions r ON r.scope_id=w.scope_id AND r.binding_id=w.id AND r.version=w.version
      JOIN cos.mail_bindings mb ON mb.scope_id=w.scope_id AND mb.id=w.reader_binding_id
      WHERE w.scope_id=$1 AND w.id=$2 FOR UPDATE OF w,mb`,
        [binding.scopeId, body.writerBindingId],
      )
    ).rows[0];
    need(
      writer &&
        writer.owner_id === binding.ownerId &&
        writer.session_id === binding.sessionId &&
        writer.reader_binding_id === body.readerBindingId &&
        writer.state === 'enabled' &&
        writer.version === body.writerVersion &&
        writer.digest === body.writerDigest &&
        writer.consent_ref === body.writerConsentRef &&
        validMailDraftBinding(writer.body) &&
        digest(writer.body) === writer.digest &&
        writer.body.provider === 'google' &&
        writer.provider === 'google' &&
        writer.auth === 'ready' &&
        writer.body.readerBindingId === body.readerBindingId &&
        writer.body.nativeBindingDigest === body.nativeBindingDigest &&
        writer.body.journalGeneration === profile.journalGeneration &&
        writer.body.mailboxDigest === body.mailboxDigest &&
        body.mailboxDigest === digest(String(writer.mailbox_email).toLowerCase()) &&
        digest(writer.permission_scopes) === digest([GOOGLE_MAIL_READ_SCOPE]) &&
        digest(writer.processing_providers) === digest(['codex']),
      'writer_changed',
    );
    await check();
    const policy = (
      await client.query('SELECT * FROM cos.mail_review_policies WHERE scope_id=$1 AND id=$2 FOR UPDATE', [
        binding.scopeId,
        profile.id,
      ])
    ).rows[0];
    need(
      policy &&
        policy.owner_id === binding.ownerId &&
        policy.session_id === binding.sessionId &&
        policy.agent_group_id === binding.agentGroupId &&
        [previous.version, profile.version].includes(policy.version) &&
        (policy.version === profile.version
          ? policy.state === state
          : previousHead.enabled
            ? policy.state === 'enabled'
            : ['enabled', 'disabled'].includes(policy.state)),
      'policy_changed',
    );
    const replay = policy.version === profile.version;
    const revision = async (value: MailReviewHostProfile, expectedOwnerConfig?: string) => {
      const row = (
        await client.query(
          'SELECT * FROM cos.mail_review_policy_revisions WHERE scope_id=$1 AND binding_id=$2 AND version=$3',
          [binding.scopeId, profile.id, value.version],
        )
      ).rows[0];
      need(
        row &&
          row.reader_binding_id === value.binding.readerBindingId &&
          row.writer_binding_id === value.binding.writerBindingId &&
          row.writer_version === value.binding.writerVersion &&
          row.digest === digest(value.binding) &&
          digest(row.body) === digest(value.binding) &&
          (expectedOwnerConfig
            ? row.owner_config_ref === expectedOwnerConfig
            : /^[a-f0-9]{64}$/.test(row.owner_config_ref)),
        'policy_changed',
      );
      return row;
    };
    const oldRevision = await revision(previous);
    if (replay) await revision(profile, ownerConfig);
    need(
      (
        await client.query(
          `SELECT id FROM cos.brief_runs WHERE scope_id=$1 AND schedule_id=ANY($2::uuid[])
      AND state NOT IN ('delivered','failed','cancelled') LIMIT 1 FOR UPDATE`,
          [binding.scopeId, [body.morningScheduleId, body.afternoonScheduleId]],
        )
      ).rowCount === 0,
      'run_unsettled',
    );
    const schedules: Array<{ id: string; version: number; slot: 'morning' | 'afternoon' }> = [];
    for (const slot of ['morning', 'afternoon'] as const) {
      const id = slot === 'morning' ? body.morningScheduleId : body.afternoonScheduleId;
      const row = (
        await client.query('SELECT * FROM cos.brief_schedules WHERE scope_id=$1 AND id=$2 FOR UPDATE', [
          binding.scopeId,
          id,
        ])
      ).rows[0];
      const version = replay ? profile.version : previous.version;
      const enabled = replay ? previousHead.enabled : row?.policy?.state === 'active';
      need(
        row && (replay || !previousHead.enabled || enabled) && ['active', 'paused'].includes(row.policy?.state),
        'schedule_changed',
      );
      const expected = {
        id,
        version,
        owner_id: binding.ownerId,
        session_id: binding.sessionId,
        agent_group_id: binding.agentGroupId,
        title: slot === 'morning' ? 'Morning mail review' : 'Afternoon mail review',
        policy: mailReviewSchedulePolicy(slot, enabled ? 'active' : 'paused'),
        limits,
        provenance: {
          format: 'cos-mail-review-schedule/v1',
          owner_config_ref: replay ? ownerConfig : oldRevision.owner_config_ref,
        },
        purpose: 'mail_review',
        mail_review_policy_id: profile.id,
        mail_review_policy_version: version,
        mail_review_slot: slot,
      };
      need(digest(staticSchedule(row)) === digest(expected), 'schedule_changed');
      const stored = (
        await client.query(
          'SELECT * FROM cos.brief_schedule_revisions WHERE scope_id=$1 AND schedule_id=$2 AND version=$3',
          [binding.scopeId, id, version],
        )
      ).rows[0];
      need(
        stored &&
          stored.proposal_id === null &&
          stored.mail_review_policy_id === profile.id &&
          stored.mail_review_policy_version === version &&
          stored.body &&
          digest(staticSchedule(stored.body)) === digest(expected) &&
          new Date(stored.body.activated_at).toISOString() === row.activated_at.toISOString(),
        'schedule_changed',
      );
      schedules.push({ id, version, slot });
    }
    await check();
    if (!replay) {
      const activation = (await client.query('SELECT clock_timestamp() AS activation')).rows[0]?.activation;
      need(activation instanceof Date && Number.isFinite(activation.getTime()), 'activation_unverified');
      await client.query(
        `INSERT INTO cos.mail_review_policy_revisions(scope_id,binding_id,version,reader_binding_id,writer_binding_id,writer_version,body,digest,owner_config_ref)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          binding.scopeId,
          profile.id,
          profile.version,
          body.readerBindingId,
          body.writerBindingId,
          body.writerVersion,
          JSON.stringify(body),
          digest(body),
          ownerConfig,
        ],
      );
      need(
        (
          await client.query(
            'UPDATE cos.mail_review_policies SET version=$3,state=$4,updated_at=$5 WHERE scope_id=$1 AND id=$2 AND version=$6',
            [binding.scopeId, profile.id, profile.version, state, activation, previous.version],
          )
        ).rowCount === 1,
        'policy_changed',
      );
      for (const schedule of schedules) {
        need(
          (
            await client.query(
              `UPDATE cos.brief_schedules SET version=$3,policy=$4,provenance=$5,mail_review_policy_version=$3,activated_at=$6,updated_at=$6
          WHERE scope_id=$1 AND id=$2 AND version=$7`,
              [
                binding.scopeId,
                schedule.id,
                profile.version,
                JSON.stringify(mailReviewSchedulePolicy(schedule.slot, previousHead.enabled ? 'active' : 'paused')),
                JSON.stringify({ format: 'cos-mail-review-schedule/v1', owner_config_ref: ownerConfig }),
                activation,
                schedule.version,
              ],
            )
          ).rowCount === 1,
          'schedule_changed',
        );
        await client.query(
          `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
          SELECT scope_id,id,version,to_jsonb(s),NULL,mail_review_policy_id,mail_review_policy_version FROM cos.brief_schedules s WHERE scope_id=$1 AND id=$2`,
          [binding.scopeId, schedule.id],
        );
      }
    }
    await check();
    await client.query('COMMIT');
    transaction = false;
    await check();
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
  }
}
