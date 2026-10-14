import fs from 'node:fs';
import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
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
it.each(['ENOENT', 'ESRCH'])(
  'continues verified fixture shutdown when a proc read races with %s disappearance',
  async (code) => {
    const output = new PassThrough(),
      ready = new Promise<void>((resolve) => output.once('data', () => resolve()));
    const child = startFixtureProcess(
      ['-e', 'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000);'],
      { PATH: process.env.PATH },
      output,
    );
    await ready;
    const read = fs.readFileSync;
    let disappeared = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
      if (!disappeared && args[0] === '/proc/' + process.pid + '/stat') {
        disappeared = true;
        throw Object.assign(new Error('synthetic proc disappearance'), { code });
      }
      return Reflect.apply(read, fs, args);
    }) as typeof fs.readFileSync);
    try {
      await expect(child.stop()).resolves.toBeUndefined();
      expect(disappeared).toBe(true);
      await expect(child.finished).rejects.toThrow('fixture_process_failed');
      await expect(child.stop()).resolves.toBeUndefined();
    } finally {
      vi.restoreAllMocks();
      await child.stop();
    }
  },
);
it.each(['EACCES', 'EIO'])('does not report verified shutdown after a proc observation %s error', async (code) => {
  const output = new PassThrough(),
    ready = new Promise<void>((resolve) => output.once('data', () => resolve()));
  const child = startFixtureProcess(
    ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000);'],
    { PATH: process.env.PATH },
    output,
  );
  await ready;
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof fs.readFileSync>) => {
    if (args[0] === '/proc/' + process.pid + '/stat')
      throw Object.assign(new Error('synthetic observation failure'), { code });
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readFileSync);
  try {
    await expect(child.stop()).rejects.toMatchObject({ code });
  } finally {
    vi.restoreAllMocks();
    await child.stop();
  }
});
