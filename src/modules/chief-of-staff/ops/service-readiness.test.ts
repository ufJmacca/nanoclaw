import { afterEach, expect, it, vi } from 'vitest';
import { waitForTargetProcess } from './service-readiness.js';

afterEach(() => vi.useRealTimers());
it.each(['cwd', 'exe'])('waits through transient process %s access restrictions during exec', async (link) => {
  vi.useFakeTimers();
  const failure = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
    syscall: 'readlink',
    path: '/proc/123/' + link,
  });
  const observe = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue('verified');
  const result = waitForTargetProcess(observe);
  const expected = expect(result).resolves.toBe('verified');
  await Promise.all([expected, vi.advanceTimersByTimeAsync(250)]);
  expect(observe).toHaveBeenCalledTimes(2);
});
it('refuses a persistent process access restriction and never retries unrelated permission failures', async () => {
  vi.useFakeTimers();
  const failure = Object.assign(new Error('permission denied'), {
    code: 'EACCES',
    syscall: 'readlink',
    path: '/proc/123/exe',
  });
  const observe = vi.fn().mockRejectedValue(failure);
  const rejected = expect(waitForTargetProcess(observe)).rejects.toBe(failure);
  await vi.runAllTimersAsync();
  await rejected;
  expect(observe).toHaveBeenCalledTimes(40);
  const unrelated = vi
    .fn()
    .mockRejectedValue(
      Object.assign(new Error('permission denied'), { code: 'EACCES', syscall: 'open', path: '/private/data' }),
    );
  await expect(waitForTargetProcess(unrelated)).rejects.toThrow('permission denied');
  expect(unrelated).toHaveBeenCalledOnce();
});
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
