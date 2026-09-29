import { expect, it } from 'vitest';
import { parseTargetArguments } from './target-helper.js';
it('accepts only fixed target operations, canonical private settings, and exact release identities', () => {
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
  for (const args of [
    ['shell'],
    ['status', '--settings', 'relative'],
    ['status', '--settings', '/tmp/settings', '--settings', '/tmp/other'],
    ['deploy', '--settings', '/tmp/settings', '--release-id', '../active', '--manifest-sha256', 'a'.repeat(64)],
    ['deploy', '--settings', '/tmp/settings', '--release-id', 'release-test', '--manifest-sha256', 'latest'],
    ['status', '--settings', '/tmp/settings', '--binding', '/tmp/binding'],
  ])
    expect(() => parseTargetArguments(args)).toThrow('invalid_target_arguments');
});
