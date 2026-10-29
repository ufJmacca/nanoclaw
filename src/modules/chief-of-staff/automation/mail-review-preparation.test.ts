import { expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { digest } from '../domain/contracts.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { MailReviewPreparation } from './mail-review-access.js';
import type { MailReviewInputs } from './mail-review-inputs.js';
import type { MailReviewRecord } from './mail-review-candidates.js';
import { MailReviewPreparer } from './mail-review-preparation.js';
import { log } from '../../../log.js';

function fixture() {
  const uuid = '11111111-1111-4111-8111-111111111111',
    now = Date.now();
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    provider: 'codex',
    generation: uuid,
  } as KnowledgeContext;
  const prepared = {
    id: uuid,
    version: 1,
    digest: digest('policy'),
    body: { readerBindingId: uuid, writerBindingId: uuid },
    inputs: null,
    captureId: uuid,
    captureDigest: digest('capture'),
    capturedAt: new Date(now - 1000).toISOString(),
    lastSuccessAt: new Date(now - 1000).toISOString(),
    coverage: 'stored_selection',
  } as MailReviewPreparation;
  const record: MailReviewRecord = {
    message: {
      id: 'aa',
      threadId: 'bb',
      historyId: '1',
      internalDate: now - 2000,
      labels: ['INBOX'],
      subject: 'Please review',
      from: 'person@example.test',
      to: 'owner@example.test',
      text: 'Could you review?',
      trust: 'untrusted_mail_evidence',
      attachmentsExcluded: 0,
      digest: digest('message'),
    },
    source_id: 'mail-aa',
    source_version: 1,
    revision_id: uuid,
    revision_digest: digest('revision'),
  };
  const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) } as unknown as PoolClient;
  let frozen: MailReviewInputs | undefined;
  const access = {
    preparation: vi.fn(async () => structuredClone(prepared)),
    freeze: vi.fn(async (_c, _ctx, _id, _g, _p, inputs: MailReviewInputs) => {
      frozen = structuredClone(inputs);
      return true;
    }),
  };
  const connector = {
    reviewSource: vi.fn(async (_ctx, _binding, _message, _window, current: () => Promise<boolean>) => {
      if (!(await current())) throw Error('not_current');
      return { id: 'aa', threadId: 'bb', historyId: '1', internalDate: now - 2000, observedAt: now, excluded: null };
    }),
  };
  const records = vi.fn(async () => [record]);
  const knowledge = { actionContextCurrent: vi.fn(async () => true) };
  const current = vi.fn(() => true);
  const database = { run: async <T>(op: (c: PoolClient) => Promise<T>) => op(client) };
  const preparer = new MailReviewPreparer({ database, access, knowledge, connector, records, current });
  const execute = (signal?: AbortSignal) => preparer.execute(context, 'a'.repeat(64), 1, signal);
  return {
    context,
    prepared,
    record,
    access,
    connector,
    records,
    knowledge,
    current,
    client,
    execute,
    frozen: () => frozen,
  };
}

it('loads the selected capture, rechecks metadata, and freezes references without returning Mail bodies', async () => {
  const f = fixture();
  expect(await f.execute()).toEqual({ status: 'ok' });
  expect(f.records).toHaveBeenCalledWith(f.client, f.context, f.prepared.body.readerBindingId, f.prepared.captureId);
  expect(f.connector.reviewSource).toHaveBeenCalledTimes(1);
  expect(f.frozen()?.candidates).toMatchObject([{ source_message_id: 'aa', thread_id: 'bb' }]);
  expect(JSON.stringify(f.frozen())).not.toContain('Could you review?');
  expect(f.client.query).toHaveBeenCalledWith('COMMIT');
});
it('reconciles an already frozen run without reselection or provider calls', async () => {
  const f = fixture();
  await f.execute();
  f.prepared.inputs = f.frozen()!;
  f.records.mockClear();
  f.connector.reviewSource.mockClear();
  f.access.freeze.mockClear();
  expect(await f.execute()).toEqual({ status: 'ok' });
  expect(f.records).not.toHaveBeenCalled();
  expect(f.connector.reviewSource).not.toHaveBeenCalled();
  expect(f.access.freeze).not.toHaveBeenCalled();
});
it('excludes freshly identified lists and automatic mail before freezing', async () => {
  const f = fixture();
  f.connector.reviewSource.mockImplementation(async () => ({
    id: 'aa',
    threadId: 'bb',
    historyId: '1',
    internalDate: f.record.message.internalDate,
    observedAt: Date.now(),
    excluded: 'bulk_mail' as never,
  }));
  expect(await f.execute()).toEqual({ status: 'ok' });
  expect(f.frozen()).toMatchObject({ candidates: [], excluded_threads: 1, unexamined_threads: 0 });
});
it('refuses a changed provider revision rather than presenting a previously captured message as current', async () => {
  const f = fixture();
  f.connector.reviewSource.mockImplementation(async () => ({
    id: 'aa',
    threadId: 'bb',
    historyId: '2',
    internalDate: f.record.message.internalDate,
    observedAt: Date.now(),
    excluded: null,
  }));
  expect(await f.execute()).toEqual({ status: 'denied' });
  expect(f.access.freeze).not.toHaveBeenCalled();
});
it('losing the selected capture during the metadata await prevents freezing', async () => {
  const f = fixture();
  const original = f.connector.reviewSource.getMockImplementation()!;
  f.connector.reviewSource.mockImplementation(async (...args) => {
    const value = await original(...args);
    f.prepared.captureId = '22222222-2222-4222-8222-222222222222';
    return value;
  });
  expect(await f.execute()).toEqual({ status: 'denied' });
  expect(f.access.freeze).not.toHaveBeenCalled();
});
it('never reads provider metadata or selects draft candidates from an aged capture', async () => {
  const f = fixture();
  f.prepared.coverage = 'stale';
  expect(await f.execute()).toEqual({ status: 'ok' });
  expect(f.connector.reviewSource).not.toHaveBeenCalled();
  expect(f.frozen()).toMatchObject({ candidates: [], coverage: 'stale', unexamined_threads: 1 });
});
it('rejects scheduled/model callers, lost admission, and cancelled preparation before effects', async () => {
  const f = fixture();
  f.context.origin = { kind: 'schedule', runId: 'a'.repeat(64), generation: 1 };
  expect(await f.execute()).toEqual({ status: 'denied' });
  expect(f.records).not.toHaveBeenCalled();
  delete f.context.origin;
  f.current.mockReturnValue(false);
  expect(await f.execute()).toEqual({ status: 'denied' });
  f.current.mockReturnValue(true);
  const controller = new AbortController();
  controller.abort();
  expect(await f.execute(controller.signal)).toEqual({ status: 'denied' });
  expect(f.access.freeze).not.toHaveBeenCalled();
});
it('rolls back and withholds success when the final freeze loses authority', async () => {
  const f = fixture();
  f.access.freeze.mockResolvedValue(false);
  expect(await f.execute()).toEqual({ status: 'denied' });
  expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
});

it.each(['context', 'selection', 'provider_revision', 'capture_changed', 'freeze'] as const)(
  'records only the fixed %s stage when scheduled preparation is denied',
  async (stage) => {
    const f = fixture(),
      warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
    try {
      if (stage === 'context') f.knowledge.actionContextCurrent.mockResolvedValue(false);
      if (stage === 'selection') f.access.preparation.mockResolvedValue(null as never);
      if (stage === 'provider_revision')
        f.connector.reviewSource.mockImplementation(async () => ({
          id: 'aa',
          threadId: 'bb',
          historyId: 'changed',
          internalDate: f.record.message.internalDate,
          observedAt: Date.now(),
          excluded: null,
        }));
      if (stage === 'capture_changed') {
        const original = f.connector.reviewSource.getMockImplementation()!;
        f.connector.reviewSource.mockImplementation(async (...args) => {
          const result = await original(...args);
          f.prepared.captureId = '22222222-2222-4222-8222-222222222222';
          return result;
        });
      }
      if (stage === 'freeze') f.access.freeze.mockResolvedValue(false);
      expect(await f.execute()).toEqual({ status: 'denied' });
      expect(warning).toHaveBeenCalledExactlyOnceWith('CoS Mail review preparation closed', {
        stage,
        status: 'denied',
      });
      if (stage === 'context' || stage === 'freeze') expect(f.client.query).toHaveBeenCalledWith('ROLLBACK');
      if (stage !== 'freeze') expect(f.access.freeze).not.toHaveBeenCalled();
    } finally {
      warning.mockRestore();
    }
  },
);

it('withholds private provider errors from preparation diagnostics and preserves an unavailable outcome', async () => {
  const f = fixture(),
    warning = vi.spyOn(log, 'warn').mockImplementation(() => {});
  try {
    f.connector.reviewSource.mockRejectedValue(new Error('private mailbox and credential diagnostic'));
    expect(await f.execute()).toEqual({ status: 'unavailable' });
    expect(warning).toHaveBeenCalledExactlyOnceWith('CoS Mail review preparation closed', {
      stage: 'provider_metadata',
      status: 'unavailable',
    });
    expect(f.access.freeze).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});

it('keeps preparation denied even if diagnostic output fails', async () => {
  const f = fixture(),
    warning = vi.spyOn(log, 'warn').mockImplementation(() => {
      throw Error('logger unavailable');
    });
  try {
    f.knowledge.actionContextCurrent.mockResolvedValue(false);
    expect(await f.execute()).toEqual({ status: 'denied' });
    expect(f.access.freeze).not.toHaveBeenCalled();
  } finally {
    warning.mockRestore();
  }
});
