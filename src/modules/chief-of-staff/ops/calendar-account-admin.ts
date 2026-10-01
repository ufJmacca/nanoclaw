import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { connectCosHostStore } from '../host-store.js';
import { CalendarStore } from '../calendar/store.js';
import { CalendarCredentialOwner } from '../calendar/credentials.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import {
  configureCalendarStorage,
  verifyCalendarStorage,
  type CalendarStorageRoots,
} from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { backupCalendarState } from '../calendar/backup.js';
import { openCalendarCredentials } from '../calendar/config.js';
import { checkedClient, type GoogleOAuthClient, type OAuthTransport } from '../calendar/oauth.js';
import { startCalendarAuthorization } from '../calendar/oauth-listener.js';
import { calendarZone, hasCalendarControl, object } from '../calendar/normalization.js';
import {
  readCalendarAdminJson as readJson,
  calendarAdminDirectory as directory,
  calendarAdminOperation as operation,
} from './calendar-admin.js';
import { writeAtomic } from './target-state.js';

export type CalendarAccountArguments =
  | { command: 'calendar-setup'; scopeId: string; requestId: string; backupRoot: string }
  | { command: 'calendar-link'; scopeId: string; requestId: string; bindingId: string; manifestFile: string };
type Selection = { calendarIds: string[]; timeZone: string; processingProviders: string[] };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isCalendarAccountCommand(args: { command: string }): args is CalendarAccountArguments {
  return ['calendar-setup', 'calendar-link'].includes(args.command);
}
export function parseCalendarAccountArguments(args: string[]): CalendarAccountArguments {
  const invalid = () => new Error('invalid_admin_arguments');
  if (!isCalendarAccountCommand({ command: args[0] }) || args.length % 2 !== 1) throw invalid();
  const allowed = [
    '--scope',
    '--request-id',
    ...(args[0] === 'calendar-setup' ? ['--backup-root'] : ['--binding', '--manifest']),
  ];
  const values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'];
  const file = values[args[0] === 'calendar-setup' ? '--backup-root' : '--manifest'];
  if (
    !scopeId ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId) ||
    !requestId ||
    !uuid.test(requestId) ||
    !file ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    /[\0\r\n]/.test(file)
  )
    throw invalid();
  if (args[0] === 'calendar-setup') return { command: 'calendar-setup', scopeId, requestId, backupRoot: file };
  const bindingId = values['--binding'];
  if (!bindingId || !uuid.test(bindingId)) throw invalid();
  return { command: 'calendar-link', scopeId, requestId, bindingId, manifestFile: file };
}
export function parseCalendarSelection(value: unknown): Selection {
  try {
    if (
      !object(value) ||
      Object.keys(value).sort().join(',') !== 'calendarIds,processingProviders,timeZone' ||
      !Array.isArray(value.calendarIds) ||
      value.calendarIds.length < 1 ||
      value.calendarIds.length > 20 ||
      new Set(value.calendarIds).size !== value.calendarIds.length ||
      value.calendarIds.some(
        (id) =>
          typeof id !== 'string' ||
          !id ||
          id.length > 1024 ||
          hasCalendarControl(id) ||
          id.includes(' ') ||
          ['.', '..'].includes(id),
      ) ||
      !Array.isArray(value.processingProviders) ||
      value.processingProviders.length < 1 ||
      value.processingProviders.length > 2 ||
      new Set(value.processingProviders).size !== value.processingProviders.length ||
      value.processingProviders.some((provider) => !['codex', 'claude'].includes(provider))
    )
      throw new Error('invalid');
    calendarZone(value.timeZone);
    return structuredClone(value) as Selection;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Do not expose selected account/calendar identifiers through validation errors.
    throw new Error('invalid_calendar_manifest');
  }
}
type Options = {
  args: CalendarAccountArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  check(): Promise<void>;
  assertAuthority(): void;
};
/** Code-only fixture seams; no environment variable or CLI argument can bypass production storage or transport. */
type Dependencies = {
  connect?: typeof connectCosHostStore;
  inspect?: StorageInspection;
  fetch?: OAuthTransport['fetch'];
  display?(authorizationUrl: string): void | Promise<void>;
};
type Setup = {
  contract: 'cos-calendar-setup/v1';
  clientDigest: string;
  storageDigest: string;
  phase: 'initializing' | 'ready';
};
function clientAt(roots: CalendarStorageRoots): GoogleOAuthClient {
  try {
    return checkedClient(readJson(path.join(roots.targetRoot, 'calendar', 'oauth-client.json')) as GoogleOAuthClient);
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Client material remains in the protected file; no nested parse error.
    throw new Error('calendar_configuration_unavailable');
  }
}
function setupState(
  roots: CalendarStorageRoots,
  client: GoogleOAuthClient,
  inspect?: StorageInspection,
): { expected: Omit<Setup, 'phase'>; existing: Setup | null } {
  const policy = verifyCalendarStorage(roots, inspect);
  const expected = {
    contract: 'cos-calendar-setup/v1' as const,
    clientDigest: digest(client),
    storageDigest: digest(policy),
  };
  const file = path.join(roots.targetRoot, 'calendar-setup.json');
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return { expected, existing: null };
  const value = readJson(file);
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'clientDigest,contract,phase,storageDigest' ||
    !['initializing', 'ready'].includes(String(value.phase)) ||
    digest({ contract: value.contract, clientDigest: value.clientDigest, storageDigest: value.storageDigest }) !==
      digest(expected)
  )
    throw new Error('calendar_setup_conflict');
  return { expected, existing: value as Setup };
}
async function configure(
  o: Options & { args: Extract<CalendarAccountArguments, { command: 'calendar-setup' }> },
  d: Dependencies,
) {
  const { roots, args } = o;
  configureCalendarStorage(roots, args.backupRoot, d.inspect);
  const client = clientAt(roots),
    { expected, existing } = setupState(roots, client, d.inspect);
  if (!existing) writeAtomic(roots.targetRoot, 'calendar-setup.json', { ...expected, phase: 'initializing' });
  const journal = operation(roots, args.requestId, { command: args.command, scopeId: args.scopeId, expected });
  const backup = async (phase: 'before' | 'after') =>
    backupCalendarState({
      roots,
      operationId: 'admin-' + args.requestId + '-' + phase,
      receiptRoot: directory(journal.root, phase),
      check: o.check,
      inspect: d.inspect,
    });
  await backup('before');
  await o.check();
  const root = path.join(roots.targetRoot, 'calendar');
  if (existing?.phase !== 'ready') {
    // Initialize only newly created directories. Existing directories with lost markers are never repaired.
    for (const name of ['credentials', 'access-denials']) {
      const child = path.join(root, name);
      if (!fs.lstatSync(child, { throwIfNoEntry: false })) {
        directory(root, name);
        if (name === 'credentials') CalendarCredentialOwner.initialize(child);
        else CalendarAccessFences.initialize(child);
      }
    }
  }
  openCalendarCredentials(roots, d.inspect);
  await backup('after');
  await o.check();
  if (digest(setupState(roots, clientAt(roots), d.inspect).expected) !== digest(expected))
    throw new Error('calendar_setup_conflict');
  writeAtomic(roots.targetRoot, 'calendar-setup.json', { ...expected, phase: 'ready' });
  return { status: 'configured_paused', scope_id: args.scopeId, paused: true, live_model: 'not_invoked' };
}
/** Explicit owner account action. Requires existing maintenance/private membership and leaves the coordinator paused. */
export async function runCalendarAccountAdmin(o: Options, d: Dependencies = {}): Promise<Record<string, unknown>> {
  const { args, binding, roots } = o;
  if (args.scopeId !== binding.scopeId) throw new Error('context_binding_changed');
  await o.check();
  if (args.command === 'calendar-setup') return configure({ ...o, args }, d);
  let selection: Selection;
  try {
    selection = parseCalendarSelection(readJson(args.manifestFile));
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Private manifest paths/content must not enter diagnostics.
    throw new Error('invalid_calendar_manifest');
  }
  if (!selection.processingProviders.includes(binding.provider)) throw new Error('invalid_calendar_manifest');
  verifyCalendarStorage(roots, d.inspect);
  const client = clientAt(roots),
    setup = setupState(roots, client, d.inspect);
  if (setup.existing?.phase !== 'ready') throw new Error('calendar_setup_required');
  const owner = openCalendarCredentials(roots, d.inspect);
  owner.fences.assertOpen(binding.scopeId, args.bindingId);
  // One binding identity owns one authorization attempt/selection forever. Reconnect uses a new identity.
  const journal = operation(roots, args.bindingId, {
    command: args.command,
    requestId: args.requestId,
    binding,
    selection,
    setup: setup.expected,
  });
  const backup = async (phase: 'before' | 'after') =>
    backupCalendarState({
      roots,
      operationId: 'admin-' + args.requestId + '-' + phase,
      receiptRoot: directory(journal.root, phase),
      check: o.check,
      inspect: d.inspect,
    });
  const admitted = () => {
    o.assertAuthority();
    return true;
  };
  const host = await (d.connect ?? connectCosHostStore)({ ...o.env, COS_CALENDAR_ENABLED: 'false' }, roots, admitted);
  try {
    const context = {
      scopeId: binding.scopeId,
      ownerId: binding.ownerId,
      agentGroupId: binding.agentGroupId,
      sessionId: binding.sessionId,
      provider: binding.provider,
      ingressId: 'owner-calendar-' + args.requestId,
    };
    const base = { scope_id: binding.scopeId, binding_id: args.bindingId, paused: true, live_model: 'not_invoked' };
    const store = new CalendarStore(host.database);
    const authorised = await store.coverage(context);
    if (authorised.status !== 'ok') return { ...base, status: authorised.status };
    await o.check();
    await backup('before');
    const attemptFile = path.join(journal.root, 'authorization.json');
    if (!fs.lstatSync(attemptFile, { throwIfNoEntry: false })) {
      if (fs.lstatSync(path.join(owner.credentials.root, args.bindingId + '.json'), { throwIfNoEntry: false }))
        throw new Error('calendar_operation_conflict');
      if (!d.display && !process.stderr.isTTY) throw new Error('calendar_interactive_terminal_required');
      writeAtomic(journal.root, 'authorization.json', { contract: 'cos-calendar-authorization/v1', attempted: true });
      const listener = await startCalendarAuthorization(client, {
        fetch: async (url, init) => {
          await o.check();
          return (d.fetch ?? globalThis.fetch)(url, init);
        },
      });
      try {
        await (
          d.display ??
          ((url: string) => {
            process.stderr.write('Open this private calendar authorization URL in your browser:\n' + url + '\n');
          })
        )(listener.authorizationUrl);
        const tokens = await listener.result;
        await o.check();
        if (digest(setupState(roots, clientAt(roots), d.inspect).expected) !== digest(setup.expected))
          throw new Error('calendar_setup_conflict');
        await owner.credentials.install(binding.scopeId, args.bindingId, args.bindingId, tokens);
      } finally {
        await listener.close();
      }
    } else {
      if (digest(readJson(attemptFile)) !== digest({ contract: 'cos-calendar-authorization/v1', attempted: true }))
        throw new Error('calendar_link_uncertain');
      try {
        await owner.credentials.inspect(binding.scopeId, args.bindingId, args.bindingId);
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Uncertain authorization cannot be replayed or disclose credential diagnostics.
        throw new Error('calendar_link_uncertain');
      }
    }
    const credential = await owner.credentials.inspect(binding.scopeId, args.bindingId, args.bindingId);
    await backup('after');
    await o.check();
    owner.fences.assertOpen(binding.scopeId, args.bindingId);
    const result = await store.bind(context, {
      id: args.bindingId,
      provider: 'google',
      ...selection,
      credentialRef: args.bindingId,
      scopes: credential.scopes,
    });
    await o.check();
    return { ...base, status: result.status };
  } finally {
    await host.database.pool.end();
  }
}
