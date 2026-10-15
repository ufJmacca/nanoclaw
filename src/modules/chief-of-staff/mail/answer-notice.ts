import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import { GOOGLE_MAIL_READ_SCOPE } from './oauth.js';
import { MAIL_RETENTION_MS } from './normalization.js';
import { mailSourceAccess } from './source-access.js';
export type MailAnswerNotice = { text: string; fingerprint: string; identityDigest: string };
export type MailContextCheck = { status: 'ok'; notice: MailAnswerNotice | null } | { status: 'denied' };
const label = (text: string) => text.replace(/[\\`*_{}[\]<>]/g, (c) => '\\' + c);
const timestamp = (value: Date | string | null) => (value ? new Date(value).toISOString() : 'never');
const reasons: Record<string, string> = {
  message_limit: 'message selection limit reached',
  text_limit: 'text size limit reached',
  checkpoint_limit: 'checkpoint size limit reached',
  unsupported_messages: 'some message bodies are unavailable',
  deferred_messages: 'later arrivals await another scan',
  selection_changed: 'the provider selection changed during capture',
  provider_byte_limit: 'provider response size limit reached',
  owner_denied: 'some messages are withheld by owner source controls',
  retention_only: 'retention ran without a provider refresh',
  access_unavailable: 'mail access is unavailable',
};
/** No provider read, message body or token enters this metadata projection. */
export async function mailAnswerNotice(
  client: PoolClient,
  context: KnowledgeContext,
  options: { enabled(): boolean; access(scope: string, binding: string): boolean },
): Promise<MailAnswerNotice> {
  if (!options.enabled())
    return {
      text: 'Mailbox coverage is unavailable because mail retrieval is disabled. This does not establish that the inbox is empty or that all mail has been reviewed.',
      fingerprint: digest({ mail: 'disabled' }),
      identityDigest: digest({ mail: 'disabled' }),
    };
  const rows = (
    await client.query(
      `SELECT b.id::text AS binding_id,b.mailbox_email,b.auth,b.version,b.permission_scopes,
   ms.current_capture,ms.last_attempt,ms.last_success_at,ms.last_attempt_at,c.metadata,a.status AS attempt_status,clock_timestamp() AS observed_now,
   (SELECT count(*)::int FROM cos.mail_messages mm WHERE mm.scope_id=b.scope_id AND mm.binding_id=b.id AND mm.last_capture=ms.current_capture) AS stored_count,
   EXISTS(SELECT 1 FROM cos.mail_messages mm LEFT JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id
     LEFT JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id LEFT JOIN cos.artifacts ar ON ar.scope_id=r.scope_id AND ar.id=r.artifact_id
     WHERE mm.scope_id=b.scope_id AND mm.binding_id=b.id AND mm.last_capture=ms.current_capture AND
       (s.id IS NULL OR s.provenance->>'origin' IS DISTINCT FROM 'mail_message' OR s.status NOT IN ('current','stale') OR NOT $2=ANY(s.processing_providers) OR ar.lifecycle IS DISTINCT FROM 'published'
         OR EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
         OR NOT ${mailSourceAccess("ARRAY['mail:'||b.id::text]")})) AS hidden_evidence
   FROM cos.mail_bindings b JOIN cos.mail_states ms ON ms.scope_id=b.scope_id AND ms.binding_id=b.id
   LEFT JOIN cos.mail_captures c ON c.scope_id=ms.scope_id AND c.binding_id=ms.binding_id AND c.id=ms.current_capture
   LEFT JOIN cos.mail_captures a ON a.scope_id=ms.scope_id AND a.binding_id=ms.binding_id AND a.id=ms.last_attempt
   WHERE b.scope_id=$1 AND $2=ANY(b.processing_providers) ORDER BY b.id LIMIT 11`,
      [context.scopeId, context.provider],
    )
  ).rows;
  if (rows.length > 10) throw Error('mail_inventory_limit');
  const policies: Array<unknown> = [],
    states = rows.map((row) => {
      let accessible =
        row.auth === 'ready' &&
        Array.isArray(row.permission_scopes) &&
        row.permission_scopes.length === 1 &&
        row.permission_scopes[0] === GOOGLE_MAIL_READ_SCOPE;
      try {
        accessible = accessible && options.access(context.scopeId, row.binding_id);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Missing or corrupt host denial/storage proofs close metadata disclosure without revealing private diagnostics.
      } catch {
        accessible = false;
      }
      policies.push({
        binding: row.binding_id,
        version: row.version,
        auth: row.auth,
        scopes: row.permission_scopes,
        mailbox: digest(row.mailbox_email),
        accessible,
      });
      if (!accessible) return { binding: row.binding_id, accessible: false, text: 'Mail access is unavailable.' };
      const m = row.metadata,
        w = m?.window,
        validWindow = w && Number.isSafeInteger(w.capturedAt) && w.since === w.capturedAt - MAIL_RETENTION_MS;
      const selected = Array.isArray(m?.messageIds) && m.messageIds.length <= 1000 ? m.messageIds.length : null;
      const stale =
        !row.last_success_at || row.observed_now.getTime() - new Date(row.last_success_at).getTime() > 600000;
      const complete = !!(
        row.current_capture &&
        row.current_capture === row.last_attempt &&
        row.attempt_status === 'complete' &&
        m?.contract === 'cos-mail-capture/v1' &&
        m.complete === true &&
        Array.isArray(m.limitations) &&
        m.limitations.length === 0 &&
        validWindow &&
        selected === row.stored_count &&
        !row.hidden_evidence &&
        !stale
      );
      const coverage = !row.current_capture
        ? 'Incomplete: no successful capture is available.'
        : stale
          ? 'Stale: the last successful refresh is over ten minutes old.'
          : row.attempt_status === 'failed'
            ? 'Incomplete: the latest refresh failed.'
            : complete
              ? 'Capture complete within the recorded selection only.'
              : 'Incomplete: the stored selection does not establish complete coverage.';
      const limitations = Array.isArray(m?.limitations)
        ? m.limitations.map((reason: string) => reasons[reason] ?? 'unavailable coverage').join('; ')
        : '';
      const text =
        `Mailbox ${label(row.mailbox_email)}: ${coverage} Last successful refresh: ${timestamp(row.last_success_at)}. Last attempt: ${timestamp(row.last_attempt_at)}.` +
        (validWindow
          ? ` Recorded Inbox/Sent window: ${new Date(w.since).toISOString()} to ${new Date(w.capturedAt).toISOString()}.`
          : '') +
        (selected !== null ? ` Stored selected messages: ${selected}.` : '') +
        (limitations ? ` Limits: ${limitations}.` : '');
      return {
        binding: row.binding_id,
        accessible: true,
        currentCapture: row.current_capture,
        lastAttempt: row.last_attempt,
        lastSuccess: timestamp(row.last_success_at),
        lastAttemptAt: timestamp(row.last_attempt_at),
        complete,
        selected,
        hidden: row.hidden_evidence,
        text,
      };
    });
  const text = [
    'Mailbox coverage (stored Inbox/Sent selection from the most recent 30 days only):',
    ...(states.length
      ? states.map((s) => s.text)
      : ['Incomplete: no mailbox is connected for this processing provider.']),
    'This is an as-of observation recorded with this answer. It does not establish that the inbox is empty or that all mail has been reviewed.',
  ].join('\n\n');
  return { text, fingerprint: digest(states), identityDigest: digest(policies) };
}
/** Bind exposure to account/access policy, not refresh IDs. Ordinary polling
 * must not discard the shared main conversation merely to update freshness. */
export async function checkMailContext(
  client: PoolClient,
  context: KnowledgeContext,
  notice: () => Promise<MailAnswerNotice>,
  register = false,
): Promise<MailContextCheck> {
  const ticket =
    'mail-context-' + digest({ scope: context.scopeId, generation: context.generation, provider: context.provider });
  const row = (
    await client.query(
      'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
      [context.sessionId, ticket],
    )
  ).rows[0];
  if (!row && !register) return { status: 'ok', notice: null };
  const current = await notice(),
    result = { generation: context.generation, provider: context.provider, identity_digest: current.identityDigest };
  if (row)
    return row.scope_id === context.scopeId &&
      row.method === 'cos_mail_context' &&
      row.payload_hash === digest(result) &&
      digest(row.result) === digest(result)
      ? { status: 'ok', notice: current }
      : { status: 'denied' };
  const inserted = await client.query(
    "INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash,result) VALUES($1,$2,$3,'cos_mail_context',$4,$5) ON CONFLICT DO NOTHING RETURNING request_id",
    [context.sessionId, ticket, context.scopeId, digest(result), JSON.stringify(result)],
  );
  return inserted.rowCount ? { status: 'ok', notice: current } : checkMailContext(client, context, notice);
}
