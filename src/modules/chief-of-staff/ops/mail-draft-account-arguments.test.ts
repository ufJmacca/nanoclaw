import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { isMailDraftAccountCommand, parseMailDraftAccountArguments } from './mail-draft-account-arguments.js';

it('accepts only separate scoped setup and selected reader/writer link identities', () => {
  const requestId = randomUUID(),
    readerBindingId = randomUUID(),
    writerBindingId = randomUUID();
  expect(parseMailDraftAccountArguments(['mail-draft-setup', '--scope', 'fixture', '--request-id', requestId])).toEqual(
    { command: 'mail-draft-setup', scopeId: 'fixture', requestId },
  );
  expect(
    parseMailDraftAccountArguments([
      'mail-draft-link',
      '--scope',
      'fixture',
      '--request-id',
      requestId,
      '--reader-binding',
      readerBindingId,
      '--writer-binding',
      writerBindingId,
      '--manifest',
      '/private/selection.json',
    ]),
  ).toEqual({
    command: 'mail-draft-link',
    scopeId: 'fixture',
    requestId,
    readerBindingId,
    writerBindingId,
    manifestFile: '/private/selection.json',
  });
  expect(isMailDraftAccountCommand({ command: 'mail-draft-link' })).toBe(true);
  expect(isMailDraftAccountCommand({ command: 'mail-link' })).toBe(false);
});
it('rejects credential/provider overrides, reused identities and ambiguous paths before runtime modules load', () => {
  const requestId = randomUUID(),
    reader = randomUUID(),
    writer = randomUUID();
  const args = [
    'mail-draft-link',
    '--scope',
    'fixture',
    '--request-id',
    requestId,
    '--reader-binding',
    reader,
    '--writer-binding',
    writer,
    '--manifest',
    '/private/selection.json',
  ];
  for (const invalid of [
    [],
    args.slice(0, -2),
    [...args, '--token', 'PRIVATE'],
    [...args, '--callback', 'http://foreign.invalid/'],
    args.map((v) => (v === writer ? reader : v)),
    args.map((v) => (v === reader ? 'invalid' : v)),
    args.map((v) => (v === '/private/selection.json' ? '../selection.json' : v)),
    args.map((v) => (v === '/private/selection.json' ? '/private/../selection.json' : v)),
    args.map((v) => (v === '/private/selection.json' ? '/private/selection\n.json' : v)),
    ['mail-draft-setup', '--scope', 'fixture', '--request-id', requestId, '--client', '/private/client.json'],
    ['mail-draft-setup', '--scope', 'fixture', '--scope', 'fixture'],
  ])
    expect(() => parseMailDraftAccountArguments(invalid)).toThrow('invalid_admin_arguments');
});
