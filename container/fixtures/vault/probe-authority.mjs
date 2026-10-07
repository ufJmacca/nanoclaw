import fs from 'node:fs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { openVaultAuthority, checkVaultAuthority } from '/code/modules/chief-of-staff/ops/vault-authority.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
import { runtimeTestMessages, writeRuntimeTestMessage } from '/code/modules/chief-of-staff/ops/runtime-test-wire.js';
try {
  assert.equal(process.env.NANOCLAW_COS_VAULT_FIXTURE, '1');
  verifyVaultMemory();
  const mode = process.argv[2];
  if (mode === 'owner') {
    assert.equal(process.getuid(), 1000);
    const scope = { operationId: process.argv[3] ?? randomUUID(), targetDigest: 'a'.repeat(64), generation: 1 };
    let allowed = true;
    const grant = await openVaultAuthority('/case/authority', scope, async () => {
      assert.equal(allowed, true);
    });
    try {
      // Captured by the root fixture process's private pipe, never its log output.
      await writeRuntimeTestMessage(process.stdout, { socket: grant.socket, token: grant.token, scope });
      for await (const message of runtimeTestMessages(process.stdin)) {
        if (message.action === 'deny') {
          allowed = false;
          await writeRuntimeTestMessage(process.stdout, { stage: 'denied' });
        } else if (message.action === 'close') break;
        else throw Error('invalid fixture control');
      }
    } finally {
      await grant.close();
    }
  } else if (mode === 'root') {
    assert.equal(process.getuid(), 0);
    fs.mkdirSync('/case/authority', { mode: 0o700 });
    fs.chownSync('/case/authority', 1000, 1000);
    const child = spawn(
      '/usr/bin/setpriv',
      ['--reuid=1000', '--regid=1000', '--clear-groups', process.execPath, '/probe/probe-authority.mjs', 'owner'],
      {
        env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', NANOCLAW_COS_VAULT_FIXTURE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      },
    );
    child.stderr.resume();
    const exited = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) =>
        code === 0 && !signal ? resolve() : reject(Error('authority fixture unavailable')),
      );
    });
    // Register rejection handling before awaiting the private handshake.
    exited.catch(() => {});
    try {
      const messages = runtimeTestMessages(child.stdout);
      const first = await messages.next();
      assert.equal(first.done, false);
      const grant = first.value;
      assert.match(grant.token, /^[a-f0-9]{64}$/);
      await checkVaultAuthority(grant, grant.scope, 1000);
      await writeRuntimeTestMessage(child.stdin, { action: 'deny' });
      assert.deepEqual((await messages.next()).value, { stage: 'denied' });
      await assert.rejects(checkVaultAuthority(grant, grant.scope, 1000), /vault_authority_unavailable/);
      await writeRuntimeTestMessage(child.stdin, { action: 'close' });
      child.stdin.end();
      await exited;
      assert.equal(fs.readdirSync('/case/authority').length, 0);
      console.log('{"rootAuthority":"passed","ownerUid":1000,"rootUid":0,"revokedAuthorityDenied":true}');
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  } else throw Error('unknown authority fixture mode');
} catch {
  console.error('{"code":"vault_authority_fixture_unavailable"}');
  process.exitCode = 1;
}
