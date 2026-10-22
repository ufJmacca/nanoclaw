import type { PoolClient } from 'pg';
import { digest, type Result } from '../domain/contracts.js';
import type { KnowledgeContext, KnowledgeStore } from '../knowledge/store.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { mailSourceAccess } from '../mail/source-access.js';
import {
  validMailDraftCreateInput,
  validMailDraftStatusInput,
  type MailDraftCreateInput,
  type MailDraftStatusInput,
} from '../contracts/mail-draft-protocol.js';
import { contextGenerationPattern } from '../ops/conversation-ownership.js';
import { validMailDraftBinding, type MailDraftBinding } from './binding.js';
import type { MailDraftAuthority, MailDraftAuthorityResolver } from './authority.js';
import type { DraftJournal } from './journal.js';
import { MailDraftWriteError, type googleMailDraftWriter, type MailDraftResult } from './google-writer.js';

export type MailDraftSelection = {
  id: string;
  version: number;
  body: MailDraftBinding;
  digest: string;
  consent_ref: string;
  reader_provider: 'google' | 'fixture';
  mailbox_email: string;
  reader_scopes: string[];
  reader_auth: string;
  processing_providers: string[];
  reader_credential_ref: string | null;
};
export type MailDraftSourceSelection = {
  source_id: string;
  source_version: number;
  revision_id: string;
  revision_digest: string;
  thread_id: string;
  current_capture: string;
  internal_date_ms: number;
};
type Admission = { binding: MailDraftSelection; source: MailDraftSourceSelection; authority: MailDraftAuthority };
export type MailDraftDependencies = {
  journal: DraftJournal;
  authority: MailDraftAuthorityResolver;
  /** Current host-owned policy, independent journal, credential fences and actual recovery proof. No OAuth calls. */
  matches(context: KnowledgeContext, binding: MailDraftSelection): boolean;
  /** The adapter must invoke current() before/after provider awaits, including immediately before its single POST. */
  writer(
    context: KnowledgeContext,
    binding: MailDraftSelection,
    current: () => Promise<boolean>,
    source: MailDraftSourceSelection,
  ): ReturnType<typeof googleMailDraftWriter> | null;
};
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const draftStates = new Set(['verified', 'uncertain', 'edited', 'missing', 'sent', 'collision']);
function receipt(value: MailDraftResult): Result {
  if (value.status === 'skipped' && ['open_draft', 'already_answered'].includes(value.reason))
    return { status: 'ok', draft_status: 'skipped', reason: value.reason };
  if ('operationId' in value && draftStates.has(value.status) && hash(value.operationId))
    return {
      status: 'ok',
      draft_status: value.status,
      operation_id: value.operationId,
      ...(value.existing === true ? { existing: true } : {}),
    };
  throw Error('mail_draft_invalid_receipt');
}
/** PostgreSQL grants authority; the separately owned SQLite witness can only deny/reconcile effects.
 * Every database transaction ends before provider work. No reply body is persisted in cos.operations. */
export class MailDraftStore {
  constructor(
    readonly database: BoundedDatabase,
    readonly knowledge?: KnowledgeStore,
    readonly dependencies?: MailDraftDependencies,
  ) {}
  private native(context: KnowledgeContext): MailDraftAuthority | null {
    if (context.origin || context.provider !== 'codex' || !contextGenerationPattern.test(context.generation))
      return null;
    const authority = this.dependencies?.authority(context);
    return authority?.contextGeneration === context.generation &&
      authority.draftProfileDigest === digest('cos-mail-draft/v1')
      ? structuredClone(authority)
      : null;
  }
  private async transaction<T>(run: (client: PoolClient) => Promise<T>, mutation = false): Promise<T> {
    return this.database.run(async (client) => {
      await client.query('BEGIN');
      try {
        const result = await run(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      }
    }, mutation);
  }
  private async retained(client: PoolClient, context: KnowledgeContext): Promise<boolean> {
    const scope = await client.query(
      "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status='active' FOR SHARE",
      [context.scopeId, context.ownerId, context.agentGroupId],
    );
    return scope.rowCount === 1 && !!this.knowledge && (await this.knowledge.actionContextCurrent(client, context));
  }
  private async policy(
    client: PoolClient,
    context: KnowledgeContext,
    bindingId: string,
  ): Promise<Pick<Admission, 'binding' | 'authority'> | null> {
    const authority = this.native(context),
      dependencies = this.dependencies;
    if (!authority || !dependencies || !this.knowledge) return null;
    dependencies.journal.assertCurrent();
    if (!(await this.retained(client, context))) return null;
    const row = (
      await client.query(
        `SELECT b.id,b.version,r.body,r.digest,r.consent_ref,mb.provider AS reader_provider,mb.mailbox_email,
       mb.permission_scopes AS reader_scopes,mb.auth AS reader_auth,mb.processing_providers,mb.credential_ref AS reader_credential_ref
       FROM cos.mail_draft_writer_bindings b
       JOIN cos.mail_draft_writer_revisions r ON r.scope_id=b.scope_id AND r.binding_id=b.id AND r.version=b.version
       JOIN cos.mail_bindings mb ON mb.scope_id=b.scope_id AND mb.id=b.reader_binding_id
       WHERE b.scope_id=$1 AND b.id=$2 AND b.owner_id=$3 AND b.session_id=$4 AND b.state='enabled'
       AND r.body->>'readerBindingId'=b.reader_binding_id::text FOR SHARE OF mb`,
        [context.scopeId, bindingId, context.ownerId, context.sessionId],
      )
    ).rows[0] as MailDraftSelection | undefined;
    if (
      !row ||
      row.id !== bindingId ||
      !Number.isSafeInteger(row.version) ||
      row.version < 1 ||
      !validMailDraftBinding(row.body) ||
      digest(row.body) !== row.digest ||
      !hash(row.consent_ref) ||
      row.body.nativeBindingDigest !== authority.bindingDigest ||
      row.body.journalGeneration !== dependencies.journal.generation ||
      row.body.provider !== row.reader_provider ||
      typeof row.mailbox_email !== 'string' ||
      row.body.mailboxDigest !== digest(row.mailbox_email.toLowerCase()) ||
      row.reader_auth !== 'ready' ||
      !Array.isArray(row.reader_scopes) ||
      row.reader_scopes.length !== 1 ||
      row.reader_scopes[0] !== GOOGLE_MAIL_READ_SCOPE ||
      !Array.isArray(row.processing_providers) ||
      !row.processing_providers.includes(context.provider) ||
      !dependencies.matches(context, row) ||
      digest(this.native(context)) !== digest(authority)
    )
      return null;
    dependencies.journal.assertCurrent();
    return { binding: structuredClone(row), authority };
  }
  private async admission(
    client: PoolClient,
    context: KnowledgeContext,
    bindingId: string,
    messageId: string,
  ): Promise<Admission | null> {
    const policy = await this.policy(client, context, bindingId);
    if (!policy) return null;
    const { binding: row, authority } = policy,
      dependencies = this.dependencies!;
    const source = (
      await client.query(
        `SELECT s.id AS source_id,s.version AS source_version,r.id AS revision_id,r.digest AS revision_digest,
       mm.provider_thread_id AS thread_id,ms.current_capture,
       floor(extract(epoch FROM mm.internal_date)*1000)::double precision AS internal_date_ms
       FROM cos.mail_messages mm
       JOIN cos.mail_states ms ON ms.scope_id=mm.scope_id AND ms.binding_id=mm.binding_id
       JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id
       JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.source_id=s.id AND r.id=s.current_revision_id
       JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
       WHERE mm.scope_id=$1 AND mm.binding_id=$2 AND mm.provider_message_id=$3
       AND s.status IN ('current','stale') AND $4=ANY(s.processing_providers)
       AND s.provenance->>'origin'='mail_message' AND s.access_policy->>'scope_owner_only'='true'
       AND a.kind='source' AND a.lifecycle='published' AND a.digest=r.digest
       AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
       AND ${mailSourceAccess("ARRAY['mail:'||$2::text]")} FOR SHARE OF mm,ms,s,r,a`,
        [context.scopeId, row.body.readerBindingId, messageId, context.provider],
      )
    ).rows[0] as MailDraftSourceSelection | undefined;
    if (
      !source ||
      !Number.isSafeInteger(source.internal_date_ms) ||
      source.internal_date_ms < 0 ||
      !dependencies.matches(context, row) ||
      digest(this.native(context)) !== digest(authority)
    )
      return null;
    return { binding: structuredClone(row), source: structuredClone(source), authority };
  }
  /** Current main-owner metadata only. Discovery reads no message, token, body or provider resource. */
  async bindings(context: KnowledgeContext): Promise<Result> {
    if (context.origin) return { status: 'denied', items: [] };
    const pinned = this.native(context),
      retained = structuredClone(context);
    if (!pinned || !this.dependencies || !this.knowledge) return { status: 'unavailable', items: [] };
    try {
      return await this.transaction(async (client) => {
        if (!(await this.retained(client, retained))) return { status: 'denied', items: [] };
        const candidates = (
          await client.query(
            "SELECT id FROM cos.mail_draft_writer_bindings WHERE scope_id=$1 AND owner_id=$2 AND session_id=$3 AND state='enabled' ORDER BY id LIMIT 11",
            [retained.scopeId, retained.ownerId, retained.sessionId],
          )
        ).rows;
        if (candidates.length > 10) return { status: 'unavailable', items: [] };
        const items: Array<{
          writer_binding_id: string;
          reader_binding_id: string;
          daily_limit: 5;
          time_zone: 'Australia/Sydney';
          reply_mode: 'plain_text_reply';
        }> = [];
        for (const candidate of candidates) {
          const selected = await this.policy(client, retained, candidate.id);
          if (selected)
            items.push({
              writer_binding_id: selected.binding.id,
              reader_binding_id: selected.binding.body.readerBindingId,
              daily_limit: 5,
              time_zone: 'Australia/Sydney',
              reply_mode: 'plain_text_reply',
            });
        }
        this.dependencies!.journal.assertCurrent();
        return digest(this.native(retained)) === digest(pinned)
          ? { status: 'ok', items }
          : { status: 'denied', items: [] };
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Current private database/profile failures close catalogue disclosure without exposing credential metadata.
    } catch {
      return { status: 'unavailable', items: [] };
    }
  }
  private async current(context: KnowledgeContext, pinned: Admission, messageId: string): Promise<boolean> {
    try {
      return await this.transaction(async (client) => {
        const current = await this.admission(client, context, pinned.binding.id, messageId);
        return current !== null && digest(current) === digest(pinned);
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Current authority cannot be inferred after a private database/profile failure.
    } catch {
      return false;
    }
  }
  private effectMatches(operationId: string, context: KnowledgeContext, pinned: Admission, messageId: string): boolean {
    const record = this.dependencies!.journal.find(operationId);
    return (
      !!record &&
      record.scopeId === context.scopeId &&
      record.sourceMessageId === messageId &&
      record.threadId === pinned.source.thread_id &&
      record.mailboxDigest === pinned.binding.body.mailboxDigest
    );
  }
  async create(context: KnowledgeContext, requestId: string, input: MailDraftCreateInput): Promise<Result> {
    if (!validMailDraftCreateInput(input) || !contextGenerationPattern.test(requestId) || !this.native(context))
      return { status: 'denied' };
    const selected = structuredClone(input),
      retained = structuredClone(context),
      method = 'cos_mail_draft_create',
      payloadHash = digest({
        method,
        input: selected,
        owner: retained.ownerId,
        group: retained.agentGroupId,
        scope: retained.scopeId,
        generation: retained.generation,
      });
    try {
      const prepared = await this.transaction(async (client) => {
        const admission = await this.admission(
          client,
          retained,
          selected.writer_binding_id,
          selected.source_message_id,
        );
        if (!admission) return { result: { status: 'denied' } as Result };
        const inserted = await client.query(
          `INSERT INTO cos.operations(session_id,request_id,scope_id,method,payload_hash)
           VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING request_id`,
          [retained.sessionId, requestId, retained.scopeId, method, payloadHash],
        );
        if (inserted.rowCount === 1) return { admission, prior: null };
        const prior = (
          await client.query(
            'SELECT scope_id,method,payload_hash,result FROM cos.operations WHERE session_id=$1 AND request_id=$2',
            [retained.sessionId, requestId],
          )
        ).rows[0];
        if (
          !prior ||
          prior.scope_id !== retained.scopeId ||
          prior.method !== method ||
          prior.payload_hash !== payloadHash
        )
          return { result: { status: 'conflict' } as Result };
        return { admission, prior: prior.result as Result | null };
      }, true);
      if (prepared.result) return prepared.result;
      const pinned = prepared.admission!;
      if (!(await this.current(retained, pinned, selected.source_message_id))) return { status: 'denied' };
      const current = () => this.current(retained, pinned, selected.source_message_id),
        writer = this.dependencies!.writer(retained, pinned.binding, current, pinned.source);
      if (!writer) return { status: 'denied' };
      // A persisted success is an observation, never permission to claim that an owner-edited draft is unchanged.
      const prior = prepared.prior;
      let result: Result;
      if (prior?.status === 'ok' && prior.draft_status === 'skipped') {
        if (!['open_draft', 'already_answered'].includes(String(prior.reason))) return { status: 'denied' };
        result = { status: 'ok', draft_status: 'skipped', reason: prior.reason };
      } else if (prior) {
        if (
          prior.status !== 'ok' ||
          !hash(prior.operation_id) ||
          !this.effectMatches(prior.operation_id, retained, pinned, selected.source_message_id)
        )
          return { status: 'denied' };
        result = receipt(await writer.status(prior.operation_id));
      } else {
        result = receipt(
          await writer.create({ requestId, sourceMessageId: selected.source_message_id, text: selected.reply_text }),
        );
      }
      if (
        hash(result.operation_id) &&
        !this.effectMatches(result.operation_id, retained, pinned, selected.source_message_id)
      )
        return { status: 'denied' };
      if (!(await current())) return { status: 'denied' };
      return await this.transaction(async (client) => {
        const latest = await this.admission(client, retained, selected.writer_binding_id, selected.source_message_id);
        if (!latest || digest(latest) !== digest(pinned)) return { status: 'denied' };
        const updated = await client.query(
          'UPDATE cos.operations SET result=$3 WHERE session_id=$1 AND request_id=$2 AND scope_id=$4 AND method=$5 AND payload_hash=$6',
          [retained.sessionId, requestId, JSON.stringify(result), retained.scopeId, method, payloadHash],
        );
        return updated.rowCount === 1 ? result : { status: 'pending' };
      }, true);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Private database/credential diagnostics must not enter model responses; unknown failures close writes.
    } catch (error) {
      if (error instanceof DatabaseUnavailable) return { status: error.code === 'pending' ? 'pending' : 'unavailable' };
      if (error instanceof MailDraftWriteError) return { status: 'unavailable', reason: error.code };
      return { status: 'unavailable' };
    }
  }
  async status(context: KnowledgeContext, input: MailDraftStatusInput): Promise<Result> {
    if (!validMailDraftStatusInput(input) || !this.native(context)) return { status: 'denied' };
    const retained = structuredClone(context),
      operationId = input.operation_id;
    try {
      const record = this.dependencies!.journal.find(operationId);
      if (!record || record.scopeId !== retained.scopeId) return { status: 'denied' };
      const pinned = await this.transaction((client) =>
        this.admission(client, retained, record.bindingId, record.sourceMessageId),
      );
      if (!pinned || !this.effectMatches(operationId, retained, pinned, record.sourceMessageId))
        return { status: 'denied' };
      const current = () => this.current(retained, pinned, record.sourceMessageId),
        writer = this.dependencies!.writer(retained, pinned.binding, current, pinned.source);
      if (!writer || !(await current())) return { status: 'denied' };
      const result = receipt(await writer.status(operationId));
      return (await current()) ? result : { status: 'denied' };
      // eslint-disable-next-line no-catch-all/no-catch-all -- Private journal/provider diagnostics must not enter model responses; unknown failures close reads.
    } catch (error) {
      if (error instanceof MailDraftWriteError) return { status: 'unavailable', reason: error.code };
      return { status: 'unavailable' };
    }
  }
}
