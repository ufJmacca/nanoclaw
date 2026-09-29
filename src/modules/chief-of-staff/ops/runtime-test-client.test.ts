import { PassThrough } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { RuntimeTestClient } from './runtime-test-client.js';
const expected = { owner: 'fixture-run', databaseFingerprint: '1'.repeat(64), bindingDigest: '2'.repeat(64) };
const lease = {
  nonce: '3'.repeat(8) + '-3333-4333-8333-' + '3'.repeat(12),
  owner: expected.owner,
  generation: 2,
  purpose: 'runtime-disposable',
};
it('requires a fresh matching challenge and stable Pi lease on every control reply', async () => {
  const incoming = new PassThrough(),
    outgoing = new PassThrough();
  const client = new RuntimeTestClient(incoming, outgoing, expected, () => {});
  outgoing.on('data', (bytes) => {
    const request = JSON.parse(bytes.toString());
    incoming.write(
      JSON.stringify({
        ...expected,
        lease,
        releaseId: 'release-fixture',
        lifecycle: 'implementation_disposable',
        challenge: request.challenge,
        status: request.action === 'finish' ? 'complete' : 'ready',
        reopened: request.action === 'finish',
      }) + '\n',
    );
  });
  expect((await client.request('begin')).status).toBe('ready');
  expect((await client.request('check')).lease).toEqual(lease);
  expect((await client.request('finish')).status).toBe('complete');
  incoming.end();
  outgoing.end();
});
it('rejects cached replies, changed database identity and a lost SSH channel', async () => {
  for (const kind of ['stale', 'database', 'disconnect']) {
    const incoming = new PassThrough(),
      outgoing = new PassThrough(),
      lost = vi.fn();
    const client = new RuntimeTestClient(incoming, outgoing, expected, lost);
    outgoing.on('data', (bytes) => {
      if (kind === 'disconnect') {
        incoming.end();
        return;
      }
      const request = JSON.parse(bytes.toString());
      incoming.write(
        JSON.stringify({
          ...expected,
          lease,
          releaseId: 'release-fixture',
          lifecycle: 'implementation_disposable',
          challenge: kind === 'stale' ? 'old-challenge' : request.challenge,
          databaseFingerprint: kind === 'database' ? '9'.repeat(64) : expected.databaseFingerprint,
          status: 'ready',
          reopened: false,
        }) + '\n',
      );
    });
    await expect(client.request('begin')).rejects.toThrow();
    expect(lost).toHaveBeenCalledOnce();
    incoming.destroy();
    outgoing.destroy();
  }
});
