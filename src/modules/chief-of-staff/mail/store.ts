import { digest, type Context, type Result } from '../domain/contracts.js';
import { randomUUID } from 'node:crypto';
import { DatabaseUnavailable, type BoundedDatabase } from '../store/client.js';
import type { ArtifactLease, KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { MAIL_RETENTION_MS, mailHistoryId, type MailWindow, type MailMessage } from './normalization.js';
import { MAIL_CAPTURE_MESSAGES, MAIL_CAPTURE_TEXT_BYTES, type MailCapture } from './capture.js';
import type { PoolClient } from 'pg';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { MailEvidence } from './evidence.js';
import { retainedMailCapture, suppressMailCapture, mailRetentionChanged } from './retention.js';
import { MAIL_CHECKPOINT_BYTES, mailCheckpointBytes } from './bounds.js';
import { mailSourceAccess } from './source-access.js';
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
/** Host maintenance inventory contains no account, credential or message data. */
export type MailMaintenanceBinding = {
  binding_id: string;
  auth: MailConnection['auth'];
  provider_allowed: boolean;
  poll_due: boolean;
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
      !['full', 'incremental', 'resync', 'retention'].includes(c.mode) ||
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
    let bytes = 0,
      checkpointBytes = 0;
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
      checkpointBytes += mailCheckpointBytes(m, c.mailboxEmail);
    }
    if (
      bytes !== c.textBytes ||
      bytes > MAIL_CAPTURE_TEXT_BYTES ||
      checkpointBytes > MAIL_CHECKPOINT_BYTES ||
      !Array.isArray(c.deferred) ||
      c.deferred.length > 1000 ||
      new Set(c.deferred.map((d) => d.id)).size !== c.deferred.length ||
      c.deferred.some(
        (d) =>
          !providerId(d.id) ||
          !Number.isSafeInteger(d.until) ||
          (d.until <= c.window.capturedAt && c.mode !== 'retention') ||
          d.until <= d.seenAt ||
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
          !['invalid_message', 'content_limit', 'body_unavailable', 'response_too_large', 'owner_denied'].includes(
            u.reason,
          ) ||
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
            'owner_denied',
            'retention_only',
            'access_unavailable',
            'checkpoint_limit',
          ].includes(l),
      ) ||
      c.complete !== (c.limitations.length === 0) ||
      (c.mode === 'retention' && !c.limitations.includes('retention_only')) ||
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
    retaining = false,
  ): Promise<Result> {
    try {
      return await this.database.run(async (client) => {
        await client.query('BEGIN');
        let committed = false;
        try {
          if (publishing) await client.query('SELECT pg_advisory_xact_lock(73101004)');
          const scope = await client.query(
            `SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND ${this.ownerAdministration || retaining ? "status IN ('active','paused')" : "status='active'"} FOR ${mutation ? 'UPDATE' : 'SHARE'}`,
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
  /** Polling and physical retention share the selected database clock. */
  async captureWindow(context: Context): Promise<Result> {
    return this.transaction(context, false, async (client) => {
      const capturedAt = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
      return { status: 'ok', window: { capturedAt, since: capturedAt - MAIL_RETENTION_MS } };
    });
  }
  /** Keyset paging includes closed and paused bindings for deletion obligations. */
  async maintenanceBindings(context: Context & { provider: string }, after?: string): Promise<Result> {
    if (context.origin || (after !== undefined && !uuid(after))) return { status: 'denied' };
    return this.transaction(
      context,
      false,
      async (client) => {
        const rows = (
          await client.query<MailMaintenanceBinding>(
            `SELECT b.id AS binding_id,b.auth,$2=ANY(b.processing_providers) AS provider_allowed,
            (s.next_poll_at IS NULL OR s.next_poll_at<=clock_timestamp()) AS poll_due
            FROM cos.mail_bindings b JOIN cos.mail_states s ON s.scope_id=b.scope_id AND s.binding_id=b.id
            WHERE b.scope_id=$1 AND ($3::uuid IS NULL OR b.id>$3) ORDER BY b.id LIMIT 11`,
            [context.scopeId, context.provider, after ?? null],
          )
        ).rows;
        return { status: 'ok', items: rows.slice(0, 10), next_after: rows.length > 10 ? rows[9].binding_id : null };
      },
      false,
      true,
    );
  }
  /** Claim with the selected database clock, including failures before collection
   * starts. A claim never creates a capture or advances provider freshness. */
  async claimPoll(context: Context & { provider: string }, binding: string): Promise<Result> {
    if (context.origin || !uuid(binding)) return { status: 'denied' };
    return this.transaction(context, true, async (client) => {
      const result = await client.query(
        `UPDATE cos.mail_states s SET next_poll_at=clock_timestamp()+interval '5 minutes'
        FROM cos.mail_bindings b WHERE b.scope_id=s.scope_id AND b.id=s.binding_id
        AND s.scope_id=$1 AND s.binding_id=$2 AND b.auth='ready' AND $3=ANY(b.processing_providers)
        AND (s.next_poll_at IS NULL OR s.next_poll_at<=clock_timestamp()) RETURNING s.binding_id`,
        [context.scopeId, binding, context.provider],
      );
      return { status: 'ok', claimed: !!result.rowCount };
    });
  }
  /** Trusted host access loss only. A new link must use a fresh binding identity. */
  async setAuth(context: Context, binding: string, auth: Exclude<MailConnection['auth'], 'ready'>): Promise<Result> {
    if (context.origin || !uuid(binding) || !['expired', 'revoked', 'disconnected'].includes(auth))
      return { status: 'denied' };
    return this.transaction(
      context,
      true,
      async (client) => {
        const current = await this.binding(client, context, binding);
        if (!current) return { status: 'denied' };
        if (current.auth !== 'ready') return { status: 'ok', auth: current.auth };
        await client.query(
          'UPDATE cos.mail_bindings SET auth=$3,version=version+1,updated_at=clock_timestamp() WHERE scope_id=$1 AND id=$2',
          [context.scopeId, binding, auth],
        );
        return { status: 'ok', auth };
      },
      true,
      true,
    );
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
      let previous: MailCapture | null | undefined;
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
        previous = await this.previous(client, context, binding, state.current_capture);
        if (previous && captured.capturedAt < previous.window.capturedAt) return { status: 'conflict' };
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
        previous:
          previous === undefined ? await this.previous(client, context, binding, state.current_capture) : previous,
      };
    });
  }
  async publish(context: Context, binding: string, id: string, input: MailCapture): Promise<Result> {
    if (!uuid(binding) || !uuid(id) || !validMailCapture(input) || input.mode === 'retention')
      return { status: 'denied' };
    const capture = structuredClone(input);
    try {
      return await this.artifacts.exclusive((lease) =>
        this.transaction(context, true, this.publishOperation(context, binding, id, capture, lease), true),
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Artifact failures contain private paths and source content; the public boundary returns a fixed status.
    } catch {
      return { status: 'unavailable' };
    }
  }
  private publishOperation(
    context: Context,
    binding: string,
    id: string,
    capture: MailCapture,
    lease: ArtifactLease,
    retaining = false,
  ) {
    return async (client: PoolClient): Promise<Result> => {
      const b = await this.binding(client, context, binding);
      if (!b || (!retaining && b.auth !== 'ready') || b.mailbox_email !== capture.mailboxEmail)
        return { status: 'denied' };
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
        (!retaining && state.last_attempt !== id) ||
        state.current_capture !== attempt.base_capture
      )
        return { status: 'conflict' };
      if (state.history_cursor && BigInt(capture.historyId) < BigInt(state.history_cursor))
        return { status: 'conflict' };
      if (
        (
          await this.deniedMessageIds(
            client,
            context,
            binding,
            capture.messages.map((m) => m.id),
          )
        ).length
      )
        return { status: 'denied' };
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
        selection_id: old.get(message.id)?.selection_id ?? randomUUID(),
        source_id: old.get(message.id)?.source_id ?? null,
      }));
      const anchors = rows
        .filter((row) => !old.has(row.provider_message_id))
        .map((row) => {
          const metadata = {
            contract: 'cos-mail-selection-anchor/v1',
            binding_id: binding,
            selection_id: row.selection_id,
            provider_message_id: row.provider_message_id,
            first_capture_id: id,
            first_capture_digest: capture.digest,
          };
          return { id: row.selection_id, metadata, content_digest: digest(metadata) };
        });
      await client.query(
        `INSERT INTO cos.mail_captures(scope_id,binding_id,id,binding_version,status,capture_window,content_digest,metadata,result,completed_at)
              SELECT $1,$2,x.id,$3,'complete',$4,x.content_digest,x.metadata,jsonb_build_object('status','ok','selection_anchor',true),clock_timestamp()
              FROM jsonb_to_recordset($5::jsonb) AS x(id uuid,metadata jsonb,content_digest text)`,
        [context.scopeId, binding, b.version, JSON.stringify(capture.window), JSON.stringify(anchors)],
      );
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
      const present = new Set(capture.messages.map((m) => m.id)),
        retiredSources = previous
          .filter((r) => !present.has(r.provider_message_id) && r.source_id)
          .map((r) => r.source_id);
      await new MailEvidence(this.artifacts).publish(client, context, b, id, rows, lease, retiredSources);
      const { messages, ...metadata } = capture,
        result = {
          status: 'ok' as const,
          capture_id: id,
          message_count: messages.length,
          complete: capture.complete,
          limitations: capture.limitations,
          history_cursor: capture.historyId,
          ...(retaining ? { retention: true } : {}),
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
        retaining
          ? 'UPDATE cos.mail_states SET current_capture=$3,history_cursor=$4 WHERE scope_id=$1 AND binding_id=$2'
          : "UPDATE cos.mail_states SET current_capture=$3,history_cursor=$4,last_success_at=clock_timestamp(),next_poll_at=clock_timestamp()+interval '5 minutes' WHERE scope_id=$1 AND binding_id=$2",
        [context.scopeId, binding, id, capture.historyId],
      );
      await this.compactCaptures(client, context, binding);
      return result;
    };
  }
  private async deniedMessageIds(
    client: PoolClient,
    context: Context,
    binding: string,
    ids: string[],
  ): Promise<string[]> {
    if (!ids.length) return [];
    return (
      await client.query(
        `SELECT DISTINCT s.access_policy->>'provider_message_id' AS id FROM cos.sources s
      JOIN cos.revocation_tombstones t ON t.scope_id=s.scope_id AND t.source_id=s.id
      WHERE s.scope_id=$1 AND s.access_policy->>'mail_binding_id'=$2 AND s.access_policy->>'provider_message_id'=ANY($3::text[])
        AND COALESCE(t.provenance->>'origin','')<>'mail_selection_retired'`,
        [context.scopeId, binding, ids],
      )
    ).rows.map((row) => row.id);
  }
  async filterCapture(context: Context, binding: string, input: MailCapture): Promise<Result> {
    if (!uuid(binding) || !validMailCapture(input) || input.mode === 'retention') return { status: 'denied' };
    const capture = structuredClone(input);
    return this.transaction(context, false, async (client) => {
      const b = await this.binding(client, context, binding);
      if (!b || b.auth !== 'ready' || b.mailbox_email !== capture.mailboxEmail) return { status: 'denied' };
      const ids = [...new Set([...capture.messages.map((m) => m.id), ...capture.unsupported.map((u) => u.id)])];
      return {
        status: 'ok',
        capture: suppressMailCapture(capture, await this.deniedMessageIds(client, context, binding, ids)),
      };
    });
  }
  /** No Google or model access. This path may only tighten retention while a
   * scope is paused or source access is closed; it never reopens admission. */
  async maintain(context: Context, binding: string, id: string): Promise<Result> {
    if (context.origin || !uuid(binding) || !uuid(id)) return { status: 'denied' };
    try {
      return await this.artifacts.exclusive((lease) =>
        this.transaction(
          context,
          true,
          async (client) => {
            const b = await this.binding(client, context, binding);
            if (!b) return { status: 'denied' };
            const existing = (
              await client.query(
                'SELECT status,binding_version,result FROM cos.mail_captures WHERE scope_id=$1 AND binding_id=$2 AND id=$3',
                [context.scopeId, binding, id],
              )
            ).rows[0];
            if (existing)
              return existing.status === 'complete' &&
                existing.binding_version === b.version &&
                existing.result?.retention === true
                ? existing.result
                : { status: 'conflict' };
            const state = (
              await client.query(
                'SELECT current_capture FROM cos.mail_states WHERE scope_id=$1 AND binding_id=$2 FOR UPDATE',
                [context.scopeId, binding],
              )
            ).rows[0];
            const previous = await this.previous(client, context, binding, state?.current_capture ?? null);
            if (!previous) {
              await this.compactCaptures(client, context, binding);
              return { status: 'ok', retention: true, changed: false };
            }
            const at = (await client.query('SELECT clock_timestamp() AS now')).rows[0].now.getTime();
            const denied = await this.deniedMessageIds(
              client,
              context,
              binding,
              previous.messages.map((m) => m.id),
            );
            const capture = retainedMailCapture(previous, at, denied, b.auth !== 'ready');
            if (!validMailCapture(capture)) throw Error('mail_retention_invalid');
            if (!mailRetentionChanged(previous, capture)) {
              await this.compactCaptures(client, context, binding);
              return { status: 'ok', retention: true, changed: false };
            }
            await client.query(
              "INSERT INTO cos.mail_captures(scope_id,binding_id,id,binding_version,base_capture,status,capture_window) VALUES($1,$2,$3,$4,$5,'collecting',$6)",
              [context.scopeId, binding, id, b.version, state.current_capture, JSON.stringify(capture.window)],
            );
            return this.publishOperation(context, binding, id, capture, lease, true)(client);
          },
          true,
          true,
        ),
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Maintenance storage diagnostics and source bytes stay inside the trusted host.
    } catch {
      return { status: 'unavailable' };
    }
  }
  /** Historical completion receipts retain their content commitment/result, not
   * an ever-growing duplicate inventory. Current captures and FK anchors remain
   * intact; receipt records cannot be hydrated as a current capture. */
  private async compactCaptures(client: PoolClient, context: Context, binding: string) {
    const unreferenced = `NOT EXISTS(SELECT 1 FROM cos.mail_states s WHERE s.scope_id=c.scope_id AND s.binding_id=c.binding_id AND (s.current_capture=c.id OR s.last_attempt=c.id))
      AND NOT EXISTS(SELECT 1 FROM cos.mail_messages m WHERE m.scope_id=c.scope_id AND m.binding_id=c.binding_id AND (m.last_capture=c.id OR m.selection_id=c.id))`;
    await client.query(
      `UPDATE cos.mail_captures c SET metadata=jsonb_build_object('contract','cos-mail-capture-receipt/v1','mode',c.metadata->'mode','window',c.capture_window,'capture_digest',c.content_digest)
      WHERE c.scope_id=$1 AND c.binding_id=$2 AND c.status='complete' AND c.metadata->>'contract'='cos-mail-capture/v1' AND ${unreferenced}`,
      [context.scopeId, binding],
    );
    await client.query(
      `DELETE FROM cos.mail_captures c WHERE c.scope_id=$1 AND c.binding_id=$2 AND c.created_at<clock_timestamp()-interval '30 days' AND ${unreferenced}`,
      [context.scopeId, binding],
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
          `SELECT b.id AS binding_id,b.auth,b.permission_scopes,s.last_attempt_at,s.last_success_at,s.next_poll_at,s.current_capture,c.metadata,a.status AS attempt_status
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
  /** References only, from the committed selection. No provider thread expansion or raw body read. */
  async evidenceSnapshot(context: Context & { provider: string }, binding: string, thread?: string): Promise<Result> {
    if (!uuid(binding) || (thread !== undefined && !providerId(thread))) return { status: 'denied' };
    return this.transaction(context, false, async (client) => {
      const state = (
        await client.query(
          `SELECT ms.current_capture,ms.last_attempt,ms.last_success_at FROM cos.mail_bindings b
         JOIN cos.mail_states ms ON ms.scope_id=b.scope_id AND ms.binding_id=b.id
         WHERE b.scope_id=$1 AND b.id=$2 AND $3=ANY(b.processing_providers) AND b.auth='ready'
         AND b.permission_scopes=ARRAY[$4]::text[]`,
          [context.scopeId, binding, context.provider, GOOGLE_MAIL_READ_SCOPE],
        )
      ).rows[0];
      if (!state) return { status: 'denied' };
      const items = (
        await client.query(
          `SELECT mm.provider_message_id AS message_id,mm.provider_thread_id AS thread_id,mm.source_id,
         s.current_revision_id AS revision_id,s.version,
         (SELECT count(*)::int FROM cos.chunks ch WHERE ch.scope_id=s.scope_id AND ch.revision_id=s.current_revision_id) AS chunk_count,
         COALESCE(s.provenance->>'origin'='mail_message' AND s.status IN ('current','stale') AND $3=ANY(s.processing_providers)
           AND a.lifecycle='published' AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
           AND ${mailSourceAccess("ARRAY['mail:'||$2::text]")},false) AS readable
         FROM cos.mail_messages mm LEFT JOIN cos.sources s ON s.scope_id=mm.scope_id AND s.id=mm.source_id
         LEFT JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.id=s.current_revision_id
         LEFT JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
         WHERE mm.scope_id=$1 AND mm.binding_id=$2::uuid AND mm.last_capture=$4 AND ($5::text IS NULL OR mm.provider_thread_id=$5)
         ORDER BY mm.internal_date,mm.provider_message_id LIMIT 1001`,
          [context.scopeId, binding, context.provider, state.current_capture, thread ?? null],
        )
      ).rows;
      if (items.length > 1000) return { status: 'unavailable' };
      return { status: 'ok', binding_id: binding, ...state, items };
    });
  }
}
