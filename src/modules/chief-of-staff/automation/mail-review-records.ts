import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailMessage } from '../mail/normalization.js';
import { MAIL_MESSAGE_TEXT_BYTES } from '../mail/normalization.js';
import { MAIL_CAPTURE_MESSAGES, MAIL_CAPTURE_TEXT_BYTES } from '../mail/capture.js';
import { mailHistoryId } from '../mail/normalization.js';
import { mailSourceAccess } from '../mail/source-access.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import type { MailReviewRecord } from './mail-review-candidates.js';

/** Borrowed preparation client only, never an RPC. The caller separately holds current review
 * admission and rechecks that policy/capture after loading. No withdrawn or unpublished source is read. */
export async function loadMailReviewRecords(
  client: Pick<PoolClient, 'query'>,
  context: KnowledgeContext,
  bindingId: string,
  captureId: string,
): Promise<MailReviewRecord[]> {
  const invalid = () => Error('mail_review_source_unavailable');
  if (
    context.origin ||
    context.provider !== 'codex' ||
    !contextGenerationPattern.test(bindingId) ||
    !contextGenerationPattern.test(captureId)
  )
    throw invalid();
  const rows = (
    await client.query(
      `SELECT mm.message,mm.content_digest,mm.provider_message_id,mm.provider_thread_id,
    floor(extract(epoch FROM mm.internal_date)*1000)::double precision AS internal_date_ms,
    s.id AS source_id,s.version AS source_version,r.id AS revision_id,r.digest AS revision_digest
    FROM cos.mail_messages mm
    JOIN cos.scopes sc ON sc.id=mm.scope_id AND sc.owner_id=$5 AND sc.agent_group_id=$6 AND sc.status='active'
    JOIN cos.mail_states ms ON ms.scope_id=mm.scope_id AND ms.binding_id=mm.binding_id AND ms.current_capture=$3
    JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id
    JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.source_id=s.id AND r.id=s.current_revision_id
    JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id AND a.kind='source' AND a.lifecycle='published' AND a.digest=r.digest
    WHERE mm.scope_id=$1 AND mm.binding_id=$2 AND s.status IN ('current','stale') AND $4=ANY(s.processing_providers)
     AND s.provenance->>'origin'='mail_message' AND s.access_policy->>'scope_owner_only'='true'
     AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
     AND ${mailSourceAccess("ARRAY['mail:'||$2::text]")}
    ORDER BY mm.internal_date DESC,mm.provider_message_id LIMIT 1001`,
      [context.scopeId, bindingId, captureId, context.provider, context.ownerId, context.agentGroupId],
    )
  ).rows;
  if (rows.length > MAIL_CAPTURE_MESSAGES) throw invalid();
  let bytes = 0;
  return rows.map((row) => {
    const m = row.message as MailMessage;
    if (
      !m ||
      typeof m !== 'object' ||
      Array.isArray(m) ||
      Object.keys(m).sort().join(',') !==
        'attachmentsExcluded,digest,from,historyId,id,internalDate,labels,subject,text,threadId,to,trust' ||
      m.id !== row.provider_message_id ||
      m.threadId !== row.provider_thread_id ||
      !mailHistoryId(m.historyId) ||
      !Number.isSafeInteger(m.internalDate) ||
      m.internalDate < 0 ||
      m.internalDate !== row.internal_date_ms ||
      !Array.isArray(m.labels) ||
      m.labels.length > 100 ||
      m.labels.some((label) => typeof label !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(label)) ||
      ![m.subject, m.from, m.to, m.text].every((value) => typeof value === 'string') ||
      [m.subject, m.from, m.to].some((value) => value.length > 16384) ||
      Buffer.byteLength(m.text) > MAIL_MESSAGE_TEXT_BYTES ||
      m.trust !== 'untrusted_mail_evidence' ||
      !Number.isSafeInteger(m.attachmentsExcluded) ||
      m.attachmentsExcluded < 0 ||
      m.attachmentsExcluded > 64 ||
      typeof row.source_id !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(row.source_id) ||
      !Number.isSafeInteger(row.source_version) ||
      row.source_version < 1 ||
      row.source_version > 2147483647 ||
      !contextGenerationPattern.test(row.revision_id) ||
      !/^[a-f0-9]{64}$/.test(row.revision_digest)
    )
      throw invalid();
    bytes += [m.text, m.subject, m.from, m.to].reduce((n, value) => n + Buffer.byteLength(value), 0);
    if (bytes > MAIL_CAPTURE_TEXT_BYTES) throw invalid();
    const { digest: stored, ...content } = m;
    if (stored !== row.content_digest || digest(content) !== stored) throw invalid();
    return {
      message: structuredClone(m),
      source_id: row.source_id,
      source_version: row.source_version,
      revision_id: row.revision_id,
      revision_digest: row.revision_digest,
    };
  });
}
