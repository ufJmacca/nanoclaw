/** Final-artifact regression: synthetic native state only, without accounts, database credentials or network. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { installCosBoundary } from '../../cos-boundary.js';
import { ensureModelBudget } from '../../modules/chief-of-staff/bridge/model-policy.js';
import { backupNativeDatabase } from '../../modules/chief-of-staff/ops/native-installation.js';
import { initializeTarget, protectTarget, readTarget } from '../../modules/chief-of-staff/ops/target-state.js';
import { withVaultDirectory, vaultStorageStatus } from '../../modules/chief-of-staff/ops/vault-storage.js';

test('G01 vault loss preserves protected lifecycle, native history, context and consumed allowance', async () => {
  assert.equal(process.platform, 'linux');
  assert.ok(
    Object.values(os.networkInterfaces())
      .flat()
      .every((address) => !address || address.internal),
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-g01-protected-'));
  fs.chmodSync(root, 0o700);
  const targetRoot = root + '/target',
    installationRoot = root + '/application',
    dataRoot = root + '/data';
  const binding = {
    hostFingerprint: 'a'.repeat(64),
    databaseFingerprint: 'b'.repeat(64),
    service: 'nanoclaw-fixture.service',
    installationRoot,
    dataRoot,
  };
  let native: Database.Database | undefined;
  try {
    initializeTarget(targetRoot, binding);
    const stale = fs.readFileSync(targetRoot + '/state.json');
    protectTarget(targetRoot, binding);
    const seal = fs.readFileSync(targetRoot + '/protected.json');
    for (const directory of [installationRoot, dataRoot, root + '/snapshot']) fs.mkdirSync(directory, { mode: 0o700 });
    const file = dataRoot + '/native.sqlite';
    native = new Database(file);
    native.pragma('journal_mode=WAL');
    fs.chmodSync(file, 0o600);
    installCosBoundary(
      {
        scopeId: 'synthetic-scope',
        ownerId: 'synthetic-owner',
        agentGroupId: 'synthetic-group',
        messagingGroupId: 'synthetic-chat',
        sessionId: 'synthetic-session',
        provider: 'codex',
        instanceId: 'synthetic-instance',
        channelId: 'synthetic-channel',
        botId: 'synthetic-bot',
      },
      native,
    );
    ensureModelBudget(native);
    native.exec(`CREATE TABLE ordinary_messages(id TEXT PRIMARY KEY, body TEXT);
      INSERT INTO ordinary_messages VALUES('synthetic-message','synthetic history');
      CREATE TABLE ordinary_sessions(id TEXT PRIMARY KEY, context TEXT);
      INSERT INTO ordinary_sessions VALUES('synthetic-session','synthetic-main-context');
      INSERT INTO cos_model_budgets VALUES('synthetic-activation','synthetic-policy-digest',3);
      INSERT INTO cos_model_attempts VALUES('synthetic-activation','synthetic-attempt','synthetic-ingress');`);
    const snapshot = () => ({
      messages: native!.prepare('SELECT * FROM ordinary_messages ORDER BY id').all(),
      sessions: native!.prepare('SELECT * FROM ordinary_sessions ORDER BY id').all(),
      boundaries: native!.prepare('SELECT * FROM cos_identity_boundaries ORDER BY scope_id').all(),
      budgets: native!.prepare('SELECT * FROM cos_model_budgets ORDER BY activation_id').all(),
      attempts: native!.prepare('SELECT * FROM cos_model_attempts ORDER BY attempt_id').all(),
    });
    const before = snapshot(),
      roots = { targetRoot, installationRoot, dataRoot };
    let touched = false;
    await assert.rejects(
      withVaultDirectory(roots, 'google', async () => {
        touched = true;
      }),
      /vault_storage_unavailable/,
    );
    assert.equal(touched, false);
    assert.equal(vaultStorageStatus(roots).googleCredentials, 'unavailable');
    assert.equal(fs.existsSync(targetRoot + '/calendar'), false);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(fs.readFileSync(targetRoot + '/protected.json'), seal);
    fs.writeFileSync(targetRoot + '/state.json', stale);
    assert.equal(readTarget(targetRoot, binding).lifecycle, 'protected');
    assert.equal(initializeTarget(targetRoot, binding).lifecycle, 'protected');
    const receipt = await backupNativeDatabase(file, root + '/snapshot');
    assert.deepEqual(await backupNativeDatabase(file, root + '/snapshot'), receipt);
    const copy = new Database(receipt.file, { readonly: true });
    try {
      assert.deepEqual(copy.prepare('SELECT * FROM ordinary_messages ORDER BY id').all(), before.messages);
      assert.deepEqual(copy.prepare('SELECT * FROM ordinary_sessions ORDER BY id').all(), before.sessions);
      assert.deepEqual(
        copy.prepare('SELECT * FROM cos_identity_boundaries ORDER BY scope_id').all(),
        before.boundaries,
      );
      assert.deepEqual(copy.prepare('SELECT * FROM cos_model_budgets ORDER BY activation_id').all(), before.budgets);
      assert.deepEqual(copy.prepare('SELECT * FROM cos_model_attempts ORDER BY attempt_id').all(), before.attempts);
      assert.equal(copy.pragma('quick_check', { simple: true }), 'ok');
    } finally {
      copy.close();
    }
    assert.deepEqual(snapshot(), before);
  } finally {
    native?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
