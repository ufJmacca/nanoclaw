import { expect, it, vi } from 'vitest';
import { OperationQueue } from './operation-queue.js';

it('serializes concurrent publication before acquiring an artifact lock or database client', async () => {
  const queue = new OperationQueue(3, 1000);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = queue.run(async () => {
    await held;
    return 'first';
  });
  const secondWork = vi.fn(async () => 'second');
  const second = queue.run(secondWork);
  expect(secondWork).not.toHaveBeenCalled();
  release();
  await expect(first).resolves.toBe('first');
  await expect(second).resolves.toBe('second');
});

it('bounds admitted publications and releases the queue after an operation fails', async () => {
  const queue = new OperationQueue(2, 1000);
  let release!: () => void;
  const first = queue.run(async () => {
    await new Promise<void>((r) => {
      release = r;
    });
    throw Error('interrupted');
  });
  const failed = expect(first).rejects.toThrow('interrupted');
  const second = queue.run(async () => 'second');
  await expect(queue.run(async () => 'overflow')).rejects.toThrow('artifact_operation_busy');
  release();
  await failed;
  await expect(second).resolves.toBe('second');
  await expect(queue.run(async () => 'later')).resolves.toBe('later');
});

it('expires waiting work without granting a publication or bypassing the active operation', async () => {
  vi.useFakeTimers();
  try {
    const queue = new OperationQueue(3, 100);
    let release!: () => void;
    const first = queue.run(async () => {
      await new Promise<void>((r) => {
        release = r;
      });
      return 'first';
    });
    const waitingWork = vi.fn(async () => 'expired');
    const expired = expect(queue.run(waitingWork)).rejects.toThrow('artifact_operation_busy');
    await vi.advanceTimersByTimeAsync(101);
    await expired;
    const nextWork = vi.fn(async () => 'next');
    const next = queue.run(nextWork);
    expect(nextWork).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toBe('first');
    await expect(next).resolves.toBe('next');
    expect(waitingWork).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
