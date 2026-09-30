import { expect, it } from 'vitest';
import { parseTargetArguments } from './target-helper.js';
it('accepts only fixed target operations, canonical private settings, and exact release identities', () => {
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
