import fs from 'node:fs';
import { digest } from '../domain/contracts.js';
import {
  checkedClient,
  GOOGLE_MAIL_READ_SCOPE,
  GOOGLE_MAIL_DRAFT_SCOPE,
  type GoogleOAuthClient,
  type OAuthTransport,
} from '../calendar/oauth-core.js';
import { startMailAuthorization, startMailDraftAuthorization } from '../calendar/oauth-listener.js';
import type { CalendarCredentialCore } from '../calendar/credential-core.js';
import { contextGenerationPattern, privateConversationDirectory } from './conversation-ownership.js';
import { readCalendarAdminJson } from './calendar-admin.js';
import { writeAtomic } from './target-state.js';

/** Shared private consent-attempt state machine. The caller has already sealed its operation
 * to the current owner, selected account and client. Reader and writer markers remain distinct;
 * a spent/uncertain authorization can only reconcile an already installed matching grant. */
export async function authorizeMailProfile(input: {
  root: string;
  profile: 'mail_reader' | 'mail_draft_writer';
  scopeId: string;
  bindingId: string;
  reference: string;
  client: GoogleOAuthClient;
  credentials: Pick<CalendarCredentialCore, 'inspect' | 'install' | 'token'>;
  credentialsPresent(): boolean;
  verifyMailbox(token: () => Promise<string>): Promise<void>;
  check(): Promise<void>;
  fetch?: OAuthTransport['fetch'];
  display?(url: string): void | Promise<void>;
}): Promise<void> {
  const args = { ...input },
    prefix = args.profile === 'mail_reader' ? 'mail' : 'mail_draft';
  try {
    if (
      !['mail_reader', 'mail_draft_writer'].includes(args.profile) ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(args.scopeId) ||
      !contextGenerationPattern.test(args.bindingId) ||
      !contextGenerationPattern.test(args.reference)
    )
      throw Error('invalid_authorization_identity');
    const client = checkedClient(args.client),
      draft = args.profile === 'mail_draft_writer',
      marker = { contract: draft ? 'cos-mail-draft-authorization/v1' : 'cos-mail-authorization/v1', attempted: true },
      attempt = args.root + '/authorization.json';
    await args.check();
    privateConversationDirectory(args.root);
    if (!fs.lstatSync(attempt, { throwIfNoEntry: false })) {
      if (args.credentialsPresent()) throw Error(prefix + '_operation_conflict');
      if (!args.display && !process.stderr.isTTY) throw Error(prefix + '_interactive_terminal_required');
      writeAtomic(args.root, 'authorization.json', marker);
      const listener = await (draft ? startMailDraftAuthorization : startMailAuthorization)(client, {
        fetch: args.fetch,
      });
      try {
        await (
          args.display ??
          ((url: string) => {
            process.stderr.write(
              'Open this private ' +
                (draft ? 'Gmail draft' : 'Mail') +
                ' authorization URL in your browser:\n' +
                url +
                '\n',
            );
          })
        )(listener.authorizationUrl);
        const tokens = await listener.result;
        await args.check();
        await args.verifyMailbox(async () => tokens.accessToken);
        await args.check();
        await args.credentials.install(args.scopeId, args.bindingId, args.reference, tokens);
        await args.check();
      } finally {
        await listener.close();
      }
    } else {
      if (digest(readCalendarAdminJson(attempt)) !== digest(marker))
        throw Error(prefix + (draft ? '_operation_conflict' : '_link_uncertain'));
      try {
        const stored = await args.credentials.inspect(args.scopeId, args.bindingId, args.reference),
          scope = draft ? GOOGLE_MAIL_DRAFT_SCOPE : GOOGLE_MAIL_READ_SCOPE;
        if (stored.auth !== 'ready' || stored.scopes.length !== 1 || stored.scopes[0] !== scope)
          throw Error('stored_grant_unavailable');
      } catch {
        // eslint-disable-next-line preserve-caught-error -- A spent consent cannot be replayed or reveal private credential/fence diagnostics.
        throw Error(prefix + '_link_uncertain');
      }
      await args.check();
      await args.verifyMailbox(() => args.credentials.token(args.scopeId, args.bindingId, args.reference));
      await args.check();
    }
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- Only fixed operation-state errors leave this private URL/token boundary.
    throw Error(
      error instanceof Error &&
        [
          prefix + '_operation_conflict',
          prefix + '_interactive_terminal_required',
          prefix + '_link_uncertain',
        ].includes(error.message)
        ? error.message
        : prefix + '_authorization_unavailable',
    );
  }
}
