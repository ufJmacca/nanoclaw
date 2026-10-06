import { expect, it } from 'vitest';
import { parseRecoveryDrillArguments } from './recovery-drill.js';
it('S11-PG02 requires an explicit private synthetic recovery phase and one canonical root', () => {
  expect(parseRecoveryDrillArguments(['--phase', 'capture', '--root', '/fixture/request/recovery'])).toEqual({
    phase: 'capture',
    root: '/fixture/request/recovery',
  });
  expect(parseRecoveryDrillArguments(['--phase', 'restore', '--root', '/fixture/request/recovery'])).toEqual({
    phase: 'restore',
    root: '/fixture/request/recovery',
  });
  for (const args of [
    [],
    ['--phase', 'resume', '--root', '/fixture'],
    ['--phase', 'capture', '--root', '/'],
    ['--phase', 'restore', '--root', '/fixture/../elsewhere'],
    ['--phase', 'restore', '--root', '/fixture', '--runtime-password', 'private'],
  ])
    expect(() => parseRecoveryDrillArguments(args)).toThrow('invalid_recovery_drill_arguments');
});
