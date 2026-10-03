import { expect, it, vi } from 'vitest';
import { runTargetHealth } from './target-health.js';

it('records the exact failed gate without exposing error messages or running later checks', async () => {
  const write = vi.fn();
  const later = vi.fn();
  const secret = 'private-provider-token';
  await expect(
    runTargetHealth({
      releaseId: 'release-fixture',
      sourceCommit: 'a'.repeat(40),
      write,
      checks: [
        { stage: 'native_compatibility', run: async () => {} },
        {
          stage: 'process',
          run: async () => {
            throw Object.assign(new Error(secret), { code: secret });
          },
        },
        { stage: 'schema', run: later },
      ],
    }),
  ).resolves.toBe(false);
  expect(later).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledOnce();
  expect(write.mock.calls[0][0]).toMatchObject({
    releaseId: 'release-fixture',
    sourceCommit: 'a'.repeat(40),
    status: 'failed',
    stage: 'process',
    code: 'unclassified_failure',
    completed: ['native_compatibility'],
  });
  expect(JSON.stringify(write.mock.calls)).not.toContain(secret);
});

it.each([
  [new Error('target_host_ownership_mismatch'), 'target_host_ownership_mismatch'],
  [Object.assign(new Error('private path'), { code: 'EACCES' }), 'EACCES'],
  [Object.assign(new Error('private expected value'), { name: 'AssertionError' }), 'fixture_assertion_failed'],
])('records only admitted failure classifications', async (error, code) => {
  const write = vi.fn();
  await expect(
    runTargetHealth({
      releaseId: 'release-fixture',
      sourceCommit: 'b'.repeat(40),
      write,
      checks: [
        {
          stage: 'fixture',
          run: async () => {
            throw error;
          },
        },
      ],
    }),
  ).resolves.toBe(false);
  expect(write.mock.calls[0][0]).toMatchObject({ status: 'failed', stage: 'fixture', code });
  expect(JSON.stringify(write.mock.calls)).not.toContain('private');
});

it('records successful checks in order and propagates a receipt write failure', async () => {
  const order: string[] = [],
    write = vi.fn();
  const options = {
    releaseId: 'release-fixture',
    sourceCommit: 'c'.repeat(40),
    write,
    checks: [
      {
        stage: 'schema' as const,
        run: async () => {
          order.push('schema');
        },
      },
      {
        stage: 'fixture' as const,
        run: async () => {
          order.push('fixture');
        },
      },
    ],
  };
  await expect(runTargetHealth(options)).resolves.toBe(true);
  expect(order).toEqual(['schema', 'fixture']);
  expect(write.mock.calls[0][0]).toMatchObject({ status: 'passed', completed: order });
  write.mockImplementation(() => {
    throw new Error('receipt_storage_unavailable');
  });
  await expect(runTargetHealth(options)).rejects.toThrow('receipt_storage_unavailable');
});
