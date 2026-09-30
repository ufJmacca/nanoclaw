/** Offline final-host fixture. Application imports resolve only to the baked compiled payload. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

test(
  'compiled subscription operator preserves pause and revocation across explicit recovery',
  { timeout: 15000 },
  async () => {
    assert.ok(
      Object.values(os.networkInterfaces())
        .flat()
        .every((entry) => !entry || entry.internal),
    );
    const root = fs.mkdtempSync('/tmp/cos-operator-');
    process.chdir(root);
    fs.mkdirSync(root + '/data', { mode: 0o700 });
    const load = (name) => import('/release/dist/' + name + '.js');
    const { initDb, closeDb, getDb } = await load('db/connection');
    const { getSession } = await load('db/sessions');
    const { runMigrations } = await load('db/migrations/index');
    const { subscribeMattermostChannelStrict } = await load('channels/mattermost-subscription');
    const { resolveSession, openInboundDb, openOutboundDb } = await load('session-manager');
    const { bindCoordinator } = await load('modules/chief-of-staff/ops/bind');
    const { initializeTarget, writeAtomic, readTarget } = await load('modules/chief-of-staff/ops/target-state');
    const { beginMaintenance, confirmQuiescence } = await load('modules/chief-of-staff/ops/maintenance');
    const { contextAdminCommand } = await load('modules/chief-of-staff/ops/context-admin');
    const { reserveSubscriptionAttempt } = await load('modules/chief-of-staff/bridge/model-policy');
    const { CosController } = await load('modules/chief-of-staff/bridge/controller');
    const { createConversationState } = await load('modules/chief-of-staff/bridge/conversation-state');
    const { guardConversationAccess } = await load('modules/chief-of-staff/bridge/conversation-access');
    const { verifyConversationBackup } = await load('modules/chief-of-staff/ops/conversation-backup');
    const state = root + '/state',
      central = root + '/data/v2.db';
    const target = {
      hostFingerprint: 'a'.repeat(64),
      databaseFingerprint: 'b'.repeat(64),
      service: 'fixture.service',
      installationRoot: root,
      dataRoot: root + '/data',
    };
    const channel = { id: 'private', type: 'P', delete_at: 0, members: ['bot', 'owner'], activeSubscription: true };
    const facts = async () => channel;
    const env = { COS_ENABLED: 'true', COS_TARGET_STATE_DIR: state };
    const dependencies = { target: () => readTarget(state, target), facts, quiescent: async () => true };
    const admin = (args) => contextAdminCommand({ scopeId: 'fixture', ...args }, env, dependencies);
    try {
      runMigrations(initDb(central));
      assert.ok(getDb().prepare("SELECT name FROM schema_version WHERE name='cos-subscription-context'").get());
      const subscription = subscribeMattermostChannelStrict({ instanceKey: 'fixture', channelId: 'private' });
      resolveSession(subscription.agentGroup.id, subscription.messagingGroup.id, null, 'shared');
      await bindCoordinator(
        {
          scopeId: 'fixture',
          instanceId: 'fixture',
          channelId: 'private',
          ownerId: 'owner',
          botId: 'bot',
          provider: 'codex',
        },
        { facts, bindScope: async () => ({ status: 'ok' }) },
      );
      closeDb();
      initializeTarget(state, target);
      const lease = beginMaintenance(state, target, 'fixture-operation', 'deployment');
      await confirmQuiescence(state, target, lease, async () => ({
        activeCoordinators: 0,
        activeDatabaseOperations: 0,
      }));
      fs.mkdirSync(state + '/codex-auth', { mode: 0o700 });
      writeAtomic(state + '/codex-auth', 'account-binding.json', {
        accountHash: 'c'.repeat(64),
        sourcePathHash: createHash('sha256')
          .update(path.join(os.homedir(), '.codex', 'auth.json'))
          .digest('hex'),
      });
      assert.equal((await admin({ command: 'context-status' })).context, 'not_initialized');
      const prepared = await admin({ command: 'context-prepare' });
      assert.equal(prepared.status, 'prepared_paused');
      const old = state + '/conversations/' + prepared.generation;
      fs.writeFileSync(old + '/history-canary', 'retained synthetic conversation', { mode: 0o600 });
      const policy = {
        version: 2,
        runtime: 'codex-subscription/v1',
        activationId: 'e'.repeat(32),
        scopeId: 'fixture',
        provider: 'codex',
        model: 'fixture-model',
        consentRef: 'offline-fixture-only',
        expiresAt: new Date(Date.now() + 60000).toISOString(),
        maxAttempts: 3,
        accountFingerprint: 'c'.repeat(64),
        contextGeneration: prepared.generation,
      };
      writeAtomic(state, 'fixture-consent.json', policy);
      assert.equal(
        (await admin({ command: 'model-activate', policyFile: state + '/fixture-consent.json' })).status,
        'activation_configured_paused',
      );
      let native = initDb(central);
      const binding = JSON.parse(native.prepare('SELECT binding FROM cos_identity_boundaries').get().binding);
      const output = openOutboundDb(binding.agentGroupId, binding.sessionId, { readonly: false });
      output.exec(
        "INSERT INTO messages_out(id,kind,timestamp,content) VALUES('cancelled','chat','fixture','old synthetic answer')",
      );
      output.close();
      closeDb();
      const resume = { command: 'context-resume', activationId: policy.activationId, resumeId: randomUUID() };
      assert.equal((await admin(resume)).status, 'resumed');
      native = initDb(central);
      const input = openInboundDb(binding.agentGroupId, binding.sessionId);
      assert.equal(
        input.prepare("SELECT status FROM delivered WHERE message_out_id='cancelled'").get().status,
        'quarantined_pause',
      );
      input.close();
      assert.equal(reserveSubscriptionAttempt(native, policy, 'fixture-ingress', randomUUID()), true);
      let stops = 0;
      const unexpected = () => {
        throw new Error('pause attempted a model/database/network effect');
      };
      const controller = new CosController({
        db: native,
        facts,
        enabled: () => false,
        session: getSession,
        decide: unexpected,
        acknowledge: unexpected,
        project: unexpected,
        wake: unexpected,
        stop: () => {
          stops++;
        },
      });
      await controller.ingress(binding, {
        channelType: 'mattermost',
        platformId: 'mattermost:fixture:private',
        threadId: null,
        message: {
          id: randomUUID(),
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({ senderId: 'mattermost:owner', text: 'cos pause automation' }),
        },
      });
      assert.equal(stops, 1);
      assert.equal(native.prepare('SELECT paused FROM cos_identity_boundaries').get().paused, 1);
      closeDb();
      const replay = await admin(resume);
      assert.equal(replay.status, 'resume_replayed');
      assert.equal(replay.paused, true);
      assert.equal((await admin({ command: 'context-status' })).remainingAttempts, 2);
      native = initDb(central);
      const conversation = createConversationState(state, native);
      const transient = guardConversationAccess({
        active: () => true,
        facts: async () => {
          throw new Error('fixture-transient');
        },
        revoke: () => conversation.invalidate(binding.scopeId, 'access_changed'),
      });
      await assert.rejects(transient(binding), /fixture-transient/);
      assert.equal(conversation.current(binding, policy.accountFingerprint, prepared.generation), true);
      const revoked = guardConversationAccess({
        active: () => true,
        facts: async () => ({ ...channel, members: ['bot', 'owner', 'unexpected-member'] }),
        revoke: () => conversation.invalidate(binding.scopeId, 'access_changed'),
      });
      await assert.rejects(revoked(binding));
      assert.equal(conversation.current(binding, policy.accountFingerprint, prepared.generation), false);
      closeDb();
      assert.equal((await admin({ command: 'context-status' })).context, 'invalidated');
      await assert.rejects(admin({ ...resume, resumeId: randomUUID() }));
      const recoveryId = randomUUID();
      const recovered = await admin({
        command: 'context-recover',
        expectedGeneration: prepared.generation,
        recoveryId,
      });
      assert.equal(recovered.status, 'recovered_paused');
      assert.notEqual(recovered.generation, prepared.generation);
      assert.equal(fs.readFileSync(old + '/history-canary', 'utf8'), 'retained synthetic conversation');
      const backup = state + '/context-recovery-backups/' + recoveryId;
      assert.equal(
        fs.readFileSync(backup + '/conversation-backup/history/' + prepared.generation + '/history-canary', 'utf8'),
        'retained synthetic conversation',
      );
      await verifyConversationBackup(state + '/conversations', backup);
      assert.deepEqual(fs.readdirSync(state + '/conversations/' + recovered.generation), []);
      const status = await admin({ command: 'context-status' });
      assert.equal(status.paused, true);
      assert.equal(status.activation, 'configured');
      assert.equal(status.remainingAttempts, 2);
      assert.equal(recovered.activation.status, 'rebound_paused');
      assert.deepEqual(JSON.parse(fs.readFileSync(state + '/model-activation.json', 'utf8')), {
        ...policy,
        contextGeneration: recovered.generation,
      });
      assert.equal(status.live_model, 'not_verified');
      assert.equal(readTarget(state, target).maintenance, true);
      console.log(
        JSON.stringify({
          probe: 'passed',
          nativeSchemaContract: 22,
          contextPreparation: true,
          boundedActivation: true,
          pauseReplay: true,
          transientHistoryPreserved: true,
          revocationFenced: true,
          recoveryBackupVerified: true,
          newGenerationEmptyPaused: true,
          remainingConsentPreservedWithoutRefill: true,
          modelCalls: 0,
          messagesSent: 0,
          hostAndChannelFacts: 'synthetic',
        }),
      );
    } finally {
      closeDb();
      process.chdir('/tmp');
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
