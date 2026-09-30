import { expect, it } from 'vitest';
import { parseAdminArguments, safeAdminError } from './admin.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSourceImport, readSourceManifest } from './knowledge-admin.js';
const requestId = '11111111-1111-4111-8111-111111111111';
it('requires explicit scoped import with a private manifest and stable request identity', () => {
  expect(
    parseAdminArguments([
      'source-import',
      '--scope',
      'fixture',
      '--request-id',
      requestId,
      '--manifest',
      '/private/import.json',
    ]),
  ).toEqual({ command: 'source-import', scopeId: 'fixture', requestId, manifestFile: '/private/import.json' });
  for (const args of [
    ['source-import', '--scope', 'fixture', '--request-id', requestId, '--manifest', '../import.json'],
    ['source-import', '--scope', 'fixture', '--request-id', 'unstable', '--manifest', '/private/import.json'],
    ['source-import', '--scope', 'fixture', '--manifest', '/private/import.json'],
    ['source-inventory', '--scope', 'fixture', '--scope', 'foreign'],
    ['source-inventory', '--scope', 'fixture', '--limit', '101'],
    ['source-inventory', '--scope', 'fixture', '--after', '../foreign'],
    ['source-reconcile', '--scope', 'fixture', '--grace', '0'],
  ])
    expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
  expect(
    parseAdminArguments([
      'source-inventory',
      '--scope',
      'fixture',
      '--limit',
      '2',
      '--status',
      'failed',
      '--after',
      requestId,
    ]),
  ).toEqual({
    command: 'source-inventory',
    scopeId: 'fixture',
    page: { limit: 2, status: 'failed', after: requestId },
  });
  expect(parseAdminArguments(['source-reconcile', '--scope', 'fixture'])).toEqual({
    command: 'source-reconcile',
    scopeId: 'fixture',
  });
});
it('accepts only a selected flat filename and explicit processing policy without authority overrides', () => {
  const valid = {
    sourceKey: 'note',
    filename: 'Note.txt',
    title: 'Note',
    processingProviders: ['codex'],
    expectedVersion: 0,
  };
  expect(parseSourceImport(valid)).toEqual(valid);
  for (const value of [
    null,
    [],
    { ...valid, scopeId: 'foreign' },
    { ...valid, filename: '/private/secret.txt' },
    { ...valid, filename: '../note.txt' },
    { ...valid, processingProviders: ['shell'] },
    { ...valid, processingProviders: ['codex', 'codex'] },
    { ...valid, expectedVersion: -1 },
    { ...valid, title: 'bad\nCANARY' },
  ])
    expect(() => parseSourceImport(value)).toThrow('invalid_source_manifest');
  expect(safeAdminError(new Error('unsupported_source'))).toBe('unsupported_source');
  expect(safeAdminError(new Error('invalid_source_manifest'))).toBe('invalid_source_manifest');
  expect(safeAdminError(new Error('unsupported_source: SECRET'))).toBe('unreachable');
});

it('reads only a bounded private regular manifest with no symbolic or hard links', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-source-manifest-'));
  const file = path.join(root, 'manifest.json');
  try {
    const value = {
      sourceKey: 'note',
      filename: 'note.md',
      title: 'Note',
      processingProviders: ['codex'],
      expectedVersion: 0,
    };
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
    expect(readSourceManifest(file)).toEqual(value);
    fs.symlinkSync(file, root + '/link.json');
    expect(() => readSourceManifest(root + '/link.json')).toThrow('invalid_source_manifest');
    fs.linkSync(file, root + '/hard.json');
    expect(() => readSourceManifest(file)).toThrow('invalid_source_manifest');
    fs.unlinkSync(root + '/hard.json');
    fs.chmodSync(file, 0o644);
    expect(() => readSourceManifest(file)).toThrow('invalid_source_manifest');
    fs.chmodSync(file, 0o600);
    fs.writeFileSync(file, ' '.repeat(8193));
    expect(() => readSourceManifest(file)).toThrow('invalid_source_manifest');
    fs.writeFileSync(file, '{bad');
    expect(() => readSourceManifest(file)).toThrow('invalid_source_manifest');
    expect(() => readSourceManifest(root)).toThrow('invalid_source_manifest');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
