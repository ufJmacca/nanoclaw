import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue, type BackupRetirementRequest } from './backup-queue.js';
import type { RemoteCheckpoint } from './backup-restic-transfer.js';
import type { BackupKind } from './backup-policy.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const op = '9f99d9b4-4dac-423a-956c-afd953993c2d',
  next = '6ea53126-7177-469b-8bc1-cedd11635b79';
async function fixture(kind: BackupKind = 'state') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-retirement-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  for (const name of ['state', 'credentials']) fs.mkdirSync(root + '/' + name, { mode: 0o700 });
  let available = true;
  const queue = new BackupQueue('a'.repeat(64), async (selected, callback) => {
    if (!available) throw Error('unavailable');
    return callback(root + '/' + selected);
  });
  await queue.capture(
    kind,
    op,
    async (sink) => {
      sink.write('a.json', Buffer.from('SYNTHETIC_FIRST'));
      sink.write('nested/b.json', Buffer.from('SYNTHETIC_SECOND'));
    },
    65536,
  );
  return {
    root,
    queue,
    queueRoot: root + '/' + kind + '/backup-queue',
    slot: root + '/' + kind + '/backup-queue/' + (kind === 'state' ? 'full' : op),
    close: () => {
      available = false;
    },
  };
}
function checkpoint(request: BackupRetirementRequest): RemoteCheckpoint {
  return {
    contract: 'cos-backup-remote-checkpoint/v1',
    repositoryId: 'b'.repeat(64),
    ownerDigest: 'c'.repeat(64),
    kind: request.receipt.kind,
    operationId: request.receipt.operationId,
    snapshotId: 'd'.repeat(64),
    snapshotAt: '2026-10-11T00:00:00Z',
    archiveBytes: request.archive.bytes,
    archiveSha256: request.archive.sha256,
    reconciled: !!request.previous,
    verifiedAt: new Date().toISOString(),
  };
}
const prove = async (request: BackupRetirementRequest) => ({ checkpoint: checkpoint(request), assertCurrent() {} });
it.each(['state', 'credentials'] as const)(
  'retires only a fresh verified %s slot and durably records its acknowledgement',
  async (kind) => {
    const f = await fixture(kind);
    const result = await f.queue.retirePending(kind, op, prove);
    expect(result.operationId).toBe(op);
    expect(await f.queue.pending(kind)).toEqual([]);
    expect(fs.existsSync(f.slot)).toBe(false);
    const ack = JSON.parse(fs.readFileSync(f.queueRoot + '/.cos-last-ack.json', 'utf8'));
    expect(ack.receipt.operationId).toBe(op);
    expect(result).toMatchObject(ack.remote);
    expect(ack.remote).not.toHaveProperty('verifiedAt');
    expect(ack.remote).not.toHaveProperty('reconciled');
    expect(ack.retired).toBe(true);
    expect(fs.statSync(f.queueRoot + '/.cos-last-ack.json').mode & 0o777).toBe(0o600);
    expect(fs.existsSync(f.queueRoot + '/.cos-retirement.json')).toBe(false);
    await expect(
      f.queue.capture(kind, next, async (sink) => sink.write('new.json', Buffer.from('new')), 65536),
    ).resolves.toMatchObject({ status: 'queued', operationId: next });
  },
);
it('preserves unrelated credential snapshots and the separate full checkpoint', async () => {
  const f = await fixture('credentials');
  await f.queue.capture('credentials', next, async (sink) => sink.write('next.json', Buffer.from('next')), 65536);
  await f.queue.capture('state', next, async (sink) => sink.write('full.json', Buffer.from('full')), 65536);
  await f.queue.retirePending('credentials', op, prove);
  expect(await f.queue.pending('credentials')).toMatchObject([{ operationId: next, state: 'pending' }]);
  expect(await f.queue.pending('state')).toMatchObject([{ operationId: next, state: 'pending' }]);
});
it('does not hold the publication lock while waiting for remote evidence', async () => {
  const f = await fixture('credentials');
  let entered!: () => void, resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const done = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const retiring = f.queue.retirePending('credentials', op, async (request) => {
    entered();
    await done;
    return prove(request);
  });
  await started;
  try {
    await expect(
      f.queue.capture('credentials', next, async (sink) => sink.write('next.json', Buffer.from('next')), 65536),
    ).resolves.toMatchObject({ status: 'queued' });
  } finally {
    resume();
  }
  await retiring;
});
it('retains all local data when remote verification fails', async () => {
  const f = await fixture();
  await expect(
    f.queue.retirePending('state', op, async () => {
      throw Error('PRIVATE_PROVIDER_ERROR');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect((await f.queue.pending('state'))[0].state).toBe('pending');
  expect(fs.readFileSync(f.slot + '/data/a.json', 'utf8')).toBe('SYNTHETIC_FIRST');
  expect(fs.existsSync(f.queueRoot + '/.cos-retirement.json')).toBe(false);
});
it.each([
  'kind',
  'operationId',
  'archiveBytes',
  'archiveSha256',
  'snapshotId',
  'repositoryId',
  'ownerDigest',
  'verifiedAt',
] as const)('refuses a mismatched or invalid remote %s', async (field) => {
  const f = await fixture();
  await expect(
    f.queue.retirePending('state', op, async (request) => {
      const remote = checkpoint(request);
      Object.assign(remote, { [field]: field === 'archiveBytes' ? remote.archiveBytes + 1 : 'invalid' });
      return { checkpoint: remote, assertCurrent() {} };
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect((await f.queue.pending('state'))[0].state).toBe('pending');
  expect(fs.existsSync(f.slot + '/data/a.json')).toBe(true);
});
it('refuses an expired proof before writing acknowledgement or removing files', async () => {
  const f = await fixture();
  await expect(
    f.queue.retirePending('state', op, async (request) => ({
      checkpoint: checkpoint(request),
      assertCurrent() {
        throw Error('expired');
      },
    })),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(f.slot + '/data/a.json')).toBe(true);
  expect(fs.existsSync(f.queueRoot + '/.cos-retirement.json')).toBe(false);
});
it.each(['changed', 'extra', 'symlink', 'hardlink'] as const)(
  'refuses %s source data without any removal',
  async (mode) => {
    const f = await fixture();
    await expect(
      f.queue.retirePending('state', op, async (request) => {
        const source = f.slot + '/data/a.json';
        if (mode === 'changed') fs.writeFileSync(source, 'modified', { mode: 0o600 });
        if (mode === 'extra') fs.writeFileSync(f.slot + '/data/extra.json', 'foreign', { mode: 0o600 });
        if (mode === 'symlink') {
          fs.renameSync(source, f.root + '/outside');
          fs.symlinkSync(f.root + '/outside', source);
        }
        if (mode === 'hardlink') fs.linkSync(source, f.root + '/outside');
        return prove(request);
      }),
    ).rejects.toThrow(/^backup_queue_unavailable$/);
    expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
  },
);
async function interruptedFixture() {
  const f = await fixture();
  const unlink = fs.unlinkSync;
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/b.json')) throw Error('interrupted');
    return unlink(file);
  });
  await expect(f.queue.retirePending('state', op, prove)).rejects.toThrow(/^backup_queue_unavailable$/);
  fault.mockRestore();
  const metadata = JSON.parse(fs.readFileSync(f.queueRoot + '/.cos-retirement.json', 'utf8'));
  return { ...f, metadata };
}
const temporaryOne = '.cos-publish-11111111-1111-4111-8111-111111111111.tmp',
  temporaryTwo = '.cos-publish-22222222-2222-4222-8222-222222222222.tmp';
it('legacy intents and complete publication records remain evidence and require fresh proof', async () => {
  const f = await interruptedFixture();
  const legacy = {
    contract: 'cos-backup-queue-retirement/v1',
    receipt: f.metadata.receipt,
    remote: { ...f.metadata.remote, reconciled: false, verifiedAt: '2026-10-11T00:00:01Z' },
    slot: f.metadata.slot,
    retiredAt: null,
  };
  fs.writeFileSync(f.queueRoot + '/.cos-retirement.json', JSON.stringify(legacy) + '\n', { mode: 0o600 });
  fs.writeFileSync(f.queueRoot + '/' + temporaryOne, JSON.stringify(legacy) + '\n', { mode: 0o600 });
  await expect(
    f.queue.retirePending('state', op, async () => {
      throw Error('NAS_OFFLINE');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(f.queueRoot + '/' + temporaryOne)).toBe(true);
  await f.queue.retirePending('state', op, async (request) => {
    expect(request.previous).not.toHaveProperty('verifiedAt');
    return prove(request);
  });
  expect(await f.queue.pending('state')).toEqual([]);
  expect(fs.existsSync(f.queueRoot + '/' + temporaryOne)).toBe(false);
});
it('a legacy acknowledgement remains readable without deleting a newer full checkpoint', async () => {
  const f = await fixture(),
    remote = await f.queue.retirePending('state', op, prove);
  const current = JSON.parse(fs.readFileSync(f.queueRoot + '/.cos-last-ack.json', 'utf8'));
  fs.writeFileSync(
    f.queueRoot + '/.cos-last-ack.json',
    JSON.stringify({
      contract: 'cos-backup-queue-retirement/v1',
      receipt: current.receipt,
      remote,
      slot: current.slot,
      retiredAt: new Date().toISOString(),
    }) + '\n',
    { mode: 0o600 },
  );
  await f.queue.capture('state', next, async (sink) => sink.write('next.json', Buffer.from('newer')), 65536);
  await f.queue.retirePending('state', op, prove);
  expect(await f.queue.pending('state')).toMatchObject([{ operationId: next, state: 'pending' }]);
});
it('does not remove any temporary or payload file when another publication file is unrecognized', async () => {
  const f = await interruptedFixture();
  const expected = Buffer.from(JSON.stringify(f.metadata) + '\n');
  fs.writeFileSync(f.queueRoot + '/' + temporaryOne, expected.subarray(0, 100), { mode: 0o600 });
  fs.writeFileSync(f.queueRoot + '/' + temporaryTwo, 'UNRELATED_PRIVATE_FILE', { mode: 0o600 });
  await expect(f.queue.retirePending('state', op, prove)).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.readFileSync(f.queueRoot + '/' + temporaryOne)).toEqual(expected.subarray(0, 100));
  expect(fs.readFileSync(f.queueRoot + '/' + temporaryTwo, 'utf8')).toBe('UNRELATED_PRIVATE_FILE');
  expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
});
it.each(['mode', 'symlink', 'hardlink', 'bounds'] as const)(
  'refuses an unsafe publication temporary (%s)',
  async (reason) => {
    const f = await interruptedFixture(),
      file = f.queueRoot + '/' + temporaryOne;
    const contents = Buffer.from(JSON.stringify(f.metadata) + '\n');
    if (reason === 'symlink') {
      fs.writeFileSync(f.root + '/foreign', contents, { mode: 0o600 });
      fs.symlinkSync(f.root + '/foreign', file);
    } else fs.writeFileSync(file, reason === 'bounds' ? Buffer.alloc(1024 ** 2 + 1) : contents, { mode: 0o600 });
    if (reason === 'mode') fs.chmodSync(file, 0o644);
    if (reason === 'hardlink') fs.linkSync(file, f.root + '/foreign');
    await expect(f.queue.retirePending('state', op, prove)).rejects.toThrow(/^backup_queue_unavailable$/);
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
  },
);
it('refuses an expired live proof without clearing matching publication remnants', async () => {
  const f = await interruptedFixture(),
    file = f.queueRoot + '/' + temporaryOne;
  fs.writeFileSync(file, JSON.stringify(f.metadata) + '\n', { mode: 0o600 });
  await expect(
    f.queue.retirePending('state', op, async (request) => ({
      checkpoint: checkpoint(request),
      assertCurrent() {
        throw Error('expired');
      },
    })),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
});
it('rechecks the queue kernel lease before removing a publication temporary', async () => {
  const f = await interruptedFixture(),
    file = f.queueRoot + '/' + temporaryOne;
  fs.writeFileSync(file, JSON.stringify(f.metadata) + '\n', { mode: 0o600 });
  let checks = 0;
  await expect(
    f.queue.retirePending('state', op, async (request) => ({
      checkpoint: checkpoint(request),
      assertCurrent() {
        if (++checks === 2) fs.writeFileSync(f.queueRoot + '/.cos-writer.lock', 'foreign owner', { mode: 0o600 });
      },
    })),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
});
it('resumes partial cleanup only after another fresh matching repository readback', async () => {
  const f = await fixture();
  const unlink = fs.unlinkSync;
  const fault = vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
    if (String(file).endsWith('/b.json')) throw Error('interrupted');
    return unlink(file);
  });
  await expect(f.queue.retirePending('state', op, prove)).rejects.toThrow(/^backup_queue_unavailable$/);
  fault.mockRestore();
  expect(fs.existsSync(f.slot + '/data/a.json')).toBe(false);
  expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
  expect(await f.queue.pending('state')).toMatchObject([{ operationId: op, state: 'failed' }]);
  await expect(
    f.queue.capture(
      'state',
      next,
      async () => {
        throw Error('must_skip');
      },
      65536,
    ),
  ).resolves.toMatchObject({ status: 'skipped_pending' });
  await expect(
    f.queue.retirePending('state', op, async () => {
      throw Error('NAS_OFFLINE');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  let reverified = 0;
  await f.queue.retirePending('state', op, async (request) => {
    reverified++;
    expect(request.previous?.operationId).toBe(op);
    expect(request.archive.sha256).toBe(request.previous?.archiveSha256);
    return prove(request);
  });
  expect(reverified).toBe(1);
  expect(await f.queue.pending('state')).toEqual([]);
});
it('does not treat a saved acknowledgement as authority to delete a new full slot', async () => {
  const f = await fixture();
  await f.queue.retirePending('state', op, prove);
  await f.queue.capture('state', next, async (sink) => sink.write('new.json', Buffer.from('new')), 65536);
  await expect(
    f.queue.retirePending('state', op, async () => {
      throw Error('NAS_OFFLINE');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  await f.queue.retirePending('state', op, prove);
  expect(await f.queue.pending('state')).toMatchObject([{ operationId: next, state: 'pending' }]);
});
it('revoked vault access refuses retirement without touching the slot', async () => {
  const f = await fixture();
  f.close();
  const verifier = vi.fn(prove);
  await expect(f.queue.retirePending('state', op, verifier)).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(verifier).not.toHaveBeenCalled();
  expect(fs.existsSync(f.slot + '/data/a.json')).toBe(true);
});
it.each(['slot_removal', 'ack_publication', 'intent_removal'] as const)(
  'recovers the %s interruption gap using fresh evidence',
  async (gap) => {
    const f = await fixture();
    const rmdir = fs.rmdirSync,
      rename = fs.renameSync,
      unlink = fs.unlinkSync;
    if (gap === 'slot_removal')
      vi.spyOn(fs, 'rmdirSync').mockImplementation((file) => {
        if (String(file).endsWith('/full')) throw Error('interrupted');
        return rmdir(file);
      });
    if (gap === 'ack_publication')
      vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
        if (String(to).endsWith('/.cos-last-ack.json')) {
          throw Error('interrupted');
        }
        return rename(from, to);
      });
    if (gap === 'intent_removal')
      vi.spyOn(fs, 'unlinkSync').mockImplementation((file) => {
        if (String(file).endsWith('/.cos-retirement.json')) throw Error('interrupted');
        return unlink(file);
      });
    await expect(f.queue.retirePending('state', op, prove)).rejects.toThrow(/^backup_queue_unavailable$/);
    vi.restoreAllMocks();
    expect(await f.queue.pending('state')).toMatchObject([{ operationId: op, state: 'failed' }]);
    let fresh = 0;
    await f.queue.retirePending('state', op, async (request) => {
      fresh++;
      expect(request.previous).toBeDefined();
      return prove(request);
    });
    expect(fresh).toBe(1);
    expect(await f.queue.pending('state')).toEqual([]);
  },
);
it('refuses a valid-looking but different archive hash before any retirement intent', async () => {
  const f = await fixture();
  await expect(
    f.queue.retirePending('state', op, async (request) => ({
      checkpoint: { ...checkpoint(request), archiveSha256: 'e'.repeat(64) },
      assertCurrent() {},
    })),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(f.slot + '/data/a.json')).toBe(true);
  expect(fs.existsSync(f.queueRoot + '/.cos-retirement.json')).toBe(false);
});
it('fresh proof revocation during cleanup stops further deletion and remains recoverable', async () => {
  const f = await fixture();
  await expect(
    f.queue.retirePending('state', op, async (request) => ({
      checkpoint: checkpoint(request),
      assertCurrent() {
        if (!fs.existsSync(f.slot + '/data/a.json')) throw Error('revoked');
      },
    })),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(f.slot + '/data/nested/b.json')).toBe(true);
  await f.queue.retirePending('state', op, prove);
  expect(await f.queue.pending('state')).toEqual([]);
});
it('recovers after an actual process is killed during cleanup without stealing a stale lease', async () => {
  const f = await fixture();
  const moduleUrl = new URL('./backup-queue.ts', import.meta.url).href;
  const code = `import fs from 'node:fs'; import { BackupQueue } from ${JSON.stringify(moduleUrl)};
    const root=${JSON.stringify(f.root)}, queue=new BackupQueue('a'.repeat(64),(kind,callback)=>callback(root+'/'+kind));
    await queue.retirePending('state',${JSON.stringify(op)},async request=>({ checkpoint: {
      contract:'cos-backup-remote-checkpoint/v1',repositoryId:'b'.repeat(64),ownerDigest:'c'.repeat(64),kind:'state',operationId:${JSON.stringify(op)},
      snapshotId:'d'.repeat(64),snapshotAt:'2026-10-11T00:00:00Z',archiveBytes:request.archive.bytes,archiveSha256:request.archive.sha256,
      reconciled:false,verifiedAt:new Date().toISOString() }, assertCurrent() {
        if (!fs.existsSync(root+'/state/backup-queue/full/data/a.json')) {
          fs.writeSync(1,'READY\\n'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);
        }
      } }));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture_start_timeout')), 5000);
      child.stdout.once('data', (bytes) => {
        clearTimeout(timer);
        if (bytes.toString() === 'READY\n') resolve();
        else reject(Error('fixture_start_failed'));
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(Error('fixture_start_failed'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await expect(f.queue.capture('state', next, async () => {}, 65536)).rejects.toThrow(/^backup_queue_unavailable$/);
    child.kill('SIGKILL');
    await closed;
    await f.queue.retirePending('state', op, prove);
    expect(await f.queue.pending('state')).toEqual([]);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});
it.each([
  'intent:empty',
  'intent:partial',
  'intent:before_rename',
  'intent:after_rename',
  'ack:empty',
  'ack:partial',
  'ack:before_rename',
  'ack:after_rename',
])('recovers metadata publication after an actual writer is killed at %s', async (scenario) => {
  const f = await fixture();
  const [target, stage] = scenario.split(':');
  const moduleUrl = new URL('./backup-queue.ts', import.meta.url).href;
  const code = `import fs from 'node:fs'; import { BackupQueue } from ${JSON.stringify(moduleUrl)};
      const root=${JSON.stringify(f.root)}, stage=${JSON.stringify(stage)}, target=${JSON.stringify(target)};
      const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      const write=fs.writeFileSync, rename=fs.renameSync;
      fs.writeFileSync=(file,bytes,...options)=>{
        if(typeof file==='number' && Buffer.isBuffer(bytes) && bytes.toString().startsWith('{"contract":"cos-backup-queue-retirement/')) {
          const value=JSON.parse(bytes.toString());
          const isAck=value.retired===true || (value.retiredAt!==null && value.retiredAt!==undefined);
          if((target==='ack')===isAck) {
            if(stage==='empty')pause();
            if(stage==='partial'){write(file,bytes.subarray(0,Math.floor(bytes.length/2)),...options);pause();}
          }
        }
        return write(file,bytes,...options);
      };
      fs.renameSync=(from,to)=>{
        const selected=String(to).endsWith(target==='ack'?'/.cos-last-ack.json':'/.cos-retirement.json');
        if(selected && stage==='before_rename')pause();
        const result=rename(from,to);if(selected && stage==='after_rename')pause();return result;
      };
      const queue=new BackupQueue('a'.repeat(64),(kind,callback)=>callback(root+'/'+kind));
      await queue.retirePending('state',${JSON.stringify(op)},async request=>({checkpoint:{
        contract:'cos-backup-remote-checkpoint/v1',repositoryId:'b'.repeat(64),ownerDigest:'c'.repeat(64),kind:'state',operationId:${JSON.stringify(op)},
        snapshotId:'d'.repeat(64),snapshotAt:'2026-10-11T00:00:00Z',archiveBytes:request.archive.bytes,archiveSha256:request.archive.sha256,
        reconciled:false,verifiedAt:new Date().toISOString()},assertCurrent(){}}));`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
    cwd: process.cwd(),
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture_start_timeout')), 5000);
      child.stdout.once('data', (bytes) => {
        clearTimeout(timer);
        if (bytes.toString() === 'READY\n') resolve();
        else reject(Error('fixture_start_failed'));
      });
      child.once('close', () => {
        clearTimeout(timer);
        reject(Error('fixture_start_failed'));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    await expect(f.queue.capture('state', next, async () => {}, 65536)).rejects.toThrow(/^backup_queue_unavailable$/);
    child.kill('SIGKILL');
    await closed;
    const namesBefore = fs.readdirSync(f.queueRoot).sort();
    await expect(
      f.queue.retirePending('state', op, async () => {
        throw Error('NAS_OFFLINE');
      }),
    ).rejects.toThrow(/^backup_queue_unavailable$/);
    expect(fs.readdirSync(f.queueRoot).sort()).toEqual(namesBefore);
    let fresh = 0;
    await f.queue.retirePending('state', op, async (request) => {
      fresh++;
      return prove(request);
    });
    expect(fresh).toBe(1);
    expect(await f.queue.pending('state')).toEqual([]);
    expect(fs.readdirSync(f.queueRoot).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  } finally {
    child.kill('SIGKILL');
    await closed;
  }
});
