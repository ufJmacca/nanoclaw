import { digest, type Context, type Result } from '../domain/contracts.js';
import { DatabaseUnavailable, type BoundedDatabase } from '../store/client.js';
import type { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { MAIL_RETENTION_MS, mailHistoryId, type MailWindow, type MailMessage } from './normalization.js';
import { MAIL_CAPTURE_MESSAGES, MAIL_CAPTURE_TEXT_BYTES, type MailCapture } from './capture.js';
import type { PoolClient } from 'pg';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
export type MailBindingInput = {
  id: string;
  provider: 'google' | 'fixture';
  mailboxEmail: string;
  scopes: string[];
  credentialRef?: string;
  processingProviders: string[];
};
export type MailConnection = MailBindingInput & {
  version: number;
  auth: 'ready' | 'expired' | 'revoked' | 'disconnected';
};
const uuid = (x: unknown): x is string =>
  typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(x);
const email = (x: unknown): x is string =>
  typeof x === 'string' && x.length <= 254 && /^[a-z0-9][a-z0-9._%+-]{0,127}@[a-z0-9.-]{1,180}\.[a-z]{2,24}$/.test(x);
const providerId = (x: unknown): x is string => typeof x === 'string' && /^[a-f0-9]{1,128}$/.test(x);
const textSafe = (value: string, header = false) =>
  [...value].every((character) => {
    const code = character.codePointAt(0)!;
    return !(code < 32 && (header || ![9, 10].includes(code))) && !(code >= 127 && code <= 159);
  });
const windowValid = (w: MailWindow) =>
  w &&
  Number.isSafeInteger(w.capturedAt) &&
  w.capturedAt > MAIL_RETENTION_MS &&
  w.since === w.capturedAt - MAIL_RETENTION_MS;
function bindingValid(b: MailBindingInput): boolean {
  return (
    !!b &&
    typeof b === 'object' &&
    Object.keys(b).every((k) =>
      ['id', 'provider', 'mailboxEmail', 'scopes', 'credentialRef', 'processingProviders'].includes(k),
    ) &&
    uuid(b.id) &&
    ['google', 'fixture'].includes(b.provider) &&
    email(b.mailboxEmail) &&
    Array.isArray(b.scopes) &&
    b.scopes.length === 1 &&
    b.scopes[0] === GOOGLE_MAIL_READ_SCOPE &&
    (b.credentialRef === undefined || uuid(b.credentialRef)) &&
    (b.provider !== 'google' || uuid(b.credentialRef)) &&
    Array.isArray(b.processingProviders) &&
    b.processingProviders.length <= 2 &&
    new Set(b.processingProviders).size === b.processingProviders.length &&
    b.processingProviders.every((p) => ['codex', 'claude'].includes(p))
  );
}
/** Even a host-prepared capture must pass identity and size checks before persistence. */
export function validMailCapture(c: MailCapture): boolean {
  try {
    const keys =
      'complete,contract,deferred,digest,historyId,lastFullSyncAt,limitations,mailboxEmail,messages,mode,removedIds,textBytes,unsupported,window';
    if (
      !c ||
      Object.keys(c).sort().join(',') !== keys ||
      c.contract !== 'cos-mail-capture/v1' ||
      !['full', 'incremental', 'resync'].includes(c.mode) ||
      !email(c.mailboxEmail) ||
      !windowValid(c.window) ||
      Object.keys(c.window).sort().join(',') !== 'capturedAt,since' ||
      !mailHistoryId(c.historyId) ||
      !Number.isSafeInteger(c.lastFullSyncAt) ||
      c.lastFullSyncAt < 0 ||
      c.lastFullSyncAt > c.window.capturedAt ||
      !Array.isArray(c.messages) ||
      c.messages.length > MAIL_CAPTURE_MESSAGES ||
      new Set(c.messages.map((m) => m.id)).size !== c.messages.length ||
      Buffer.byteLength(JSON.stringify(c)) > 34 * 1024 ** 2
    )
      return false;
    let bytes = 0;
    for (const m of c.messages) {
      if (
        Object.keys(m).sort().join(',') !==
          'attachmentsExcluded,digest,from,historyId,id,internalDate,labels,subject,text,threadId,to,trust' ||
        !providerId(m.id) ||
        !providerId(m.threadId) ||
        !mailHistoryId(m.historyId) ||
        m.trust !== 'untrusted_mail_evidence' ||
        !Number.isSafeInteger(m.internalDate) ||
        m.internalDate < c.window.since ||
        m.internalDate > c.window.capturedAt ||
        !Array.isArray(m.labels) ||
        m.labels.length > 100 ||
        m.labels.some((label) => typeof label !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(label)) ||
        new Set(m.labels).size !== m.labels.length ||
        !m.labels.some((l) => ['INBOX', 'SENT'].includes(l)) ||
        m.labels.some((l) => ['SPAM', 'TRASH', 'DRAFT'].includes(l)) ||
        !['text', 'subject', 'from', 'to'].every((k) => typeof m[k as keyof MailMessage] === 'string') ||
        Buffer.byteLength(m.text) > 65536 ||
        !textSafe(m.text) ||
        ![m.subject, m.from, m.to].every((header) => header.length <= 16384 && textSafe(header, true)) ||
        !Number.isSafeInteger(m.attachmentsExcluded) ||
        m.attachmentsExcluded < 0 ||
        m.attachmentsExcluded > 64
      )
        return false;
      const { digest: stored, ...content } = m;
      if (stored !== digest(content)) return false;
      bytes +=
        Buffer.byteLength(m.text) + Buffer.byteLength(m.subject) + Buffer.byteLength(m.from) + Buffer.byteLength(m.to);
    }
    if (
      bytes !== c.textBytes ||
      bytes > MAIL_CAPTURE_TEXT_BYTES ||
      !Array.isArray(c.deferred) ||
      c.deferred.length > 1000 ||
      new Set(c.deferred.map((d) => d.id)).size !== c.deferred.length ||
      c.deferred.some(
        (d) =>
          !providerId(d.id) ||
          !Number.isSafeInteger(d.until) ||
          d.until <= c.window.capturedAt ||
          !Number.isSafeInteger(d.seenAt) ||
          d.seenAt < c.window.since ||
          c.messages.some((m) => m.id === d.id) ||
          d.seenAt > c.window.capturedAt,
      ) ||
      !Array.isArray(c.unsupported) ||
      c.unsupported.length > 1000 ||
      new Set(c.unsupported.map((u) => u.id)).size !== c.unsupported.length ||
      c.unsupported.some(
        (u) =>
          !providerId(u.id) ||
          !['invalid_message', 'content_limit', 'body_unavailable', 'response_too_large'].includes(u.reason) ||
          !Number.isSafeInteger(u.seenAt) ||
          u.seenAt < c.window.since ||
          c.messages.some((m) => m.id === u.id) ||
          c.deferred.some((d) => d.id === u.id) ||
          u.seenAt > c.window.capturedAt,
      ) ||
      !Array.isArray(c.limitations) ||
      new Set(c.limitations).size !== c.limitations.length ||
      c.limitations.some(
        (l) =>
          ![
            'message_limit',
            'text_limit',
            'unsupported_messages',
            'deferred_messages',
            'selection_changed',
            'provider_byte_limit',
          ].includes(l),
      ) ||
      c.complete !== (c.limitations.length === 0) ||
      (c.deferred.length > 0 && !c.limitations.includes('deferred_messages')) ||
      (c.unsupported.length > 0 && !c.limitations.includes('unsupported_messages')) ||
      !Array.isArray(c.removedIds) ||
      c.removedIds.length > 1000 ||
      new Set(c.removedIds).size !== c.removedIds.length ||
      c.removedIds.some((id) => !providerId(id) || c.messages.some((m) => m.id === id))
    )
      return false;
    const { digest: stored, ...content } = c;
    return stored === digest(content);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Malformed private capture records are denied without exposing parser diagnostics or content.
  } catch {
    return false;
  }
}
type BindingRow = {
  id: string;
  provider: MailBindingInput['provider'];
  mailbox_email: string;
  permission_scopes: string[];
  credential_ref: string | null;
  processing_providers: string[];
  auth: MailConnection['auth'];
  version: number;
};
export class MailStore {
  constructor(
    readonly database: BoundedDatabase,
    readonly artifacts: KnowledgeArtifacts,
    readonly hooks: { beforePublishCommit?(): Promise<void>; afterPublishCommit?(): Promise<void> } = {},
  ) {}
  protected readonly ownerAdministration: boolean = false;
  private async transaction(
    context: Context,
    mutation: boolean,
    operation: (client: PoolClient) => Promise<Result>,
    publishing = false,
  ): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        let committed = false;
        try {
          const scope = await client.query(
            `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND ${this.ownerAdministration ? "status IN ('active','paused')" : "status='active'"} FOR ${mutation ? 'UPDATE' : 'SHARE'}`,
            [context.scopeId, context.ownerId, context.agentGroupId],
          );
          if (!scope.rowCount) {
            await client.query('COMMIT');
            committed = true;
            return { status: 'denied' };
          }
          const result = await operation(client);
          if (publishing && result.status === 'ok') await this.hooks.beforePublishCommit?.();
          await client.query('COMMIT');
          committed = true;
          if (publishing && result.status === 'ok') await this.hooks.afterPublishCommit?.();
          return result;
        } catch (error) {
          if (!committed) await client.query('ROLLBACK').catch(() => {});
          throw error;
        }
      }, mutation);
    } catch (error) {
      if (error instanceof DatabaseUnavailable)
        return { status: mutation && error.code === 'pending' ? 'pending' : 'unavailable' };
      throw error;
    }
  }
  private async binding(client: PoolClient, context: Context, id: string): Promise<BindingRow | null> {
    return (
      (await client.query('SELECT * FROM cos.mail_bindings WHERE scope_id=$1 AND id=$2', [context.scopeId, id]))
        .rows[0] ?? null
    );
  }
  async bind(context: Context, input: MailBindingInput): Promise<Result> {
    if (context.origin || !bindingValid(input)) return { status: 'denied' };
    const b = structuredClone(input);
    return this.transaction(context, true, async (client) => {
      const old = await this.binding(client, context, b.id);
      if (old) {
        const prior = {
          id: old.id,
          provider: old.provider,
          mailboxEmail: old.mailbox_email,
          scopes: old.permission_scopes,
          ...(old.credential_ref ? { credentialRef: old.credential_ref } : {}),
          processingProviders: old.processing_providers,
        };
        return {
          status: old.auth === 'ready' && digest(prior) === digest(b) ? 'ok' : 'conflict',
          binding_id: b.id,
          access_generation: b.id + ':' + old.version,
        };
      }
      await client.query(
        "INSERT INTO cos.mail_bindings(scope_id,id,provider,mailbox_email,permission_scopes,credential_ref,processing_providers,auth,provenance) VALUES($1,$2,$3,$4,$5,$6,$7,'ready',$8)",
        [
          context.scopeId,
          b.id,
          b.provider,
          b.mailboxEmail,
          b.scopes,
          b.credentialRef ?? null,
          b.processingProviders,
          JSON.stringify({ origin: 'operator_mail_binding', owner_id: context.ownerId, ingress_id: context.ingressId }),
        ],
      );
      await client.query('INSERT INTO cos.mail_states(scope_id,binding_id) VALUES($1,$2)', [context.scopeId, b.id]);
      return { status: 'ok', binding_id: b.id, access_generation: b.id + ':1' };
    });
  }
  async connection(context: Context, id: string): Promise<Result> {
    if (!uuid(id)) return { status: 'denied' };
    return this.transaction(context, false, async (client) => {
      const b = await this.binding(client, context, id);
      if (!b) return { status: 'denied' };
      const binding: MailConnection = {
        id: b.id,
        provider: b.provider,
        mailboxEmail: b.mailbox_email,
        scopes: b.permission_scopes,
        ...(b.credential_ref ? { credentialRef: b.credential_ref } : {}),
        processingProviders: b.processing_providers,
        auth: b.auth,
        version: b.version,
      };
      return { status: 'ok', binding };
    });
  }
  private async previous(
    client: PoolClient,
    context: Context,
    binding: string,
    id: string | null,
  ): Promise<MailCapture | null> {
    if (id === null) return null;
    const row = (
      await client.query(
        "SELECT metadata FROM cos.mail_captures WHERE scope_id=$1 AND binding_id=$2 AND id=$3 AND status='complete'",
        [context.scopeId, binding, id],
      )
    ).rows[0];
    if (!row?.metadata || !Array.isArray(row.metadata.messageIds)) throw Error('mail_capture_unavailable');
    const rows = (
      await client.query(
        'SELECT provider_message_id,message FROM cos.mail_messages WHERE scope_id=$1 AND binding_id=$2 AND last_capture=$3',
        [context.scopeId, binding, id],
      )
    ).rows;
    const values = new Map(rows.map((r) => [r.provider_message_id, r.message]));
    if (values.size !== row.metadata.messageIds.length) throw Error('mail_capture_unavailable');
    const { messageIds, ...metadata } = row.metadata;
    const capture = { ...metadata, messages: messageIds.map((id: string) => values.get(id)) } as MailCapture;
    if (!validMailCapture(capture)) throw Error('mail_capture_unavailable');
    return capture;
  }
  async start(context: Context, binding: string, id: string, window: MailWindow): Promise<Result> {
    if (!uuid(binding) || !uuid(id) || !windowValid(window)) return { status: 'denied' };
    const captured = structuredClone(window);
    return this.transaction(context, true, async (client) => {
      const b = await this.binding(client, context, binding);
      if (!b || b.auth !== 'ready') return { status: 'denied' };
      const state = (
        await client.query('SELECT * FROM cos.mail_states WHERE scope_id=$1 AND binding_id=$2 FOR UPDATE', [
          context.scopeId,
          binding,
        ])
      ).rows[0];
      const attempt = (
        await client.query('SELECT * FROM cos.mail_captures WHERE scope_id=$1 AND binding_id=$2 AND id=$3', [
          context.scopeId,
          binding,
          id,
        ])
      ).rows[0];
      if (attempt) {
        if (attempt.binding_version !== b.version || digest(attempt.capture_window) !== digest(captured))
          return { status: 'conflict' };
        if (attempt.status === 'complete') return { status: 'ok', already_complete: true, result: attempt.result };
        if (
          state.last_attempt !== id ||
          attempt.base_capture !== state.current_capture ||
          attempt.status === 'superseded'
        )
          return { status: 'conflict' };
        await client.query(
          "UPDATE cos.mail_captures SET status='collecting',failure_code=NULL WHERE scope_id=$1 AND binding_id=$2 AND id=$3",
          [context.scopeId, binding, id],
        );
      } else {
        if (Math.abs(Date.now() - captured.capturedAt) > 60000) return { status: 'denied' };
        await client.query(
          "UPDATE cos.mail_captures SET status='superseded' WHERE scope_id=$1 AND binding_id=$2 AND id=$3 AND status='collecting'",
          [context.scopeId, binding, state.last_attempt],
        );
        await client.query(
          "INSERT INTO cos.mail_captures(scope_id,binding_id,id,binding_version,base_capture,status,capture_window) VALUES($1,$2,$3,$4,$5,'collecting',$6)",
          [context.scopeId, binding, id, b.version, state.current_capture, JSON.stringify(captured)],
        );
      }
      await client.query(
        "UPDATE cos.mail_states SET last_attempt=$3,last_attempt_at=clock_timestamp(),next_poll_at=clock_timestamp()+interval '5 minutes' WHERE scope_id=$1 AND binding_id=$2",
        [context.scopeId, binding, id],
      );
      return {
        status: 'ok',
        capture_id: id,
        binding_version: b.version,
        base_capture: state.current_capture,
        previous: await this.previous(client, context, binding, state.current_capture),
      };
    });
  }
  async publish(context: Context, binding: string, id: string, input: MailCapture): Promise<Result> {
    if (!uuid(binding) || !uuid(id) || !validMailCapture(input)) return { status: 'denied' };
    const capture = structuredClone(input);
    return this.transaction(
      context,
      true,
      async (client) => {
        const b = await this.binding(client, context, binding);
        if (!b || b.auth !== 'ready' || b.mailbox_email !== capture.mailboxEmail) return { status: 'denied' };
        const attempt = (
          await client.query('SELECT * FROM cos.mail_captures WHERE scope_id=$1 AND binding_id=$2 AND id=$3', [
            context.scopeId,
            binding,
            id,
          ])
        ).rows[0];
        if (
          !attempt ||
          attempt.binding_version !== b.version ||
          digest(attempt.capture_window) !== digest(capture.window)
        )
          return { status: 'conflict' };
        if (attempt.status === 'complete')
          return attempt.content_digest === capture.digest ? attempt.result : { status: 'conflict' };
        const state = (
          await client.query('SELECT * FROM cos.mail_states WHERE scope_id=$1 AND binding_id=$2 FOR UPDATE', [
            context.scopeId,
            binding,
          ])
        ).rows[0];
        if (
          attempt.status !== 'collecting' ||
          state.last_attempt !== id ||
          state.current_capture !== attempt.base_capture
        )
          return { status: 'conflict' };
        if (state.history_cursor && BigInt(capture.historyId) < BigInt(state.history_cursor))
          return { status: 'conflict' };
        const previous = (
          await client.query(
            'SELECT provider_message_id,selection_id,source_id FROM cos.mail_messages WHERE scope_id=$1 AND binding_id=$2',
            [context.scopeId, binding],
          )
        ).rows;
        const old = new Map(previous.map((r) => [r.provider_message_id, r]));
        const rows = capture.messages.map((message) => ({
          provider_message_id: message.id,
          provider_thread_id: message.threadId,
          message,
          content_digest: message.digest,
          internal_date: new Date(message.internalDate).toISOString(),
          selection_id: old.get(message.id)?.selection_id ?? id,
          source_id: old.get(message.id)?.source_id ?? null,
        }));
        await client.query(
          'DELETE FROM cos.mail_messages WHERE scope_id=$1 AND binding_id=$2 AND NOT provider_message_id=ANY($3::text[])',
          [context.scopeId, binding, capture.messages.map((m) => m.id)],
        );
        await client.query(
          `INSERT INTO cos.mail_messages(scope_id,binding_id,provider_message_id,provider_thread_id,message,content_digest,internal_date,selection_id,source_id,last_capture)
    SELECT $1,$2,x.provider_message_id,x.provider_thread_id,x.message,x.content_digest,x.internal_date,x.selection_id,x.source_id,$3 FROM jsonb_to_recordset($4::jsonb) AS x(provider_message_id text,provider_thread_id text,message jsonb,content_digest text,internal_date timestamptz,selection_id uuid,source_id text)
    ON CONFLICT(scope_id,binding_id,provider_message_id) DO UPDATE SET provider_thread_id=EXCLUDED.provider_thread_id,message=EXCLUDED.message,content_digest=EXCLUDED.content_digest,internal_date=EXCLUDED.internal_date,last_capture=EXCLUDED.last_capture,updated_at=clock_timestamp()`,
          [context.scopeId, binding, id, JSON.stringify(rows)],
        );
        const { messages, ...metadata } = capture,
          result = {
            status: 'ok' as const,
            capture_id: id,
            message_count: messages.length,
            complete: capture.complete,
            limitations: capture.limitations,
            history_cursor: capture.historyId,
          };
        await client.query(
          "UPDATE cos.mail_captures SET status='complete',content_digest=$4,metadata=$5,result=$6,completed_at=clock_timestamp(),failure_code=NULL WHERE scope_id=$1 AND binding_id=$2 AND id=$3",
          [
            context.scopeId,
            binding,
            id,
            capture.digest,
            JSON.stringify({ ...metadata, messageIds: messages.map((m) => m.id) }),
            JSON.stringify(result),
          ],
        );
        await client.query(
          "UPDATE cos.mail_states SET current_capture=$3,history_cursor=$4,last_success_at=clock_timestamp(),next_poll_at=clock_timestamp()+interval '5 minutes' WHERE scope_id=$1 AND binding_id=$2",
          [context.scopeId, binding, id, capture.historyId],
        );
        return result;
      },
      true,
    );
  }
  async fail(context: Context, binding: string, id: string, code: string): Promise<Result> {
    if (!uuid(binding) || !uuid(id)) return { status: 'denied' };
    return this.transaction(context, true, async (client) => {
      const result = await client.query(
        "UPDATE cos.mail_captures c SET status='failed',failure_code=$4,completed_at=clock_timestamp() FROM cos.mail_states s WHERE c.scope_id=$1 AND c.binding_id=$2 AND c.id=$3 AND c.status='collecting' AND s.scope_id=c.scope_id AND s.binding_id=c.binding_id AND s.last_attempt=c.id",
        [context.scopeId, binding, id, /^mail_[a-z0-9_]{1,80}$/.test(code) ? code : 'mail_unavailable'],
      );
      return { status: result.rowCount ? 'ok' : 'conflict' };
    });
  }
  async coverage(context: Context & { provider: string }): Promise<Result> {
    return this.transaction(context, false, async (client) => {
      const rows = (
        await client.query(
          `SELECT b.id AS binding_id,b.auth,s.last_attempt_at,s.last_success_at,s.next_poll_at,s.current_capture,c.metadata,a.status AS attempt_status
    FROM cos.mail_bindings b JOIN cos.mail_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id
    LEFT JOIN cos.mail_captures c ON c.scope_id=s.scope_id AND c.binding_id=s.binding_id AND c.id=s.current_capture
    LEFT JOIN cos.mail_captures a ON a.scope_id=s.scope_id AND a.binding_id=s.binding_id AND a.id=s.last_attempt
    WHERE b.scope_id=$1 AND $2=ANY(b.processing_providers) ORDER BY b.id LIMIT 11`,
          [context.scopeId, context.provider],
        )
      ).rows;
      const more = rows.length > 10;
      rows.length = Math.min(rows.length, 10);
      return {
        status: 'ok',
        items: rows.map(({ metadata, ...row }) => ({
          ...row,
          message_count: metadata?.messageIds?.length ?? 0,
          capture_complete: metadata?.complete === true && row.attempt_status === 'complete',
          limitations: metadata?.limitations ?? ['not_captured'],
          window: metadata?.window ?? null,
        })),
        more,
      };
    });
  }
}
