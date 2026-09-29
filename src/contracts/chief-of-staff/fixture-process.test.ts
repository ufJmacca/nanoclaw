import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { startFixtureProcess } from './fixture-process.js';
it('waits for fixture completion and leaves no live local process group', async () => {
  const output = new PassThrough();
  output.resume();
  const child = startFixtureProcess(['-e', 'process.stdout.write("fixture");'], { PATH: process.env.PATH }, output);
  await child.finished;
  await expect(child.stop()).resolves.toBeUndefined();
});
it('terminates a fixture that ignores the graceful stop signal before reporting shutdown', async () => {
  const output = new PassThrough();
  const ready = new Promise<void>((resolve) => output.once('data', () => resolve()));
  const child = startFixtureProcess(
    ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);'],
    { PATH: process.env.PATH },
    output,
  );
  await ready;
  await child.stop();
  await expect(child.finished).rejects.toThrow('fixture_process_failed');
  await expect(child.stop()).resolves.toBeUndefined();
});
