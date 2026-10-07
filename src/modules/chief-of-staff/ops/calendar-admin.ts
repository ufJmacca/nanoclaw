/** Owner-run calendar controls; never exposed through model RPC or a message body. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { connectCosHostStore } from '../host-store.js';
import { openKnowledgeArtifacts } from '../knowledge/config.js';
import { CalendarStore, type CalendarConnection } from '../calendar/store.js';
import { CalendarEvidence } from '../calendar/evidence.js';
import { CalendarConnector } from '../calendar/connector.js';
import { calendarSettings, openCalendarCredentials, openCalendarFences } from '../calendar/config.js';
import { backupCalendarState } from '../calendar/backup.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import type { OAuthTransport } from '../calendar/oauth.js';
import {
  hasCalendarControl,
  object,
  snapshotWindow,
  validateCalendarWindow,
  type CalendarWindow,
} from '../calendar/normalization.js';
import { writeAtomic } from './target-state.js';

export type CalendarAdminArguments =
  | { command: 'calendar-status'; scopeId: string; offset: number }
  | { command: 'calendar-sync'; scopeId: string; bindingId: string; requestId: string; manifestFile: string }
  | { command: 'calendar-disconnect'; scopeId: string; bindingId: string; requestId: string };
type SyncInput = { calendarId: string; window?: CalendarWindow };
export {
  readJson as readCalendarAdminJson,
  childDirectory as calendarAdminDirectory,
  operation as calendarAdminOperation,
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isCalendarCommand(args: { command: string }): args is CalendarAdminArguments {
  return ['calendar-status', 'calendar-sync', 'calendar-disconnect'].includes(args.command);
}
export function parseCalendarArguments(args: string[]): CalendarAdminArguments {
  const invalid = () => new Error('invalid_admin_arguments');
  if (!isCalendarCommand({ command: args[0] }) || args.length % 2 !== 1) throw invalid();
  const allowed =
    args[0] === 'calendar-status'
      ? ['--scope', '--offset']
      : ['--scope', '--binding', '--request-id', ...(args[0] === 'calendar-sync' ? ['--manifest'] : [])];
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'];
  if (!scopeId || !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId)) throw invalid();
  if (args[0] === 'calendar-status') {
    const offset = values['--offset'] ?? '0';
    if (!/^(0|[1-9][0-9]{0,4})$/.test(offset) || Number(offset) > 10000) throw invalid();
    return { command: 'calendar-status', scopeId, offset: Number(offset) };
  }
  const bindingId = values['--binding'],
    requestId = values['--request-id'];
  if (!bindingId || !requestId || !uuid.test(bindingId) || !uuid.test(requestId)) throw invalid();
  if (args[0] === 'calendar-disconnect') return { command: 'calendar-disconnect', scopeId, bindingId, requestId };
  const manifestFile = values['--manifest'];
  if (
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'calendar-sync', scopeId, bindingId, requestId, manifestFile };
}
export function parseCalendarSync(value: unknown): SyncInput {
  try {
    if (
      !object(value) ||
      Object.keys(value).some((key) => !['calendarId', 'window'].includes(key)) ||
      typeof value.calendarId !== 'string' ||
      !value.calendarId ||
      value.calendarId.length > 1024 ||
      hasCalendarControl(value.calendarId) ||
      value.calendarId.includes(' ') ||
      ['.', '..'].includes(value.calendarId)
    )
      throw new Error('invalid');
    if (value.window !== undefined) validateCalendarWindow(value.window as CalendarWindow);
    return structuredClone(value) as SyncInput;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Invalid private input must not leak through a nested cause.
    throw new Error('invalid_calendar_manifest');
  }
}
/** Private bounded regular files only; never block on pipes or follow symbolic/hard links. */
function readJson(file: string): unknown {
  if (!path.isAbsolute(file) || fs.realpathSync(file) !== file) throw new Error('unsafe_calendar_admin_state');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o777) !== 0o600 ||
      stat.size > 16384
    )
      throw new Error('unsafe_calendar_admin_state');
    const bytes = Buffer.alloc(16385);
    let size = 0;
    while (size < bytes.length) {
      const n = fs.readSync(fd, bytes, size, bytes.length - size, size);
      if (!n) break;
      size += n;
    }
    const after = fs.fstatSync(fd);
    if (size !== stat.size || size > 16384 || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs)
      throw new Error('unsafe_calendar_admin_state');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } finally {
    fs.closeSync(fd);
  }
}
function privateDirectory(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700 ||
    fs.realpathSync(root) !== root
  )
    throw new Error('unsafe_calendar_admin_state');
}
function childDirectory(parent: string, name: string): string {
  privateDirectory(parent);
  const root = path.join(parent, name);
  if (!fs.lstatSync(root, { throwIfNoEntry: false })) fs.mkdirSync(root, { mode: 0o700 });
  privateDirectory(root);
  const fd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return root;
}
/** Only hashes and a frozen time window go in the operation journal. No event/token/client bytes. */
function operation(
  roots: CalendarStorageRoots,
  requestId: string,
  request: unknown,
  makeWindow?: () => CalendarWindow,
) {
  const root = childDirectory(childDirectory(roots.targetRoot, 'calendar-admin'), requestId);
  const file = path.join(root, 'request.json'),
    requestDigest = digest(request);
  let record: { contract: 'cos-calendar-admin/v1'; requestDigest: string; window: CalendarWindow | null };
  if (fs.lstatSync(file, { throwIfNoEntry: false })) {
    const existing = readJson(file);
    if (
      !object(existing) ||
      Object.keys(existing).sort().join(',') !== 'contract,requestDigest,window' ||
      existing.contract !== 'cos-calendar-admin/v1' ||
      existing.requestDigest !== requestDigest ||
      (makeWindow ? existing.window === null : existing.window !== null)
    )
      throw new Error('calendar_operation_conflict');
    if (existing.window !== null) validateCalendarWindow(existing.window as CalendarWindow);
    record = existing as typeof record;
  } else {
    if (fs.readdirSync(root).length) throw new Error('unsafe_calendar_admin_state');
    record = { contract: 'cos-calendar-admin/v1', requestDigest, window: makeWindow?.() ?? null };
  }
  writeAtomic(root, 'request.json', record);
  return { root, window: record.window };
}
/** Caller holds target, maintenance and host leases and verifies a paused private native binding. */
export async function runCalendarAdmin(
  options: {
    args: CalendarAdminArguments;
    env: NodeJS.ProcessEnv;
    roots: CalendarStorageRoots;
    binding: CosBinding;
    check(): Promise<void>;
    assertAuthority(): void;
  },
  dependencies: {
    inspect?: StorageInspection;
    memory?: () => void;
    fetch?: OAuthTransport['fetch'];
    connect?: typeof connectCosHostStore;
    artifacts?: typeof openKnowledgeArtifacts;
  } = {},
): Promise<Record<string, unknown>> {
  const { args, binding, roots } = options;
  if (args.scopeId !== binding.scopeId) throw new Error('context_binding_changed');
  await options.check();
  const enabled = calendarSettings(options.env).enabled;
  if (args.command === 'calendar-sync' && !enabled) throw new Error('calendar_disabled');
  let input: SyncInput | undefined;
  if (args.command === 'calendar-sync') {
    try {
      input = parseCalendarSync(readJson(args.manifestFile));
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Manifest paths and content are private.
      throw new Error('invalid_calendar_manifest');
    }
  }
  const fences = openCalendarFences(roots, dependencies.inspect);
  let journal: ReturnType<typeof operation> | undefined;
  const backup = async (phase: 'before' | 'after') => {
    if (!journal || args.command === 'calendar-status') throw new Error('unsafe_calendar_admin_state');
    await options.check();
    await backupCalendarState({
      roots,
      operationId: 'admin-' + args.requestId + '-' + phase,
      receiptRoot: childDirectory(journal.root, phase),
      check: options.check,
      inspect: dependencies.inspect,
      memory: dependencies.memory,
    });
  };
  // Native ownership is already checked. A deny-only local tombstone must survive even an unavailable database.
  if (args.command === 'calendar-disconnect') {
    journal = operation(roots, args.requestId, { command: args.command, binding, bindingId: args.bindingId });
    options.assertAuthority();
    fences.deny(binding.scopeId, args.bindingId, 'disconnected');
  }
  const context = {
    scopeId: binding.scopeId,
    ownerId: binding.ownerId,
    agentGroupId: binding.agentGroupId,
    sessionId: binding.sessionId,
    provider: binding.provider,
    ingressId: 'owner-calendar-' + (args.command === 'calendar-status' ? randomUUID() : args.requestId),
  };
  const base = { scope_id: binding.scopeId, paused: true, live_model: 'not_invoked' };
  const admitted = () => {
    options.assertAuthority();
    return true;
  };
  try {
    // Admin disconnect/status remain possible with refresh disabled or unusable OAuth credentials.
    const host = await (dependencies.connect ?? connectCosHostStore)(
      { ...options.env, COS_CALENDAR_ENABLED: 'false' },
      roots,
      admitted,
    );
    try {
      await options.check();
      const store = new CalendarStore(
        host.database,
        {},
        new CalendarEvidence(
          (dependencies.artifacts ?? openKnowledgeArtifacts)(roots.targetRoot, [
            roots.installationRoot,
            roots.dataRoot,
          ]),
        ),
      );
      if (args.command === 'calendar-status') {
        const result = await store.coverage(context, args.offset);
        await options.check();
        if (result.status !== 'ok') return { ...base, status: result.status };
        const items = (result.items as Record<string, unknown>[]).map((item) => {
          let local_access = 'available';
          try {
            fences.assertOpen(binding.scopeId, String(item.binding_id));
          } catch {
            local_access = 'unavailable';
          }
          return { ...item, local_access };
        });
        return { ...base, status: 'ok', items, next_offset: result.next_offset, refresh_enabled: enabled };
      }
      if (args.command === 'calendar-disconnect') {
        const result = await new CalendarConnector({ store, fences, admitted }).disconnect(context, args.bindingId);
        await options.check();
        return { ...base, status: result.status, binding_id: args.bindingId, local_access: 'denied' };
      }
      const selected = await store.connection(context, args.bindingId);
      if (selected.status !== 'ok') return { ...base, status: selected.status };
      const connection = selected.binding as CalendarConnection;
      if (
        connection.provider !== 'google' ||
        connection.auth !== 'ready' ||
        !connection.calendarIds.includes(input!.calendarId) ||
        !connection.processingProviders.includes(context.provider) ||
        (input!.window && input!.window.timeZone !== connection.timeZone)
      )
        return { ...base, status: 'denied' };
      fences.assertOpen(binding.scopeId, args.bindingId);
      journal = operation(
        roots,
        args.requestId,
        { command: args.command, binding, connection, input },
        () => input!.window ?? snapshotWindow(new Date(Date.now()).toISOString(), connection.timeZone),
      );
      await backup('before');
      const owner = openCalendarCredentials(roots, dependencies.inspect, dependencies.memory);
      await options.check();
      const connector = new CalendarConnector({ store, ...owner, admitted, fetch: dependencies.fetch });
      const refreshed = await connector.refresh(
        context,
        args.bindingId,
        input!.calendarId,
        args.requestId,
        journal.window!,
      );
      await backup('after');
      await options.check();
      // Prepared snapshot bytes and provider response details never enter terminal output or admin receipts.
      return { ...base, status: refreshed.result.status, snapshot_id: args.requestId };
    } finally {
      await host.database.pool.end();
    }
  } finally {
    if (args.command === 'calendar-disconnect') await backup('after');
  }
}
