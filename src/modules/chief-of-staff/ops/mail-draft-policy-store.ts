import type pg from 'pg';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { parseMailDraftHostGrant, type MailDraftHostGrant } from '../mail-drafts/profile.js';
import type { MailDraftAccountConsent } from './mail-draft-consent.js';

/** SQL metadata only. Caller owns a verified migration connection, current paused
 * owner/credential/recovery checks and separate host-profile publication. No policy
 * row, including a committed row after a lost acknowledgement, grants host access. */
export async function writeMailDraftStandingPolicy(
  client: pg.Client,
  binding: CosBinding,
  grant: MailDraftHostGrant,
  consent: MailDraftAccountConsent,
  ready: () => Promise<void>,
): Promise<void> {
  const inputs = { binding, grant, consent },
    original = digest(inputs);
  binding = structuredClone(binding);
  grant = parseMailDraftHostGrant(grant);
  consent = structuredClone(consent);
  if (
    binding.provider !== 'codex' ||
    grant.version !== 1 ||
    grant.binding.provider !== 'google' ||
    grant.scopeId !== binding.scopeId ||
    grant.ownerId !== binding.ownerId ||
    grant.agentGroupId !== binding.agentGroupId ||
    grant.sessionId !== binding.sessionId ||
    grant.binding.nativeBindingDigest !== digest(binding) ||
    consent.nativeBindingDigest !== digest(binding) ||
    consent.selection.scopeId !== binding.scopeId ||
    consent.selection.writerBindingId !== grant.id ||
    consent.selection.readerBindingId !== grant.binding.readerBindingId ||
    consent.selection.writerReference !== grant.binding.credentialReference
  )
    throw Error('draft_policy_owner_changed');
  const consentDigest = digest(consent),
    check = async () => {
      if (digest(inputs) !== original) throw Error('draft_policy_inputs_changed');
      await ready();
      if (digest(inputs) !== original) throw Error('draft_policy_inputs_changed');
    };
  await check();
  await client.query('BEGIN');
  let transaction = true;
  try {
    if (!(await client.query('SELECT pg_try_advisory_xact_lock(73101020) AS locked')).rows[0]?.locked)
      throw Error('draft_policy_busy');
    const scoped = await client.query(
      "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND instance_id=$4 AND channel_id=$5 AND status IN ('active','paused') FOR UPDATE",
      [binding.scopeId, binding.ownerId, binding.agentGroupId, binding.instanceId, binding.channelId],
    );
    if (scoped.rowCount !== 1) throw Error('draft_policy_scope_changed');
    const readers = await client.query(
        'SELECT id,provider,mailbox_email,permission_scopes,credential_ref,processing_providers,auth,version FROM cos.mail_bindings WHERE scope_id=$1 AND id=$2 FOR UPDATE',
        [binding.scopeId, grant.binding.readerBindingId],
      ),
      b = readers.rows[0];
    if (
      readers.rowCount !== 1 ||
      !b ||
      b.provider !== 'google' ||
      b.auth !== 'ready' ||
      b.credential_ref !== consent.selection.readerReference ||
      digest(String(b.mailbox_email).toLowerCase()) !== grant.binding.mailboxDigest ||
      digest(b.permission_scopes) !== digest([GOOGLE_MAIL_READ_SCOPE]) ||
      digest(b.processing_providers) !== digest(['codex']) ||
      digest({
        status: 'ok',
        binding: {
          id: b.id,
          provider: b.provider,
          mailboxEmail: b.mailbox_email,
          scopes: b.permission_scopes,
          credentialRef: b.credential_ref,
          processingProviders: b.processing_providers,
          auth: b.auth,
          version: b.version,
        },
      }) !== consent.readerConnectionDigest
    )
      throw Error('draft_policy_reader_changed');
    const row = (
      await client.query(
        'SELECT b.owner_id,b.session_id,b.reader_binding_id,b.version,b.state,r.body,r.digest,r.consent_ref FROM cos.mail_draft_writer_bindings b JOIN cos.mail_draft_writer_revisions r ON r.scope_id=b.scope_id AND r.binding_id=b.id AND r.version=b.version WHERE b.scope_id=$1 AND b.id=$2',
        [binding.scopeId, grant.id],
      )
    ).rows[0];
    if (row) {
      if (
        row.owner_id !== binding.ownerId ||
        row.session_id !== binding.sessionId ||
        row.reader_binding_id !== grant.binding.readerBindingId ||
        row.version !== 1 ||
        row.state !== 'enabled' ||
        digest(row.body) !== digest(grant.binding) ||
        row.digest !== digest(grant.binding) ||
        row.consent_ref !== consentDigest
      )
        throw Error('draft_policy_revision_changed');
    } else {
      await client.query(
        "INSERT INTO cos.mail_draft_writer_bindings(scope_id,id,reader_binding_id,owner_id,session_id,version,state) VALUES($1,$2,$3,$4,$5,1,'enabled')",
        [binding.scopeId, grant.id, grant.binding.readerBindingId, binding.ownerId, binding.sessionId],
      );
      await client.query(
        'INSERT INTO cos.mail_draft_writer_revisions(scope_id,binding_id,version,body,digest,consent_ref) VALUES($1,$2,1,$3,$4,$5)',
        [binding.scopeId, grant.id, JSON.stringify(grant.binding), digest(grant.binding), consentDigest],
      );
    }
    await check();
    await client.query('COMMIT');
    transaction = false;
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {});
  }
}
