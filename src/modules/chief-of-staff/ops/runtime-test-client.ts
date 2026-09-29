import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { digest } from '../domain/contracts.js';
import type { MaintenanceLease } from './maintenance.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from './runtime-test-wire.js';

export type RuntimeTestReply = {
  challenge: string;
  status: 'ready' | 'complete' | 'paused';
  owner: string;
  lease: MaintenanceLease;
  releaseId: string;
  databaseFingerprint: string;
  bindingDigest: string;
  lifecycle: 'implementation_disposable';
  reopened: boolean;
};
type Action = 'begin' | 'check' | 'finish' | 'abort';
/** A cached receipt cannot answer a new random challenge. Failed transport invokes the local fixture stop callback. */
export class RuntimeTestClient {
  private queue: Promise<void> = Promise.resolve();
  private pending:
    | {
        challenge: string;
        action: Action;
        resolve(value: RuntimeTestReply): void;
        reject(error: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  private leaseDigest: string | undefined;
  private failure: Error | undefined;
  private complete = false;
  constructor(
    input: AsyncIterable<Uint8Array | string>,
    private output: Writable,
    private expected: { owner: string; databaseFingerprint: string; bindingDigest: string },
    private onLost: () => void,
  ) {
    output.on('error', () => this.fail());
    void this.read(input);
  }
  private fail() {
    if (this.failure || this.complete) return;
    this.failure = new Error('runtime_test_control_lost');
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(this.failure);
      this.pending = undefined;
    }
    this.onLost();
  }
  private async read(input: AsyncIterable<Uint8Array | string>) {
    try {
      for await (const value of runtimeTestMessages(input)) {
        const reply = value as RuntimeTestReply,
          pending = this.pending;
        if (
          !pending ||
          !reply ||
          reply.challenge !== pending.challenge ||
          reply.owner !== this.expected.owner ||
          reply.databaseFingerprint !== this.expected.databaseFingerprint ||
          reply.bindingDigest !== this.expected.bindingDigest ||
          reply.lifecycle !== 'implementation_disposable' ||
          !/^release-[a-zA-Z0-9_-]{1,120}$/.test(reply.releaseId ?? '') ||
          typeof reply.reopened !== 'boolean' ||
          !reply.lease ||
          reply.lease.owner !== this.expected.owner ||
          reply.lease.purpose !== 'runtime-disposable' ||
          !/^[a-f0-9-]{36}$/.test(reply.lease.nonce ?? '') ||
          !Number.isSafeInteger(reply.lease.generation) ||
          reply.lease.generation < 1
        )
          throw new Error('runtime_test_protocol_invalid');
        const statuses =
          pending.action === 'begin'
            ? ['ready', 'complete']
            : pending.action === 'check'
              ? ['ready']
              : pending.action === 'abort'
                ? ['paused']
                : ['complete'];
        if (!statuses.includes(reply.status) || (reply.status !== 'complete' && reply.reopened))
          throw new Error('runtime_test_protocol_invalid');
        const identity = digest({ lease: reply.lease, releaseId: reply.releaseId });
        if (this.leaseDigest && this.leaseDigest !== identity) throw new Error('runtime_test_protocol_invalid');
        this.leaseDigest = identity;
        if (reply.status === 'complete' || reply.status === 'paused') this.complete = true;
        clearTimeout(pending.timer);
        this.pending = undefined;
        pending.resolve(reply);
      }
      if (!this.complete) this.fail();
    } catch {
      this.fail();
    }
  }
  request(action: Action): Promise<RuntimeTestReply> {
    const result = this.queue.then(async () => {
      if (this.failure) throw this.failure;
      if (this.complete) throw new Error('runtime_test_session_closed');
      const challenge = randomUUID();
      const reply = new Promise<RuntimeTestReply>((resolve, reject) => {
        this.pending = { challenge, action, resolve, reject, timer: setTimeout(() => this.fail(), 60000) };
      });
      // Observe rejection before writing: a disconnected transport may fail synchronously.
      void reply.catch(() => {});
      try {
        await writeRuntimeTestMessage(this.output, { action, challenge });
      } catch {
        this.fail();
      }
      return reply;
    });
    this.queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
