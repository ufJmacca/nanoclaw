import type { Context } from '../domain/contracts.js';
/** Main-context identity only. Separate current database policy, host profile, source and journal checks grant effects. */
export type MailDraftAuthority = {
  bindingDigest: string;
  contextGeneration: string;
  draftProfileDigest: string;
  provider: { profile: string; model: string; policyDigest: string };
};
export type MailDraftAuthorityResolver = (context: Context) => MailDraftAuthority | null;
