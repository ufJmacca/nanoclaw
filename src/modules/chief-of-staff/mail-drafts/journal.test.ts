import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { DraftJournal, initializeDraftJournal } from './journal.js';

const roots: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { force: true, recursive: true });
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-journal-'));
  roots.push(parent);
  const root = path.join(parent, 'draft-effects'),
    installation = digest('fixture installation');
  const owner = initializeDraftJournal(root, installation);
  const open = () => {
    const journal = new DraftJournal(root, installation, owner.generation);
    journals.push(journal);
    return journal;
  };
  return { root, installation, owner, open, journal: open() };
}
const now = Date.parse('2026-10-23T00:00:00Z');
const input = (index = 1) => ({
  scopeId: 'chief-of-staff',
  bindingId: '11111111-1111-4111-8111-111111111111',
  contextGeneration: '22222222-2222-4222-8222-222222222222',
  mailboxDigest: digest('owner@example.test'),
  sourceMessageId: index.toString(16).padStart(16, '0'),
  threadId: (100 + index).toString(16).padStart(16, '0'),
  requestId: '33333333-3333-4333-8333-333333333333',
  contentDigest: digest('reply ' + index),
});
function child(code: string): Promise<{ code: number | null; signal: string | null; output: string }> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    process.stdout.on('data', (bytes) => {
      output += bytes.toString();
    });
    process.stderr.on('data', (bytes) => {
      output += bytes.toString();
    });
    process.on('error', reject);
    process.on('close', (code, signal) => resolve({ code, signal, output }));
  });
}
const childImport = `import {DraftJournal} from ${JSON.stringify(new URL('./journal.ts', import.meta.url).href)};`;
describe('independent Gmail draft effect journal', () => {
  it('retains the reservation after an actual process kill immediately following its commit', async () => {
    const f = fixture();
    const result = await child(
      childImport +
        `
      const journal = new DraftJournal(${JSON.stringify(f.root)},${JSON.stringify(f.installation)},${JSON.stringify(f.owner.generation)});
      journal.reserve(${JSON.stringify(input())},${now});
      process.kill(process.pid,'SIGKILL');
    `,
    );
    expect(result.signal).toBe('SIGKILL');
    expect(f.open().reserve(input(), now + 1).created).toBe(false);
  });
  it('atomically enforces the cap when eight independent processes race to create drafts', async () => {
    const f = fixture();
    const outcomes = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        child(
          childImport +
            `
      const journal = new DraftJournal(${JSON.stringify(f.root)},${JSON.stringify(f.installation)},${JSON.stringify(f.owner.generation)});
      try {
        const result=journal.reserve(${JSON.stringify(input(index + 1))},${now});
        console.log(result.created ? 'reserved' : 'existing');
      } catch(error) { console.log(error.message); } finally { journal.close(); }
    `,
        ),
      ),
    );
    expect(outcomes.every((outcome) => outcome.code === 0)).toBe(true);
    expect(outcomes.map((outcome) => outcome.output.trim()).sort()).toEqual([
      ...Array(3).fill('mail_draft_daily_limit'),
      ...Array(5).fill('reserved'),
    ]);
  });
  it('durably reserves before submission and never returns a new create after restart or store restore', () => {
    const f = fixture(),
      first = f.journal.reserve(input(), now);
    expect(first.created).toBe(true);
    expect(first.record.state).toBe('reserved');
    expect(first.record.correlation).toMatch(/^[a-f0-9]{64}$/);
    f.journal.close();
    const restarted = f.open();
    expect(restarted.reserve(input(), now + 1000)).toEqual({ created: false, record: first.record });
    expect(restarted.find(first.record.operationId)).toEqual(first.record);
    expect(() => restarted.reserve({ ...input(), contentDigest: digest('changed reply') }, now + 2000)).toThrow(
      'mail_draft_already_reserved',
    );
    const bytes = fs.readFileSync(path.join(f.root, 'effects.sqlite'));
    expect(bytes.includes(Buffer.from('owner@example.test'))).toBe(false);
    expect(bytes.includes(Buffer.from('changed reply'))).toBe(false);
  });
  it('charges all uncertain attempts against the global five-per-Sydney-day limit across connections and bindings', () => {
    const f = fixture(),
      other = f.open();
    for (let index = 1; index <= 5; index++) {
      const value = {
        ...input(index),
        bindingId: index % 2 ? input().bindingId : '44444444-4444-4444-8444-444444444444',
      };
      expect((index % 2 ? f.journal : other).reserve(value, now + index).created).toBe(true);
    }
    expect(() => other.reserve(input(6), now + 6)).toThrow('mail_draft_daily_limit');
    expect(f.journal.reserve(input(), now + 7).created).toBe(false);
    expect(other.reserve(input(6), Date.parse('2026-10-23T13:00:00Z')).created).toBe(true);
  });
  it('uses the actual Sydney midnight through daylight-saving offsets', () => {
    const f = fixture(),
      before = Date.parse('2026-10-03T13:59:59Z');
    for (let i = 1; i <= 5; i++) expect(f.journal.reserve(input(i), before).record.day).toBe('2026-10-03');
    expect(f.journal.reserve(input(6), before + 1000).record.day).toBe('2026-10-04');
    for (let i = 7; i <= 10; i++) f.journal.reserve(input(i), before + 2000);
    expect(() => f.journal.reserve(input(11), Date.parse('2026-10-04T12:59:59Z'))).toThrow('mail_draft_daily_limit');
    expect(f.journal.reserve(input(11), Date.parse('2026-10-04T13:00:00Z')).record.day).toBe('2026-10-05');
  });
  it('blocks another source in an unresolved thread without charging a sixth reservation', () => {
    const f = fixture(),
      first = f.journal.reserve(input(), now);
    expect(() => f.journal.reserve({ ...input(2), threadId: input().threadId }, now + 1)).toThrow(
      'mail_draft_thread_reserved',
    );
    f.journal.observe(first.record.operationId, { state: 'missing' }, now + 2);
    expect(f.journal.reserve({ ...input(2), threadId: input().threadId }, now + 3).created).toBe(true);
    expect(f.journal.reserve(input(), now + 4).created).toBe(false);
  });
  it('records verified readback and refuses changed provider identities', () => {
    const f = fixture(),
      first = f.journal.reserve(input(), now),
      id = first.record.operationId;
    const observation = {
      state: 'verified' as const,
      draftId: 'r-123456',
      messageId: 'a'.repeat(16),
      threadId: input().threadId,
      contentDigest: input().contentDigest,
    };
    expect(f.journal.observe(id, observation, now + 1).state).toBe('verified');
    expect(f.open().observe(id, observation, now + 2).state).toBe('verified');
    expect(() => f.journal.observe(id, { ...observation, messageId: 'b'.repeat(16) }, now + 3)).toThrow(
      'mail_draft_observation_conflict',
    );
    expect(() => f.journal.observe(id, { ...observation, contentDigest: digest('edited body') }, now + 3)).toThrow(
      'mail_draft_observation_conflict',
    );
  });
  it.each(['edited', 'missing', 'sent', 'collision'] as const)(
    'never recreates or re-verifies a %s effect after restart',
    (state) => {
      const f = fixture(),
        first = f.journal.reserve(input(), now),
        id = first.record.operationId;
      f.journal.observe(id, { state }, now + 1);
      const restarted = f.open();
      expect(restarted.reserve(input(), now + 2).created).toBe(false);
      expect(restarted.find(id)?.state).toBe(state);
      expect(() =>
        restarted.observe(
          id,
          {
            state: 'verified',
            draftId: 'r1',
            messageId: 'a'.repeat(16),
            threadId: input().threadId,
            contentDigest: input().contentDigest,
          },
          now + 3,
        ),
      ).toThrow('mail_draft_observation_conflict');
    },
  );
  it('allows edited/collision metadata to become missing or sent while preserving the consumed source', () => {
    const f = fixture(),
      first = f.journal.reserve(input(), now),
      id = first.record.operationId;
    f.journal.observe(id, { state: 'edited' }, now + 1);
    expect(f.journal.observe(id, { state: 'sent' }, now + 2).state).toBe('sent');
    expect(() => f.journal.observe(id, { state: 'missing' }, now + 3)).toThrow('mail_draft_observation_conflict');
    expect(f.journal.reserve(input(), now + 4).created).toBe(false);
  });
  it('does not free a daily allowance after deletion, sending or unsuccessful reconciliation', () => {
    const f = fixture();
    for (let i = 1; i <= 5; i++) {
      const r = f.journal.reserve(input(i), now + i);
      f.journal.observe(r.record.operationId, { state: i % 2 ? 'missing' : 'sent' }, now + i);
    }
    expect(() => f.journal.reserve(input(6), now + 6)).toThrow('mail_draft_daily_limit');
  });
  it('fails closed for a regressed host clock', () => {
    const f = fixture();
    f.journal.reserve(input(), now);
    expect(() => f.journal.reserve(input(2), now - 1)).toThrow('mail_draft_clock_regressed');
  });
  it.each([
    { sourceMessageId: '../escape' },
    { threadId: 'bad/thread' },
    { mailboxDigest: 'not a digest' },
    { contentDigest: 'unsafe' },
    { bindingId: 'not a UUID' },
    { contextGeneration: 'unsafe' },
    { requestId: 'unsafe' },
    { scopeId: '' },
    { send: true },
  ])('rejects malformed or expanded reservation input: %j', (patch) => {
    const f = fixture();
    expect(() => f.journal.reserve({ ...input(), ...patch }, now)).toThrow('unsafe_mail_draft_journal');
  });
  it('runtime cannot create, reinitialize or adopt missing history', () => {
    const f = fixture();
    f.journal.reserve(input(), now);
    f.journal.close();
    fs.unlinkSync(path.join(f.root, 'effects.sqlite'));
    expect(() => f.open()).toThrow();
    expect(() => initializeDraftJournal(f.root, f.installation)).toThrow();
    expect(fs.existsSync(path.join(f.root, 'effects.sqlite'))).toBe(false);
  });
  it('pins the journal and owner files and rejects changed identity, permissions, links and replacement', () => {
    const f = fixture();
    expect(() => new DraftJournal(f.root, digest('other'), f.owner.generation)).toThrow();
    const file = path.join(f.root, 'effects.sqlite');
    fs.chmodSync(file, 0o644);
    expect(() => f.journal.reserve(input(), now)).toThrow();
    fs.chmodSync(file, 0o600);
    fs.renameSync(file, file + '.old');
    fs.copyFileSync(file + '.old', file);
    fs.chmodSync(file, 0o600);
    expect(() => f.journal.reserve(input(), now)).toThrow();
    expect(() => f.open()).toThrow();
    fs.unlinkSync(file);
    fs.renameSync(file + '.old', file);
    fs.linkSync(file, file + '.link');
    expect(() => f.journal.reserve(input(), now)).toThrow();
  });
});
