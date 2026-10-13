import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { after, test } from 'node:test';
import { BackupQueue } from '../../modules/chief-of-staff/ops/backup-queue.js';
import { BackupResticTransfer } from '../../modules/chief-of-staff/ops/backup-restic-transfer.js';
import { BackupRepositoryWriter } from '../../modules/chief-of-staff/ops/backup-repository-lease.js';
import { streamQueuedBackup } from '../../modules/chief-of-staff/ops/backup-archive-producer.js';
import { verifyResticBinary, withVerifiedResticBinary } from '../../modules/chief-of-staff/ops/restic-artifact.js';
// Real Restic and kernel scopes; vault/CIFS admission is synthetic. Never select runtime credentials.
process.umask(0o077);
const binary = process.env.COS_BACKUP_FIXTURE_BINARY;
if (!binary) throw Error('backup_fixture_artifact_required');
verifyResticBinary(binary);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-publication-'));
fs.chmodSync(root, 0o700);
const area = root + '/queue',
  repository = root + '/repository',
  lock = root + '/lock',
  cache = root + '/cache';
for (const file of [area, repository, lock, cache]) fs.mkdirSync(file, { mode: 0o700 });
const password = root + '/synthetic-password';
fs.writeFileSync(password, 'synthetic-fixture-recovery-password\n', { mode: 0o600 });
const passwordFd = fs.openSync(password, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
  repositoryFd = fs.openSync(repository, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
  cacheFd = fs.openSync(cache, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
  binaryFd = fs.openSync(binary, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
const env = { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'Australia/Sydney' };
function run(args: string[]): string {
  return execFileSync(
    '/proc/self/fd/3',
    ['--repo', '/proc/self/fd/5', '--password-file', '/proc/self/fd/4', '--no-cache', '--json', '--quiet', ...args],
    {
      env,
      timeout: 30000,
      maxBuffer: 1024 ** 2,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe', binaryFd, passwordFd, repositoryFd],
    },
  );
}
run(['init', '--repository-version', '2']);
const repositoryId = (JSON.parse(run(['cat', 'config'])) as { version: number; id: string }).id;
assert.match(repositoryId, /^[a-f0-9]{64}$/);
const owner = 'c'.repeat(64),
  queue = new BackupQueue('a'.repeat(64), async (_kind, operation) => operation(area));
const writer = new BackupRepositoryWriter(owner, async (operation) => operation(lock));
const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js',
  // Producers inherit the measured backup cache as TMPDIR; the source loader
  // must not leave its own files there or add a wrapper process around writers.
  childImports =
    extension === 'ts'
      ? [
          '--import',
          'data:text/javascript,' +
            encodeURIComponent(
              `process.env.TSX_DISABLE_CACHE='1';await import(${JSON.stringify(import.meta.resolve('tsx'))});`,
            ),
        ]
      : [];
const moduleUrl = (name: string) =>
  new URL('../../modules/chief-of-staff/ops/' + name + '.' + extension, import.meta.url).href;
const queueUrl = moduleUrl('backup-queue'),
  transferUrl = moduleUrl('backup-restic-transfer'),
  writerUrl = moduleUrl('backup-repository-lease'),
  binaryUrl = moduleUrl('restic-artifact'),
  producerUrl = moduleUrl('backup-archive-producer');
function descriptor(fd: number, file: string, directory: boolean) {
  const initial = fs.fstatSync(fd);
  return {
    fd,
    assertCurrent() {
      const held = fs.fstatSync(fd),
        current = fs.lstatSync(file);
      assert.equal(held.dev, initial.dev);
      assert.equal(held.ino, initial.ino);
      assert.equal(current.dev, initial.dev);
      assert.equal(current.ino, initial.ino);
      assert.equal(held.uid, process.getuid?.());
      assert.equal(held.mode & 0o777, directory ? 0o700 : 0o600);
      assert(directory ? held.isDirectory() : held.isFile() && held.nlink === 1);
      if (!directory) {
        assert.equal(held.size, initial.size);
        assert.equal(held.ctimeMs, initial.ctimeMs);
        assert.equal(held.mtimeMs, initial.mtimeMs);
      }
    },
  };
}
const passwordScope = descriptor(passwordFd, password, false),
  repositoryScope = descriptor(repositoryFd, repository, true),
  cacheScope = descriptor(cacheFd, cache, true);
async function withTransfer<T>(
  operation: (transfer: BackupResticTransfer, current: () => void) => Promise<T>,
  allowUpload = false,
): Promise<T> {
  return withVerifiedResticBinary(binary!, async (executable) =>
    writer.exclusive(async (lease) => {
      const current = () => {
        executable.assertCurrent();
        lease.assertCurrent();
        passwordScope.assertCurrent();
        repositoryScope.assertCurrent();
        cacheScope.assertCurrent();
      };
      const transfer = new BackupResticTransfer({
        binary: executable,
        password: passwordScope,
        repository: repositoryScope,
        cache: cacheScope,
        writer: lease,
        repositoryId,
        ownerDigest: owner,
        admitUpload: async () => {
          assert(allowUpload);
        },
        producer: (_kind, operationId) => {
          assert(allowUpload);
          return [
            process.execPath,
            ...childImports,
            '--input-type=module',
            '-e',
            `import {BackupQueue} from ${JSON.stringify(queueUrl)}; import {streamQueuedBackup} from ${JSON.stringify(producerUrl)};
          const queue=new BackupQueue('a'.repeat(64),(_,operation)=>operation(${JSON.stringify(area)}));
          await streamQueuedBackup(queue,'state',${JSON.stringify(operationId)},bytes=>new Promise((resolve,reject)=>process.stdout.write(bytes,error=>error?reject(error):resolve())));`,
          ];
        },
      });
      return operation(transfer, current);
    }),
  );
}
const stages = [
  'intent:empty',
  'intent:partial',
  'intent:before_rename',
  'intent:after_rename',
  'ack:empty',
  'ack:partial',
  'ack:before_rename',
  'ack:after_rename',
];
for (const scenario of stages)
  test('real repository recovery after SIGKILL at ' + scenario, { timeout: 60000 }, async () => {
    const operationId = randomUUID(),
      [target, stage] = scenario.split(':');
    const canary = 'COS_G02_SYNTHETIC_PUBLICATION_CANARY_' + scenario;
    const before = (JSON.parse(run(['snapshots'])) as Array<{ id: string }>).length;
    await queue.capture('state', operationId, async (sink) => sink.write('canary.json', Buffer.from(canary)), 65536);
    const archive = await streamQueuedBackup(queue, 'state', operationId, async () => {});
    const uploaded = await withTransfer((transfer) => transfer.upload('state', operationId, archive), true);
    const code = `import fs from 'node:fs';
    import {BackupQueue} from ${JSON.stringify(queueUrl)}; import {BackupResticTransfer} from ${JSON.stringify(transferUrl)};
    import {BackupRepositoryWriter} from ${JSON.stringify(writerUrl)}; import {withVerifiedResticBinary} from ${JSON.stringify(binaryUrl)};
    const stage=${JSON.stringify(stage)},target=${JSON.stringify(target)},area=${JSON.stringify(area)};
    const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    const write=fs.writeFileSync,rename=fs.renameSync;
    fs.writeFileSync=(file,bytes,...options)=>{
      if(typeof file==='number'&&Buffer.isBuffer(bytes)&&bytes.toString().startsWith('{"contract":"cos-backup-queue-retirement/v2"')) {
        const ack=JSON.parse(bytes.toString()).retired;if((target==='ack')===ack){
          if(stage==='empty')pause();if(stage==='partial'){write(file,bytes.subarray(0,Math.floor(bytes.length/2)),...options);pause();}
        }
      }return write(file,bytes,...options);
    };
    fs.renameSync=(from,to)=>{const selected=String(to).endsWith(target==='ack'?'/.cos-last-ack.json':'/.cos-retirement.json');
      if(selected&&stage==='before_rename')pause();const result=rename(from,to);if(selected&&stage==='after_rename')pause();return result;};
    const scope=(fd,file,directory)=>{const initial=fs.fstatSync(fd);return{fd,assertCurrent(){
      const held=fs.fstatSync(fd),current=fs.lstatSync(file);
      if(held.dev!==initial.dev||held.ino!==initial.ino||current.dev!==initial.dev||current.ino!==initial.ino||
        held.uid!==process.getuid()||(held.mode&511)!==(directory?448:384)||
        !(directory?held.isDirectory():held.isFile()&&held.nlink===1&&held.size===initial.size&&held.ctimeMs===initial.ctimeMs))throw Error('synthetic_scope_changed');
    }}};
    const password=scope(3,${JSON.stringify(password)},false),repository=scope(4,${JSON.stringify(repository)},true),cache=scope(5,${JSON.stringify(cache)},true);
    const queue=new BackupQueue('a'.repeat(64),(_,operation)=>operation(area));
    const writer=new BackupRepositoryWriter(${JSON.stringify(owner)},operation=>operation(${JSON.stringify(lock)}));
    await withVerifiedResticBinary(${JSON.stringify(binary)},async executable=>writer.exclusive(async lease=>{
      const current=()=>{executable.assertCurrent();lease.assertCurrent();password.assertCurrent();repository.assertCurrent();cache.assertCurrent();};
      const transfer=new BackupResticTransfer({binary:executable,password,repository,cache,writer:lease,repositoryId:${JSON.stringify(repositoryId)},
        ownerDigest:${JSON.stringify(owner)},producer(){throw Error('must_not_upload');},admitUpload:async()=>{throw Error('must_not_upload');}});
      await queue.retirePending('state',${JSON.stringify(operationId)},async request=>({
        checkpoint:await transfer.verify('state',${JSON.stringify(operationId)},request.archive,request.receipt),assertCurrent:current}));
    }));`;
    const child = spawn(process.execPath, [...childImports, '--input-type=module', '-e', code], {
      env,
      stdio: ['ignore', 'pipe', 'pipe', passwordFd, repositoryFd, cacheFd],
    });
    assert(child.stderr && child.stdout);
    const childStdout = child.stdout;
    child.stderr.on('data', (bytes: Buffer) => bytes.fill(0));
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (exitCode, signal) => resolve({ code: exitCode, signal }));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('fixture_start_timeout')), 15000);
        childStdout.once('data', (bytes) => {
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
      await assert.rejects(
        writer.exclusive(async () => {}),
        /^Error: backup_repository_busy$/,
      );
      await assert.rejects(
        queue.capture('state', randomUUID(), async () => {}, 65536),
        /^Error: backup_queue_unavailable$/,
      );
      assert(child.kill('SIGKILL'));
      assert.equal((await closed).signal, 'SIGKILL');
      const queueRoot = area + '/backup-queue',
        existing = fs.readdirSync(queueRoot).sort();
      await assert.rejects(
        queue.retirePending('state', operationId, async () => {
          throw Error('synthetic_NAS_offline');
        }),
        /^Error: backup_queue_unavailable$/,
      );
      assert.deepEqual(fs.readdirSync(queueRoot).sort(), existing);
      let fresh = 0;
      const recovered = await withTransfer(async (transfer, current) =>
        queue.retirePending('state', operationId, async (request) => {
          fresh++;
          const checkpoint = await transfer.verify('state', operationId, request.archive, request.receipt);
          return { checkpoint, assertCurrent: current };
        }),
      );
      assert.equal(fresh, 1);
      assert.equal(recovered.snapshotId, uploaded.snapshotId);
      assert.equal(recovered.archiveSha256, uploaded.archiveSha256);
      assert.deepEqual(await queue.pending('state'), []);
      assert(!fs.readdirSync(queueRoot).some((name) => name.endsWith('.tmp')));
      const ack = JSON.parse(fs.readFileSync(queueRoot + '/.cos-last-ack.json', 'utf8'));
      assert.equal(ack.contract, 'cos-backup-queue-retirement/v2');
      assert.equal(ack.retired, true);
      assert.equal(ack.remote.verifiedAt, undefined);
      assert.equal(ack.remote.reconciled, undefined);
      assert.equal((JSON.parse(run(['snapshots'])) as Array<{ id: string }>).length, before + 1);
      run(['check', '--read-data']);
    } finally {
      child.kill('SIGKILL');
      await closed;
    }
  });
after(() => {
  for (const fd of [passwordFd, repositoryFd, cacheFd, binaryFd]) fs.closeSync(fd);
  fs.rmSync(root, { recursive: true, force: true });
});
