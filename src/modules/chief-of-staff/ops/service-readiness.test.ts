import { afterEach, expect, it, vi } from 'vitest';
import { waitForTargetProcess } from './service-readiness.js';

afterEach(() => vi.useRealTimers());
it('waits for native database ownership after the service manager reports running', async () => {
  vi.useFakeTimers();
  const identity = { executable: '/release/node', entryPoint: '/release/index.js' };
  const observe = vi
    .fn()
    .mockRejectedValueOnce(new Error('target_host_ownership_mismatch'))
    .mockResolvedValue(identity);
  const result = waitForTargetProcess(observe);
  await vi.advanceTimersByTimeAsync(250);
  await expect(result).resolves.toEqual(identity);
  expect(observe).toHaveBeenCalledTimes(2);
});
it('bounds startup retries and never treats an unowned service as healthy', async () => {
  vi.useFakeTimers();
  const observe = vi.fn().mockRejectedValue(new Error('target_service_unhealthy'));
  const rejected = expect(waitForTargetProcess(observe)).rejects.toThrow('target_service_unhealthy');
  await vi.runAllTimersAsync();
  await rejected;
  expect(observe).toHaveBeenCalledTimes(40);
});
it('refuses a wrong process identity or unexpected verification error immediately', async () => {
  for (const failure of [new Error('target_process_mismatch'), new Error('unexpected verification failure')]) {
    const observe = vi.fn().mockRejectedValue(failure);
    await expect(waitForTargetProcess(observe)).rejects.toBe(failure);
    expect(observe).toHaveBeenCalledOnce();
  }
});
