import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import crypto, { randomUUID } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type pg from 'pg';
import { connectFixtureDatabase, fixtureDatabaseConfig, fixtureRuntimeUser } from './fixture-database.js';
import { migrate } from '../../modules/chief-of-staff/store/migrations.js';
import { BoundedDatabase } from '../../modules/chief-of-staff/store/client.js';
import { PriorityStore } from '../../modules/chief-of-staff/store/priorities.js';
import { KnowledgeArtifacts } from '../../modules/chief-of-staff/knowledge/artifacts.js';
import { KnowledgeStore, type Evidence, type KnowledgeContext } from '../../modules/chief-of-staff/knowledge/store.js';
import { digest, type ProposalChange } from '../../modules/chief-of-staff/domain/contracts.js';
import type { ReviewCharterDefinition } from '../../modules/chief-of-staff/contracts/strategy-protocol.js';
import { ReviewCollector } from '../../modules/chief-of-staff/strategy/collector.js';
import { ReviewArtifacts } from '../../modules/chief-of-staff/strategy/artifacts.js';
import { outcomeStatus, type ReviewSnapshot } from '../../modules/chief-of-staff/strategy/review.js';

let admin: pg.Client;
const scopes: string[] = [];
before(async () => {
  admin = await connectFixtureDatabase(process.env, 'migration');
  assert.equal((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked, true);
  await migrate(admin, fixtureRuntimeUser());
});
after(async () => {
  if (!admin) return;
  await admin.query('BEGIN');
  try {
    await admin.query('SET CONSTRAINTS ALL DEFERRED');
    await admin.query('UPDATE cos.sources SET current_revision_id=NULL WHERE scope_id=ANY($1)', [scopes]);
    for (const table of [
      'strategy_review_results',
      'strategy_review_snapshots',
      'strategy_observations',
      'review_charters',
      'review_charter_revisions',
      'derivation_links',
      'evidence_refs',
      'chunks',
      'revocation_tombstones',
      'source_revisions',
      'sources',
      'artifacts',
      'outbox',
      'events',
      'operations',
      'proposals',
      'records',
      'scopes',
    ])
      await admin.query(
        'DELETE FROM cos.' + table + ' WHERE ' + (table === 'scopes' ? 'id' : 'scope_id') + '=ANY($1)',
        [scopes],
      );
    await admin.query('COMMIT');
  } catch (error) {
    await admin.query('ROLLBACK');
    throw error;
  } finally {
    await admin.end();
  }
});

for (const evolution of ['revised', 'deselected', 'revoked', 'deleted', 'capped-revised'] as const)
  test(`S10 fresh reviews omit ${evolution} historical evidence without losing immutable observations`, async (t) => {
    const revised = evolution === 'revised' || evolution === 'capped-revised';
    if (evolution === 'capped-revised') {
      // All approvals use the real store. Deterministic UUID ordering places every retired
      // observation before the new one, so the regression cannot pass by random chance.
      const prefix = randomUUID().slice(0, 24);
      let sequence = 0;
      const controlled = t.mock.method(
        crypto,
        'randomUUID',
        () => prefix + (++sequence).toString(16).padStart(12, '0'),
      );
      syncBuiltinESMExports();
      t.after(() => {
        controlled.mock.restore();
        syncBuiltinESMExports();
      });
    }
    const scope = 'strategy-evolution-' + randomUUID();
    scopes.push(scope);
    const context: KnowledgeContext = {
      scopeId: scope,
      ownerId: 'fixture-owner',
      agentGroupId: scope,
      sessionId: scope,
      ingressId: randomUUID(),
      provider: 'codex',
      generation: randomUUID(),
    };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-strategy-evolution-'));
    for (const name of ['staging', 'artifacts']) fs.mkdirSync(path.join(root, name), { mode: 0o700 });
    const database = BoundedDatabase.fromConfig(await fixtureDatabaseConfig());
    const knowledge = new KnowledgeStore(
      database,
      new KnowledgeArtifacts(path.join(root, 'artifacts'), path.join(root, 'staging')),
    );
    const store = new PriorityStore(database, knowledge);
    const collector = new ReviewCollector({ database, knowledge, work: store.work });
    const reviews = new ReviewArtifacts(collector);
    async function approve(change: ProposalChange, authority = context) {
      const proposal = await store.propose(authority, randomUUID(), change, authority);
      assert.equal(proposal.status, 'ok');
      assert.equal(
        (
          await store.decide(
            { ...authority, ingressId: randomUUID() },
            String(proposal.proposal_id),
            String(proposal.confirmation_token),
            'approve',
          )
        ).status,
        'ok',
      );
      const result = await store.apply(scope, String(proposal.proposal_id));
      assert.equal(result.status, 'ok');
      return result;
    }
    try {
      await admin.query(
        "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'fixture-owner','fixture',$1,$1,'active')",
        [scope],
      );
      const project = String(
        (
          await approve({
            kind: 'project',
            title: 'Current strategy',
            description: '',
            lifecycle: 'active',
            reason: 'Fixture direction',
            expected_version: 0,
          })
        ).record_id,
      );
      const sourceKey = randomUUID(),
        filename = randomUUID() + '.md';
      fs.writeFileSync(path.join(root, 'staging', filename), 'Original synthetic outcome evidence.', { mode: 0o600 });
      const imported = await knowledge.importSource(context, randomUUID(), {
        sourceKey,
        filename,
        title: 'Synthetic observation',
        processingProviders: ['codex'],
        expectedVersion: 0,
      });
      assert.equal(imported.status, 'ok');
      const source = String(imported.source_id);
      const now = (await admin.query('SELECT clock_timestamp() AS now')).rows[0].now as Date;
      const definition: ReviewCharterDefinition = {
        title: 'Current evidence review',
        initiative_ids: [project],
        source_ids: [source],
        starts_at: new Date(now.getTime() - 86400000).toISOString(),
        ends_at: new Date(now.getTime() + 86400000).toISOString(),
        cadence: 'manual',
        resource_constraints: 'One hour',
        evidence_limits: 'Synthetic fixture only',
        exploration_minutes_per_week: 0,
        measures: [
          { id: 'result', initiative_id: project, outcome: 'Useful result', test: 'Observed evidence' },
          { id: 'reported', initiative_id: project, outcome: 'Owner report', test: 'Ask owner' },
        ],
        assumptions: [],
      };
      await approve({ kind: 'review_charter', expected_version: 0, reason: 'Fixture review', definition });
      const found = await knowledge.search(context, { query: 'Original', sourceId: source });
      assert.equal(found.status, 'ok');
      const evidence = (found.items as Evidence[])[0];
      assert.ok(evidence);
      const canary = 'RetiredObservationPrivateCanary-' + evolution;
      const observation = {
        kind: 'strategy_observation' as const,
        charter_version: 1,
        initiative_id: project,
        target: { kind: 'outcome' as const, id: 'result' },
        basis: 'evidence_backed' as const,
        signal: 'supported' as const,
        statement: canary,
        observed_at: new Date(now.getTime() - 1000).toISOString(),
        evidence: [{ kind: 'source' as const, evidence_id: evidence.evidence_id }],
        reason: 'Retired rationale ' + canary,
      };
      await approve(observation);
      await approve({
        ...observation,
        target: { kind: 'outcome', id: 'reported' },
        basis: 'self_reported',
        evidence: [],
        statement: 'Current owner report',
        reason: 'Fixture report',
      });
      if (evolution === 'capped-revised')
        for (let index = 0; index < 24; index++)
          await approve({ ...observation, reason: 'Retired approved observation ' + index });
      const retained = (
        await admin.query('SELECT id,body,digest FROM cos.strategy_observations WHERE scope_id=$1 ORDER BY id', [scope])
      ).rows;
      const old = await reviews.request(context, randomUUID(), { charter_version: 1, previous_review_id: null });
      assert.equal(old.status, 'ok');
      assert.equal(outcomeStatus(old.snapshot as ReviewSnapshot, project, 'result'), 'evidence_backed');
      const oldRefs = (
        await admin.query(
          'SELECT version_refs FROM cos.strategy_review_snapshots WHERE scope_id=$1 AND id=$2 AND revision=1',
          [scope, old.review_id],
        )
      ).rows[0].version_refs;
      let version = 1;
      if (revised) {
        fs.writeFileSync(path.join(root, 'staging', filename), 'Revised synthetic outcome evidence.', { mode: 0o600 });
        assert.equal(
          (
            await knowledge.importSource(context, randomUUID(), {
              sourceKey,
              filename,
              title: 'Synthetic observation',
              processingProviders: ['codex'],
              expectedVersion: 1,
            })
          ).status,
          'ok',
        );
      } else if (evolution === 'revoked' || evolution === 'deleted') {
        await approve({ kind: 'source_revoke', source_id: source, expected_version: 1, reason: 'Fixture withdrawal' });
      }
      if (evolution !== 'deselected') {
        // Real host context retirement is independently tested. A stale generation must remain fenced.
        assert.equal(
          (
            await collector.collect(
              context,
              { charter_version: 1, previous_review_id: null },
              { review_id: 'review-' + digest(randomUUID()), revision: 1, previous: null },
            )
          ).status,
          'denied',
        );
      }
      const fresh = { ...context, generation: randomUUID(), ingressId: randomUUID() };
      if (!revised) {
        if (evolution !== 'deselected')
          assert.equal(
            (
              await collector.collect(
                fresh,
                { charter_version: 1, previous_review_id: null },
                { review_id: 'review-' + digest(randomUUID()), revision: 1, previous: null },
              )
            ).status,
            'denied',
          );
        await approve(
          {
            kind: 'review_charter',
            expected_version: 1,
            reason: 'Review without withdrawn evidence',
            definition: { ...definition, source_ids: [] },
          },
          fresh,
        );
        version = 2;
      }
      if (evolution === 'deleted') {
        await approve(
          { kind: 'source_delete', source_id: source, expected_version: 2, reason: 'Fixture retention' },
          fresh,
        );
        await admin.query(
          "UPDATE cos.revocation_tombstones SET purge_after=clock_timestamp()-interval '1 second' WHERE scope_id=$1 AND source_id=$2",
          [scope, source],
        );
        knowledge.hooks.purgeContexts = async () => ({ status: 'ok' });
        assert.equal((await knowledge.purgeDue(scope)).status, 'ok');
      }
      const id = randomUUID(),
        request = { charter_version: version, previous_review_id: null };
      const result = await reviews.request(fresh, id, request);
      assert.equal(result.status, 'ok');
      const snapshot = result.snapshot as ReviewSnapshot;
      assert.equal(snapshot.coverage, 'limited');
      assert.equal(snapshot.truncated, true);
      assert.equal(outcomeStatus(snapshot, project, 'result'), 'unknown');
      assert.equal(outcomeStatus(snapshot, project, 'reported'), version === 1 ? 'self_reported' : 'unknown');
      assert.equal(snapshot.observations.length, 1);
      assert.equal(snapshot.observations[0].basis, 'self_reported');
      assert.equal(snapshot.observations[0].statement, 'Current owner report');
      assert.equal(JSON.stringify(result).includes(canary), false);
      assert.equal(JSON.stringify(result).includes(evidence.evidence_id), false);
      assert.deepEqual(await reviews.request(fresh, id, request), result);
      assert.deepEqual(
        (
          await admin.query('SELECT id,body,digest FROM cos.strategy_observations WHERE scope_id=$1 ORDER BY id', [
            scope,
          ])
        ).rows,
        retained,
      );
      assert.equal(
        await database.run((client) =>
          collector.validateSnapshot(client, fresh, old.snapshot as ReviewSnapshot, oldRefs),
        ),
        false,
      );
      assert.equal(
        (await reviews.request({ ...fresh, ownerId: 'wrong-owner' }, randomUUID(), request)).status,
        'denied',
      );
      assert.equal(
        (
          await reviews.request(
            { ...fresh, origin: { kind: 'schedule', runId: randomUUID(), generation: 1 } },
            randomUUID(),
            request,
          )
        ).status,
        'denied',
      );
      if (revised) {
        const currentEvidence = await knowledge.search(fresh, { query: 'Revised', sourceId: source });
        assert.equal(currentEvidence.status, 'ok');
        const currentObservation = await approve(
          {
            ...observation,
            statement: 'New verified outcome',
            reason: 'Current fixture outcome evidence',
            evidence: [{ kind: 'source', evidence_id: (currentEvidence.items as Evidence[])[0].evidence_id }],
          },
          fresh,
        );
        const current = await reviews.request(fresh, randomUUID(), request);
        if (evolution === 'capped-revised') {
          const beforeNew = await admin.query(
            "SELECT count(*)::int AS n FROM cos.strategy_observations WHERE scope_id=$1 AND id<$2::uuid AND body->>'statement'=$3",
            [scope, currentObservation.record_id, canary],
          );
          assert.equal(beforeNew.rows[0].n, 25);
        }
        assert.equal(current.status, 'ok');
        assert.equal(outcomeStatus(current.snapshot as ReviewSnapshot, project, 'result'), 'evidence_backed');
        assert.equal(JSON.stringify(current).includes(canary), false);
        if (evolution === 'capped-revised') {
          for (let index = 0; index < 19; index++)
            await approve(
              {
                ...observation,
                statement: 'Current verified outcome ' + index,
                reason: 'Current approved evidence',
                evidence: [{ kind: 'source', evidence_id: (currentEvidence.items as Evidence[])[0].evidence_id }],
              },
              fresh,
            );
          const filled = await reviews.request(fresh, randomUUID(), request);
          assert.equal(filled.status, 'ok');
          const fullSnapshot = filled.snapshot as ReviewSnapshot;
          assert.equal(fullSnapshot.observations.length, 20);
          assert(fullSnapshot.observations.every((row) => row.basis === 'evidence_backed'));
          assert.equal(fullSnapshot.coverage, 'limited');
          assert.equal(JSON.stringify(filled).includes(canary), false);
          assert.deepEqual(
            (
              await admin.query(
                'SELECT id,body,digest FROM cos.strategy_observations WHERE scope_id=$1 AND id=ANY($2::uuid[]) ORDER BY id',
                [scope, retained.map((row) => row.id)],
              )
            ).rows,
            retained,
          );
        }
      }
    } finally {
      await database.pool.end();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
