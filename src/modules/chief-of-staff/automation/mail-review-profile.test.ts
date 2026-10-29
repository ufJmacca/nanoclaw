import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from '../ops/target-state.js';
import { initializeTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import type { DraftJournal } from '../mail-drafts/journal.js';
import {
  parseMailReviewHostProfile,
  readMailReviewHostProfile,
  mailReviewProfileMatches,
  type MailReviewHostProfile,
} from './mail-review-profile.js';
const roots: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const j of journals.splice(0)) j.close();
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-review-profile-'));
  roots.push(root);
  const installation = digest('fixture installation'),
    journal = initializeTargetDraftJournal(root, installation);
  journals.push(journal);
  const profile: MailReviewHostProfile = {
    format: 'cos-mail-review-host/v1',
    installationDigest: installation,
    journalGeneration: journal.generation,
    scopeId: 'chief-of-staff',
    ownerId: 'owner',
    sessionId: 'session',
    agentGroupId: 'group',
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
      nativeBindingDigest: digest('native'),
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
  const file = path.join(root, 'mail-drafts', 'review-profile-' + digest(profile.scopeId) + '.json');
  const save = () => writeAtomic(path.dirname(file), path.basename(file), profile);
  const pin = (expectedRevision = 0, enabled = true) =>
    journal.publishReviewPolicyPin(
      {
        requestId: randomUUID(),
        expectedRevision,
        enabled,
        pin: {
          scopeId: profile.scopeId,
          policyId: profile.id,
          policyVersion: profile.version,
          profileDigest: digest(profile),
        },
      },
      () => {},
    );
  const context = {
    scopeId: profile.scopeId,
    ownerId: profile.ownerId,
    sessionId: profile.sessionId,
    agentGroupId: profile.agentGroupId,
    ingressId: 'fixture',
    provider: 'codex',
    generation: profile.binding.contextGeneration,
  };
  const selected = { id: profile.id, version: profile.version, digest: digest(profile.binding), body: profile.binding };
  return { root, installation, journal, profile, file, save, pin, context, selected };
}
it('does not initialize missing profile history or admit an unpinned profile file', () => {
  const f = fixture(),
    before = fs.readdirSync(path.join(f.root, 'mail-drafts'));
  expect(readMailReviewHostProfile(f.root, f.installation, f.journal, f.profile.scopeId)).toBeNull();
  expect(fs.readdirSync(path.join(f.root, 'mail-drafts'))).toEqual(before);
  f.save();
  expect(readMailReviewHostProfile(f.root, f.installation, f.journal, f.profile.scopeId)).toBeNull();
  expect(mailReviewProfileMatches(f.root, f.installation, f.journal, f.context, f.selected)).toBe(false);
});
it('requires the independent pin, current profile, owner, main context and SQL policy identity', () => {
  const f = fixture();
  f.save();
  f.pin();
  expect(readMailReviewHostProfile(f.root, f.installation, f.journal, f.profile.scopeId)).toEqual(f.profile);
  expect(mailReviewProfileMatches(f.root, f.installation, f.journal, f.context, f.selected)).toBe(true);
  expect(
    mailReviewProfileMatches(f.root, f.installation, f.journal, { ...f.context, ownerId: 'other' }, f.selected),
  ).toBe(false);
  expect(
    mailReviewProfileMatches(f.root, f.installation, f.journal, { ...f.context, generation: randomUUID() }, f.selected),
  ).toBe(false);
  expect(
    mailReviewProfileMatches(f.root, f.installation, f.journal, f.context, {
      ...f.selected,
      digest: digest('other revision'),
    }),
  ).toBe(false);
  f.pin(1, false);
  expect(mailReviewProfileMatches(f.root, f.installation, f.journal, f.context, f.selected)).toBe(false);
  f.save();
  expect(readMailReviewHostProfile(f.root, f.installation, f.journal, f.profile.scopeId)).toBeNull();
});
it.each(['changed-file', 'foreign-installation', 'foreign-journal', 'linked-file', 'permissive-file'] as const)(
  'refuses %s rather than accepting restored metadata',
  (kind) => {
    const f = fixture();
    f.save();
    f.pin();
    if (kind === 'changed-file') {
      f.profile.version = 2;
      f.save();
    }
    if (kind === 'foreign-journal') {
      f.profile.journalGeneration = randomUUID();
      f.save();
    }
    if (kind === 'linked-file') {
      const bytes = fs.readFileSync(f.file);
      fs.renameSync(f.file, f.file + '.old');
      fs.writeFileSync(f.file + '.replacement', bytes, { mode: 0o600 });
      fs.symlinkSync(f.file + '.replacement', f.file);
    }
    if (kind === 'permissive-file') fs.chmodSync(f.file, 0o644);
    expect(
      mailReviewProfileMatches(
        f.root,
        kind === 'foreign-installation' ? digest('other') : f.installation,
        f.journal,
        f.context,
        f.selected,
      ),
    ).toBe(false);
  },
);
it.each([{ enabled: true }, { sendEnabled: true }, { binding: { provider: 'fixture' } }])(
  'rejects additional or incomplete profile authority: %j',
  (patch) => {
    const f = fixture();
    expect(() => parseMailReviewHostProfile({ ...f.profile, ...patch })).toThrow('mail_review_profile_invalid');
  },
);
