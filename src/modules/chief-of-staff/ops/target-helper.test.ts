import { expect, it } from 'vitest';
import { parseTargetArguments } from './target-helper.js';
it('requires the exact manifest hash and rejects repair, binding and account flags for protected release completion', () => {
  const args = [
    'protected-release',
    '--settings',
    '/home/pi/settings.json',
    '--release-id',
    'release-final',
    '--manifest-sha256',
    'a'.repeat(64),
  ];
  expect(parseTargetArguments(args)).toEqual({
    command: 'protected-release',
    settings: '/home/pi/settings.json',
    releaseId: 'release-final',
    manifestHash: 'a'.repeat(64),
  });
  for (const extra of [
    ['--recover-from', 'release-failed'],
    ['--binding', '/home/pi/binding.json'],
    ['--owner', 'fixture'],
    ['--completion', '/home/pi/proof.json'],
    ['--phase', 'release'],
    ['--manifest-sha256', 'b'.repeat(64)],
  ])
    expect(() => parseTargetArguments([...args, ...extra])).toThrow('invalid_target_arguments');
  expect(() => parseTargetArguments([...args.slice(0, -1), 'latest'])).toThrow('invalid_target_arguments');
  expect(() => parseTargetArguments(args.slice(0, -2))).toThrow('invalid_target_arguments');
});
it('accepts only fixed target operations, canonical private settings, and exact release identities', () => {
  expect(
    parseTargetArguments([
      'operations-maintenance',
      '--settings',
      '/home/pi/settings.json',
      '--request-id',
      '01234567-89ab-4def-8123-456789abcdef',
      '--phase',
      'hold',
    ]),
  ).toEqual({
    command: 'operations-maintenance',
    settings: '/home/pi/settings.json',
    requestId: '01234567-89ab-4def-8123-456789abcdef',
    phase: 'hold',
  });
  expect(
    parseTargetArguments([
      'programme-protect',
      '--settings',
      '/home/pi/settings.json',
      '--completion',
      '/home/pi/completion.json',
    ]),
  ).toEqual({
    command: 'programme-protect',
    settings: '/home/pi/settings.json',
    completion: '/home/pi/completion.json',
  });
  expect(
    parseTargetArguments(['runtime-test', '--settings', '/home/pi/settings.json', '--owner', 'fixture-run']),
  ).toEqual({ command: 'runtime-test', settings: '/home/pi/settings.json', owner: 'fixture-run' });
  expect(
    parseTargetArguments([
      'rollback',
      '--settings',
      '/home/pi/settings.json',
      '--release-id',
      'release-prior',
      '--from-release-id',
      'release-current',
    ]),
  ).toEqual({
    command: 'rollback',
    settings: '/home/pi/settings.json',
    releaseId: 'release-prior',
    fromReleaseId: 'release-current',
  });
  expect(parseTargetArguments(['status', '--settings', '/home/pi/settings.json'])).toEqual({
    command: 'status',
    settings: '/home/pi/settings.json',
  });
  expect(
    parseTargetArguments([
      'deploy',
      '--settings',
      '/home/pi/settings.json',
      '--release-id',
      'release-test',
      '--manifest-sha256',
      'a'.repeat(64),
    ]),
  ).toMatchObject({ command: 'deploy', releaseId: 'release-test', manifestHash: 'a'.repeat(64) });
  const recovery = [
    'deploy',
    '--settings',
    '/tmp/settings',
    '--release-id',
    'release-corrected',
    '--manifest-sha256',
    'a'.repeat(64),
    '--recover-from',
    'release-failed',
  ];
  expect(parseTargetArguments(recovery)).toMatchObject({ command: 'deploy', recoverFrom: 'release-failed' });
  for (const value of ['../failed', 'release-corrected', ''])
    expect(() => parseTargetArguments([...recovery.slice(0, -1), value])).toThrow();
  for (const args of [
    ['shell'],
    [
      'operations-maintenance',
      '--settings',
      '/tmp/settings',
      '--request-id',
      '01234567-89ab-4def-8123-456789abcdef',
      '--phase',
      'resume',
    ],
    ['operations-maintenance', '--settings', '/tmp/settings', '--request-id', '../foreign', '--phase', 'hold'],
    ['programme-protect', '--settings', '/tmp/settings', '--completion', '../proof'],
    ['programme-protect', '--settings', '/tmp/settings', '--completion', '/tmp/proof', '--owner', 'fixture'],
    ['status', '--settings', '/tmp/settings', '--completion', '/tmp/proof'],
    ['status', '--settings', 'relative'],
    ['status', '--settings', '/tmp/settings', '--settings', '/tmp/other'],
    ['deploy', '--settings', '/tmp/settings', '--release-id', '../active', '--manifest-sha256', 'a'.repeat(64)],
    ['deploy', '--settings', '/tmp/settings', '--release-id', 'release-test', '--manifest-sha256', 'latest'],
    ['status', '--settings', '/tmp/settings', '--binding', '/tmp/binding'],
    ['runtime-test', '--settings', '/tmp/settings', '--owner', '../foreign'],
    ['runtime-test', '--settings', '/tmp/settings', '--owner', 'fixture-run', '--release-id', 'release-test'],
    ['rollback', '--settings', '/tmp/settings', '--release-id', 'release-prior'],
    [
      'rollback',
      '--settings',
      '/tmp/settings',
      '--release-id',
      'release-prior',
      '--from-release-id',
      'release-current',
      '--binding',
      '/tmp/binding',
    ],
  ])
    expect(() => parseTargetArguments(args)).toThrow('invalid_target_arguments');
});
