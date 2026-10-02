import { expect, it } from 'vitest';
import { stopFixtureWorkers } from './fixture-workers.js';
const image = 'sha256:' + 'a'.repeat(64),
  id = 'b'.repeat(64),
  other = 'c'.repeat(64),
  root = '/var/lib/docker/volumes/test/_data';
const row = (Id = id, Source = root + '/.cos-plan-state/fixtures/flow-s05-one/session/cos-v1') => ({
  Id,
  Image: image,
  State: 'running',
  Mounts: [{ Type: 'bind', Source, Destination: '/workspace' }],
});
it('stops only the exact selected image and fixture workspace, then verifies absence', async () => {
  let stopped = false;
  const stops: string[][] = [];
  await stopFixtureWorkers(root, image, (args) => {
    if (args[0] === 'ps') return stopped ? other : id + '\n' + other;
    if (args[0] === 'inspect')
      return (stopped ? [row(other, '/protected/session/cos-v1')] : [row(), row(other, '/protected/session/cos-v1')])
        .map((r) => JSON.stringify(r))
        .join('\n');
    stops.push(args);
    stopped = true;
    return id;
  });
  expect(stops).toEqual([['stop', '-t', '1', id]]);
});
it('refuses an unexpected image at an owned workspace instead of stopping it or releasing the fence', async () => {
  const calls: string[][] = [];
  await expect(
    stopFixtureWorkers(root, image, (args) => {
      calls.push(args);
      return args[0] === 'ps' ? id : JSON.stringify({ ...row(), Image: 'sha256:' + 'd'.repeat(64) });
    }),
  ).rejects.toThrow('fixture_worker_identity_changed');
  expect(calls.some((args) => args[0] === 'stop')).toBe(false);
});
it('does not claim absence when Docker inspection fails', async () => {
  await expect(
    stopFixtureWorkers(root, image, () => {
      throw Error('docker_unavailable');
    }),
  ).rejects.toThrow();
});
it('rejects broad or ambiguous roots before inspecting containers', async () => {
  for (const bad of ['/', 'relative', '/a/../b'])
    await expect(
      stopFixtureWorkers(bad, image, () => {
        throw Error('must_not_inspect');
      }),
    ).rejects.toThrow('invalid_fixture_worker_root');
});
