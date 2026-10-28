import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { initializeTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import type { DraftJournal } from '../mail-drafts/journal.js';
import {
  mailReviewProfileName,
  readMailReviewHostProfile,
  type MailReviewHostProfile,
} from '../automation/mail-review-profile.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { publishReboundMailReview } from './mail-review-rebind-publication.js';

const resources: Array<{ root: string; journal: DraftJournal }> = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const { root, journal } of resources.splice(0)) {
    journal.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture(enabled = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-rebind-')),
    installation = digest('synthetic installation'),
    journal = initializeTargetDraftJournal(root, installation);
  resources.push({ root, journal });
  const binding: CosBinding = {
    scopeId: 'chief-of-staff',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
    messagingGroupId: 'messages',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
    botId: 'bot',
  };
  const previous: MailReviewHostProfile = {
    format: 'cos-mail-review-host/v1',
    installationDigest: installation,
    journalGeneration: journal.generation,
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    sessionId: binding.sessionId,
    agentGroupId: binding.agentGroupId,
    id: randomUUID(),
    version: 1,
    binding: {
      format: 'cos-mail-review-binding/v1',
      provider: 'google',
      readerBindingId: randomUUID(),
      writerBindingId: randomUUID(),
      writerVersion: 1,
      writerDigest: digest('old writer'),
      writerConsentRef: digest('old consent'),
      nativeBindingDigest: digest(binding),
      mailboxDigest: digest('same mailbox'),
      contextGeneration: randomUUID(),
      morningScheduleId: randomUUID(),
      afternoonScheduleId: randomUUID(),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    },
  };
  const profile = structuredClone(previous);
  profile.version = 2;
  Object.assign(profile.binding, {
    readerBindingId: randomUUID(),
    writerBindingId: randomUUID(),
    writerDigest: digest('new writer'),
    writerConsentRef: digest('new consent'),
    contextGeneration: randomUUID(),
  });
  const head = journal.publishReviewPolicyPin(
    {
      requestId: randomUUID(),
      expectedRevision: 0,
      enabled,
      pin: { scopeId: previous.scopeId, policyId: previous.id, policyVersion: 1, profileDigest: digest(previous) },
    },
    () => {},
  );
  const file = path.join(root, 'mail-drafts', mailReviewProfileName(binding.scopeId));
  writeAtomic(path.dirname(file), path.basename(file), previous);
  const at = Date.parse('2026-10-28T04:00:00Z');
  for (let index = 1; index <= 5; index++) {
    const effect = journal.reserve(
      {
        scopeId: binding.scopeId,
        bindingId: previous.binding.writerBindingId,
        contextGeneration: previous.binding.contextGeneration,
        mailboxDigest: previous.binding.mailboxDigest,
        sourceMessageId: 'aa0' + index,
        threadId: 'bb0' + index,
        requestId: randomUUID(),
        contentDigest: digest('reply ' + index),
      },
      at + index * 20,
    ).record;
    if (index === 1) {
      journal.acknowledge(effect.operationId, { draftId: 'draft-one', messageId: 'cc01' }, at + 21);
      journal.observe(
        effect.operationId,
        {
          state: 'verified',
          draftId: 'draft-one',
          messageId: 'cc01',
          threadId: 'bb01',
          contentDigest: effect.contentDigest,
        },
        at + 22,
      );
    }
  }
  const effects = () => {
      const db = new Database(path.join(journal.root, 'effects.sqlite'), { readonly: true, fileMustExist: true });
      try {
        return db.prepare('SELECT * FROM effects ORDER BY operation_id').all();
      } finally {
        db.close();
      }
    },
    before = effects();
  const manifest = {
    format: 'cos-mail-review-rebind/v1',
    expectedRevision: head.revision,
    expectedPinDigest: digest(head),
    previousProfileDigest: digest(previous),
    profile,
  };
  const sql = vi.fn(async (ready: () => Promise<void>) => {
    await ready();
  });
  const options = {
    targetRoot: root,
    installationDigest: installation,
    journal,
    binding,
    manifest,
    requestId: randomUUID(),
    currentGeneration: profile.binding.contextGeneration,
    ready: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
    writePolicy: sql,
  };
  const requestFile = path.join(root, 'mail-review-policy-admin', options.requestId, 'rebind-request.json');
  const disable = () => {
    const current = journal.reviewPolicyPin(binding.scopeId)!;
    return journal.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision: current.revision,
        enabled: false,
        pin: {
          scopeId: current.scopeId,
          policyId: current.policyId,
          policyVersion: current.policyVersion,
          profileDigest: current.profileDigest,
        },
      },
      () => {},
    );
  };
  return {
    root,
    journal,
    binding,
    previous,
    profile,
    head,
    file,
    manifest,
    options,
    sql,
    requestFile,
    before,
    effects,
    disable,
    publish: () => publishReboundMailReview(options),
  };
}

it('commits SQL before the new pin and profile, and reconciles only the same request', async () => {
  const f = fixture();
  f.sql.mockImplementation(async (ready) => {
    await ready();
    expect(fs.existsSync(f.requestFile)).toBe(true);
    if (f.sql.mock.calls.length === 1) {
      expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
      expect(readPrivate(f.file)).toEqual(f.previous);
    }
  });
  const head = await f.publish();
  expect(head).toMatchObject({ revision: 2, policyVersion: 2, enabled: true, profileDigest: digest(f.profile) });
  expect(readMailReviewHostProfile(f.root, f.options.installationDigest, f.journal, f.binding.scopeId)).toEqual(
    f.profile,
  );
  expect(await f.publish()).toEqual(head);
  expect(f.effects()).toEqual(f.before);
  const calls = f.sql.mock.calls.length;
  await expect(publishReboundMailReview({ ...f.options, requestId: randomUUID() })).rejects.toThrow();
  expect(f.sql).toHaveBeenCalledTimes(calls);
});
it('preserves an independently disabled policy while replacing its consent references', async () => {
  const f = fixture(false);
  expect((await f.publish()).enabled).toBe(false);
  expect(readPrivate(f.file)).toEqual(f.profile);
  expect(readMailReviewHostProfile(f.root, f.options.installationDigest, f.journal, f.binding.scopeId)).toBeNull();
  expect(f.effects()).toEqual(f.before);
});
it('never refunds old daily reservations or recreates an old draft under the new writer', async () => {
  const f = fixture();
  await f.publish();
  const old = f.journal.findSource(f.previous.binding.mailboxDigest, 'aa01')!;
  expect(
    f.journal.reserve(
      {
        scopeId: old.scopeId,
        bindingId: f.profile.binding.writerBindingId,
        contextGeneration: f.profile.binding.contextGeneration,
        mailboxDigest: old.mailboxDigest,
        sourceMessageId: old.sourceMessageId,
        threadId: old.threadId,
        requestId: randomUUID(),
        contentDigest: old.contentDigest,
      },
      Date.parse('2026-10-28T04:01:00Z'),
    ),
  ).toMatchObject({ created: false, record: old });
  await expect(async () =>
    f.journal.reserve(
      {
        scopeId: f.binding.scopeId,
        bindingId: f.profile.binding.writerBindingId,
        contextGeneration: f.profile.binding.contextGeneration,
        mailboxDigest: f.profile.binding.mailboxDigest,
        sourceMessageId: 'aa06',
        threadId: 'bb06',
        requestId: randomUUID(),
        contentDigest: digest('sixth'),
      },
      Date.parse('2026-10-28T04:02:00Z'),
    ),
  ).rejects.toThrow('daily_limit');
  expect(f.effects()).toEqual(f.before);
});
it('preserves the old pin and profile on uncertain SQL, then reconciles the original operation', async () => {
  const f = fixture();
  f.sql.mockRejectedValueOnce(Error('synthetic lost SQL acknowledgement'));
  await expect(f.publish()).rejects.toThrow();
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
  expect(readPrivate(f.file)).toEqual(f.previous);
  expect((await f.publish()).revision).toBe(2);
  expect(f.effects()).toEqual(f.before);
});
it('reconciles a new pin after its acknowledgement was lost without incrementing it twice', async () => {
  const f = fixture(),
    original = f.journal.publishReviewPolicyPin.bind(f.journal);
  const fault = vi.spyOn(f.journal, 'publishReviewPolicyPin').mockImplementationOnce((...args) => {
    original(...args);
    throw Error('synthetic lost pin acknowledgement');
  });
  await expect(f.publish()).rejects.toThrow();
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.revision).toBe(2);
  expect(readPrivate(f.file)).toEqual(f.previous);
  expect(() => readMailReviewHostProfile(f.root, f.options.installationDigest, f.journal, f.binding.scopeId)).toThrow();
  fault.mockRestore();
  expect((await f.publish()).revision).toBe(2);
  expect(readPrivate(f.file)).toEqual(f.profile);
  expect(f.effects()).toEqual(f.before);
});
it('finishes interrupted profile publication using only the original request', async () => {
  const f = fixture(),
    rename = fs.renameSync;
  const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to) === f.file) throw Error('synthetic profile publication failure');
    return rename(from, to);
  });
  await expect(f.publish()).rejects.toThrow();
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.revision).toBe(2);
  expect(readPrivate(f.file)).toEqual(f.previous);
  fault.mockRestore();
  expect((await f.publish()).revision).toBe(2);
  expect(readPrivate(f.file)).toEqual(f.profile);
});
it('never replaces a concurrently changed profile', async () => {
  const f = fixture(),
    foreign = { ...f.previous, version: 3 };
  f.sql.mockImplementation(async (ready) => {
    await ready();
    writeAtomic(path.dirname(f.file), path.basename(f.file), foreign);
  });
  await expect(f.publish()).rejects.toThrow();
  expect(readPrivate(f.file)).toEqual(foreign);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
  expect(f.effects()).toEqual(f.before);
});
it('does not override an owner disable during SQL or by replaying a completed operation', async () => {
  const f = fixture();
  f.sql.mockImplementation(async (ready) => {
    await ready();
    f.disable();
  });
  await expect(f.publish()).rejects.toThrow();
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.enabled).toBe(false);
  expect(readPrivate(f.file)).toEqual(f.previous);
  const g = fixture();
  await g.publish();
  const disabled = g.disable(),
    calls = g.sql.mock.calls.length;
  await expect(g.publish()).rejects.toThrow();
  expect(g.sql).toHaveBeenCalledTimes(calls);
  expect(g.journal.reviewPolicyPin(g.binding.scopeId)).toEqual(disabled);
});
it('withdraws before publication when owner readiness or the request changes across SQL', async () => {
  for (const reason of ['owner', 'manifest'] as const) {
    const f = fixture();
    let active = true;
    f.options.assertAuthority.mockImplementation(() => {
      if (!active) throw Error('synthetic owner lease expired');
    });
    f.sql.mockImplementation(async (ready) => {
      await ready();
      if (reason === 'owner') active = false;
      else f.options.manifest.profile.binding.writerConsentRef = digest('changed consent');
    });
    await expect(f.publish()).rejects.toThrow();
    expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
    expect(readPrivate(f.file)).toEqual(f.previous);
  }
});
it('does not create a request or call SQL when fresh readiness is already unavailable', async () => {
  const f = fixture();
  f.options.ready.mockRejectedValue(Error('synthetic expired maintenance'));
  await expect(f.publish()).rejects.toThrow();
  expect(fs.existsSync(f.requestFile)).toBe(false);
  expect(f.sql).not.toHaveBeenCalled();
  expect(f.effects()).toEqual(f.before);
});

it.each([null, false, 0])('never replaces an existing corrupt request whose contents are %s', async (corrupt) => {
  const f = fixture();
  f.sql.mockRejectedValueOnce(Error('synthetic lost SQL acknowledgement'));
  await expect(f.publish()).rejects.toThrow();
  writeAtomic(path.dirname(f.requestFile), path.basename(f.requestFile), corrupt);
  const calls = f.sql.mock.calls.length;
  await expect(f.publish()).rejects.toThrow();
  expect(f.sql).toHaveBeenCalledTimes(calls);
  expect(readPrivate(f.requestFile)).toEqual(corrupt);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toEqual(f.head);
  expect(f.effects()).toEqual(f.before);
});

it('does not treat copied recovery metadata as acknowledgement of a different request', async () => {
  const f = fixture();
  await f.publish();
  const requestId = randomUUID(),
    directory = path.join(f.root, 'mail-review-policy-admin', requestId);
  fs.mkdirSync(directory, { mode: 0o700 });
  const copied = readPrivate<Record<string, unknown>>(f.requestFile);
  writeAtomic(directory, 'rebind-request.json', { ...copied, requestId });
  const calls = f.sql.mock.calls.length;
  await expect(publishReboundMailReview({ ...f.options, requestId })).rejects.toThrow();
  expect(f.sql).toHaveBeenCalledTimes(calls);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.revision).toBe(2);
  expect(f.effects()).toEqual(f.before);
});

it('retries profile durability before acknowledging an already visible replacement', async () => {
  const f = fixture(),
    sync = fs.fsyncSync;
  const fault = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (
      fs.readlinkSync('/proc/self/fd/' + fd) === path.dirname(f.file) &&
      digest(readPrivate(f.file)) === digest(f.profile)
    )
      throw Error('synthetic directory sync failure');
    return sync(fd);
  });
  await expect(f.publish()).rejects.toThrow();
  expect(readPrivate(f.file)).toEqual(f.profile);
  await expect(f.publish()).rejects.toThrow();
  fault.mockRestore();
  expect((await f.publish()).revision).toBe(2);
  expect(f.effects()).toEqual(f.before);
});
