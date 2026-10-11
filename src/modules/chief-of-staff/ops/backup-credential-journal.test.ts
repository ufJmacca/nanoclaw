import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { BackupQueue, type BackupRetirementRequest } from './backup-queue.js';
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const event = (generation = 1, phase: 'ready' | 'refreshing' | 'revoked' = 'ready') => ({
  sourceKind: 'calendar_reader' as const,
  sourceKey: 'b'.repeat(64),
  generation,
  phase,
  files: [{ name: 'credential.json', bytes: Buffer.from('SYNTHETIC_CREDENTIAL_' + generation + '_' + phase) }],
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-credential-journal-'));
  roots.push(root);
  fs.chmodSync(root, 0o700);
  let available = true;
  const access = async (_kind: string, callback: (root: string) => Promise<unknown>) => {
    if (!available) throw Error('PRIVATE_VAULT_ERROR');
    return callback(root);
  };
  const queue = new BackupQueue('a'.repeat(64), access as never);
  return {
    root,
    queue,
    rebuild: () => new BackupQueue('a'.repeat(64), access as never),
    close: () => {
      available = false;
    },
  };
}
it.each(['payload', 'pending-publication'] as const)(
  'retries the same credential event after %s failure under fresh primary authority',
  async (phase) => {
    const f = fixture();
    const open = fs.openSync,
      rename = fs.renameSync;
    const create = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
      if (phase === 'payload' && String(file).endsWith('/credential-event.json'))
        throw Error('PRIVATE_CAPTURE_FAILURE');
      return open(file, ...args);
    });
    const publish = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (
        phase === 'pending-publication' &&
        String(to).endsWith('/receipt.json') &&
        JSON.parse(fs.readFileSync(from, 'utf8')).state === 'pending'
      )
        throw Error('PRIVATE_CAPTURE_FAILURE');
      return rename(from, to);
    });
    await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow('backup_queue_unavailable');
    create.mockRestore();
    publish.mockRestore();
    const prior = (await f.queue.pending('credentials'))[0],
      payload = f.root + '/backup-queue/' + prior.operationId + '/data/credential.json',
      inode = fs.statSync(payload).ino,
      guard = vi.fn(() => {});
    expect(await f.rebuild().recordCredential(event(), guard)).toEqual({
      status: 'recorded',
      operationId: prior.operationId,
    });
    expect(guard).toHaveBeenCalled();
    expect((await f.queue.pending('credentials')).map((receipt) => receipt.operationId)).toEqual([prior.operationId]);
    expect(fs.readFileSync(payload, 'utf8')).toBe('SYNTHETIC_CREDENTIAL_1_ready');
    if (phase === 'pending-publication') expect(fs.statSync(payload).ino).toBe(inode);
    expect(await f.rebuild().recordCredential(event(), guard)).toMatchObject({ operationId: prior.operationId });
  },
);
it('preserves an interrupted credential copy when fresh primary authority is withdrawn', async () => {
  const f = fixture(),
    open = fs.openSync;
  const fault = vi.spyOn(fs, 'openSync').mockImplementation((file, ...args) => {
    if (String(file).endsWith('/credential-event.json')) throw Error('capture failure');
    return open(file, ...args);
  });
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow('backup_queue_unavailable');
  fault.mockRestore();
  const id = (await f.queue.pending('credentials'))[0].operationId,
    payload = f.root + '/backup-queue/' + id + '/data/credential.json',
    before = fs.statSync(payload).ino;
  await expect(
    f.rebuild().recordCredential(event(), () => {
      throw Error('primary withdrawn');
    }),
  ).rejects.toThrow('backup_queue_unavailable');
  expect(fs.statSync(payload).ino).toBe(before);
  expect(fs.readFileSync(payload, 'utf8')).toBe('SYNTHETIC_CREDENTIAL_1_ready');
});
const prove = async (request: BackupRetirementRequest) => ({
  checkpoint: {
    contract: 'cos-backup-remote-checkpoint/v1' as const,
    repositoryId: 'c'.repeat(64),
    ownerDigest: 'd'.repeat(64),
    kind: request.receipt.kind,
    operationId: request.receipt.operationId,
    snapshotId: 'e'.repeat(64),
    snapshotAt: '2026-10-11T00:00:00Z',
    archiveBytes: request.archive.bytes,
    archiveSha256: request.archive.sha256,
    reconciled: !!request.previous,
    verifiedAt: new Date().toISOString(),
  },
  assertCurrent() {},
});
it('queues one private snapshot and journal per transition, and deduplicates ordinary reads', async () => {
  const f = fixture();
  const first = await f.queue.recordCredential(event(), () => {});
  expect(first.status).toBe('recorded');
  expect(await f.queue.recordCredential(event(), () => {})).toMatchObject({
    status: 'recorded',
    operationId: first.operationId,
  });
  await f.queue.recordCredential(event(1, 'refreshing'), () => {});
  await f.queue.recordCredential(event(2), () => {});
  expect(await f.queue.pending('credentials')).toHaveLength(3);
  await f.queue.withPending('credentials', first.operationId, async (directory, receipt) => {
    expect(fs.readFileSync(directory + '/credential.json', 'utf8')).toBe('SYNTHETIC_CREDENTIAL_1_ready');
    const journal = JSON.parse(fs.readFileSync(directory + '/credential-event.json', 'utf8'));
    expect(journal).toMatchObject({ contract: 'cos-backup-credential-event/v1', generation: 1, phase: 'ready' });
    expect(journal).not.toHaveProperty('tokens');
    expect(receipt.files.map((file) => file.name)).toEqual(['credential-event.json', 'credential.json']);
    expect(fs.statSync(directory + '/credential.json').mode & 0o777).toBe(0o600);
  });
});
it('remembers completed local recording after multiple uploads and process reconstruction', async () => {
  const f = fixture();
  const first = await f.queue.recordCredential(event(), () => {});
  await f.queue.retirePending('credentials', first.operationId, prove);
  const other = { ...event(), sourceKey: 'f'.repeat(64) };
  const second = await f.queue.recordCredential(other, () => {});
  await f.queue.retirePending('credentials', second.operationId, prove);
  expect(await f.rebuild().recordCredential(event(), () => {})).toMatchObject({ operationId: first.operationId });
  expect(await f.queue.pending('credentials')).toEqual([]);
});
it('refuses a changed snapshot at the same generation and never regresses the journal head', async () => {
  const f = fixture();
  await f.queue.recordCredential(event(), () => {});
  const changed = event();
  changed.files[0].bytes = Buffer.from('SYNTHETIC_DIFFERENT');
  await expect(f.queue.recordCredential(changed, () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  await f.queue.recordCredential(event(2), () => {});
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(await f.queue.pending('credentials')).toHaveLength(2);
});
it('retains and verifies a pending snapshot when journal-head publication fails', async () => {
  const f = fixture();
  const rename = fs.renameSync;
  const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
    if (String(to).includes('/.cos-credential-')) throw Error('PRIVATE_SYNC_FAILURE');
    return rename(from, to);
  });
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  spy.mockRestore();
  const pending = await f.queue.pending('credentials');
  expect(pending).toHaveLength(1);
  const recovered = await f.rebuild().recordCredential(event(), () => {});
  expect(recovered.operationId).toBe(pending[0].operationId);
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it('the uploader repairs a missing completion head only from a fully verified local journal and fresh remote proof', async () => {
  const f = fixture();
  const captured = await f.queue.recordCredential(event(), () => {});
  const queueRoot = f.root + '/backup-queue';
  const name = fs.readdirSync(queueRoot).find((name) => /^\.cos-credential-[a-f0-9]{64}\.json$/.test(name))!;
  fs.unlinkSync(queueRoot + '/' + name);
  await expect(
    f.queue.retirePending('credentials', captured.operationId, async () => {
      throw Error('NAS_OFFLINE');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.existsSync(queueRoot + '/' + name)).toBe(false);
  await f.queue.retirePending('credentials', captured.operationId, prove);
  expect(fs.existsSync(queueRoot + '/' + name)).toBe(true);
  await f.rebuild().recordCredential(event(), () => {});
  expect(await f.queue.pending('credentials')).toEqual([]);
});
it('finishes the completion directory sync on replay before acknowledging a record', async () => {
  const f = fixture(),
    sync = fs.fsyncSync;
  const failed = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    const directory = fs.readlinkSync('/proc/self/fd/' + fd);
    if (
      directory === f.root + '/backup-queue' &&
      fs.readdirSync(directory).some((name) => /^\.cos-credential-[a-f0-9]{64}\.json$/.test(name))
    )
      throw Error('PRIVATE_DIRECTORY_SYNC_FAILURE');
    sync(fd);
  });
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(await f.queue.pending('credentials')).toHaveLength(1);
  await expect(f.rebuild().recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  failed.mockRestore();
  await f.queue.recordCredential(event(), () => {});
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it('does not acknowledge a corrupted pending payload even when its journal head is intact', async () => {
  const f = fixture();
  const captured = await f.queue.recordCredential(event(), () => {});
  fs.writeFileSync(f.root + '/backup-queue/' + captured.operationId + '/data/credential.json', 'SYNTHETIC_CORRUPTION');
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
});
it('a lost vault or current credential guard refuses recording without exposing private errors', async () => {
  const f = fixture();
  f.close();
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  const s = fixture();
  await expect(
    s.queue.recordCredential(event(), () => {
      throw Error('PRIVATE_CREDENTIAL_CHANGE');
    }),
  ).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(await s.queue.inspect('credentials')).toEqual([]);
});
it('checks the complete known snapshot budget before creating an occupied failed slot', async () => {
  const f = fixture();
  vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0n, bsize: 4096n, ffree: 10000n } as fs.BigIntStatsFs);
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(await f.queue.inspect('credentials')).toEqual([]);
});
it('charges durable completion heads against the queue budget before creating another snapshot', async () => {
  const f = fixture();
  await f.queue.recordCredential(event(), () => {});
  const lstat = fs.lstatSync;
  vi.spyOn(fs, 'lstatSync').mockImplementation(((file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = lstat(file, options as never);
    if (/\.cos-credential-[a-f0-9]{64}\.json$/.test(String(file)))
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { blocks: (128 * 1024 ** 2) / 512 });
    return stat;
  }) as typeof fs.lstatSync);
  await expect(f.queue.recordCredential(event(2), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it('validates every orphan before removing any corroborated temporary', async () => {
  const f = fixture();
  await f.queue.recordCredential(event(), () => {});
  const root = f.root + '/backup-queue',
    name = fs.readdirSync(root).find((name) => /^\.cos-credential-[a-f0-9]{64}\.json$/.test(name))!;
  const prefix = name.slice(0, -5),
    known = root + '/' + prefix + '-11111111-1111-4111-8111-111111111111.tmp',
    unknown = root + '/' + prefix + '-22222222-2222-4222-8222-222222222222.tmp';
  fs.writeFileSync(known, fs.readFileSync(root + '/' + name).subarray(0, 71), { mode: 0o600 });
  fs.writeFileSync(unknown, 'UNCLAIMED_PRIVATE_METADATA', { mode: 0o600 });
  const before = fs.readFileSync(known);
  await expect(f.queue.recordCredential(event(), () => {})).rejects.toThrow(/^backup_queue_unavailable$/);
  expect(fs.readFileSync(known).equals(before)).toBe(true);
  expect(fs.readFileSync(unknown, 'utf8')).toBe('UNCLAIMED_PRIVATE_METADATA');
  expect(await f.queue.pending('credentials')).toHaveLength(1);
});
it.each(['empty', 'partial', 'before_rename', 'after_rename'])(
  'reconciles journal completion after an actual writer is killed at %s',
  async (stage) => {
    const f = fixture(),
      extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js',
      moduleUrl = new URL('./backup-queue.' + extension, import.meta.url).href;
    const code = `import fs from 'node:fs'; import { BackupQueue } from ${JSON.stringify(moduleUrl)};
      const root=${JSON.stringify(f.root)},stage=${JSON.stringify(stage)};
      const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      const write=fs.writeFileSync,rename=fs.renameSync;
      fs.writeFileSync=(file,bytes,...options)=>{
        if(typeof file==='number' && Buffer.isBuffer(bytes) && bytes.toString().startsWith('{"contract":"cos-backup-credential-head/v1"')) {
          if(stage==='empty')pause();
          if(stage==='partial'){write(file,bytes.subarray(0,Math.floor(bytes.length/2)),...options);pause();}
        }
        return write(file,bytes,...options);
      };
      fs.renameSync=(from,to)=>{
        const selected=/\\/.cos-credential-[a-f0-9]{64}\\.json$/.test(String(to));
        if(selected && stage==='before_rename')pause();const result=rename(from,to);
        if(selected && stage==='after_rename')pause();return result;
      };
      const queue=new BackupQueue('a'.repeat(64),(_kind,callback)=>callback(root));
      await queue.recordCredential({sourceKind:'calendar_reader',sourceKey:'b'.repeat(64),generation:1,phase:'ready',
        files:[{name:'credential.json',bytes:Buffer.from('SYNTHETIC_CREDENTIAL_1_ready')}]},()=>{});`;
    const child = spawn(
      process.execPath,
      [...(extension === 'ts' ? ['--import', 'tsx'] : []), '--input-type=module', '-e', code],
      {
        cwd: process.cwd(),
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    const closed = new Promise<string | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (_code, signal) => resolve(signal));
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
      await expect(f.queue.recordCredential({ ...event(), sourceKey: 'c'.repeat(64) }, () => {})).rejects.toThrow(
        /^backup_queue_unavailable$/,
      );
      child.kill('SIGKILL');
      expect(await closed).toBe('SIGKILL');
      const root = f.root + '/backup-queue',
        before = fs.readdirSync(root).sort();
      await expect(
        f.queue.recordCredential(event(), () => {
          throw Error('CURRENT_CREDENTIAL_WITHDRAWN');
        }),
      ).rejects.toThrow(/^backup_queue_unavailable$/);
      expect(fs.readdirSync(root).sort()).toEqual(before);
      const recovered = await f.rebuild().recordCredential(event(), () => {});
      expect(await f.queue.pending('credentials')).toMatchObject([
        { operationId: recovered.operationId, state: 'pending' },
      ]);
      expect(fs.readdirSync(root).filter((name) => /^\.cos-credential-.*\.tmp$/.test(name))).toEqual([]);
      await f.queue.retirePending('credentials', recovered.operationId, prove);
      await f.rebuild().recordCredential(event(), () => {});
      expect(await f.queue.pending('credentials')).toEqual([]);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  },
);
