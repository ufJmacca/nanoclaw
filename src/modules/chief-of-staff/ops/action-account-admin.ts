/** Owner-run account commands, never model RPC. Linking credentials does not grant runtime write admission. */
import fs from 'node:fs';
import path from 'node:path';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { object, hasCalendarControl } from '../calendar/normalization.js';
import {
  configureCalendarStorage,
  verifyCalendarStorage,
  type CalendarStorageRoots,
} from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import { backupCalendarState } from '../calendar/backup.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { checkedClient, type GoogleOAuthClient, type OAuthTransport } from '../calendar/oauth.js';
import { startCalendarWriterAuthorization } from '../calendar/oauth-listener.js';
import { CalendarWriterCredentialOwner } from '../actions/credentials.js';
import { openWriterCredentials } from '../actions/config.js';
import { writeAtomic } from './target-state.js';
import {
  readCalendarAdminJson as readJson,
  calendarAdminDirectory as directory,
  calendarAdminOperation as operation,
} from './calendar-admin.js';

export type ActionAccountArguments =
  | { command: 'action-setup'; scopeId: string; requestId: string; backupRoot: string }
  | { command: 'action-link'; scopeId: string; requestId: string; bindingId: string; manifestFile: string };
export type ActionSelection = { calendarId: string; primaryCalendarId: string; processingProvider: 'codex' };
export function isActionAccountCommand(args: { command: string }): args is ActionAccountArguments {
  return ['action-setup', 'action-link'].includes(args.command);
}
export function parseActionAccountArguments(args: string[]): ActionAccountArguments {
  const invalid = () => Error('invalid_admin_arguments'),
    setup = args[0] === 'action-setup';
  if (!isActionAccountCommand({ command: args[0] }) || args.length !== (setup ? 7 : 9)) throw invalid();
  const allowed = ['--scope', '--request-id', ...(setup ? ['--backup-root'] : ['--binding', '--manifest'])],
    values: Record<string, string> = {};
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'],
    file = values[setup ? '--backup-root' : '--manifest'];
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') ||
    !uuid.test(requestId ?? '') ||
    !file ||
    !path.isAbsolute(file) ||
    path.resolve(file) !== file ||
    /[\0\r\n]/.test(file)
  )
    throw invalid();
  if (setup) return { command: 'action-setup', scopeId, requestId, backupRoot: file };
  if (!uuid.test(values['--binding'] ?? '')) throw invalid();
  return { command: 'action-link', scopeId, requestId, bindingId: values['--binding'], manifestFile: file };
}
export function parseActionSelection(value: unknown): ActionSelection {
  if (
    !object(value) ||
    Object.keys(value).sort().join(',') !== 'calendarId,primaryCalendarId,processingProvider' ||
    value.processingProvider !== 'codex' ||
    ['calendarId', 'primaryCalendarId'].some((key) => {
      const id = value[key];
      return (
        typeof id !== 'string' ||
        !id ||
        id.length > 1024 ||
        hasCalendarControl(id) ||
        /\s/u.test(id) ||
        ['.', '..', 'primary'].includes(id.toLowerCase())
      );
    })
  )
    throw Error('invalid_action_manifest');
  return structuredClone(value) as ActionSelection;
}
type Options = {
  args: ActionAccountArguments;
  env: NodeJS.ProcessEnv;
  roots: CalendarStorageRoots;
  binding: CosBinding;
  check(): Promise<void>;
  assertAuthority(): void;
};
type Dependencies = {
  inspect?: StorageInspection;
  fetch?: OAuthTransport['fetch'];
  display?(url: string): void | Promise<void>;
};
function setupState(roots: CalendarStorageRoots, inspect?: StorageInspection) {
  const client = checkedClient(
      readJson(path.join(roots.targetRoot, 'calendar', 'writer-oauth-client.json')) as GoogleOAuthClient,
    ),
    expected = {
      contract: 'cos-action-setup/v1',
      clientDigest: digest(client),
      storageDigest: digest(verifyCalendarStorage(roots, inspect)),
    },
    file = path.join(roots.targetRoot, 'action-setup.json'),
    present = !!fs.lstatSync(file, { throwIfNoEntry: false }),
    existing = present ? readJson(file) : null;
  if (
    present &&
    (!object(existing) ||
      Object.keys(existing).sort().join(',') !== 'clientDigest,contract,phase,storageDigest' ||
      !['initializing', 'ready'].includes(String(existing.phase)) ||
      digest({
        contract: existing.contract,
        clientDigest: existing.clientDigest,
        storageDigest: existing.storageDigest,
      }) !== digest(expected))
  )
    throw Error('action_setup_conflict');
  return { client, expected, existing };
}
export async function runActionAccountAdmin(o: Options, d: Dependencies = {}): Promise<Record<string, unknown>> {
  const { args, binding, roots } = o;
  if (args.scopeId !== binding.scopeId || binding.provider !== 'codex') throw Error('context_binding_changed');
  await o.check();
  if (args.command === 'action-setup') configureCalendarStorage(roots, args.backupRoot, d.inspect);
  const setup = setupState(roots, d.inspect);
  if (args.command === 'action-link' && (!object(setup.existing) || setup.existing.phase !== 'ready'))
    throw Error('action_setup_required');
  const selection = args.command === 'action-link' ? parseActionSelection(readJson(args.manifestFile)) : null;
  const journal = operation(roots, args.command === 'action-link' ? args.bindingId : args.requestId, {
    command: args.command,
    requestId: args.requestId,
    binding,
    setup: setup.expected,
    selection,
  });
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
  if (args.command === 'action-setup') {
    if (!setup.existing)
      writeAtomic(roots.targetRoot, 'action-setup.json', { ...setup.expected, phase: 'initializing' });
    if (!object(setup.existing) || setup.existing.phase !== 'ready')
      for (const name of ['writer-credentials', 'writer-access-denials']) {
        const child = path.join(roots.targetRoot, 'calendar', name);
        if (!fs.lstatSync(child, { throwIfNoEntry: false })) {
          directory(path.dirname(child), name);
          if (name === 'writer-credentials') CalendarWriterCredentialOwner.initialize(child);
          else CalendarAccessFences.initialize(child);
        }
      }
    openWriterCredentials(roots, d.inspect);
    await backup('after');
    await o.check();
    if (digest(setupState(roots, d.inspect).expected) !== digest(setup.expected)) throw Error('action_setup_conflict');
    writeAtomic(roots.targetRoot, 'action-setup.json', { ...setup.expected, phase: 'ready' });
    return {
      status: 'configured_paused',
      scope_id: binding.scopeId,
      paused: true,
      writer_enabled: false,
      live_model: 'not_invoked',
    };
  }
  const owner = openWriterCredentials(roots, d.inspect),
    attempt = path.join(journal.root, 'authorization.json'),
    reference = args.bindingId;
  owner.fences.assertOpen(binding.scopeId, reference);
  if (!fs.lstatSync(attempt, { throwIfNoEntry: false })) {
    if (fs.lstatSync(path.join(owner.credentials.root, reference + '.json'), { throwIfNoEntry: false }))
      throw Error('action_setup_conflict');
    if (!d.display && !process.stderr.isTTY) throw Error('calendar_interactive_terminal_required');
    writeAtomic(journal.root, 'authorization.json', { contract: 'cos-action-authorization/v1', attempted: true });
    const listener = await startCalendarWriterAuthorization(setup.client, {
      fetch: async (url, init) => {
        await o.check();
        owner.verify();
        return (d.fetch ?? globalThis.fetch)(url, init);
      },
    });
    try {
      await (
        d.display ??
        ((url: string) => {
          process.stderr.write('Open this private calendar writer authorization URL in your browser:\n' + url + '\n');
        })
      )(listener.authorizationUrl);
      const tokens = await listener.result;
      await o.check();
      owner.verify();
      if (digest(setupState(roots, d.inspect).expected) !== digest(setup.expected))
        throw Error('action_setup_conflict');
      await owner.credentials.install(binding.scopeId, reference, reference, tokens);
    } finally {
      await listener.close();
    }
  } else if (digest(readJson(attempt)) !== digest({ contract: 'cos-action-authorization/v1', attempted: true }))
    throw Error('action_link_uncertain');
  // An uncertain exchange is never repeated. Only already committed ready credentials permit completion.
  const credential = await owner.credentials.inspect(binding.scopeId, reference, reference);
  if (credential.auth !== 'ready') throw Error('action_link_uncertain');
  await backup('after');
  await o.check();
  owner.verify();
  const consent = {
    format: 'cos-action-account-consent/v1',
    nativeBindingDigest: digest(binding),
    bindingId: reference,
    credentialReference: reference,
    selection,
    setupDigest: digest(setup.expected),
  };
  const consentFile = path.join(journal.root, 'consent.json');
  if (fs.lstatSync(consentFile, { throwIfNoEntry: false }) && digest(readJson(consentFile)) !== digest(consent))
    throw Error('action_setup_conflict');
  writeAtomic(journal.root, 'consent.json', consent);
  return {
    status: 'credentials_ready_writes_disabled',
    scope_id: binding.scopeId,
    binding_id: reference,
    paused: true,
    writer_enabled: false,
    live_model: 'not_invoked',
  };
}
