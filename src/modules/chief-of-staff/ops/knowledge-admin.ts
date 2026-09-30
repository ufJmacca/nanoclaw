/** Owner-selected local setup inputs, never model RPC arguments. */
import path from 'node:path';
import fs from 'node:fs';
import type Database from 'better-sqlite3';
import { purgeRetiredContexts } from './conversation-purge.js';
import { randomUUID } from 'node:crypto';
import type { CosBinding } from '../../../cos-boundary.js';
import type { ImportSource, InventoryPage } from '../knowledge/store.js';
import { validInventoryPage } from '../knowledge/store.js';
import { connectCosHostStore } from '../host-store.js';

export type KnowledgeAdminArguments =
  | { command: 'source-import'; scopeId: string; requestId: string; manifestFile: string }
  | { command: 'source-inventory'; scopeId: string; page: InventoryPage }
  | { command: 'source-reconcile' | 'source-purge'; scopeId: string };
const identifier = /^[a-zA-Z0-9_-]{1,128}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isKnowledgeCommand(args: { command: string }): args is KnowledgeAdminArguments {
  return ['source-import', 'source-inventory', 'source-reconcile', 'source-purge'].includes(args.command);
}
export function parseKnowledgeArguments(args: string[]): KnowledgeAdminArguments {
  const values: Record<string, string> = {};
  const allowed =
    args[0] === 'source-import'
      ? ['--scope', '--request-id', '--manifest']
      : args[0] === 'source-inventory'
        ? ['--scope', '--limit', '--after', '--status']
        : ['--scope'];
  const invalid = () => new Error('invalid_admin_arguments');
  if (!isKnowledgeCommand({ command: args[0] }) || args.length % 2 !== 1) throw invalid();
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'];
  if (!scopeId || !identifier.test(scopeId)) throw invalid();
  if (args[0] === 'source-import') {
    const requestId = values['--request-id'],
      manifestFile = values['--manifest'];
    if (
      !requestId ||
      !uuid.test(requestId) ||
      !manifestFile ||
      !path.isAbsolute(manifestFile) ||
      path.resolve(manifestFile) !== manifestFile ||
      /[\0\r\n]/.test(manifestFile)
    )
      throw invalid();
    return { command: 'source-import', scopeId, requestId, manifestFile };
  }
  if (args[0] === 'source-inventory') {
    if (values['--limit'] && !/^[1-9][0-9]{0,2}$/.test(values['--limit'])) throw invalid();
    const page = {
      ...(values['--limit'] ? { limit: Number(values['--limit']) } : {}),
      ...(values['--after'] ? { after: values['--after'] } : {}),
      ...(values['--status'] ? { status: values['--status'] } : {}),
    };
    if (!validInventoryPage(page)) throw invalid();
    return { command: 'source-inventory', scopeId, page };
  }
  return { command: args[0] as 'source-reconcile' | 'source-purge', scopeId };
}
export function parseSourceImport(value: unknown): ImportSource {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_source_manifest');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some(
      (key) => !['sourceKey', 'filename', 'title', 'processingProviders', 'expectedVersion', 'projectId'].includes(key),
    ) ||
    typeof v.sourceKey !== 'string' ||
    !identifier.test(v.sourceKey) ||
    typeof v.filename !== 'string' ||
    !/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,120}\.(md|txt)$/i.test(v.filename) ||
    typeof v.title !== 'string' ||
    !v.title.trim() ||
    v.title.length > 200 ||
    /\p{C}/u.test(v.title) ||
    !Array.isArray(v.processingProviders) ||
    v.processingProviders.length > 2 ||
    new Set(v.processingProviders).size !== v.processingProviders.length ||
    v.processingProviders.some((p) => !['codex', 'claude'].includes(p)) ||
    !Number.isSafeInteger(v.expectedVersion) ||
    Number(v.expectedVersion) < 0 ||
    (v.projectId !== undefined && (typeof v.projectId !== 'string' || !identifier.test(v.projectId)))
  )
    throw new Error('invalid_source_manifest');
  return v as ImportSource;
}
/** Bound the owner manifest separately from source bytes; never follow a link or wait on a pipe. */
export function readSourceManifest(file: string): ImportSource {
  try {
    if (!path.isAbsolute(file) || path.resolve(file) !== file || fs.realpathSync(file) !== file)
      throw new Error('invalid_source_manifest');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = fs.fstatSync(fd);
      if (
        !before.isFile() ||
        before.uid !== process.getuid?.() ||
        before.nlink !== 1 ||
        (before.mode & 0o777) !== 0o600 ||
        before.size > 8192
      )
        throw new Error('invalid_source_manifest');
      const bytes = Buffer.alloc(8193);
      let length = 0;
      while (length < bytes.length) {
        const n = fs.readSync(fd, bytes, length, bytes.length - length, length);
        if (!n) break;
        length += n;
      }
      const after = fs.fstatSync(fd);
      if (length > 8192 || length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new Error('invalid_source_manifest');
      return parseSourceImport(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))));
    } finally {
      fs.closeSync(fd);
    }
  } catch (cause) {
    throw new Error('invalid_source_manifest', { cause });
  }
}
/** The caller owns target/maintenance/host leases and verifies paused private membership. */
export async function runKnowledgeAdmin(options: {
  args: KnowledgeAdminArguments;
  env: NodeJS.ProcessEnv;
  roots: { targetRoot: string; installationRoot: string; dataRoot: string };
  binding: CosBinding;
  db: Database.Database;
  inbound?: Database.Database;
  check(): Promise<void>;
  assertAuthority(): void;
}): Promise<Record<string, unknown>> {
  const { args, binding } = options;
  if (args.scopeId !== binding.scopeId) throw new Error('context_binding_changed');
  await options.check();
  const input = args.command === 'source-import' ? readSourceManifest(args.manifestFile) : undefined;
  const store = await connectCosHostStore(
    options.env,
    options.roots,
    () => {
      options.assertAuthority();
      return true;
    },
    args.command === 'source-purge'
      ? {
          purgeContexts: async (job) => {
            if (job.scopeId !== binding.scopeId || !options.inbound) throw new Error('context_binding_changed');
            return purgeRetiredContexts({
              root: options.roots.targetRoot,
              db: options.db,
              inbound: options.inbound,
              binding,
              contexts: job.contexts,
              check: options.check,
              assertAuthority: options.assertAuthority,
            });
          },
        }
      : {},
  );
  try {
    await options.check();
    const knowledge = store.knowledge;
    if (!knowledge) throw new Error('knowledge_store_unavailable');
    const context = {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      agentGroupId: binding.agentGroupId,
      sessionId: binding.sessionId,
      ingressId: 'owner-import-' + (args.command === 'source-import' ? args.requestId : randomUUID()),
    };
    let result;
    if (args.command === 'source-import') result = await knowledge.importSource(context, args.requestId, input!);
    else if (args.command === 'source-inventory') result = await knowledge.inventory(context, args.page);
    else {
      const allowed = await knowledge.inventory(context, { limit: 1 });
      result =
        allowed.status === 'ok'
          ? args.command === 'source-purge'
            ? await knowledge.purgeDue(binding.scopeId)
            : await knowledge.reconcileArtifacts()
          : { status: allowed.status };
    }
    await options.check();
    return { ...result, scope_id: binding.scopeId, paused: true, live_model: 'not_invoked' };
  } finally {
    await store.database.pool.end();
  }
}
