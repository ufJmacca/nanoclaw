import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
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
import { writeAtomic } from './target-state.js';
import { publishInitialMailReview } from './mail-review-publication.js';

const roots: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-publish-'));
  roots.push(root);
  const installation = digest('fixture installation'),
    journal = initializeTargetDraftJournal(root, installation);
  journals.push(journal);
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
  const profile: MailReviewHostProfile = {
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
      writerDigest: digest('writer'),
      writerConsentRef: digest('consent'),
      nativeBindingDigest: digest(binding),
      mailboxDigest: digest('mailbox'),
      contextGeneration: randomUUID(),
      morningScheduleId: randomUUID(),
      afternoonScheduleId: randomUUID(),
      timeZone: 'Australia/Sydney',
      maxCandidateThreads: 10,
      maxModelAttempts: 3,
      maxDraftsPerDay: 5,
    },
  };
  const file = path.join(root, 'mail-drafts', mailReviewProfileName(binding.scopeId));
  const sql = vi.fn(async (ready: () => Promise<void>) => {
    await ready();
  });
  const options = {
    targetRoot: root,
    installationDigest: installation,
    journal,
    binding,
    profile,
    requestId: randomUUID(),
    ready: vi.fn(async () => {}),
    assertAuthority: vi.fn(),
    writePolicy: sql,
  };
  const pin = (revision: number, enabled: boolean) =>
    journal.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision: revision,
        enabled,
        pin: { scopeId: profile.scopeId, policyId: profile.id, policyVersion: 1, profileDigest: digest(profile) },
      },
      () => {},
    );
  return { root, journal, binding, profile, file, sql, options, pin, publish: () => publishInitialMailReview(options) };
}
it('publishes SQL before the independent pin and private file, and reconciles only the original request', async () => {
  const f = fixture();
  f.sql.mockImplementation(async (ready) => {
    await ready();
    if (f.sql.mock.calls.length === 1) {
      expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
      expect(fs.existsSync(f.file)).toBe(false);
    }
  });
  const head = await f.publish();
  expect(head).toMatchObject({ revision: 1, enabled: true, profileDigest: digest(f.profile) });
  expect(readMailReviewHostProfile(f.root, f.options.installationDigest, f.journal, f.binding.scopeId)).toEqual(
    f.profile,
  );
  expect(await f.publish()).toEqual(head);
  await expect(publishInitialMailReview({ ...f.options, requestId: randomUUID() })).rejects.toThrow(
    'revision_conflict',
  );
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.revision).toBe(1);
});
it('leaves runtime access closed after an uncertain SQL write', async () => {
  const f = fixture();
  f.sql.mockRejectedValue(Error('fixture lost SQL acknowledgement'));
  await expect(f.publish()).rejects.toThrow('lost SQL');
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
  expect(fs.existsSync(f.file)).toBe(false);
});
it('does not overwrite a concurrently changed profile file', async () => {
  const f = fixture();
  f.sql.mockImplementation(async (ready) => {
    await ready();
    writeAtomic(path.dirname(f.file), path.basename(f.file), { ...f.profile, version: 2 });
  });
  await expect(f.publish()).rejects.toThrow('changed');
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
  expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).version).toBe(2);
});
it('cannot reactivate a policy disabled while SQL completes or by replaying an earlier successful request', async () => {
  const f = fixture();
  f.sql.mockImplementation(async (ready) => {
    await ready();
    f.pin(0, false);
  });
  await expect(f.publish()).rejects.toThrow('changed');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.enabled).toBe(false);
  const g = fixture();
  await g.publish();
  g.pin(1, false);
  g.sql.mockClear();
  await expect(g.publish()).rejects.toThrow('closed');
  expect(g.sql).not.toHaveBeenCalled();
});
it('reconciles an acknowledged pin whose caller stopped before private profile publication', async () => {
  const f = fixture(),
    original = f.journal.publishReviewPolicyPin.bind(f.journal);
  const call = vi.spyOn(f.journal, 'publishReviewPolicyPin').mockImplementationOnce((...args) => {
    original(...args);
    throw Error('fixture lost pin acknowledgement');
  });
  await expect(f.publish()).rejects.toThrow('lost pin');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)?.revision).toBe(1);
  call.mockRestore();
  expect((await f.publish()).revision).toBe(1);
  expect(readMailReviewHostProfile(f.root, f.options.installationDigest, f.journal, f.binding.scopeId)).toEqual(
    f.profile,
  );
});
it.each(['owner', 'native', 'journal', 'version'] as const)('rejects changed %s identity before SQL', async (field) => {
  const f = fixture();
  if (field === 'owner') f.profile.ownerId = 'another';
  if (field === 'native') f.profile.binding.nativeBindingDigest = digest('other');
  if (field === 'journal') f.profile.journalGeneration = randomUUID();
  if (field === 'version') f.profile.version = 2;
  await expect(f.publish()).rejects.toThrow();
  expect(f.sql).not.toHaveBeenCalled();
});
it('checks original input and authority again after SQL awaits', async () => {
  const f = fixture();
  f.sql.mockImplementation(async () => {
    f.profile.binding.contextGeneration = randomUUID();
  });
  await expect(f.publish()).rejects.toThrow('changed');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
});
it('losing administrative authority after SQL leaves independent admission and the private file absent', async () => {
  const f = fixture();
  let active = true;
  f.options.assertAuthority.mockImplementation(() => {
    if (!active) throw Error('fixture authority lost');
  });
  f.sql.mockImplementation(async (ready) => {
    await ready();
    active = false;
  });
  await expect(f.publish()).rejects.toThrow('authority lost');
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toBeNull();
  expect(fs.existsSync(f.file)).toBe(false);
});
it('a disable after pin publication still wins before the profile can be written', async () => {
  const f = fixture();
  let disabled = false;
  f.options.ready.mockImplementation(async () => {
    if (!disabled && f.journal.reviewPolicyPin(f.binding.scopeId)?.enabled) {
      f.pin(1, false);
      disabled = true;
    }
  });
  await expect(f.publish()).rejects.toThrow('pin_changed');
  expect(fs.existsSync(f.file)).toBe(false);
  expect(f.journal.reviewPolicyPin(f.binding.scopeId)).toMatchObject({ enabled: false, revision: 2 });
});
