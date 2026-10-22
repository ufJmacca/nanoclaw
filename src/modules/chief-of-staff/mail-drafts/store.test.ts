import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import type { BoundedDatabase } from '../store/client.js';
import { DatabaseUnavailable } from '../store/client.js';
import type { KnowledgeStore } from '../knowledge/store.js';
import { digest } from '../domain/contracts.js';
import { GOOGLE_MAIL_READ_SCOPE } from '../calendar/oauth-core.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
import type { DraftJournal } from './journal.js';
import type { MailDraftBinding } from './binding.js';
import { MailDraftStore } from './store.js';

const context = {
  scopeId: 'scope',
  ownerId: 'owner',
  agentGroupId: 'group',
  sessionId: 'session',
  ingressId: 'turn',
  provider: 'codex',
  generation: '33333333-3333-4333-8333-333333333333',
};
const requestId = '11111111-1111-4111-8111-111111111111';
const input = {
  writer_binding_id: '22222222-2222-4222-8222-222222222222',
  source_message_id: 'aa01',
  reply_text: 'PRIVATE_REPLY_BODY',
};
const operationId = 'a'.repeat(64);
function fixture() {
  const authority = {
    bindingDigest: digest('native'),
    contextGeneration: context.generation,
    draftProfileDigest: digest('cos-mail-draft/v1'),
    provider: { profile: 'subscription', model: 'fixture', policyDigest: digest('policy') },
  };
  const body: MailDraftBinding = {
    format: 'cos-mail-draft-binding/v1',
    provider: 'fixture',
    readerBindingId: '44444444-4444-4444-8444-444444444444',
    mailboxDigest: digest('owner@example.test'),
    writerClientDigest: digest('writer'),
    readerClientDigest: digest('reader'),
    credentialReference: '55555555-5555-4555-8555-555555555555',
    nativeBindingDigest: authority.bindingDigest,
    journalGeneration: '66666666-6666-4666-8666-666666666666',
    maxPerDay: 5,
    timeZone: 'Australia/Sydney',
    replyMode: 'plain_text_reply',
    permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
    recoveryProofDigest: digest('actual recovery'),
  };
  const row = {
    id: input.writer_binding_id,
    version: 1,
    body,
    digest: digest(body),
    consent_ref: digest('consent'),
    reader_provider: 'fixture',
    mailbox_email: 'owner@example.test',
    reader_scopes: [GOOGLE_MAIL_READ_SCOPE],
    reader_auth: 'ready',
    processing_providers: ['codex'],
    reader_credential_ref: '77777777-7777-4777-8777-777777777777',
  };
  const source = {
    source_id: 'source',
    source_version: 1,
    revision_id: 'revision',
    revision_digest: digest('source'),
    thread_id: 'bb02',
    current_capture: 'capture',
    internal_date_ms: 1792713600000,
  };
  const operations = new Map<string, Record<string, unknown>>();
  let scope = true,
    readable = true,
    retained = true,
    host = true,
    active = true,
    loseCommit = false;
  const statements: Array<{ sql: string; values: unknown[] }> = [];
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values: structuredClone(values) });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) {
      if (sql === 'COMMIT' && loseCommit) {
        loseCommit = false;
        throw new DatabaseUnavailable('pending');
      }
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM cos.scopes'))
      return { rows: scope ? [{ id: context.scopeId }] : [], rowCount: scope ? 1 : 0 };
    if (sql.includes('FROM cos.mail_draft_writer_bindings')) return { rows: [structuredClone(row)], rowCount: 1 };
    if (sql.includes('FROM cos.mail_messages'))
      return { rows: readable ? [structuredClone(source)] : [], rowCount: readable ? 1 : 0 };
    if (sql.startsWith('INSERT INTO cos.operations')) {
      const key = String(values[0]) + ':' + String(values[1]);
      if (operations.has(key)) return { rows: [], rowCount: 0 };
      operations.set(key, { scope_id: values[2], method: values[3], payload_hash: values[4], result: null });
      return { rows: [{ request_id: values[1] }], rowCount: 1 };
    }
    if (sql.includes('FROM cos.operations')) {
      const row = operations.get(String(values[0]) + ':' + String(values[1]));
      return { rows: row ? [structuredClone(row)] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE cos.operations')) {
      const operation = operations.get(String(values[0]) + ':' + String(values[1]));
      if (operation) operation.result = JSON.parse(String(values[2]));
      return { rows: [], rowCount: operation ? 1 : 0 };
    }
    throw Error('unexpected fixture query');
  });
  let inTransaction = false;
  const database = {
    run: async <T>(run: (client: PoolClient) => Promise<T>) => {
      inTransaction = true;
      try {
        return await run({ query } as unknown as PoolClient);
      } finally {
        inTransaction = false;
      }
    },
  } as BoundedDatabase;
  const create = vi.fn(async () => {
    expect(inTransaction).toBe(false);
    return { status: 'verified' as const, operationId };
  });
  const status = vi.fn(async () => {
    expect(inTransaction).toBe(false);
    return { status: 'edited' as const, operationId };
  });
  const record = {
    scopeId: context.scopeId,
    bindingId: input.writer_binding_id,
    sourceMessageId: 'aa01',
    threadId: 'bb02',
    mailboxDigest: body.mailboxDigest,
  };
  const journal = {
    assertCurrent: vi.fn(),
    generation: body.journalGeneration,
    find: vi.fn(() => record),
  } as unknown as DraftJournal;
  const matches = vi.fn(() => host);
  let current: () => Promise<boolean> = async () => false;
  const writer = vi.fn((_context, _binding, recheck: () => Promise<boolean>) => {
    current = recheck;
    return { create, status };
  });
  const knowledge = { actionContextCurrent: vi.fn(async () => retained) } as unknown as KnowledgeStore;
  const dependencies = { journal, authority: vi.fn(() => (active ? authority : null)), matches, writer };
  const store = new MailDraftStore(database, knowledge, dependencies);
  return {
    store,
    database,
    dependencies,
    row,
    body,
    source,
    operations,
    query,
    statements,
    create,
    status,
    writer,
    journal,
    knowledge,
    current: () => current(),
    scope: (v: boolean) => {
      scope = v;
    },
    readable: (v: boolean) => {
      readable = v;
    },
    retained: (v: boolean) => {
      retained = v;
    },
    host: (v: boolean) => {
      host = v;
    },
    active: (v: boolean) => {
      active = v;
    },
    loseCommit: () => {
      loseCommit = true;
    },
    record,
  };
}

it('commits stable request identity before contacting a provider and stores no reply body', async () => {
  const f = fixture();
  expect(await f.store.create(context, requestId, input)).toEqual({
    status: 'ok',
    draft_status: 'verified',
    operation_id: operationId,
  });
  expect(f.create).toHaveBeenCalledWith({ requestId, sourceMessageId: 'aa01', text: 'PRIVATE_REPLY_BODY' });
  const persisted = JSON.stringify([...f.operations.values()]);
  expect(persisted).not.toContain('PRIVATE_REPLY_BODY');
  expect(persisted).toContain(operationId);
  expect(f.statements.findIndex((s) => s.sql === 'COMMIT')).toBeGreaterThan(
    f.statements.findIndex((s) => s.sql.startsWith('INSERT INTO cos.operations')),
  );
});
it('rechecks a saved result rather than repeating creation or claiming stale verified content', async () => {
  const f = fixture();
  await f.store.create(context, requestId, input);
  expect(await f.store.create(context, requestId, input)).toEqual({
    status: 'ok',
    draft_status: 'edited',
    operation_id: operationId,
  });
  expect(f.create).toHaveBeenCalledTimes(1);
  expect(f.status).toHaveBeenCalledWith(operationId);
});
it('cannot use a stored request receipt to read a different source effect from the journal', async () => {
  const f = fixture();
  await f.store.create(context, requestId, input);
  f.record.sourceMessageId = 'cc03';
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'denied' });
  expect(f.status).not.toHaveBeenCalled();
});
it('rejects the same request ID with changed text, binding, source, method or scope', async () => {
  const f = fixture();
  await f.store.create(context, requestId, input);
  expect(await f.store.create(context, requestId, { ...input, reply_text: 'changed' })).toEqual({ status: 'conflict' });
  const old = [...f.operations.values()][0];
  old.method = 'cos_change_propose';
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'conflict' });
  old.method = 'cos_mail_draft_create';
  old.scope_id = 'foreign';
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'conflict' });
  expect(f.create).toHaveBeenCalledTimes(1);
});
it('never invokes a provider after an uncertain database commit; a later retry can reconcile', async () => {
  const f = fixture();
  f.loseCommit();
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'pending' });
  expect(f.create).not.toHaveBeenCalled();
  expect((await f.store.create(context, requestId, input)).status).toBe('ok');
  expect(f.create).toHaveBeenCalledTimes(1);
});
it.each(['scope', 'readable', 'retained', 'host', 'active'] as const)(
  'denies before provider work when current %s authority is lost',
  async (key) => {
    const f = fixture();
    f[key](false);
    expect(await f.store.create(context, requestId, input)).toEqual({ status: 'denied' });
    expect(f.create).not.toHaveBeenCalled();
  },
);
it.each(['native', 'digest', 'mailbox', 'readonly_scope', 'provider', 'journal'] as const)(
  'rejects mismatched %s policy metadata',
  async (key) => {
    const f = fixture();
    if (key === 'native') f.row.body.nativeBindingDigest = digest('foreign');
    if (key === 'digest') f.row.digest = digest('bad revision');
    if (key === 'mailbox') f.row.mailbox_email = 'foreign@example.test';
    if (key === 'readonly_scope') f.row.reader_scopes = [GOOGLE_MAIL_DRAFT_SCOPE];
    if (key === 'provider') f.row.reader_provider = 'google';
    if (key === 'journal') f.row.body.journalGeneration = '88888888-8888-4888-8888-888888888888';
    if (key !== 'digest') f.row.digest = digest(f.row.body);
    expect(await f.store.create(context, requestId, input)).toEqual({ status: 'denied' });
    expect(f.create).not.toHaveBeenCalled();
  },
);
it('supplies the adapter a fresh database, source, native and host-policy recheck', async () => {
  const f = fixture();
  await f.store.create(context, requestId, input);
  expect(await f.current()).toBe(true);
  f.readable(false);
  expect(await f.current()).toBe(false);
  f.readable(true);
  f.source.source_version++;
  expect(await f.current()).toBe(false);
});
it('withholds provider success if authority changes while the request is in flight', async () => {
  const f = fixture();
  f.create.mockImplementationOnce(async () => {
    f.active(false);
    return { status: 'verified', operationId };
  });
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'denied' });
  expect([...f.operations.values()][0].result).toBeNull();
});
it('status requires the current owner policy and current selected source; foreign effects remain private', async () => {
  const f = fixture();
  expect(await f.store.status(context, { operation_id: operationId })).toEqual({
    status: 'ok',
    draft_status: 'edited',
    operation_id: operationId,
  });
  f.record.scopeId = 'foreign';
  expect(await f.store.status(context, { operation_id: operationId })).toEqual({ status: 'denied' });
  expect(f.status).toHaveBeenCalledTimes(1);
});
it('denies automatic origins, foreign retained generation and malformed requests before database access', async () => {
  const f = fixture();
  expect(
    await f.store.create({ ...context, origin: { kind: 'schedule', runId: 'run', generation: 1 } }, requestId, input),
  ).toEqual({ status: 'denied' });
  expect(
    await f.store.create({ ...context, generation: '88888888-8888-4888-8888-888888888888' }, requestId, input),
  ).toEqual({ status: 'denied' });
  expect(await f.store.create(context, requestId, { ...input, to: 'injected' } as typeof input)).toEqual({
    status: 'denied',
  });
  expect(f.query).not.toHaveBeenCalled();
});
it('has no local authority fallback when PostgreSQL is unavailable', async () => {
  const f = fixture();
  f.query.mockRejectedValueOnce(new DatabaseUnavailable());
  expect(await f.store.create(context, requestId, input)).toEqual({ status: 'unavailable' });
  expect(f.create).not.toHaveBeenCalled();
});
