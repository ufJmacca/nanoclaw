// Baked compiled production code on a disposable real LUKS2/ext4 volume. Synthetic data only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';
import { configureCalendarStorage } from '/code/modules/chief-of-staff/calendar/storage-policy.js';
import { CalendarCredentialOwner } from '/code/modules/chief-of-staff/calendar/credentials.js';
import { CalendarAccessFences } from '/code/modules/chief-of-staff/calendar/access-fences.js';
import { openCalendarCredentials } from '/code/modules/chief-of-staff/calendar/config.js';
import { GOOGLE_EVENT_READ_SCOPE } from '/code/modules/chief-of-staff/calendar/reader.js';
import { createVaultBackupQueue } from '/code/modules/chief-of-staff/ops/backup-queue.js';
import { createVaultCredentialJournal } from '/code/modules/chief-of-staff/ops/backup-credential-journal.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { readBackupCapacity } from '/code/modules/chief-of-staff/ops/backup-capacity.js';
import { writeAtomic } from '/code/modules/chief-of-staff/ops/target-state.js';

assert.equal(process.getuid(), 1000); assert.equal(process.platform, 'linux'); assert.equal(process.arch, 'arm64');
verifyVaultMemory(); process.umask(0o077);
const roots = { targetRoot: '/home/fixture/.config/nanoclaw-cos/state', installationRoot: '/case/application', dataRoot: '/case/data' };
const calendar = roots.targetRoot + '/calendar', queue = createVaultBackupQueue(roots), journal = createVaultCredentialJournal(roots);
const canary = '/case/vault/journals/.vault-canary', originalCanary = fs.lstatSync(canary);
const original = await queue.pending('credentials');
assert.equal(original.length, 1); // Default backup credential install must have queued its exact private snapshot.
await queue.withPending('credentials', original[0].operationId, async directory => {
  const event = JSON.parse(fs.readFileSync(directory + '/credential-event.json', 'utf8'));
  assert.equal(event.sourceKind, 'backup_repository');
  assert.equal(fs.readFileSync(directory + '/smb-credentials').equals(fs.readFileSync('/case/vault/backup-credentials/smb-credentials')), true);
});
let cases = 1;
for (const name of ['credentials', 'access-denials']) fs.mkdirSync(calendar + '/' + name, { mode: 0o700 });
CalendarCredentialOwner.initialize(calendar + '/credentials'); CalendarAccessFences.initialize(calendar + '/access-denials');
const client = { clientId: 'synthetic-journal.apps.googleusercontent.com', clientSecret: 'SYNTHETIC_CLIENT_SECRET' };
writeAtomic(calendar, 'oauth-client.json', client);
configureCalendarStorage(roots, '/case/vault/calendar-backups');
const opened = openCalendarCredentials(roots), reference = randomUUID(), binding = randomUUID(), now = Date.now();
const tokens = expired => ({ accessToken: 'SYNTHETIC_ACCESS', refreshToken: 'SYNTHETIC_REFRESH',
  expiresAt: now + (expired ? -1 : 3600000), refreshExpiresAt: null, scopes: [GOOGLE_EVENT_READ_SCOPE] });
await opened.credentials.install('journal-fixture', binding, reference, tokens(false));
await opened.credentials.inspect('journal-fixture', binding, reference);
assert.equal((await queue.pending('credentials')).length, 2); cases++;
const second = randomUUID(); let exchanges = 0;
const rotating = new CalendarCredentialOwner(calendar + '/credentials', client, opened.fences, {
  now: () => now, fetch: async () => { exchanges++; return new Response(JSON.stringify({ access_token: 'SYNTHETIC_ROTATED_ACCESS',
    refresh_token: 'SYNTHETIC_ROTATED_REFRESH', token_type: 'Bearer', expires_in: 3600, scope: GOOGLE_EVENT_READ_SCOPE })); },
}, opened.verifyStorage, journal);
await rotating.install('journal-fixture', binding, second, tokens(true));
assert.equal(await rotating.token('journal-fixture', binding, second), 'SYNTHETIC_ROTATED_ACCESS');
await rotating.token('journal-fixture', binding, second);
assert.equal(exchanges, 1); assert.equal((await queue.pending('credentials')).length, 5); cases++;
const revokedReference = randomUUID(), revokedBinding = randomUUID();
const revoked = new CalendarCredentialOwner(calendar + '/credentials', client, opened.fences, {
  now: () => now, fetch: async () => new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 }),
}, opened.verifyStorage, journal);
await revoked.install('journal-fixture', revokedBinding, revokedReference, tokens(true));
await assert.rejects(revoked.token('journal-fixture', revokedBinding, revokedReference), /calendar_auth_revoked/);
assert.throws(() => opened.fences.assertOpen('journal-fixture', revokedBinding), /calendar_auth_revoked/);
assert.equal((await queue.pending('credentials')).length, 8); cases++;

for (const stage of ['empty', 'partial', 'before_rename', 'after_rename']) {
  const sourceKey = digest({ stage, fixture: 'encrypted-credential-journal' }), primary = '/case/vault/backup-credentials/journal-source-' + stage + '.json';
  fs.writeFileSync(primary, JSON.stringify({ synthetic: true, stage }) + '\n', { flag: 'wx', mode: 0o600 });
  const bytes = fs.readFileSync(primary), identity = digest(bytes.toString('utf8'));
  const change = { sourceKind: 'backup_repository', sourceKey, generation: 1, phase: 'ready', files: [{ name: 'credential.json', bytes }] };
  const guard = () => { verifyVaultMemory(); assert.equal(digest(fs.readFileSync(primary, 'utf8')), identity); };
  const code = `import fs from 'node:fs'; import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';
    import { createVaultCredentialJournal } from '/code/modules/chief-of-staff/ops/backup-credential-journal.js';
    import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
    const stage=${JSON.stringify(stage)},primary=${JSON.stringify(primary)},identity=${JSON.stringify(identity)};
    const write=fs.writeFileSync,rename=fs.renameSync;
    const pause=()=>{fs.writeSync(1,'READY\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
    fs.writeFileSync=(file,bytes,...options)=>{
      if(typeof file==='number' && Buffer.isBuffer(bytes) && bytes.toString().startsWith('{"contract":"cos-backup-credential-head/v1"')) {
        if(stage==='empty')pause();if(stage==='partial'){write(file,bytes.subarray(0,Math.floor(bytes.length/2)),...options);pause();}
      }return write(file,bytes,...options);
    };
    fs.renameSync=(from,to)=>{const selected=/\\/.cos-credential-[a-f0-9]{64}\\.json$/.test(String(to));
      if(selected && stage==='before_rename')pause();const result=rename(from,to);if(selected && stage==='after_rename')pause();return result;};
    const bytes=fs.readFileSync(primary);try { await createVaultCredentialJournal(${JSON.stringify(roots)})({sourceKind:'backup_repository',
      sourceKey:${JSON.stringify(sourceKey)},generation:1,phase:'ready',files:[{name:'credential.json',bytes}]},
      ()=>{verifyVaultMemory();if(digest(fs.readFileSync(primary,'utf8'))!==identity)throw Error('fixture_primary_changed');}); }
    finally {bytes.fill(0);}`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code], { env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const closed = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', (_code, signal) => resolve(signal)); });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('fixture_start_timeout')), 5000);
      child.stdout.once('data', value => { clearTimeout(timer); value.toString() === 'READY\n' ? resolve() : reject(Error('fixture_start_failed')); });
      child.once('close', () => { clearTimeout(timer); reject(Error('fixture_start_failed')); });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    await assert.rejects(journal({ ...change, sourceKey: digest({ sourceKey, competing: true }) }, guard), /backup_credential_journal_unavailable/);
    child.kill('SIGKILL'); assert.equal(await closed, 'SIGKILL');
    const before = (await queue.pending('credentials')).length;
    await assert.rejects(journal(change, () => { throw Error('fixture_source_withdrawn'); }), /backup_credential_journal_unavailable/);
    assert.equal((await queue.pending('credentials')).length, before);
    await journal(change, guard); await journal(change, guard);
    assert.equal((await queue.pending('credentials')).length, before);
    assert.deepEqual(fs.readdirSync('/case/vault/journals/backup-queue').filter(name => /^\.cos-credential-.*\.tmp$/.test(name)), []);
    cases++;
  } finally { child.kill('SIGKILL'); await closed; bytes.fill(0); }
}
const repositoryRoot = '/case/vault/cache/journal-capacity-repository-fixture'; fs.mkdirSync(repositoryRoot, { mode: 0o700 });
const fd = fs.openSync(repositoryRoot, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
try {
  const capacity = await readBackupCapacity(roots, { fd, assertCurrent() { verifyVaultMemory(); } });
  assert(capacity.credentials > 0 && capacity.credentials < 128 * 1024 ** 2); cases++;
} finally { fs.closeSync(fd); }
const currentCanary = fs.lstatSync(canary);
for (const key of ['dev', 'ino', 'uid', 'gid', 'mode', 'nlink', 'size', 'mtimeMs', 'ctimeMs']) assert.equal(currentCanary[key], originalCanary[key]);
assert.equal((await queue.pending('credentials')).length, 12);
console.log(JSON.stringify({ encryptedCredentialJournal: 'passed', cases, actualKilledWriters: 4,
  actualEncryptedVault: true, compiledProductionQueue: true, defaultReaderAndBackupOwner: true,
  productionMemoryAndStorageOverrides: false, rootProofBytesRead: false,
  oauth: 'fixture', remoteRepository: 'metadata-only-fixture', remoteUpload: 'not_exercised', syntheticCredentialsOnly: true }));
