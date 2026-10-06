import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import { canonical, digest, type Context, type Result } from '../domain/contracts.js';
import { validAnswerCitation } from '../contracts/answer-protocol.js';
import { BoundedDatabase, DatabaseUnavailable } from '../store/client.js';
import type { KnowledgeArtifacts } from '../knowledge/artifacts.js';
import { withDeploymentLock } from './deployment-lock.js';
import { artifactHash } from './release-artifacts.js';
import { readPrivate, writeAtomic } from './target-state.js';
import { SCHEMA_VERSION } from '../store/migrations.js';

type ExportOptions = {
  database: BoundedDatabase;
  context: Context;
  provider: string;
  artifacts: KnowledgeArtifacts;
  root: string;
  requestId: string;
  /** Fresh native owner/binding/pause checks, including after every asynchronous boundary. */
  check(): Promise<void>;
};
type SourceRef = {
  source_id: string;
  source_version: number;
  revision_id: string;
  artifact_id: string;
  digest: string;
};
type ExportReceipt = {
  format: 'cos-owner-export-receipt/v1';
  contextDigest: string;
  requestId: string;
  file: string;
  sha256: string;
  sources: SourceRef[];
  exportedAt: string;
};
const maximumBytes = 16 * 1024 * 1024;
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const sourceSelection = `SELECT s.id AS source_id,s.version AS source_version,s.title,r.id AS revision_id,r.artifact_id,r.digest
 FROM cos.sources s JOIN cos.source_revisions r ON r.scope_id=s.scope_id AND r.source_id=s.id AND r.id=s.current_revision_id
 JOIN cos.artifacts a ON a.scope_id=r.scope_id AND a.id=r.artifact_id
 WHERE s.scope_id=$1 AND s.status IN ('current','stale') AND $2=ANY(s.processing_providers)
 AND s.provenance->>'origin'='selected_staging_file' AND s.access_policy='{"scope_owner_only":true}'::jsonb
 AND a.kind='source' AND a.lifecycle='published' AND a.digest=r.digest
 AND NOT EXISTS(SELECT 1 FROM cos.revocation_tombstones t WHERE t.scope_id=s.scope_id AND t.source_id=s.id)
 ORDER BY s.id LIMIT 101 FOR SHARE OF s,r,a`;
function identity(options: ExportOptions) {
  const { scopeId, ownerId, agentGroupId } = options.context;
  return digest({ scopeId, ownerId, agentGroupId, provider: options.provider });
}
function directory(root: string) {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw Error('unsafe_owner_export');
}
function privateFile(file: string) {
  const stat = fs.lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o600 ||
    fs.realpathSync(file) !== file
  )
    throw Error('unsafe_owner_export');
}
function parameters(options: ExportOptions) {
  if (
    options.context.origin ||
    !['codex', 'claude'].includes(options.provider) ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(options.context.scopeId) ||
    !new RegExp('^' + uuid + '$').test(options.requestId)
  )
    throw Error('invalid_owner_export');
  directory(options.root);
  const prefix = digest(options.context.scopeId) + '-' + options.requestId;
  return { file: prefix + '.export.json', receipt: prefix + '.receipt.json' };
}
function ownership(root: string) {
  const marker = path.join(root, '.cos-exports');
  if (!fs.lstatSync(marker, { throwIfNoEntry: false })) {
    if (fs.readdirSync(root).some((n) => n !== '.operation.lock')) throw Error('unowned_export_root');
    writeAtomic(root, '.cos-exports', { format: 'cos-owner-exports/v1' });
  }
  if (digest(readPrivate(marker)) !== digest({ format: 'cos-owner-exports/v1' })) throw Error('unowned_export_root');
}
async function authorised(client: PoolClient, options: ExportOptions) {
  const c = options.context;
  await options.check();
  const scope = await client.query(
    "SELECT id FROM cos.scopes WHERE id=$1 AND owner_id=$2 AND agent_group_id=$3 AND status IN ('active','paused') FOR SHARE",
    [c.scopeId, c.ownerId, c.agentGroupId],
  );
  await options.check();
  return scope.rowCount === 1;
}
async function sources(client: PoolClient, options: ExportOptions) {
  const result = await client.query(sourceSelection, [options.context.scopeId, options.provider]);
  await options.check();
  if (result.rows.length > 100) throw Error('owner_export_bounds');
  return result.rows as Array<SourceRef & { title: string }>;
}
function reference(source: SourceRef): SourceRef {
  const { source_id, source_version, revision_id, artifact_id, digest: hash } = source;
  return { source_id, source_version, revision_id, artifact_id, digest: hash };
}
async function guardedRun<T, Options extends ExportOptions>(
  options: Options,
  operation: (client: PoolClient, guarded: Options) => Promise<T>,
): Promise<T> {
  let active = true;
  const guarded = {
    ...options,
    check: async () => {
      if (!active) throw Error('owner_export_expired');
      await options.check();
      if (!active) throw Error('owner_export_expired');
    },
  };
  try {
    return await options.database.run((client) => operation(client, guarded), true);
  } finally {
    active = false;
  }
}
/** Owner-local portable records only. No model, provider tokens, ordinary NanoClaw histories or raw approval/effect payloads. */
export async function exportOwnerRecords(options: ExportOptions): Promise<Result> {
  try {
    const names = parameters(options);
    return await withDeploymentLock(path.join(options.root, '.operation.lock'), async () => {
      await options.check();
      return guardedRun(options, async (client, options) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        let committed = false;
        try {
          if (!(await authorised(client, options))) return { status: 'denied' };
          ownership(options.root);
          const selected = await sources(client, options);
          const records = (
            await client.query(
              'SELECT id,kind,title,description,lifecycle,version FROM cos.records WHERE scope_id=$1 ORDER BY id LIMIT 1001 FOR SHARE',
              [options.context.scopeId],
            )
          ).rows;
          await options.check();
          const work = (
            await client.query(
              'SELECT id,kind,state,title,description,project_id,due,defer_until,version,evidence FROM cos.work_items WHERE scope_id=$1 AND owner_id=$2 ORDER BY id LIMIT 1001 FOR SHARE',
              [options.context.scopeId, options.context.ownerId],
            )
          ).rows;
          await options.check();
          if (records.length > 1000 || work.length > 1000) throw Error('owner_export_bounds');
          const visibleWork: Record<string, unknown>[] = [];
          for (const row of work) {
            if (!Array.isArray(row.evidence) || row.evidence.length > 10 || !row.evidence.every(validAnswerCitation))
              throw Error('owner_export_invalid_evidence');
            let readable = true;
            for (const ref of row.evidence) {
              if (ref.kind === 'record')
                readable &&= records.some(
                  (r) => r.id === ref.record_id && r.version === ref.version && r.lifecycle === 'active',
                );
              else {
                const evidence = (
                  await client.query(
                    'SELECT source_id,revision_id,revision_digest,source_version FROM cos.evidence_refs WHERE scope_id=$1 AND id=$2',
                    [options.context.scopeId, ref.evidence_id],
                  )
                ).rows[0];
                await options.check();
                readable &&=
                  !!evidence &&
                  selected.some(
                    (s) =>
                      s.source_id === evidence.source_id &&
                      s.revision_id === evidence.revision_id &&
                      s.digest === evidence.revision_digest &&
                      s.source_version === evidence.source_version,
                  );
              }
            }
            if (readable) visibleWork.push(row);
          }
          const content: Array<Record<string, unknown>> = [];
          let length = Buffer.byteLength(canonical({ records, work: visibleWork }));
          for (const source of selected) {
            await options.check();
            const text = options.artifacts.read(source.artifact_id, source.digest);
            length += Buffer.byteLength(text);
            if (length > maximumBytes) throw Error('owner_export_bounds');
            content.push({
              source_id: source.source_id,
              source_version: source.source_version,
              revision_id: source.revision_id,
              title: source.title,
              text,
            });
          }
          const snapshot = {
            format: 'cos-owner-records/v1',
            schemaVersion: SCHEMA_VERSION,
            contextDigest: identity(options),
            records,
            work: visibleWork,
            sources: content,
            limitations: [
              'selected_staging_sources_only',
              'derived_artifacts_and_private_conversations_excluded',
              'already_delivered_copies_and_provider_or_backup_retention_are_independent',
            ],
          };
          const bytes = Buffer.from(canonical(snapshot)),
            hash = digest(snapshot);
          if (bytes.length > maximumBytes) throw Error('owner_export_bounds');
          const eventId = 'owner-export-' + digest({ scope: options.context.scopeId, request: options.requestId }),
            audit = { format: 'cos-owner-export-audit/v1', contextDigest: identity(options), sha256: hash };
          await client.query(
            "INSERT INTO cos.events(id,scope_id,kind,resource_id,version,provenance) VALUES($1,$2,'owner_export',$3,1,$4) ON CONFLICT DO NOTHING",
            [eventId, options.context.scopeId, options.requestId, JSON.stringify(audit)],
          );
          const event = (
            await client.query(
              "SELECT provenance,created_at FROM cos.events WHERE id=$1 AND scope_id=$2 AND kind='owner_export' AND resource_id=$3",
              [eventId, options.context.scopeId, options.requestId],
            )
          ).rows[0];
          await options.check();
          if (!event || digest(event.provenance) !== digest(audit)) return { status: 'conflict' };
          await client.query('COMMIT');
          committed = true;
          await options.check();
          // The audit is durable before local delivery. Reacquire current scope/source locks across publication;
          // the earlier snapshot cannot disclose a source revoked during the audit commit.
          await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
          committed = false;
          if (!(await authorised(client, options))) return { status: 'denied' };
          const current = await sources(client, options);
          if (digest(current.map(reference)) !== digest(selected.map(reference))) return { status: 'conflict' };
          const file = path.join(options.root, names.file);
          const receipt: ExportReceipt = {
            format: 'cos-owner-export-receipt/v1',
            contextDigest: identity(options),
            requestId: options.requestId,
            file: names.file,
            sha256: hash,
            sources: selected.map(reference),
            exportedAt: event.created_at.toISOString(),
          };
          directory(options.root);
          if (fs.lstatSync(file, { throwIfNoEntry: false })) {
            privateFile(file);
            if ((await artifactHash(file, maximumBytes)) !== hash) return { status: 'conflict' };
            await options.check();
          } else {
            // Retain an audited ownership record even if interrupted before local publication.
            writeAtomic(options.root, names.receipt, receipt);
            const fd = fs.openSync(
              file,
              fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
              0o600,
            );
            try {
              fs.writeFileSync(fd, bytes);
              fs.fsyncSync(fd);
            } finally {
              fs.closeSync(fd);
            }
          }
          // Sync the new directory entry as well as its file bytes.
          writeAtomic(options.root, names.receipt, receipt);
          await client.query('COMMIT');
          committed = true;
          return {
            status: 'ok',
            delivery: 'owner_local_only',
            file,
            sha256: hash,
            records: records.length,
            work: visibleWork.length,
            withheldWork: work.length - visibleWork.length,
            sources: selected.length,
          };
        } finally {
          if (!committed) await client.query('ROLLBACK');
        }
      });
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- A private local export is withheld on any unresolved authority, audit or publication error.
  } catch (error) {
    return {
      status: error instanceof DatabaseUnavailable && error.code === 'pending' ? 'pending' : 'unavailable',
      delivery: 'withheld',
    };
  }
}
/** Retire only checked application-owned export copies. This cannot retract copies the owner already took away. */
export async function purgeOwnerExports(options: ExportOptions & { retentionMs: number }): Promise<Result> {
  try {
    parameters(options);
    if (
      !Number.isSafeInteger(options.retentionMs) ||
      options.retentionMs < 0 ||
      options.retentionMs > 365 * 24 * 60 * 60 * 1000
    )
      return { status: 'denied' };
    return await withDeploymentLock(path.join(options.root, '.operation.lock'), async () => {
      return guardedRun(options, async (client, options) => {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        let committed = false;
        try {
          if (!(await authorised(client, options))) return { status: 'denied' };
          ownership(options.root);
          const selected = await sources(client, options),
            prefix = digest(options.context.scopeId) + '-',
            names = fs
              .readdirSync(options.root)
              .filter((n) => new RegExp('^' + prefix + uuid + '\\.receipt\\.json$').test(n));
          if (names.length > 1000) throw Error('owner_export_bounds');
          let removed = 0;
          for (const name of names) {
            const receipt = readPrivate<ExportReceipt>(path.join(options.root, name));
            privateFile(path.join(options.root, name));
            if (
              receipt.format !== 'cos-owner-export-receipt/v1' ||
              receipt.contextDigest !== identity(options) ||
              name !== prefix + receipt.requestId + '.receipt.json' ||
              receipt.file !== prefix + receipt.requestId + '.export.json' ||
              !/^[a-f0-9]{64}$/.test(receipt.sha256) ||
              !Array.isArray(receipt.sources) ||
              receipt.sources.length > 100 ||
              !Number.isFinite(Date.parse(receipt.exportedAt))
            )
              throw Error('owner_export_conflict');
            const revoked = receipt.sources.some((ref) => !selected.some((s) => digest(reference(s)) === digest(ref))),
              expired = Date.now() - Date.parse(receipt.exportedAt) >= options.retentionMs;
            if (!revoked && !expired) continue;
            const file = path.join(options.root, receipt.file);
            directory(options.root);
            if (fs.lstatSync(file, { throwIfNoEntry: false })) privateFile(file);
            if (
              fs.lstatSync(file, { throwIfNoEntry: false }) &&
              (await artifactHash(file, maximumBytes)) !== receipt.sha256
            )
              throw Error('owner_export_conflict');
            await options.check();
            if (fs.lstatSync(file, { throwIfNoEntry: false })) fs.unlinkSync(file);
            fs.unlinkSync(path.join(options.root, name));
            removed++;
          }
          await client.query('COMMIT');
          committed = true;
          const fd = fs.openSync(
            options.root,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
          );
          try {
            fs.fsyncSync(fd);
          } finally {
            fs.closeSync(fd);
          }
          return { status: 'ok', removed, delivery: 'owner_local_only', externalCopies: 'not_retracted' };
        } finally {
          if (!committed) await client.query('ROLLBACK');
        }
      });
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- Retention failures preserve unknown files and never expose private export content.
  } catch {
    return { status: 'unavailable', delivery: 'withheld' };
  }
}
