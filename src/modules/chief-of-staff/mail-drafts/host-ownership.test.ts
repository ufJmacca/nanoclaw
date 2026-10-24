import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import type { DraftJournal } from './journal.js';
import { initializeTargetDraftJournal, openTargetDraftJournal } from './host-ownership.js';
const cleanup: string[] = [],
  journals: DraftJournal[] = [];
afterEach(() => {
  for (const journal of journals.splice(0)) journal.close();
  for (const root of cleanup.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-draft-host-'));
  cleanup.push(root);
  return { root, installation: digest('fixture installation') };
}
it('initializes the independent target journal only in trusted setup and retains its generation through restart', () => {
  const f = fixture(),
    first = initializeTargetDraftJournal(f.root, f.installation);
  journals.push(first);
  const next = openTargetDraftJournal(f.root, f.installation);
  journals.push(next);
  expect(next.generation).toBe(first.generation);
  expect(next.root).toBe(path.join(f.root, 'mail-drafts/effects'));
  const retry = initializeTargetDraftJournal(f.root, f.installation);
  journals.push(retry);
  expect(retry.generation).toBe(first.generation);
  expect(fs.existsSync(path.join(f.root, 'mail-drafts/writer-profile.json'))).toBe(false);
});
it('runtime never creates missing ownership or grants authority from an empty target directory', () => {
  const f = fixture();
  expect(() => openTargetDraftJournal(f.root, f.installation)).toThrow();
  expect(fs.readdirSync(f.root)).toEqual([]);
});
it.each(['owner.json', 'effects/owner.json', 'effects/effects.sqlite'])(
  'refuses silently recreating lost independent history: %s',
  (lost) => {
    const f = fixture(),
      journal = initializeTargetDraftJournal(f.root, f.installation);
    journal.close();
    fs.unlinkSync(path.join(f.root, 'mail-drafts', lost));
    expect(() => openTargetDraftJournal(f.root, f.installation)).toThrow();
    expect(() => initializeTargetDraftJournal(f.root, f.installation)).toThrow();
    expect(fs.existsSync(path.join(f.root, 'mail-drafts', lost))).toBe(false);
  },
);
it('refuses foreign installations, linked roots and permissive ownership files', () => {
  const f = fixture(),
    journal = initializeTargetDraftJournal(f.root, f.installation);
  journals.push(journal);
  expect(() => openTargetDraftJournal(f.root, digest('other installation'))).toThrow();
  fs.chmodSync(path.join(f.root, 'mail-drafts/owner.json'), 0o644);
  expect(() => openTargetDraftJournal(f.root, f.installation)).toThrow();
});
