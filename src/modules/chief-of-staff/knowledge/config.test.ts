import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { knowledgeSettings, openKnowledgeArtifacts } from './config.js';
const roots: string[] = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-knowledge-config-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('requires explicit retrieval enablement and bounds owner-configured retention', () => {
  expect(knowledgeSettings({})).toEqual({ enabled: false, retentionMs: 30 * 86400000 });
  expect(knowledgeSettings({ COS_KNOWLEDGE_ENABLED: 'true', COS_KNOWLEDGE_RETENTION_DAYS: '0' })).toEqual({
    enabled: true,
    retentionMs: 0,
  });
  expect(knowledgeSettings({ COS_KNOWLEDGE_ENABLED: 'false', COS_KNOWLEDGE_RETENTION_DAYS: '365' })).toEqual({
    enabled: false,
    retentionMs: 365 * 86400000,
  });
  for (const env of [
    { COS_KNOWLEDGE_ENABLED: 'yes' },
    { COS_KNOWLEDGE_RETENTION_DAYS: '-1' },
    { COS_KNOWLEDGE_RETENTION_DAYS: '366' },
    { COS_KNOWLEDGE_RETENTION_DAYS: '1.5' },
    { COS_KNOWLEDGE_RETENTION_DAYS: '' },
  ])
    expect(() => knowledgeSettings(env)).toThrow();
});
it('creates only private owned knowledge directories and preserves them across restart', () => {
  const root = fixture();
  const first = openKnowledgeArtifacts(root, []);
  expect(first.root).toBe(path.join(root, 'knowledge', 'artifacts'));
  expect(first.staging).toBe(path.join(root, 'knowledge', 'staging'));
  for (const directory of [path.join(root, 'knowledge'), first.root, first.staging])
    expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
  fs.writeFileSync(path.join(first.staging, 'owner-note.md'), 'preserve', { mode: 0o600 });
  expect(openKnowledgeArtifacts(root, []).root).toBe(first.root);
  expect(fs.readFileSync(path.join(first.staging, 'owner-note.md'), 'utf8')).toBe('preserve');
});
it('rejects Git and protected-runtime roots before writing knowledge state', () => {
  const root = fixture();
  fs.mkdirSync(path.join(root, '.git'));
  expect(() => openKnowledgeArtifacts(root, [])).toThrow('unsafe_knowledge_configuration');
  expect(fs.existsSync(path.join(root, 'knowledge'))).toBe(false);
  fs.rmdirSync(path.join(root, '.git'));
  expect(() => openKnowledgeArtifacts(root, [root])).toThrow('unsafe_knowledge_configuration');
  expect(() => openKnowledgeArtifacts(root, [path.join(root, 'data')])).toThrow('unsafe_knowledge_configuration');
  expect(fs.existsSync(path.join(root, 'knowledge'))).toBe(false);
});
it('refuses symlinks, permissive roots and adoption of an existing unowned directory', () => {
  const root = fixture(),
    foreign = fixture();
  fs.symlinkSync(foreign, path.join(root, 'knowledge'));
  expect(() => openKnowledgeArtifacts(root, [])).toThrow();
  expect(fs.readdirSync(foreign)).toEqual([]);
  fs.unlinkSync(path.join(root, 'knowledge'));
  fs.mkdirSync(path.join(root, 'knowledge'), { mode: 0o700 });
  fs.writeFileSync(path.join(root, 'knowledge', 'unrelated'), 'preserve');
  expect(() => openKnowledgeArtifacts(root, [])).toThrow('unowned_knowledge_configuration');
  fs.chmodSync(root, 0o755);
  expect(() => openKnowledgeArtifacts(root, [])).toThrow('unsafe_knowledge_configuration');
});
