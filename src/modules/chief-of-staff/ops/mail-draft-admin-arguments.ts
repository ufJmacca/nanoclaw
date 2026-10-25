import path from 'node:path';
export type MailDraftAdminArguments =
  | { command: 'mail-draft-configure'; scopeId: string; requestId: string; manifestFile: string }
  | { command: 'mail-draft-disable'; scopeId: string; requestId: string; bindingId: string };
export function isMailDraftAdminCommand(args: { command: string }): args is MailDraftAdminArguments {
  return ['mail-draft-configure', 'mail-draft-disable'].includes(args.command);
}
/** No runtime imports: validate retained helper arguments before selecting installed cwd. */
export function parseMailDraftAdminArguments(args: string[]): MailDraftAdminArguments {
  const invalid = () => Error('invalid_admin_arguments'),
    configure = args[0] === 'mail-draft-configure',
    values: Record<string, string> = {};
  if (!isMailDraftAdminCommand({ command: args[0] }) || args.length !== 7) throw invalid();
  const allowed = ['--scope', '--request-id', configure ? '--manifest' : '--binding'];
  for (let i = 1; i < args.length; i += 2) {
    if (!allowed.includes(args[i]) || values[args[i]] !== undefined || !args[i + 1]) throw invalid();
    values[args[i]] = args[i + 1];
  }
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    scopeId = values['--scope'],
    requestId = values['--request-id'];
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') || !uuid.test(requestId ?? '')) throw invalid();
  if (!configure) {
    if (!uuid.test(values['--binding'] ?? '')) throw invalid();
    return { command: 'mail-draft-disable', scopeId, requestId, bindingId: values['--binding'] };
  }
  const manifestFile = values['--manifest'];
  if (
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'mail-draft-configure', scopeId, requestId, manifestFile };
}
