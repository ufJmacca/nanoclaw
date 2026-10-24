import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { initializeTargetDraftJournal } from '../mail-drafts/host-ownership.js';
import { writeAtomic } from './target-state.js';
import { readMailDraftAccountConsent } from './mail-draft-consent.js';
const cleanup: string[] = [];
afterEach(() => {
  for (const p of cleanup.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-consent-'));
  cleanup.push(root);
  fs.chmodSync(root, 0o700);
  const installation = 'a'.repeat(64),
    binding = {
      scopeId: 'fixture',
      ownerId: 'owner',
      agentGroupId: 'group',
      sessionId: 'session',
      provider: 'codex',
      instanceId: 'instance',
      channelId: 'private',
      botId: 'bot',
    } as CosBinding;
  const journal = initializeTargetDraftJournal(root, installation),
    writer = randomUUID(),
    parent = root + '/mail-draft-admin',
    dir = parent + '/' + writer;
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(dir, { mode: 0o700 });
  const consent = {
    format: 'cos-mail-draft-account-consent/v1',
    installationDigest: installation,
    nativeBindingDigest: digest(binding),
    journalGeneration: journal.generation,
    requestId: randomUUID(),
    readerConnectionDigest: 'b'.repeat(64),
    selection: {
      scopeId: binding.scopeId,
      readerBindingId: randomUUID(),
      writerBindingId: writer,
      readerReference: randomUUID(),
      writerReference: writer,
      mailboxDigest: 'c'.repeat(64),
      readerClientDigest: 'd'.repeat(64),
      writerClientDigest: 'e'.repeat(64),
    },
  };
  writeAtomic(dir, 'consent.json', consent);
  const read = () => readMailDraftAccountConsent(root, installation, binding, writer, journal);
  return { root, installation, binding, writer, journal, consent, dir, read };
}
it('reads only completed owner consent metadata bound to the installed journal and exact reader/writer identities', () => {
  const f = fixture();
  try {
    expect(f.read()).toEqual(f.consent);
    const result = f.read();
    result.selection.writerReference = randomUUID();
    expect(f.read()).toEqual(f.consent);
  } finally {
    f.journal.close();
  }
});
it.each([
  'owner',
  'installation',
  'journal',
  'scope',
  'writer',
  'reference',
  'client',
  'extra',
  'connection',
  'request',
  'mode',
  'symlink',
  'hardlink',
] as const)('denies %s consent substitutions', (reason) => {
  const f = fixture();
  try {
    if (reason === 'owner') f.binding.ownerId = 'foreign';
    if (reason === 'installation') f.consent.installationDigest = 'f'.repeat(64);
    if (reason === 'journal') f.consent.journalGeneration = randomUUID();
    if (reason === 'scope') f.consent.selection.scopeId = 'foreign';
    if (reason === 'writer') f.consent.selection.writerBindingId = randomUUID();
    if (reason === 'reference') f.consent.selection.writerReference = f.consent.selection.readerReference;
    if (reason === 'client') f.consent.selection.writerClientDigest = f.consent.selection.readerClientDigest;
    if (reason === 'extra') Object.assign(f.consent, { token: 'PRIVATE' });
    if (reason === 'connection') f.consent.readerConnectionDigest = 'invalid';
    if (reason === 'request') Object.assign(f.consent, { requestId: 'invalid' });
    writeAtomic(f.dir, 'consent.json', f.consent);
    if (reason === 'mode') fs.chmodSync(f.dir + '/consent.json', 0o644);
    if (reason === 'symlink') {
      fs.renameSync(f.dir + '/consent.json', f.dir + '/real.json');
      fs.symlinkSync(f.dir + '/real.json', f.dir + '/consent.json');
    }
    if (reason === 'hardlink') fs.linkSync(f.dir + '/consent.json', f.dir + '/copy.json');
    expect(f.read).toThrow('mail_draft_consent_unavailable');
  } finally {
    f.journal.close();
  }
});
it('does not create missing consent, adopt a replaced history or permit a closed journal', () => {
  const f = fixture();
  f.journal.close();
  expect(f.read).toThrow('mail_draft_consent_unavailable');
  fs.unlinkSync(f.dir + '/consent.json');
  expect(f.read).toThrow('mail_draft_consent_unavailable');
  expect(fs.existsSync(f.dir + '/consent.json')).toBe(false);
});
