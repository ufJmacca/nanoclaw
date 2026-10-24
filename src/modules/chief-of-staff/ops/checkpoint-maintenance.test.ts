import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import Database from 'better-sqlite3';
import { digest } from '../domain/contracts.js';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { initializeTarget, protectTarget, readPrivate, readTarget, writeAtomic } from './target-state.js';
import { activeMaintenanceLease, admittedGeneration, beginMaintenance, type MaintenanceLease } from './maintenance.js';
import { checkpointMaintenance } from './checkpoint-maintenance.js';
import { BackupQueue } from './backup-queue.js';
import { streamQueuedBackup } from './backup-archive-producer.js';

const roots: string[] = [];
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const binding = {
  hostFingerprint: 'a'.repeat(64),
  databaseFingerprint: 'b'.repeat(64),
  service: 'fixture.service',
  installationRoot: '/home/pi/nano',
  dataRoot: '/home/pi/nano/data',
};
function fixture(slice: 'G02' | 'G03' | 'G04' | 'G05' = 'G02') {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-checkpoint-maintenance-'));
  roots.push(base);
  const root = path.join(base, 'target');
  const manifest = fixtureVaultRelease(slice),
    requestId = randomUUID(),
    events: string[] = [];
  const state = initializeTarget(root, binding);
  writeAtomic(root, 'state.json', { ...state, releaseId: manifest.releaseId, maintenance: false });
  const protectedState = protectTarget(root, binding);
  writeAtomic(root, 'maintenance.json', {
    version: 1,
    bindingDigest: digest(binding),
    nonce: randomUUID(),
    owner: 'fixture-accepted-release',
    purpose: 'deployment',
    generation: protectedState.generation,
    phase: 'complete',
    reopen: true,
  });
  writeAtomic(root, 'state.json', {
    ...protectedState,
    maintenance: false,
    maintenanceHistory: true,
    generation: protectedState.generation + 1,
  });
  const native = new Database(path.join(base, 'native.sqlite'));
  databases.push(native);
  native.exec(
    "CREATE TABLE state(paused INTEGER,context TEXT,used INTEGER); INSERT INTO state VALUES(0,'original-main-context',3); CREATE TABLE messages(body TEXT); INSERT INTO messages VALUES('ordinary-message');",
  );
  const readNative = () => ({
    ...(native.prepare('SELECT * FROM state').get() as object),
    messages: native.prepare('SELECT body FROM messages').all(),
  });
  const snapshot = { status: 'queued' as const, queueOperationId: '', snapshotDigest: 'c'.repeat(64) };
  const effects = {
    verify: vi.fn(async () => manifest),
    inspect: vi.fn(async () => [] as Array<{ operationId: string; state: 'pending' | 'capturing' | 'failed' }>),
    workersIdle: vi.fn(async () => true),
    stopNative: vi.fn(async () => {
      events.push('stop');
    }),
    nativeStopped: vi.fn(async () => true),
    databaseCompatible: vi.fn(async () => true),
    startNative: vi.fn(async () => {
      events.push('start');
    }),
    healthy: vi.fn(async () => {
      events.push('health');
      return true;
    }),
    capture: vi.fn(async () => {
      events.push('capture');
      snapshot.queueOperationId = activeMaintenanceLease(root, binding).nonce;
      return snapshot;
    }),
    verifyCapture: vi.fn(async (_lease: MaintenanceLease, _expected?: string) => {
      events.push('readback');
      return snapshot;
    }),
  };
  const invoke = () => checkpointMaintenance({ root, binding, requestId, effects });
  return { root, manifest, requestId, effects, native, readNative, events, snapshot, invoke };
}
it.each(['G02', 'G03', 'G04', 'G05'] as const)(
  '%s captures under owned maintenance and restarts healthy admission without changing context, pause, counters or messages',
  async (slice) => {
    const f = fixture(slice),
      before = f.readNative();
    await expect(f.invoke()).resolves.toMatchObject({
      status: 'backup_queued',
      admissionRestored: true,
      remoteCheckpoint: false,
    });
    expect(f.events).toEqual(['stop', 'capture', 'readback', 'start', 'health', 'health']);
    expect(f.readNative()).toEqual(before);
    expect(admittedGeneration(f.root, binding)).not.toBeNull();
    expect(readTarget(f.root, binding).lifecycle).toBe('protected');
  },
);
it('preserves a later owner pause and never recaptures or reopens work on a completed retry', async () => {
  const f = fixture();
  f.effects.capture.mockImplementationOnce(async () => {
    f.native.exec('UPDATE state SET paused=1');
    f.snapshot.queueOperationId = activeMaintenanceLease(f.root, binding).nonce;
    return f.snapshot;
  });
  await f.invoke();
  await f.invoke();
  expect(f.readNative()).toEqual({
    paused: 1,
    context: 'original-main-context',
    used: 3,
    messages: [{ body: 'ordinary-message' }],
  });
  expect(f.effects.capture).toHaveBeenCalledOnce();
  expect(f.effects.startNative).toHaveBeenCalledOnce();
});
it.each(['pending', 'capturing', 'failed'] as const)(
  'skips a foreign %s slot before maintenance or service interruption',
  async (state) => {
    const f = fixture();
    f.effects.inspect.mockResolvedValue([{ operationId: randomUUID(), state }]);
    await expect(f.invoke()).resolves.toMatchObject({
      status: 'backup_skipped_pending',
      pendingState: state,
      remoteCheckpoint: false,
    });
    expect(f.effects.stopNative).not.toHaveBeenCalled();
    expect(readTarget(f.root, binding).maintenance).toBe(false);
    expect(f.effects.capture).not.toHaveBeenCalled();
  },
);
it('a failed capture restarts the current service without reporting a successful checkpoint', async () => {
  const f = fixture();
  f.effects.capture.mockRejectedValueOnce(Error('PRIVATE_FIXTURE_DATA'));
  await expect(f.invoke()).resolves.toMatchObject({
    status: 'backup_failed',
    admissionRestored: true,
    remoteCheckpoint: false,
  });
  expect(f.effects.startNative).toHaveBeenCalledOnce();
  expect(f.effects.verifyCapture).not.toHaveBeenCalled();
  expect(JSON.stringify(readPrivate(f.root + '/backup-checkpoints/' + f.requestId + '.json'))).not.toContain(
    'PRIVATE_FIXTURE_DATA',
  );
});
it('failed health retains the same closed lease until a successful restart is verified', async () => {
  const f = fixture();
  f.effects.healthy.mockResolvedValue(false);
  await expect(f.invoke()).rejects.toThrow('checkpoint_maintenance_unverified');
  const lease = activeMaintenanceLease(f.root, binding);
  expect(admittedGeneration(f.root, binding)).toBeNull();
  f.effects.healthy.mockResolvedValue(true);
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_queued', admissionRestored: true });
  expect(f.effects.capture).toHaveBeenCalledOnce();
  expect(readTarget(f.root, binding).generation).toBe(lease.generation + 1);
});
it('reconciles a lost capture acknowledgement by fresh readback of only the owned pending slot', async () => {
  const f = fixture();
  f.effects.capture.mockImplementationOnce(async () => {
    const lease = activeMaintenanceLease(f.root, binding);
    f.snapshot.queueOperationId = lease.nonce;
    f.effects.inspect.mockResolvedValue([{ operationId: lease.nonce, state: 'pending' }]);
    throw Error('lost_ack');
  });
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_queued', admissionRestored: true });
  expect(f.effects.verifyCapture).toHaveBeenCalledOnce();
});
it('refuses a foreign maintenance owner before stopping, and refuses source changes before reopening', async () => {
  const f = fixture();
  beginMaintenance(f.root, binding, 'another-operation', 'deployment');
  await expect(f.invoke()).rejects.toThrow('checkpoint_admission_closed');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  const g = fixture();
  g.effects.capture.mockImplementationOnce(async () => {
    g.snapshot.queueOperationId = activeMaintenanceLease(g.root, binding).nonce;
    g.manifest.source.tree = 'f'.repeat(40);
    return g.snapshot;
  });
  await expect(g.invoke()).rejects.toThrow();
  expect(admittedGeneration(g.root, binding)).toBeNull();
  expect(g.effects.startNative).not.toHaveBeenCalled();
});
it('cannot reopen an independently closed maintenance latch', async () => {
  const f = fixture(),
    state = readTarget(f.root, binding);
  writeAtomic(f.root, 'state.json', { ...state, maintenance: true });
  await expect(f.invoke()).rejects.toThrow('checkpoint_admission_closed');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  expect(readTarget(f.root, binding)).toEqual({ ...state, maintenance: true });
});
it('active ordinary workers prevent maintenance before the service stop', async () => {
  const f = fixture(),
    state = readTarget(f.root, binding);
  f.effects.workersIdle.mockResolvedValue(false);
  await expect(f.invoke()).rejects.toThrow('checkpoint_workers_active');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  expect(readTarget(f.root, binding)).toEqual(state);
});
it('a service start interruption reuses the same durable checkpoint without capturing again', async () => {
  const f = fixture();
  f.effects.startNative.mockRejectedValueOnce(Error('fixture start interrupted'));
  await expect(f.invoke()).rejects.toThrow('fixture start interrupted');
  const lease = activeMaintenanceLease(f.root, binding);
  f.effects.healthy.mockResolvedValueOnce(false);
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_queued', admissionRestored: true });
  expect(f.effects.capture).toHaveBeenCalledOnce();
  expect(f.effects.startNative).toHaveBeenCalledTimes(2);
  expect(readTarget(f.root, binding).generation).toBe(lease.generation + 1);
});
it('a lost final acknowledgement observes exact completed maintenance without another service start', async () => {
  const f = fixture();
  await f.invoke();
  const name = f.requestId + '.json',
    directory = f.root + '/backup-checkpoints',
    record = readPrivate<Record<string, unknown>>(directory + '/' + name);
  writeAtomic(directory, name, { ...record, phase: 'restarting' });
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_queued', admissionRestored: true });
  expect(f.effects.capture).toHaveBeenCalledOnce();
  expect(f.effects.startNative).toHaveBeenCalledOnce();
});
it('a durable capturing retry requires fresh owned pending readback and never recaptures', async () => {
  const f = fixture(),
    lease = beginMaintenance(f.root, binding, 'release-backup-' + f.requestId, 'deployment');
  const { confirmQuiescence } = await import('./maintenance.js');
  await confirmQuiescence(f.root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
  fs.mkdirSync(f.root + '/backup-checkpoints', { mode: 0o700 });
  writeAtomic(f.root + '/backup-checkpoints', f.requestId + '.json', {
    version: 1,
    requestId: f.requestId,
    bindingDigest: digest(binding),
    manifestDigest: digest(f.manifest),
    releaseId: f.manifest.releaseId,
    phase: 'capturing',
    lease,
    outcome: null,
    snapshotDigest: null,
  });
  f.snapshot.queueOperationId = lease.nonce;
  f.effects.inspect.mockResolvedValue([{ operationId: lease.nonce, state: 'pending' }]);
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_queued', admissionRestored: true });
  expect(f.effects.capture).not.toHaveBeenCalled();
  expect(f.effects.verifyCapture).toHaveBeenCalledOnce();
});
it('a changed target after asynchronous helper verification cannot start another service', async () => {
  const f = fixture();
  f.effects.verify
    .mockImplementationOnce(async () => f.manifest)
    .mockImplementationOnce(async () => {
      const state = readTarget(f.root, binding);
      writeAtomic(f.root, 'state.json', { ...state, releaseId: 'release-changed' });
      return f.manifest;
    });
  await expect(f.invoke()).rejects.toThrow('checkpoint_maintenance_unverified');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  expect(f.effects.startNative).not.toHaveBeenCalled();
});
it('refuses changed queue readback and incompatible database health without reopening unsafe admission', async () => {
  const f = fixture();
  f.effects.verifyCapture.mockResolvedValue({ ...f.snapshot, snapshotDigest: 'd'.repeat(64) });
  await expect(f.invoke()).resolves.toMatchObject({ status: 'backup_failed', admissionRestored: true });
  const g = fixture();
  g.effects.databaseCompatible.mockResolvedValue(false);
  await expect(g.invoke()).rejects.toThrow('checkpoint_maintenance_unverified');
  expect(admittedGeneration(g.root, binding)).toBeNull();
  expect(g.effects.capture).not.toHaveBeenCalled();
});

it.each(['capturing', 'restarting', 'complete'] as const)(
  'an unreadable queue does not prevent recovery of this checkpoint at %s',
  async (phase) => {
    const f = fixture();
    if (phase === 'capturing') {
      const lease = beginMaintenance(f.root, binding, 'release-backup-' + f.requestId, 'deployment');
      const { confirmQuiescence } = await import('./maintenance.js');
      await confirmQuiescence(f.root, binding, lease, async () => ({
        activeCoordinators: 0,
        activeDatabaseOperations: 0,
      }));
      fs.mkdirSync(f.root + '/backup-checkpoints', { mode: 0o700 });
      writeAtomic(f.root + '/backup-checkpoints', f.requestId + '.json', {
        version: 1,
        requestId: f.requestId,
        bindingDigest: digest(binding),
        manifestDigest: digest(f.manifest),
        releaseId: f.manifest.releaseId,
        phase,
        lease,
        outcome: null,
        snapshotDigest: null,
      });
    } else {
      f.effects.capture.mockRejectedValueOnce(Error('synthetic_capture_failed'));
      if (phase === 'restarting') {
        f.effects.startNative.mockRejectedValueOnce(Error('synthetic_start_interrupted'));
        await expect(f.invoke()).rejects.toThrow('synthetic_start_interrupted');
        f.effects.healthy.mockResolvedValueOnce(false);
      } else await f.invoke();
    }
    f.native.exec('UPDATE state SET paused=1');
    const before = f.readNative();
    f.effects.inspect.mockRejectedValue(Error('synthetic_queue_unreadable'));
    f.effects.capture.mockClear();
    f.effects.startNative.mockClear();
    await expect(f.invoke()).resolves.toMatchObject({
      status: 'backup_failed',
      admissionRestored: true,
      remoteCheckpoint: false,
    });
    expect(f.effects.capture).not.toHaveBeenCalled();
    expect(f.effects.verifyCapture).not.toHaveBeenCalled();
    expect(f.readNative()).toEqual(before);
    expect(admittedGeneration(f.root, binding)).not.toBeNull();
    expect(f.effects.startNative).toHaveBeenCalledTimes(phase === 'complete' ? 0 : 1);
  },
);
it('an unreadable queue prevents a new checkpoint before service interruption', async () => {
  const f = fixture(),
    before = f.readNative();
  f.effects.inspect.mockRejectedValue(Error('synthetic_queue_unreadable'));
  await expect(f.invoke()).rejects.toThrow('synthetic_queue_unreadable');
  expect(f.effects.stopNative).not.toHaveBeenCalled();
  expect(f.effects.capture).not.toHaveBeenCalled();
  expect(f.readNative()).toEqual(before);
  expect(fs.existsSync(f.root + '/backup-checkpoints')).toBe(false);
});

it.each(['foreign_maintenance', 'changed_release', 'unhealthy', 'incompatible_database'])(
  'unreadable queue recovery still refuses %s',
  async (condition) => {
    const f = fixture();
    f.effects.capture.mockRejectedValueOnce(Error('synthetic_capture_failed'));
    f.effects.startNative.mockRejectedValueOnce(Error('synthetic_start_interrupted'));
    await expect(f.invoke()).rejects.toThrow('synthetic_start_interrupted');
    f.effects.inspect.mockRejectedValue(Error('synthetic_queue_unreadable'));
    f.native.exec('UPDATE state SET paused=1');
    const before = f.readNative();
    if (condition === 'foreign_maintenance') {
      const record = readPrivate<Record<string, unknown>>(f.root + '/maintenance.json');
      writeAtomic(f.root, 'maintenance.json', { ...record, owner: 'foreign-operation' });
    } else if (condition === 'changed_release') f.manifest.source.tree = 'f'.repeat(40);
    else if (condition === 'unhealthy') f.effects.healthy.mockResolvedValue(false);
    else f.effects.databaseCompatible.mockResolvedValue(false);
    await expect(f.invoke()).rejects.toThrow();
    expect(admittedGeneration(f.root, binding)).toBeNull();
    expect(f.effects.capture).toHaveBeenCalledOnce();
    expect(f.readNative()).toEqual(before);
  },
);

it.each(['initial_receipt', 'partial_payload', 'before_pending_rename', 'after_pending_rename'])(
  'recovers the owned checkpoint after SIGKILL during capture at %s',
  async (scenario) => {
    const f = fixture(),
      area = f.root + '/synthetic-vault';
    fs.mkdirSync(area, { mode: 0o700 });
    const queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
    const checkpointUrl = new URL('./checkpoint-maintenance.ts', import.meta.url).href,
      queueUrl = new URL('./backup-queue.ts', import.meta.url).href;
    const code = `import fs from 'node:fs';
      import {checkpointMaintenance} from ${JSON.stringify(checkpointUrl)};
      import {BackupQueue} from ${JSON.stringify(queueUrl)};
      const scenario=${JSON.stringify(scenario)};
      const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
      const write=fs.writeFileSync,rename=fs.renameSync;
      fs.writeFileSync=(file,bytes,...options)=>{
        if(scenario==='initial_receipt'&&typeof file==='number'&&String(bytes).startsWith('{"format":"cos-backup-queue/v1"'))pause();
        return write(file,bytes,...options);
      };
      fs.renameSync=(from,to)=>{
        const selected=String(to).endsWith('/receipt.json')&&JSON.parse(fs.readFileSync(from,'utf8')).state==='pending';
        if(selected&&scenario==='before_pending_rename')pause();const result=rename(from,to);
        if(selected&&scenario==='after_pending_rename')pause();return result;
      };
      const queue=new BackupQueue('a'.repeat(64),(_,operation)=>operation(${JSON.stringify(area)}));
      await checkpointMaintenance({root:${JSON.stringify(f.root)},binding:${JSON.stringify(binding)},requestId:${JSON.stringify(f.requestId)},effects:{
        verify:async()=>(${JSON.stringify(f.manifest)}),inspect:async()=>queue.inspect('state'),
        workersIdle:async()=>true,stopNative:async()=>{},nativeStopped:async()=>true,databaseCompatible:async()=>true,
        startNative:async()=>{},healthy:async()=>true,
        capture:async lease=>{
          await queue.capture('state',lease.nonce,async sink=>{
            sink.write('first.json',Buffer.from('SYNTHETIC_CAPTURE_FIRST'));
            if(scenario==='partial_payload')pause();
            sink.write('nested/second.json',Buffer.from('SYNTHETIC_CAPTURE_SECOND'));
          },65536);
          throw Error('fixture_must_stop');
        },verifyCapture:async()=>{throw Error('fixture_must_stop');}
      }});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(),
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const closed = new Promise<NodeJS.Signals | null>((resolve, reject) => {
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
      const lease = activeMaintenanceLease(f.root, binding);
      expect(admittedGeneration(f.root, binding)).toBeNull();
      await expect(queue.capture('state', randomUUID(), async () => {}, 65536)).rejects.toThrow(
        'backup_queue_unavailable',
      );
      f.native.exec('UPDATE state SET paused=1');
      const beforeNative = f.readNative();
      expect(child.kill('SIGKILL')).toBe(true);
      expect(await closed).toBe('SIGKILL');
      const contents = (directory: string): unknown[] =>
        fs
          .readdirSync(directory)
          .sort()
          .map((name) => {
            const file = path.join(directory, name),
              stat = fs.lstatSync(file);
            return {
              name,
              inode: stat.ino,
              mode: stat.mode,
              body: stat.isDirectory() ? contents(file) : fs.readFileSync(file),
            };
          });
      const beforeQueue = contents(area);
      f.effects.inspect.mockImplementation(async () => queue.inspect('state'));
      f.effects.verifyCapture.mockImplementation(async (current) => {
        expect(current).toEqual(lease);
        const archive = await streamQueuedBackup(queue, 'state', lease.nonce, async () => {});
        return { status: 'queued', queueOperationId: lease.nonce, snapshotDigest: digest(archive) };
      });
      const result = await f.invoke();
      expect(result).toMatchObject({
        status: scenario === 'after_pending_rename' ? 'backup_queued' : 'backup_failed',
        admissionRestored: true,
        remoteCheckpoint: false,
      });
      expect(f.effects.capture).not.toHaveBeenCalled();
      expect(f.effects.startNative).toHaveBeenCalledOnce();
      expect(f.effects.verifyCapture).toHaveBeenCalledTimes(scenario === 'after_pending_rename' ? 1 : 0);
      expect(readTarget(f.root, binding).generation).toBe(lease.generation + 1);
      expect(f.readNative()).toEqual(beforeNative);
      expect(contents(area)).toEqual(beforeQueue);
      expect(await f.invoke()).toEqual(result);
      expect(f.effects.startNative).toHaveBeenCalledOnce();
      expect(contents(area)).toEqual(beforeQueue);
      await expect(
        checkpointMaintenance({ root: f.root, binding, requestId: randomUUID(), effects: f.effects }),
      ).resolves.toMatchObject({ status: 'backup_skipped_pending', interrupted: false });
      expect(f.effects.stopNative).not.toHaveBeenCalled();
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  },
);
