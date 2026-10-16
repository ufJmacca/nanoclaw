// Synthetic credentials only. Storage, memory, descriptors and journals use production defaults.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { initializeMailProfile } from '/code/modules/chief-of-staff/mail/setup.js';
import { openMailCredentials } from '/code/modules/chief-of-staff/mail/config.js';
import { GOOGLE_MAIL_READ_SCOPE } from '/code/modules/chief-of-staff/mail/oauth.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { verifyVaultStorage } from '/code/modules/chief-of-staff/ops/vault-storage.js';
import { createVaultBackupQueue } from '/code/modules/chief-of-staff/ops/backup-queue.js';
import { createVaultCredentialJournal } from '/code/modules/chief-of-staff/ops/backup-credential-journal.js';
import { writeAtomic } from '/code/modules/chief-of-staff/ops/target-state.js';
import { digest } from '/code/modules/chief-of-staff/domain/contracts.js';

assert.equal(process.getuid(), 1000);
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert.equal(process.version, 'v22.23.2');
process.umask(0o077);
verifyVaultMemory();
const roots = {
  targetRoot: '/home/fixture/.config/nanoclaw-cos/state',
  installationRoot: '/case/application',
  dataRoot: '/case/data',
};
const calendar = '/case/vault/google/calendar',
  profile = calendar + '/mail-reader';
const client = { clientId: 'mail-kernel-fixture.apps.googleusercontent.com', clientSecret: 'SYNTHETIC_MAIL_CLIENT' };
const calendarClient = {
  clientId: 'calendar-kernel-fixture.apps.googleusercontent.com',
  clientSecret: 'SYNTHETIC_CALENDAR_CLIENT',
};
const metadataFile = roots.targetRoot + '/mail-fixture.json',
  scope = 'mail-kernel-fixture';
const mode = process.argv[2];
const stage = (name) => writeAtomic(roots.targetRoot, 'mail-kernel-stage.json', { stage: name });
const authority = (operationId) => ({
  operationId,
  assertAuthority() {
    verifyVaultMemory();
    assert.equal(process.getuid(), 1000);
  },
});
const hash = (file) => {
  const bytes = fs.readFileSync(file);
  try {
    return createHash('sha256').update(bytes).digest('hex');
  } finally {
    bytes.fill(0);
  }
};
function snapshot(directory) {
  const result = [];
  const visit = (root, relative = '') => {
    for (const name of fs.readdirSync(root).sort()) {
      const file = root + '/' + name,
        key = relative + name,
        stat = fs.lstatSync(file);
      assert.equal(stat.isSymbolicLink(), false);
      assert.equal(stat.uid, 1000);
      assert.equal(stat.dev, fs.statSync('/case/vault').dev);
      assert.equal(stat.mode & 0o7777, stat.isDirectory() ? 0o700 : 0o600);
      if (stat.isDirectory()) visit(file, key + '/');
      else {
        assert.equal(stat.isFile(), true);
        assert.equal(stat.nlink, 1);
        result.push({ key, sha256: hash(file) });
      }
    }
  };
  visit(directory);
  return digest(result);
}
async function close(host, denied = false) {
  if (denied) await assert.rejects(host.close(), /^Error: mail_configuration_unavailable$/);
  else await host.close();
  assert.equal(host.closed(), true);
  assert.throws(host.verifyStorage);
}
async function deniedUse(host, metadata) {
  assert.throws(host.verifyStorage);
  await assert.rejects(host.credentials.token(scope, metadata.binding, metadata.reference));
  assert.throws(() => host.fences.deny(scope, randomUUID(), 'revoked'));
}
if (mode === 'install') {
  stage('mail_setup');
  const source = JSON.parse(fs.readFileSync('/release/build-info.json', 'utf8'));
  assert.match(source.commit, /^[a-f0-9]{40}$/);
  assert.match(source.tree, /^[a-f0-9]{40}$/);
  console.log(
    JSON.stringify({
      contract: 'cos-g04-mail-vault-fixture/v1',
      sourceCommit: source.commit,
      sourceTree: source.tree,
      compiledProductionPayload: true,
      actualKernelVault: true,
      actualMemoryProtection: true,
      storageOverrides: false,
      memoryOverrides: false,
      journalOverrides: false,
      ownerCredentialsUsed: false,
      oauthTransport: 'fixture',
      setupAuthority: 'fixture',
      liveAccountAcceptance: false,
      installedAcceptance: false,
    }),
  );
  assert.equal(verifyVaultStorage(roots).vaultRoot, '/case/vault');
  assert.equal(fs.existsSync(profile), false);
  writeAtomic(calendar, 'oauth-client.json', calendarClient);
  const operationId = randomUUID();
  await assert.rejects(
    initializeMailProfile(roots, calendarClient, authority(operationId)),
    /mail_profile_initialization_unavailable/,
  );
  assert.equal(fs.existsSync(profile), false);
  await assert.rejects(openMailCredentials(roots), /mail_configuration_unavailable/);
  assert.equal(fs.existsSync(profile), false);
  assert.deepEqual(await initializeMailProfile(roots, client, authority(operationId)), { status: 'ready' });
  const host = await openMailCredentials(roots),
    binding = randomUUID(),
    reference = randomUUID(),
    deniedBinding = randomUUID();
  const fetch = globalThis.fetch;
  let exchanges = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://oauth2.googleapis.com/token');
    assert.equal(options.method, 'POST');
    exchanges++;
    return new Response(
      JSON.stringify({
        access_token: 'SYNTHETIC_ROTATED_ACCESS',
        refresh_token: 'SYNTHETIC_ROTATED_REFRESH',
        token_type: 'Bearer',
        expires_in: 3600,
        scope: GOOGLE_MAIL_READ_SCOPE,
      }),
    );
  };
  try {
    stage('mail_install_and_refresh');
    await host.credentials.install(scope, binding, reference, {
      accessToken: 'SYNTHETIC_EXPIRED_ACCESS',
      refreshToken: 'SYNTHETIC_REFRESH',
      expiresAt: Date.now() - 1,
      refreshExpiresAt: null,
      scopes: [GOOGLE_MAIL_READ_SCOPE],
    });
    assert.equal(await host.credentials.token(scope, binding, reference), 'SYNTHETIC_ROTATED_ACCESS');
    assert.equal(await host.credentials.token(scope, binding, reference), 'SYNTHETIC_ROTATED_ACCESS');
    assert.equal(exchanges, 1);
    assert.deepEqual(await host.credentials.inspect(scope, binding, reference), {
      auth: 'ready',
      scopes: [GOOGLE_MAIL_READ_SCOPE],
      generation: 2,
    });
    await assert.rejects(host.credentials.token(scope, randomUUID(), reference), /calendar_credentials_denied/);
    host.fences.deny(scope, deniedBinding, 'revoked');
    assert.throws(() => host.fences.assertOpen(scope, deniedBinding), /calendar_auth_revoked/);
  } finally {
    globalThis.fetch = fetch;
    await close(host);
  }
  const queue = createVaultBackupQueue(roots),
    pending = await queue.pending('credentials');
  assert.equal(pending.length, 3);
  for (const receipt of pending)
    await queue.withPending('credentials', receipt.operationId, async (directory) => {
      assert.equal(fs.statSync(directory).dev, fs.statSync('/case/vault').dev);
      assert.equal(JSON.parse(fs.readFileSync(directory + '/credential-event.json', 'utf8')).sourceKind, 'mail_reader');
    });
  stage('mail_retry_preservation');
  // The root-owned .vault-canary is storage proof, never credential payload.
  const before = snapshot(profile),
    journal = snapshot('/case/vault/journals/backup-queue');
  assert.deepEqual(await initializeMailProfile(roots, client, authority(operationId)), { status: 'ready' });
  assert.equal(snapshot(profile), before);
  assert.equal(snapshot('/case/vault/journals/backup-queue'), journal);
  const reopened = await openMailCredentials(roots);
  assert.throws(() => reopened.fences.assertOpen(scope, deniedBinding), /calendar_auth_revoked/);
  await close(reopened);
  writeAtomic(roots.targetRoot, 'mail-fixture.json', { operationId, binding, reference, deniedBinding });
  console.log(
    JSON.stringify({
      mailVaultStage: 'install',
      separateClient: true,
      retryPreserved: true,
      credentialGeneration: 2,
      actualEncryptedJournal: true,
      journalEvents: pending.length,
      deniedCrossAccount: true,
      denialPreserved: true,
    }),
  );
  stage('mail_directory_races');
  let cases = 0;
  for (const relative of ['', '/credentials', '/access-denials']) {
    const host = await openMailCredentials(roots),
      named = profile + relative,
      held = calendar + '/held-' + cases;
    fs.renameSync(named, held);
    fs.mkdirSync(named, { mode: 0o700 });
    try {
      await deniedUse(host, { binding, reference });
      assert.deepEqual(fs.readdirSync(named), []);
      cases++;
    } finally {
      fs.rmdirSync(named);
      fs.renameSync(held, named);
      await close(host);
    }
  }
  for (const name of ['oauth-client.json', '.cos-mail-reader']) {
    const host = await openMailCredentials(roots),
      named = profile + '/' + name,
      held = calendar + '/held-file';
    fs.renameSync(named, held);
    fs.copyFileSync(held, named, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(named, 0o600);
    try {
      await deniedUse(host, { binding, reference });
      assert.equal(hash(named), hash(held));
      cases++;
    } finally {
      fs.unlinkSync(named);
      fs.renameSync(held, named);
      await close(host, true);
    }
  }
  {
    const host = await openMailCredentials(roots);
    fs.chmodSync(profile, 0o755);
    try {
      await deniedUse(host, { binding, reference });
      cases++;
    } finally {
      fs.chmodSync(profile, 0o700);
      await close(host);
    }
  }
  {
    const host = await openMailCredentials(roots),
      named = profile + '/credentials',
      held = calendar + '/held-credentials';
    fs.renameSync(named, held);
    fs.symlinkSync(held, named);
    try {
      await deniedUse(host, { binding, reference });
      cases++;
    } finally {
      fs.unlinkSync(named);
      fs.renameSync(held, named);
      await close(host);
    }
  }
  assert.equal(cases, 7);
  writeAtomic(roots.targetRoot, 'mail-fixture-snapshot.json', {
    profile: snapshot(profile),
    journals: snapshot('/case/vault/journals/backup-queue'),
  });
  console.log(JSON.stringify({ mailVaultStage: 'directory_races', deniedCases: cases, replacementWrites: 0 }));
} else if (mode === 'mount-loss') {
  stage('mail_mount_race');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')),
    host = await openMailCredentials(roots);
  const journal = createVaultCredentialJournal(roots);
  writeAtomic(roots.targetRoot, 'mail-race-request', { ready: true });
  let detached = false;
  for (let attempt = 0; attempt < 500; attempt++) {
    if (fs.existsSync(roots.targetRoot + '/race-closed')) {
      detached = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(detached, true);
  await deniedUse(host, metadata);
  const bytes = Buffer.from('SYNTHETIC_LOST_MOUNT_JOURNAL');
  try {
    await assert.rejects(
      journal(
        {
          sourceKind: 'mail_reader',
          sourceKey: digest('synthetic-lost-mount'),
          generation: 1,
          phase: 'ready',
          files: [{ name: 'credential.json', bytes }],
        },
        () => verifyVaultMemory(),
      ),
      /backup_credential_journal_unavailable/,
    );
  } finally {
    bytes.fill(0);
  }
  await assert.rejects(
    initializeMailProfile(roots, client, authority(metadata.operationId)),
    /mail_profile_initialization_unavailable/,
  );
  await close(host, true);
  console.log(
    JSON.stringify({
      mailVaultStage: 'mount_loss',
      heldHostDenied: true,
      tokenDenied: true,
      denialWriteDenied: true,
      journalDenied: true,
      setupDenied: true,
      closeSettled: true,
    }),
  );
} else if (mode === 'recovered') {
  stage('mail_recovered');
  const metadata = JSON.parse(fs.readFileSync(metadataFile, 'utf8')),
    before = JSON.parse(fs.readFileSync(roots.targetRoot + '/mail-fixture-snapshot.json', 'utf8'));
  assert.equal(snapshot(profile), before.profile);
  assert.equal(snapshot('/case/vault/journals/backup-queue'), before.journals);
  const host = await openMailCredentials(roots);
  try {
    assert.deepEqual(await host.credentials.inspect(scope, metadata.binding, metadata.reference), {
      auth: 'ready',
      scopes: [GOOGLE_MAIL_READ_SCOPE],
      generation: 2,
    });
    assert.equal(await host.credentials.token(scope, metadata.binding, metadata.reference), 'SYNTHETIC_ROTATED_ACCESS');
    assert.throws(() => host.fences.assertOpen(scope, metadata.deniedBinding), /calendar_auth_revoked/);
  } finally {
    await close(host);
  }
  assert.equal(snapshot(profile), before.profile);
  assert.equal(snapshot('/case/vault/journals/backup-queue'), before.journals);
  console.log(
    JSON.stringify({
      mailVaultStage: 'recovered',
      credentialsPreserved: true,
      denialPreserved: true,
      journalPreserved: true,
    }),
  );
} else if (mode === 'unavailable') {
  stage('mail_unavailable');
  await assert.rejects(openMailCredentials(roots), /mail_configuration_unavailable/);
  await assert.rejects(
    initializeMailProfile(roots, client, authority(randomUUID())),
    /mail_profile_initialization_unavailable/,
  );
  // Plaintext underlays are root-owned mode 000. The owner must be unable to
  // read or write them; the root orchestrator separately verifies both empty.
  for (const directory of ['/case/vault', roots.targetRoot + '/calendar']) {
    const stat = fs.lstatSync(directory);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o7777, 0);
    assert.throws(() => fs.readdirSync(directory), { code: 'EACCES' });
    assert.throws(() => fs.openSync(directory + '/synthetic-plaintext-probe', 'wx', 0o600), { code: 'EACCES' });
  }
  console.log(
    JSON.stringify({ mailVaultStage: 'unavailable', openDenied: true, setupDenied: true, plaintextWrites: 0 }),
  );
} else throw Error('unknown mail fixture mode');
