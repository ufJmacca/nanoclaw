import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { writeAtomic } from '../ops/target-state.js';
import { initializeTargetDraftJournal } from './host-ownership.js';
import { parseMailDraftHostGrant, readMailDraftHostProfile, type MailDraftHostGrant } from './profile.js';
import type { DraftJournal } from './journal.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from './oauth.js';
const cleanup: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-profile-'));
  cleanup.push(root);
  const installation = digest('fixture installation'),
    journal = initializeTargetDraftJournal(root, installation);
  journals.push(journal);
  const grant: MailDraftHostGrant = {
    scopeId: 'chief-of-staff',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    id: '11111111-1111-4111-8111-111111111111',
    version: 1,
    backupOperationId: 'release-fixture',
    targetBackupDigest: digest('fixture backup'),
    writeEnabled: true,
    binding: {
      format: 'cos-mail-draft-binding/v1',
      provider: 'google',
      readerBindingId: '22222222-2222-4222-8222-222222222222',
      mailboxDigest: digest('owner@example.test'),
      writerClientDigest: digest('writer'),
      readerClientDigest: digest('reader'),
      credentialReference: '33333333-3333-4333-8333-333333333333',
      nativeBindingDigest: digest('native'),
      journalGeneration: journal.generation,
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      recoveryProofDigest: digest('fixture actual recovery'),
    },
  };
  const profile = {
    format: 'cos-mail-draft-host/v1',
    installationDigest: installation,
    journalGeneration: journal.generation,
    grants: [grant],
  };
  const save = () => writeAtomic(path.join(root, 'mail-drafts'), 'writer-profile.json', profile);
  return { root, installation, journal, grant, profile, save };
}
it('reads only exact owner/installation/journal-bound policy metadata without granting provider access', () => {
  const f = fixture();
  f.save();
  expect(parseMailDraftHostGrant(f.grant)).toEqual(f.grant);
  expect(readMailDraftHostProfile(f.root, f.installation, f.journal)).toEqual(f.profile);
  const clone = parseMailDraftHostGrant(f.grant);
  clone.binding.maxPerDay = 6 as 5;
  expect(f.grant.binding.maxPerDay).toBe(5);
});
it.each(['fixture', 'token', 'endpoint', 'cap', 'context', 'version'] as const)(
  'rejects expanded or uncertain runtime grant metadata: %s',
  (failure) => {
    const f = fixture(),
      value = structuredClone(f.grant);
    if (failure === 'fixture') value.binding.provider = 'fixture';
    if (failure === 'cap') value.binding.maxPerDay = 6 as 5;
    if (failure === 'context') value.ownerId = '';
    if (failure === 'version') value.version = 0;
    expect(() =>
      parseMailDraftHostGrant(
        failure === 'token'
          ? { ...value, refreshToken: 'PRIVATE_CANARY' }
          : failure === 'endpoint'
            ? { ...value, url: 'https://attacker.invalid' }
            : value,
      ),
    ).toThrow();
  },
);
it('rejects duplicate grants, reused credential references and a foreign journal generation', () => {
  const f = fixture();
  f.profile.grants.push(f.grant);
  f.save();
  expect(() => readMailDraftHostProfile(f.root, f.installation, f.journal)).toThrow();
  f.profile.grants = [
    { ...f.grant, binding: { ...f.grant.binding, journalGeneration: '44444444-4444-4444-8444-444444444444' } },
  ];
  f.save();
  expect(() => readMailDraftHostProfile(f.root, f.installation, f.journal)).toThrow();
});
it('does not recreate missing profile or witness files and rejects file replacement by a symlink', () => {
  const f = fixture();
  expect(() => readMailDraftHostProfile(f.root, f.installation, f.journal)).toThrow();
  expect(fs.existsSync(path.join(f.root, 'mail-drafts/writer-profile.json'))).toBe(false);
  f.save();
  const file = path.join(f.root, 'mail-drafts/writer-profile.json');
  fs.renameSync(file, file + '.held');
  fs.symlinkSync(file + '.held', file);
  expect(() => readMailDraftHostProfile(f.root, f.installation, f.journal)).toThrow();
  fs.unlinkSync(file);
  fs.renameSync(file + '.held', file);
  fs.unlinkSync(path.join(f.root, 'mail-drafts/effects/owner.json'));
  expect(() => readMailDraftHostProfile(f.root, f.installation, f.journal)).toThrow();
});
