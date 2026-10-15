import { expect, it } from 'vitest';
import { validBackupPathSegment } from './backup-names.js';

it.each(['history.jsonl', '.sandbox-migration', '.system', '.cos-capture.json'])(
  'accepts a portable provider segment %s',
  (name) => expect(validBackupPathSegment(name)).toBe(true),
);
it.each(['', '.', '..', '..hidden', '../escape', 'a/b', 'a\\b', '.hidden/../escape', 'a\0b'])(
  'rejects non-canonical provider segment %s',
  (name) => expect(validBackupPathSegment(name)).toBe(false),
);
