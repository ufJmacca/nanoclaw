import { digest } from '../../modules/chief-of-staff/domain/contracts.js';
import type { RuntimeTestClient, RuntimeTestReply } from '../../modules/chief-of-staff/ops/runtime-test-client.js';
export type FixtureRunReceipt = {
  version: 1;
  requestDigest: string;
  leaseDigest: string;
  status: 'running' | 'passed' | 'failed' | 'complete';
};
/** The Mac database fence is released only after all local fixture processes have stopped. */
export async function guardedFixtureOperation(request: {
  requestDigest: string;
  control: Pick<RuntimeTestClient, 'request'>;
  lost: Promise<never>;
  read(): FixtureRunReceipt | undefined;
  save(value: FixtureRunReceipt): Promise<void>;
  acquireFence(reply: RuntimeTestReply): Promise<() => Promise<void>>;
  run(): Promise<void>;
  stop(): Promise<void>;
}) {
  void request.lost.catch(() => {});
  const hello = await request.control.request('begin');
  const identity = {
    version: 1 as const,
    requestDigest: request.requestDigest,
    leaseDigest: digest({ lease: hello.lease, releaseId: hello.releaseId }),
  };
  const prior = request.read();
  if (
    prior &&
    (prior.version !== 1 ||
      prior.requestDigest !== identity.requestDigest ||
      prior.leaseDigest !== identity.leaseDigest ||
      !['running', 'passed', 'failed', 'complete'].includes(prior.status))
  )
    throw new Error('runtime_fixture_receipt_conflict');
  let passed = prior?.status === 'passed' || prior?.status === 'complete';
  if (hello.status === 'complete') {
    if (!passed) throw new Error('runtime_fixture_receipt_conflict');
    await request.save({ ...identity, status: 'complete' });
    return { status: 'passed', reconciled: true };
  }
  if (hello.status !== 'ready') throw new Error('runtime_fixture_not_admitted');
  if (!passed) await request.save({ ...identity, status: 'running' });
  let release: (() => Promise<void>) | undefined,
    stopped = false;
  try {
    release = await request.acquireFence(hello);
    if (!passed) await Promise.race([request.lost, request.run()]);
    await request.stop();
    stopped = true;
    if (!passed) {
      await request.save({ ...identity, status: 'passed' });
      passed = true;
    }
    await release();
    release = undefined;
    const finished = await request.control.request('finish');
    if (finished.status !== 'complete') throw new Error('runtime_fixture_finish_unverified');
    await request.save({ ...identity, status: 'complete' });
    return { status: 'passed', reconciled: prior?.status === 'passed' || prior?.status === 'complete' };
  } catch (error) {
    // If termination cannot be established, retain the live database fence and leave the Pi latch closed.
    if (!stopped) await request.stop();
    if (!passed) await request.save({ ...identity, status: 'failed' });
    if (release) await release();
    await request.control.request('abort').catch(() => {});
    throw error;
  }
}
