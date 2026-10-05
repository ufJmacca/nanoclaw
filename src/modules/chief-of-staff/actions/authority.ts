import type { Context } from '../domain/contracts.js';
/** Current main-context admission; the separate writer binding and exact approval grant effect permission. */
export type ActionAuthority = {
  bindingDigest: string;
  contextGeneration: string;
  actionProfileDigest: string;
  provider: { profile: string; model: string; policyDigest: string };
};
export type ActionAuthorityResolver = (context: Context) => ActionAuthority | null;
