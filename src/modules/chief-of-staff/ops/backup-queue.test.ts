import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { BackupQueue } from './backup-queue.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-queue-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const kind of ['state', 'credentials']) fs.mkdirSync(path.join(root, kind), { mode: 0o700 });
  let available = true;
  const queue = new BackupQueue('a'.repeat(64), async (kind, operation) => {
    if (!available) throw Error('vault_storage_unavailable');
    return operation(path.join(root, kind));
  });
  return {
    root,
    queue,
    close: () => {
      available = false;
    },
  };
}
const op = '9f99d9b4-4dac-423a-956c-afd953993c2d',
  next = '6ea53126-7177-469b-8bc1-cedd11635b79';
it('observes delivery without initializing a queue or exposing captured file names', async () => {
  const f = fixture();
  expect(await f.queue.inspectDelivery('state')).toEqual({
    items: [],
    lastRemoteCheckpointAt: null,
    lastAcknowledgedCaptureAt: null,
  });
  expect(fs.existsSync(f.root + '/state/backup-queue')).toBe(false);
  await f.queue.capture('state', op, async (sink) => sink.write('private-name.json', Buffer.from('state')), 65536);
  const delivery = await f.queue.inspectDelivery('state');
  expect(delivery.items).toEqual([
    expect.objectContaining({ kind: 'state', operationId: op, disposition: 'upload', bytes: expect.any(Number) }),
  ]);
  expect(JSON.stringify(delivery)).not.toContain('private-name');
});
it('holds failed captures instead of treating them as interrupted remote retirement', async () => {
  const f = fixture();
  await expect(
    f.queue.capture(
      'credentials',
      op,
      async (sink) => {
        sink.write('partial.json', Buffer.from('partial'));
        throw Error('interrupted capture');
      },
      65536,
    ),
  ).rejects.toThrow('backup_queue_unavailable');
  expect((await f.queue.inspectDelivery('credentials')).items).toMatchObject([
    { operationId: op, disposition: 'held' },
  ]);
  expect(fs.existsSync(f.root + '/credentials/backup-queue/' + op + '/data/partial.json')).toBe(true);
});
it('captures and verifies through the held self-descriptor used by the default vault accessor', async () => {
  const f = fixture();
  const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => {
    const fd = fs.openSync(f.root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    try {
      return await operation('/proc/self/fd/' + fd);
    } finally {
      fs.closeSync(fd);
    }
  });
  expect(await queue.inspect('state')).toEqual([]);
  await queue.capture(
    'state',
    op,
    async (sink) => sink.write('private.json', Buffer.from('SYNTHETIC_PRIVATE_STATE')),
    65536,
  );
  await queue.withPending('state', op, async (directory) => {
    expect(fs.readFileSync(directory + '/private.json', 'utf8')).toBe('SYNTHETIC_PRIVATE_STATE');
  });
});
it('durably captures private files and retains exactly one pending full checkpoint during an outage', async () => {
  const f = fixture();
  let captures = 0;
  const first = await f.queue.capture(
    'state',
    op,
    async (sink) => {
      captures++;
      sink.write('coordinated/remote.json', Buffer.from('synthetic-state'));
    },
    65536,
  );
  expect(first).toMatchObject({ status: 'queued', operationId: op, kind: 'state' });
  const second = await f.queue.capture(
    'state',
    next,
    async () => {
      captures++;
    },
    65536,
  );
  expect(second).toMatchObject({ status: 'skipped_pending', operationId: op });
  expect(captures).toBe(1);
  const pending = await f.queue.pending('state');
  expect(pending).toHaveLength(1);
  expect(pending[0].files[0].name).toBe('coordinated/remote.json');
  await f.queue.withPending('state', op, async (directory, receipt) => {
    expect(fs.readFileSync(path.join(directory, 'coordinated/remote.json'), 'utf8')).toBe('synthetic-state');
    expect(fs.statSync(path.join(directory, 'coordinated/remote.json')).mode & 0o777).toBe(0o600);
    expect(receipt.state).toBe('pending');
  });
});
it('credential snapshots remain durable and separate from the occupied full slot', async () => {
  const f = fixture();
  await f.queue.capture('state', op, async (sink) => sink.write('remote.json', Buffer.from('state')), 65536);
  await f.queue.capture(
    'credentials',
    op,
    async (sink) => sink.write('tokens.json', Buffer.from('synthetic-token')),
    65536,
  );
  await f.queue.capture(
    'credentials',
    next,
    async (sink) => sink.write('journal.json', Buffer.from('synthetic-journal')),
    65536,
  );
  expect(await f.queue.pending('credentials')).toHaveLength(2);
  expect(await f.queue.pending('state')).toHaveLength(1);
});
it('lost vault access denies capture before invoking the producer', async () => {
  const f = fixture();
  f.close();
  let called = false;
  await expect(
    f.queue.capture('state', op, async () => {
      called = true;
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(called).toBe(false);
  expect(fs.readdirSync(path.join(f.root, 'state'))).toEqual([]);
});
it('exhausted capture budgets retain a failed slot and skip subsequent full captures', async () => {
  const f = fixture();
  await expect(
    f.queue.capture(
      'state',
      op,
      async (sink) => {
        sink.write('first', Buffer.alloc(8192));
        sink.write('over-limit', Buffer.alloc(65536));
      },
      65536,
    ),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  const skipped = await f.queue.capture(
    'state',
    next,
    async () => {
      throw Error('must_not_capture');
    },
    65536,
  );
  expect(skipped.status).toBe('skipped_pending');
  expect(skipped.operationId).toBe(op);
  expect((await f.queue.pending('state'))[0].state).toBe('failed');
});
it.each(['../escape', '/absolute', 'nested/../../escape', 'a//b', 'a/./b', 'a\0b'])(
  'denies unsafe capture name %s',
  async (name) => {
    const f = fixture();
    await expect(
      f.queue.capture('state', op, async (sink) => sink.write(name, Buffer.from('x')), 65536),
    ).rejects.toThrow(/^backup_queue_unavailable$/);
  },
);
it('does not steal a concurrent writer lease', async () => {
  const f = fixture();
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    done = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const first = f.queue.capture(
    'state',
    op,
    async (sink) => {
      sink.write('state', Buffer.from('x'));
      entered();
      await done;
    },
    65536,
  );
  await started;
  await expect(f.queue.capture('state', next, async () => {}, 65536)).rejects.toThrow(/^backup_queue_unavailable$/);
  finish();
  await first;
});
it('a slow upload does not hold the credential publication lease', async () => {
  const f = fixture();
  await f.queue.capture('credentials', op, async (sink) => sink.write('token.json', Buffer.from('synthetic')), 65536);
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    done = new Promise<void>((resolve) => {
      finish = resolve;
    });
  const reading = f.queue.withPending('credentials', op, async () => {
    entered();
    await done;
  });
  await started;
  try {
    await expect(
      f.queue.capture(
        'credentials',
        next,
        async (sink) => sink.write('token.json', Buffer.from('new-synthetic')),
        65536,
      ),
    ).resolves.toMatchObject({ status: 'queued' });
  } finally {
    finish();
    await reading;
  }
});
it.each(['changed', 'symlink', 'unlisted', 'hardlink'])('denies %s pending files before upload', async (reason) => {
  const f = fixture();
  await f.queue.capture('state', op, async (sink) => sink.write('state.json', Buffer.from('original')), 65536);
  const data = path.join(f.root, 'state', 'backup-queue', 'full', 'data');
  if (reason === 'changed') fs.writeFileSync(path.join(data, 'state.json'), 'changed');
  if (reason === 'symlink') {
    fs.renameSync(path.join(data, 'state.json'), path.join(f.root, 'held'));
    fs.symlinkSync(path.join(f.root, 'held'), path.join(data, 'state.json'));
  }
  if (reason === 'unlisted') fs.writeFileSync(path.join(data, 'unlisted'), 'preserve', { mode: 0o600 });
  if (reason === 'hardlink') fs.linkSync(path.join(data, 'state.json'), path.join(f.root, 'held'));
  let called = false;
  await expect(
    f.queue.withPending('state', op, async () => {
      called = true;
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(called).toBe(false);
});
it('refuses an unexplained queue-directory collision without adopting or deleting it', async () => {
  const f = fixture(),
    existing = path.join(f.root, 'state', 'backup-queue');
  fs.mkdirSync(existing, { mode: 0o700 });
  fs.writeFileSync(path.join(existing, 'foreign'), 'preserve');
  await expect(f.queue.capture('state', op, async () => {}, 65536)).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.readFileSync(path.join(existing, 'foreign'), 'utf8')).toBe('preserve');
});

it('inspects an absent queue without creating plaintext or vault queue state', async () => {
  const f = fixture();
  expect(await f.queue.inspect('state')).toEqual([]);
  expect(fs.readdirSync(f.root + '/state')).toEqual([]);
  f.close();
  await expect(f.queue.inspect('state')).rejects.toThrow('backup_queue_unavailable');
});
it('inspection keeps occupied and failed full slots visible without changing them', async () => {
  const f = fixture();
  await expect(
    f.queue.capture(
      'state',
      op,
      async () => {
        throw Error('synthetic_failure');
      },
      65536,
    ),
  ).rejects.toThrow('backup_queue_unavailable');
  const before = fs.readFileSync(f.root + '/state/backup-queue/full/receipt.json');
  expect(await f.queue.inspect('state')).toMatchObject([{ operationId: op, state: 'failed' }]);
  expect(fs.readFileSync(f.root + '/state/backup-queue/full/receipt.json')).toEqual(before);
});
