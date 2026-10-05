import fs from 'node:fs';
import path from 'node:path';
import { digest, type Context } from '../domain/contracts.js';
import { localTarget } from '../ops/target-identity.js';
import type { CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import type { OAuthTransport } from '../calendar/oauth.js';
import { actionSettings, openWriterCredentials } from './config.js';
import { openTargetActionWitness } from './host-ownership.js';
import {
  readActionHostProfile,
  verifyActionGrantRecovery,
  actionRecoveryPinCurrent,
  type ActionHostGrant,
} from './profile.js';
import type { ActionAuthorityResolver } from './authority.js';
import type { ActionDependencies } from './store.js';
import type { ActionWriterBinding } from './binding.js';
import { googleCalendarWriter } from './google-writer.js';

type Adapters = {
  storageInspection?: StorageInspection;
  oauth?: OAuthTransport;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
};
const identity = ({ scopeId, ownerId, sessionId, agentGroupId }: Context | ActionHostGrant) => ({
  scopeId,
  ownerId,
  sessionId,
  agentGroupId,
});
/** Existing NanoClaw host only. This opens operator-owned configuration; it never initializes a consent,
 * credential, journal, model grant, context or provider event. Disabled writes can retain readback admission.
 */
export async function openActionHost(
  env: NodeJS.ProcessEnv,
  roots: CalendarStorageRoots,
  admitted: () => boolean,
  authority: ActionAuthorityResolver,
  adapters: Adapters = {},
): Promise<ActionDependencies | undefined> {
  try {
    const settings = actionSettings(env),
      file = path.join(roots.targetRoot, 'actions', 'writer-profile.json');
    if (!fs.lstatSync(file, { throwIfNoEntry: false })) {
      if (!settings.enabled) return undefined;
      throw new Error('action_profile_required');
    }
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot),
      installationDigest = digest(target.binding),
      witness = openTargetActionWitness(roots.targetRoot, installationDigest),
      profile = readActionHostProfile(roots.targetRoot, installationDigest, witness.generation),
      profileDigest = digest(profile);
    for (const grant of profile.grants)
      await verifyActionGrantRecovery(
        roots,
        grant,
        witness,
        target.binding.databaseFingerprint,
        adapters.storageInspection,
      );
    const owner = openWriterCredentials(roots, adapters.storageInspection, adapters.oauth);
    const current = (context: Context) => {
      try {
        if (
          context.origin ||
          !admitted() ||
          digest(localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot).binding) !==
            installationDigest ||
          digest(readActionHostProfile(roots.targetRoot, installationDigest, witness.generation)) !== profileDigest ||
          !profile.grants.every((grant) => actionRecoveryPinCurrent(roots.targetRoot, grant))
        )
          return null;
        owner.verify();
        const resolved = authority(context);
        return resolved &&
          profile.grants.some(
            (grant) =>
              digest(identity(grant)) === digest(identity(context)) &&
              grant.binding.bindingDigest === resolved.bindingDigest,
          )
          ? resolved
          : null;
        // eslint-disable-next-line no-catch-all/no-catch-all -- Any unconfirmed private host/proof/storage state must close provider admission.
      } catch {
        // Missing/replaced protected state closes admission, including readback, without leaking private diagnostics.
        return null;
      }
    };
    const grantFor = (context: Context, id: string, binding: ActionWriterBinding) =>
      profile.grants.find(
        (grant) =>
          grant.id === id &&
          digest(identity(grant)) === digest(identity(context)) &&
          digest(grant.binding) === digest(binding),
      );
    if (digest(readActionHostProfile(roots.targetRoot, installationDigest, witness.generation)) !== profileDigest)
      throw new Error('action_profile_changed');
    return {
      witness,
      authority: current,
      writerEnabled: (context, id, binding) =>
        !!current(context) && !!grantFor(context, id, binding)?.writeEnabled && settings.enabled,
      writer(context, id, binding) {
        const pinned = structuredClone(context),
          grant = grantFor(pinned, id, binding),
          resolved = current(pinned);
        if (!grant || !resolved) return null;
        const allowed = () => digest(current(pinned) ?? null) === digest(resolved);
        const assert = () => {
          if (!allowed()) throw new Error('action_host_admission_closed');
        };
        return googleCalendarWriter({
          admitted: allowed,
          fetch: adapters.fetch,
          now: adapters.now,
          access: async () => {
            assert();
            const value = await owner.credentials.inspect(grant.scopeId, grant.id, grant.credentialReference);
            assert();
            return {
              auth: value.auth,
              scopes: value.scopes,
              generation: grant.credentialReference,
              accountFingerprint: grant.binding.accountFingerprint,
              calendarId: grant.binding.calendarId,
              writeEnabled: settings.enabled && grant.writeEnabled,
            };
          },
          token: async () => {
            assert();
            const token = await owner.credentials.token(grant.scopeId, grant.id, grant.credentialReference);
            assert();
            return token;
          },
        });
      },
    };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- No private profile, credential, backup or host path diagnostics may escape startup.
    throw new Error('action_host_unavailable');
  }
}
