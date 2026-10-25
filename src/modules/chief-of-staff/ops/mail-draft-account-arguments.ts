import path from 'node:path';

/** Pure parsing: retained owner entrypoints select installed cwd before importing runtime roots. */
export type MailDraftAccountArguments =
  | { command: 'mail-draft-setup'; scopeId: string; requestId: string }
  | {
      command: 'mail-draft-link';
      scopeId: string;
      requestId: string;
      readerBindingId: string;
      writerBindingId: string;
      manifestFile: string;
    };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function isMailDraftAccountCommand(args: { command: string }): args is MailDraftAccountArguments {
  return ['mail-draft-setup', 'mail-draft-link'].includes(args.command);
}
export function parseMailDraftAccountArguments(args: string[]): MailDraftAccountArguments {
  const setup = args[0] === 'mail-draft-setup',
    values: Record<string, string> = {};
  const invalid = () => Error('invalid_admin_arguments');
  if (!isMailDraftAccountCommand({ command: args[0] }) || args.length !== (setup ? 5 : 11)) throw invalid();
  const allowed = ['--scope', '--request-id', ...(setup ? [] : ['--reader-binding', '--writer-binding', '--manifest'])];
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') || !uuid.test(requestId ?? '')) throw invalid();
  if (setup) return { command: 'mail-draft-setup', scopeId, requestId };
  const readerBindingId = values['--reader-binding'],
    writerBindingId = values['--writer-binding'],
    manifestFile = values['--manifest'];
  if (
    !uuid.test(readerBindingId ?? '') ||
    !uuid.test(writerBindingId ?? '') ||
    readerBindingId === writerBindingId ||
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'mail-draft-link', scopeId, requestId, readerBindingId, writerBindingId, manifestFile };
}
