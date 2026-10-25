import fs from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import { GOOGLE_MAIL_DRAFT_SCOPE } from '../../modules/chief-of-staff/mail-drafts/oauth.js';
import { createMailDraftFixtureHost, type MailDraftFixtureConfiguration } from './mail-draft-fixture-host.js';
import { initializeDraftJournal } from '../../modules/chief-of-staff/mail-drafts/journal.js';
const cleanup: Array<() => void> = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const close of cleanup.splice(0).reverse()) close();
});
function fixture() {
  const root = fs.mkdtempSync(os.tmpdir() + '/cos-draft-native-fixture-');
  fs.chmodSync(root, 0o700);
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const native = new Database(':memory:');
  cleanup.push(() => native.close());
  const binding = {
    scopeId: 'fixture',
    ownerId: 'owner',
    agentGroupId: 'group',
    messagingGroupId: 'messaging',
    sessionId: 'session',
    instanceId: 'instance',
    channelId: 'private',
    botId: 'bot',
    provider: 'codex' as const,
  };
  fs.mkdirSync(root + '/mail-draft-fixture', { mode: 0o700 });
  const history = initializeDraftJournal(root + '/mail-draft-fixture/effects', digest({ fixture: true, binding }));
  const config: MailDraftFixtureConfiguration = {
    authority: {
      bindingDigest: digest(binding),
      contextGeneration: randomUUID(),
      draftProfileDigest: digest('cos-mail-draft/v1'),
      provider: {
        profile: 'codex-subscription/coordinator-v1',
        model: 'fixture',
        policyDigest: digest('fixture policy'),
      },
    },
    writerId: randomUUID(),
    policy: {
      format: 'cos-mail-draft-binding/v1',
      provider: 'fixture',
      readerBindingId: randomUUID(),
      mailboxDigest: digest('owner@example.invalid'),
      writerClientDigest: digest('writer-fixture.apps.googleusercontent.com'),
      readerClientDigest: digest('reader-fixture.apps.googleusercontent.com'),
      credentialReference: randomUUID(),
      nativeBindingDigest: digest(binding),
      journalGeneration: randomUUID(),
      maxPerDay: 5,
      timeZone: 'Australia/Sydney',
      replyMode: 'plain_text_reply',
      permissionScopes: [GOOGLE_MAIL_DRAFT_SCOPE],
      recoveryProofDigest: digest('synthetic recovery only'),
    },
    mailboxEmail: 'owner@example.invalid',
    sources: [
      {
        id: 'aa01',
        threadId: 'bb01',
        internalDate: Date.now(),
        headers: [
          { name: 'From', value: 'sender@example.invalid' },
          { name: 'To', value: 'owner@example.invalid' },
          { name: 'Subject', value: 'Harmless fixture' },
          { name: 'Message-ID', value: '<fixture@example.invalid>' },
        ],
      },
    ],
  };
  config.policy.journalGeneration = history.generation;
  return { root, native, binding, config };
}
it('cannot construct a fixture draft writer in a production process or with a Google policy', () => {
  const f = fixture();
  expect(() => createMailDraftFixtureHost(f.root, f.native, f.binding, f.config)).toThrow();
  vi.stubEnv('COS_FIXTURE_HOST_PROCESS', 'S01');
  f.config.policy.provider = 'google';
  expect(() => createMailDraftFixtureHost(f.root, f.native, f.binding, f.config)).toThrow();
});
it('opens only explicit synthetic history and preserves its generation on restart without provider writes', async () => {
  const f = fixture();
  vi.stubEnv('COS_FIXTURE_HOST_PROCESS', 'S01');
  const first = createMailDraftFixtureHost(f.root, f.native, f.binding, f.config);
  expect(first.state()).toMatchObject({ writes: 0, sends: 0, drafts: [] });
  const generation = first.generation;
  await first.close();
  const second = createMailDraftFixtureHost(f.root, f.native, f.binding, {
    ...f.config,
    policy: { ...f.config.policy, journalGeneration: generation },
  });
  try {
    expect(second.generation).toBe(generation);
    expect(second.state()).toMatchObject({ writes: 0, sends: 0, drafts: [] });
    expect(() => second.mode('send')).toThrow();
  } finally {
    await second.close();
  }
});
