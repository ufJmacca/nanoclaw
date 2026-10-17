import path from 'node:path';

/** Pure parsing: retained owner entrypoints must select cwd before importing runtime roots. */
export type MailAccountArguments =
  | { command: 'mail-setup'; scopeId: string; requestId: string }
  | { command: 'mail-link'; scopeId: string; requestId: string; bindingId: string; manifestFile: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isMailAccountCommand(args: { command: string }): args is MailAccountArguments {
  return ['mail-setup', 'mail-link'].includes(args.command);
}
export function parseMailAccountArguments(args: string[]): MailAccountArguments {
  const setup = args[0] === 'mail-setup',
    values: Record<string, string> = {};
  const invalid = () => Error('invalid_admin_arguments');
  if (!isMailAccountCommand({ command: args[0] }) || args.length !== (setup ? 5 : 9)) throw invalid();
  const allowed = ['--scope', '--request-id', ...(setup ? [] : ['--binding', '--manifest'])];
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') || !uuid.test(requestId ?? '')) throw invalid();
  if (setup) return { command: 'mail-setup', scopeId, requestId };
  const bindingId = values['--binding'],
    manifestFile = values['--manifest'];
  if (
    !uuid.test(bindingId ?? '') ||
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'mail-link', scopeId, requestId, bindingId, manifestFile };
}
