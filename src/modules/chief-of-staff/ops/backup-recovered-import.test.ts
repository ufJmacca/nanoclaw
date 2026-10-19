import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type pg from 'pg';
import { expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { ActionWitness, initializeActionWitness } from '../actions/witness.js';
import { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { migrationStatus, SCHEMA_VERSION } from '../store/migrations.js';
import {
  connectFixtureDatabase,
  fixtureDatabaseConfig,
  fixtureProfile,
} from '../../../contracts/chief-of-staff/fixture-database.js';
import { databaseFingerprint } from './target-identity.js';
import {
  CHECKPOINT_TABLES,
  captureCoordinatedState,
  restoreRecoveredCoordinatedTestScope,
  type CoordinatedBackupOptions,
} from './coordinated-backup.js';
import { BackupQueue } from './backup-queue.js';
import { streamBackupArchive } from './backup-archive.js';
import { readBackupArchive } from './backup-archive-reader.js';
import { withPinnedBackupTestRestoreReservation } from './backup-test-restore-reservation.js';

it.runIf(process.env.COS_TEST_TARGET_ID !== undefined).each([false, true])(
  'uses the admitted separate PostgreSQL target for owned recovered import and retained-commit reconciliation (sameDatabase=%s)',
  async (sameDatabase) => {
    expect(fixtureProfile()).toBe('test');
    // Keep the two identities required by the compiled vault fixture's report.
    // Its admitted import also exercises verification beyond the session idle limit.
    const slowVerification = !sameDatabase;
    const admin = await connectFixtureDatabase(process.env, 'migration'),
      config = await fixtureDatabaseConfig(process.env, 'migration'),
      root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-owned-pg-import-')),
      sourceScope = 'recovered-source-' + randomUUID(),
      restoredScope = 'recovered-import-' + randomUUID(),
      foreignScope = 'recovered-foreign-' + randomUUID();
    fs.chmodSync(root, 0o700);
    let locked = false;
    let restoreClient: pg.Client | undefined;
    const created = new Set<string>();
    try {
      expect((await admin.query('SELECT pg_try_advisory_lock(73101002) AS locked')).rows[0].locked).toBe(true);
      locked = true;
      expect(await migrationStatus(admin)).toBe(SCHEMA_VERSION);
      await admin.query("SET TIME ZONE 'UTC'");
      for (const scope of [sourceScope, foreignScope]) {
        await admin.query(
          "INSERT INTO cos.scopes(id,owner_id,instance_id,channel_id,agent_group_id,status) VALUES($1,'owner','fixture',$1,$1,'active')",
          [scope],
        );
        created.add(scope);
        await admin.query(
          "INSERT INTO cos.records(id,scope_id,kind,title,description,lifecycle,version,provenance) VALUES($1,$2,'goal',$3,$3,'active',1,'{}')",
          ['record-' + scope, scope, 'SYNTHETIC_PRIVATE_' + scope],
        );
      }
      const preserved = async () =>
          (
            await admin.query(
              'SELECT to_jsonb(t) AS body FROM cos.records t WHERE scope_id=ANY($1::text[]) ORDER BY scope_id',
              [[sourceScope, foreignScope]],
            )
          ).rows,
        before = await preserved();
      const rows: Record<string, Record<string, unknown>[]> = Object.fromEntries(
        CHECKPOINT_TABLES.map((table) => [table, []]),
      );
      rows.scopes = (
        await admin.query('SELECT to_jsonb(t) AS body FROM cos.scopes t WHERE id=$1', [sourceScope])
      ).rows.map(({ body }) => ({
        ...body,
        id: restoredScope,
        channel_id: restoredScope,
        agent_group_id: restoredScope,
      }));
      rows.records = (
        await admin.query('SELECT to_jsonb(t) AS body FROM cos.records t WHERE scope_id=$1', [sourceScope])
      ).rows.map(({ body }) => ({ ...body, id: 'record-' + restoredScope, scope_id: restoredScope }));
      for (const name of ['artifacts', 'artifact-staging', 'receipt', 'queue-state'])
        fs.mkdirSync(root + '/' + name, { mode: 0o700 });
      const nativeFile = root + '/native.sqlite',
        native = new Database(nativeFile);
      native.exec(
        "CREATE TABLE messages(id,body); INSERT INTO messages VALUES(1,'NEWER_MESSAGE'); CREATE TABLE model_counters(consumed); INSERT INTO model_counters VALUES(4)",
      );
      native.close();
      fs.chmodSync(nativeFile, 0o600);
      const nativeBefore = fs.readFileSync(nativeFile),
        owner = initializeActionWitness(root + '/effects', digest('synthetic installation')),
        witness = new ActionWitness(root + '/effects', owner.installationDigest, owner.generation),
        journalBefore = fs.readFileSync(root + '/effects/owner.json');
      // Only the separately admitted real test database receives SQL. Source rows and
      // the foreign source fingerprint are code fixtures, not a production capture.
      const source = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.includes('SELECT owner_id,agent_group_id'))
            return { rows: [{ owner_id: 'owner', agent_group_id: restoredScope }] };
          if (sql.includes('to_jsonb(t)')) {
            const table = /FROM cos\."([a-z_]+)"/.exec(sql)?.[1];
            expect(table && CHECKPOINT_TABLES.includes(table)).toBe(true);
            return { rows: rows[table!].map((body) => ({ body })) };
          }
          return admin.query(sql, values);
        },
      } as unknown as pg.Client;
      const fingerprint = await databaseFingerprint(admin, config),
        operationId = randomUUID(),
        requestId = randomUUID(),
        options: CoordinatedBackupOptions = {
          client: source,
          context: {
            scopeId: restoredScope,
            ownerId: 'owner',
            agentGroupId: restoredScope,
            sessionId: restoredScope,
            ingressId: 'fixture',
          },
          databaseFingerprint: sameDatabase ? fingerprint : digest('explicit synthetic foreign-source transport'),
          operationId,
          receiptRoot: root + '/receipt',
          nativeDatabases: [nativeFile],
          restrictionFiles: [],
          witness,
          artifacts: new KnowledgeArtifacts(root + '/artifacts', root + '/artifact-staging'),
          quiescent: async () => ({
            generation: 1,
            activeWorkers: 0,
            activeOperations: 0,
            nativeWriters: 0,
            effectsEnabled: false,
          }),
        },
        queueOwner = digest('synthetic queue owner'),
        queue = new BackupQueue(queueOwner, async (_kind, use) => use(root + '/queue-state'));
      let checkpointDigest = '';
      await queue.capture(
        'state',
        operationId,
        async (sink) => {
          checkpointDigest = digest(await captureCoordinatedState(options, sink));
        },
        1024 ** 2,
      );
      const chunks: Buffer[] = [];
      await queue.withPending('state', operationId, async (directory, receipt) =>
        streamBackupArchive(directory, receipt, async (chunk) => {
          chunks.push(Buffer.from(chunk));
        }),
      );
      const archive = Buffer.concat(chunks),
        pendingBefore = await queue.pending('state'),
        archiveSha256 = createHash('sha256').update(archive).digest('hex');
      if (slowVerification) {
        restoreClient = await connectFixtureDatabase(process.env, 'migration');
        restoreClient.on('error', () => {});
        await restoreClient.query("SET TIME ZONE 'UTC'");
        await restoreClient.query("SET idle_in_transaction_session_timeout = '1s'");
      }
      const transport = restoreClient ?? admin,
        timeouts = async () => ({
          idle: (await transport.query('SHOW idle_in_transaction_session_timeout')).rows[0]
            .idle_in_transaction_session_timeout,
          statement: (await transport.query('SHOW statement_timeout')).rows[0].statement_timeout,
          lock: (await transport.query('SHOW lock_timeout')).rows[0].lock_timeout,
        }),
        originalTimeouts = await timeouts();
      let loseCommitAck = !sameDatabase,
        insertQueries = 0,
        inTransaction = false,
        verifiedSlowTransaction = false,
        rejectVerification = false;
      const sandboxClient = {
        query: async (sql: string, values?: unknown[]) => {
          if (sql.startsWith('INSERT INTO cos.')) insertQueries++;
          const result = await transport.query(sql, values);
          if (sql === 'BEGIN') inTransaction = true;
          if (sql === 'COMMIT' || sql === 'ROLLBACK') inTransaction = false;
          if (sql === 'COMMIT' && loseCommitAck) {
            loseCommitAck = false;
            throw Error('PRIVATE_ACTUAL_COMMIT_ACK_LOST');
          }
          return result;
        },
      } as unknown as pg.Client;
      const run = (request = requestId) =>
        queue.withRestoreWorkspace(
          request,
          () => {},
          async (scope) => {
            const data = {
                async *[Symbol.asyncIterator]() {
                  for (let offset = 0; offset < archive.length; offset += 65536)
                    yield Buffer.from(archive.subarray(offset, offset + 65536));
                },
              },
              recovered = await readBackupArchive(
                data,
                { ownerDigest: queueOwner, kind: 'state', operationId },
                scope.sink,
                scope.assertCurrent,
              ),
              stageFd = fs.openSync(root + '/queue-state', fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
            try {
              // Actual private files and writer are used. Vault/NAS/remote header
              // admission remain explicit fixture boundaries in this database test.
              return await withPinnedBackupTestRestoreReservation(
                '/proc/self/fd/' + stageFd,
                {
                  requestId: request,
                  targetDigest: owner.installationDigest,
                  repositoryId: digest('fixture repository'),
                  repositoryOwnerDigest: digest('fixture repository owner'),
                  queueOwnerDigest: queueOwner,
                  operationId,
                  snapshotId: digest('fixture remote snapshot'),
                  archiveSha256,
                  archiveBytes: archive.length,
                  snapshotDigest: digest('fixture full header'),
                  checkpointDigest,
                  sourceDatabaseFingerprint: options.databaseFingerprint,
                  scopeId: restoredScope,
                  journal: { installationDigest: owner.installationDigest, generation: owner.generation },
                },
                scope.assertCurrent,
                (port) =>
                  restoreRecoveredCoordinatedTestScope(
                    options,
                    scope,
                    recovered.receipt.files,
                    { client: sandboxClient, config, testTargetId: process.env.COS_TEST_TARGET_ID ?? '' },
                    port,
                    async () => {
                      if (slowVerification && inTransaction && !verifiedSlowTransaction) {
                        // Exercise an actual server idle timeout while the trusted
                        // verifier is working, using a separate fixture connection.
                        await new Promise((resolve) => setTimeout(resolve, 1250));
                        expect(await timeouts()).toEqual({ ...originalTimeouts, idle: '45min' });
                        verifiedSlowTransaction = true;
                      }
                      if (rejectVerification && inTransaction) throw Error('PRIVATE_VERIFICATION_REVOKED');
                    },
                  ),
              );
            } finally {
              fs.closeSync(stageFd);
            }
          },
        );
      await expect(run()).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
      const exists = (await admin.query('SELECT id FROM cos.scopes WHERE id=$1', [restoredScope])).rows.length > 0;
      if (exists) created.add(restoredScope);
      if (sameDatabase) {
        expect(exists).toBe(false);
        expect(insertQueries).toBe(0);
      } else {
        expect(exists).toBe(true);
        expect(await timeouts()).toEqual(originalTimeouts);
        if (slowVerification) {
          expect(verifiedSlowTransaction).toBe(true);
          expect(originalTimeouts.idle).toBe('1s');
        }
        // The sorted records table precedes scopes; its first FK attempt is
        // rolled back to the savepoint, then retried after the scope exists.
        expect(insertQueries).toBe(3);
        expect(
          (await admin.query('SELECT count(*)::integer AS n FROM cos.records WHERE scope_id=$1', [restoredScope]))
            .rows[0].n,
        ).toBe(1);
        const startFile = root + '/queue-state/.cos-test-restore-' + requestId + '.json',
          startBefore = fs.readFileSync(startFile);
        const checked = await run();
        expect(checked).toMatchObject({ inserted: false, admissionRestored: false, eventJournalRestored: false });
        expect(checked.sandboxDatabaseFingerprint).toBe(fingerprint);
        expect(fs.readFileSync(startFile)).toEqual(startBefore);
        expect(insertQueries).toBe(3);
        if (slowVerification) {
          rejectVerification = true;
          await expect(run()).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
          rejectVerification = false;
          expect(inTransaction).toBe(false);
          expect(await timeouts()).toEqual(originalTimeouts);
        }
        await expect(run(randomUUID())).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
        expect(insertQueries).toBe(3);
        await admin.query("UPDATE cos.records SET title='SYNTHETIC_CHANGED' WHERE scope_id=$1", [restoredScope]);
        await expect(run()).rejects.toThrow(/^backup_restore_workspace_unavailable$/);
        expect(insertQueries).toBe(3);
      }
      expect(await queue.pending('state')).toEqual(pendingBefore);
      expect(await preserved()).toEqual(before);
      expect(fs.readFileSync(nativeFile)).toEqual(nativeBefore);
      expect(fs.readFileSync(root + '/effects/owner.json')).toEqual(journalBefore);
      expect(fs.existsSync(root + '/receipt/coordinated')).toBe(false);
      expect(fs.readdirSync(root + '/queue-state').some((name) => name.startsWith('.cos-restore-'))).toBe(false);
    } finally {
      for (const scope of created) {
        expect(scope).toMatch(/^recovered-(source|foreign|import)-[a-f0-9-]{36}$/);
        await admin.query('DELETE FROM cos.records WHERE scope_id=$1', [scope]);
        await admin.query("DELETE FROM cos.scopes WHERE id=$1 AND owner_id='owner' AND agent_group_id=$1", [scope]);
      }
      try {
        if (locked) await admin.query('SELECT pg_advisory_unlock(73101002)');
      } finally {
        try {
          await restoreClient?.end();
        } finally {
          await admin.end();
          fs.rmSync(root, { recursive: true, force: true });
        }
      }
    }
  },
  30000,
);
