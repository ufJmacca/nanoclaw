import { expect, it } from 'vitest';
import { parseAdminArguments } from './admin.js';
it('S11 owner CLI status requires an exact scope and permits only bounded inspection fields', () => {
  expect(
    parseAdminArguments([
      'operator-status',
      '--scope',
      'fixture',
      '--category',
      'missions',
      '--limit',
      '5',
      '--offset',
      '20',
    ]),
  ).toEqual({ command: 'operator-status', scopeId: 'fixture', input: { category: 'missions', limit: 5, offset: 20 } });
  expect(parseAdminArguments(['operator-status', '--scope', 'fixture'])).toEqual({
    command: 'operator-status',
    scopeId: 'fixture',
    input: {},
  });
  for (const args of [
    ['operator-status'],
    ['operator-status', '--scope', '../other'],
    ['operator-status', '--scope', 'fixture', '--resume', 'true'],
    ['operator-status', '--scope', 'fixture', '--limit', '21'],
    ['operator-status', '--scope', 'fixture', '--category', 'secrets'],
    ['operator-status', '--scope', 'fixture', '--offset', '01'],
  ])
    expect(() => parseAdminArguments(args)).toThrow('invalid_admin_arguments');
});
