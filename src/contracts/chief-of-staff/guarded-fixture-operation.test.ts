import { expect, it, vi } from 'vitest';
import { guardedFixtureOperation, type FixtureRunReceipt } from './guarded-fixture-operation.js';
const lease = {
  nonce: '11111111-1111-4111-8111-111111111111',
  generation: 2,
  owner: 'fixture-run',
  purpose: 'runtime-disposable' as const,
};
function fixture() {
  const calls: string[] = [];
  let receipt: FixtureRunReceipt | undefined;
  const reply = {
    challenge: '11111111-1111-4111-8111-111111111111',
    owner: lease.owner,
    lease,
    releaseId: 'release-current',
    databaseFingerprint: '1'.repeat(64),
    bindingDigest: '2'.repeat(64),
    lifecycle: 'implementation_disposable' as const,
    reopened: false,
    status: 'ready' as 'ready' | 'complete' | 'paused',
  };
  return {
    calls,
    requestDigest: '3'.repeat(64),
    control: {
      request: vi.fn(async (action: string) => {
        calls.push(action);
        return {
          ...reply,
          status:
            action === 'finish' ? ('complete' as const) : action === 'abort' ? ('paused' as const) : ('ready' as const),
        };
      }),
    },
    lost: new Promise<never>(() => {}),
    read: () => receipt,
    save: async (value: FixtureRunReceipt) => {
      calls.push('save-' + value.status);
      receipt = value;
    },
    acquireFence: vi.fn(async () => {
      calls.push('fence');
      return async () => {
        calls.push('release-fence');
      };
    }),
    run: vi.fn(async () => {
      calls.push('run');
    }),
    stop: vi.fn(async () => {
      calls.push('stop');
    }),
  };
}
it('keeps the database fence until fixture processes stop, then reopens only after the test receipt is durable', async () => {
  const f = fixture();
  await guardedFixtureOperation(f);
  expect(f.calls).toEqual([
    'begin',
    'save-running',
    'fence',
    'run',
    'stop',
    'save-passed',
    'release-fence',
    'finish',
    'save-complete',
  ]);
});
it('lost target contact stops local tests before releasing the database fence and never finishes the Pi lease', async () => {
  const f = fixture();
  let reject!: (error: Error) => void;
  f.lost = new Promise<never>((_, fail) => {
    reject = fail;
  });
  f.run = vi.fn(async () => {
    f.calls.push('run');
    reject(new Error('SSH lost'));
    await new Promise<void>(() => {});
  });
  await expect(guardedFixtureOperation(f)).rejects.toThrow('SSH lost');
  expect(f.calls.indexOf('stop')).toBeLessThan(f.calls.indexOf('release-fence'));
  expect(f.calls).not.toContain('finish');
  expect(f.read()?.status).toBe('failed');
});
it('preserves a passed test receipt when the final target reply is lost and reconciles without rerunning tests', async () => {
  const f = fixture(),
    original = f.control.request.getMockImplementation()!;
  f.control.request.mockImplementation(async (action) => {
    if (action === 'finish') throw new Error('reply lost');
    return original(action);
  });
  await expect(guardedFixtureOperation(f)).rejects.toThrow('reply lost');
  expect(f.read()?.status).toBe('passed');
  f.control.request.mockImplementation(async () => ({ ...(await original('begin')), status: 'complete' }));
  await expect(guardedFixtureOperation(f)).resolves.toMatchObject({ status: 'passed', reconciled: true });
  expect(f.run).toHaveBeenCalledOnce();
});
it('does not release the database fence when local process termination cannot be established', async () => {
  const f = fixture();
  f.run.mockRejectedValue(new Error('fixture failed'));
  f.stop.mockRejectedValue(new Error('termination uncertain'));
  await expect(guardedFixtureOperation(f)).rejects.toThrow('termination uncertain');
  expect(f.calls).not.toContain('release-fence');
  expect(f.calls).not.toContain('finish');
});
