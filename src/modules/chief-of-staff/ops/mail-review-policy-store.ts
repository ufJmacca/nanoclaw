import type { PoolClient } from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { validMailDraftBinding } from '../mail-drafts/binding.js';
import { parseMailReviewHostProfile, type MailReviewHostProfile } from '../automation/mail-review-profile.js';
import { mailReviewSchedulePolicy } from '../automation/mail-review-policy.js';

/** SQL metadata only. Caller owns fresh paused/native/migration authority and current reader,
 * writer consent, independent journal and recovery checks. No SQL row publishes a host profile. */
export async function writeMailReviewStandingPolicy(
  client: Pick<PoolClient, 'query'>,
  binding: CosBinding,
  profile: MailReviewHostProfile,
  ready: () => Promise<void>,
): Promise<void> {
  const inputs = { binding, profile },
    original = digest(inputs);
  binding = structuredClone(binding);
  profile = parseMailReviewHostProfile(profile);
  if (
    binding.provider !== 'codex' ||
    profile.version !== 1 ||
    profile.scopeId !== binding.scopeId ||
    profile.ownerId !== binding.ownerId ||
    profile.sessionId !== binding.sessionId ||
    profile.agentGroupId !== binding.agentGroupId ||
    profile.binding.nativeBindingDigest !== digest(binding)
  )
    throw Error('mail_review_policy_owner_changed');
  const check = async () => {
    if (digest(inputs) !== original) throw Error('mail_review_policy_inputs_changed');
    await ready();
    if (digest(inputs) !== original) throw Error('mail_review_policy_inputs_changed');
  };
  const body = profile.binding,
    ownerConfig = digest({ format: 'cos-mail-review-owner-config/v1', profileDigest: digest(profile) });
  await check();
  await client.query('BEGIN');
  let transaction = true;
  try {
    if (!(await client.query('SELECT pg_try_advisory_xact_lock(73101021) AS locked')).rows[0]?.locked)
      throw Error('mail_review_policy_busy');
    const scope = await client.query(
      "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND instance_id=$4 AND channel_id=$5 AND status IN ('active','paused') FOR UPDATE",
      [binding.scopeId, binding.ownerId, binding.agentGroupId, binding.instanceId, binding.channelId],
    );
    if (scope.rowCount !== 1) throw Error('mail_review_policy_scope_changed');
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
    if (
      !writer ||
      writer.owner_id !== binding.ownerId ||
      writer.session_id !== binding.sessionId ||
      writer.reader_binding_id !== body.readerBindingId ||
      writer.state !== 'enabled' ||
      writer.version !== body.writerVersion ||
      writer.digest !== body.writerDigest ||
      writer.consent_ref !== body.writerConsentRef ||
      !validMailDraftBinding(writer.body) ||
      digest(writer.body) !== writer.digest ||
      writer.body.provider !== 'google' ||
      writer.provider !== 'google' ||
      writer.auth !== 'ready' ||
      writer.body.readerBindingId !== body.readerBindingId ||
      writer.body.nativeBindingDigest !== body.nativeBindingDigest ||
      writer.body.journalGeneration !== profile.journalGeneration ||
      writer.body.mailboxDigest !== body.mailboxDigest ||
      body.mailboxDigest !== digest(String(writer.mailbox_email).toLowerCase()) ||
      digest(writer.permission_scopes) !== digest([GOOGLE_MAIL_READ_SCOPE]) ||
      digest(writer.processing_providers) !== digest(['codex'])
    )
      throw Error('mail_review_policy_writer_changed');
    const existing = (
      await client.query(
        `SELECT p.owner_id,p.session_id,p.agent_group_id,p.version,p.state,r.body,r.digest,r.owner_config_ref
      FROM cos.mail_review_policies p LEFT JOIN cos.mail_review_policy_revisions r ON r.scope_id=p.scope_id AND r.binding_id=p.id AND r.version=p.version
      WHERE p.scope_id=$1 AND p.id=$2 FOR UPDATE OF p`,
        [binding.scopeId, profile.id],
      )
    ).rows[0];
    if (existing) {
      if (
        existing.owner_id !== binding.ownerId ||
        existing.session_id !== binding.sessionId ||
        existing.agent_group_id !== binding.agentGroupId ||
        existing.version !== profile.version ||
        existing.state !== 'enabled' ||
        existing.digest !== digest(body) ||
        digest(existing.body) !== digest(body) ||
        existing.owner_config_ref !== ownerConfig
      )
        throw Error('mail_review_policy_revision_changed');
    } else {
      await client.query(
        "INSERT INTO cos.mail_review_policies(scope_id,id,owner_id,session_id,agent_group_id,version,state) VALUES($1,$2,$3,$4,$5,1,'enabled')",
        [binding.scopeId, profile.id, binding.ownerId, binding.sessionId, binding.agentGroupId],
      );
      await client.query(
        `INSERT INTO cos.mail_review_policy_revisions(scope_id,binding_id,version,reader_binding_id,writer_binding_id,writer_version,body,digest,owner_config_ref)
        VALUES($1,$2,1,$3,$4,$5,$6,$7,$8)`,
        [
          binding.scopeId,
          profile.id,
          body.readerBindingId,
          body.writerBindingId,
          body.writerVersion,
          JSON.stringify(body),
          digest(body),
          ownerConfig,
        ],
      );
    }
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
    for (const slot of ['morning', 'afternoon'] as const) {
      const id = slot === 'morning' ? body.morningScheduleId : body.afternoonScheduleId,
        policy = mailReviewSchedulePolicy(slot),
        title = slot === 'morning' ? 'Morning mail review' : 'Afternoon mail review',
        provenance = { format: 'cos-mail-review-schedule/v1', owner_config_ref: ownerConfig };
      let row = (
        await client.query('SELECT * FROM cos.brief_schedules WHERE scope_id=$1 AND id=$2 FOR UPDATE', [
          binding.scopeId,
          id,
        ])
      ).rows[0];
      const expected = {
        id,
        version: 1,
        owner_id: binding.ownerId,
        session_id: binding.sessionId,
        agent_group_id: binding.agentGroupId,
        title,
        policy,
        limits,
        provenance,
        purpose: 'mail_review',
        mail_review_policy_id: profile.id,
        mail_review_policy_version: profile.version,
        mail_review_slot: slot,
      };
      if (row) {
        if (digest(staticSchedule(row)) !== digest(expected)) throw Error('mail_review_policy_schedule_changed');
      } else
        row = (
          await client.query(
            `INSERT INTO cos.brief_schedules(scope_id,id,owner_id,session_id,agent_group_id,title,policy,limits,version,provenance,purpose,mail_review_policy_id,mail_review_policy_version,mail_review_slot)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,$9,'mail_review',$10,1,$11) RETURNING *`,
            [
              binding.scopeId,
              id,
              binding.ownerId,
              binding.sessionId,
              binding.agentGroupId,
              title,
              JSON.stringify(policy),
              JSON.stringify(limits),
              JSON.stringify(provenance),
              profile.id,
              slot,
            ],
          )
        ).rows[0];
      const revision = (
        await client.query(
          'SELECT body,proposal_id,mail_review_policy_id,mail_review_policy_version FROM cos.brief_schedule_revisions WHERE scope_id=$1 AND schedule_id=$2 AND version=1',
          [binding.scopeId, id],
        )
      ).rows[0];
      if (revision) {
        if (
          revision.proposal_id !== null ||
          revision.mail_review_policy_id !== profile.id ||
          revision.mail_review_policy_version !== profile.version ||
          !revision.body ||
          digest(staticSchedule(revision.body)) !== digest(expected)
        )
          throw Error('mail_review_policy_schedule_revision_changed');
      } else
        await client.query(
          `INSERT INTO cos.brief_schedule_revisions(scope_id,schedule_id,version,body,proposal_id,mail_review_policy_id,mail_review_policy_version)
        VALUES($1,$2,1,$3,NULL,$4,1)`,
          [binding.scopeId, id, JSON.stringify(row), profile.id],
        );
    }
    await check();
    await client.query('COMMIT');
    transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
  }
}
