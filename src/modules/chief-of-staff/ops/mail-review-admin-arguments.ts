import path from 'node:path';

export type MailReviewAdminArguments = {
  command: 'mail-review-configure';
  scopeId: string;
  requestId: string;
  manifestFile: string;
};
export function isMailReviewAdminCommand(args: { command: string }): args is MailReviewAdminArguments {
  return args.command === 'mail-review-configure';
}
/** Validate before selecting an installed working directory. No setup, disable or resume is inferred. */
export function parseMailReviewAdminArguments(args: string[]): MailReviewAdminArguments {
  const invalid = () => Error('invalid_admin_arguments'),
    values: Record<string, string> = {};
  if (args.length !== 7 || !isMailReviewAdminCommand({ command: args[0] })) throw invalid();
  for (let i = 1; i < args.length; i += 2) {
    if (!['--scope', '--request-id', '--manifest'].includes(args[i]) || values[args[i]] !== undefined || !args[i + 1])
      throw invalid();
    values[args[i]] = args[i + 1];
  }
  const scopeId = values['--scope'],
    requestId = values['--request-id'],
    manifestFile = values['--manifest'];
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(scopeId ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(requestId ?? '') ||
    !manifestFile ||
    !path.isAbsolute(manifestFile) ||
    path.resolve(manifestFile) !== manifestFile ||
    /[\0\r\n]/.test(manifestFile)
  )
    throw invalid();
  return { command: 'mail-review-configure', scopeId, requestId, manifestFile };
}
