import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { DatabaseConfigurationError } from '../store/config.js';
import { readPrivate } from '../ops/target-state.js';
import { CalendarAccessFences } from '../calendar/access-fences.js';
import { verifyCalendarStorage, type CalendarStorageRoots } from '../calendar/storage-policy.js';
import type { StorageInspection } from '../calendar/storage-protection.js';
import type { GoogleOAuthClient, OAuthTransport } from '../calendar/oauth.js';
import { CalendarWriterCredentialOwner } from './credentials.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';

export function actionSettings(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const enabled = env.COS_ACTIONS_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new DatabaseConfigurationError('COS_ACTIONS_ENABLED');
  return { enabled: enabled === 'true' };
}
function directory(root: string): fs.Stats {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_action_root');
  return stat;
}
function protectedOwner(roots: CalendarStorageRoots, inspect?: StorageInspection) {
  const { targetRoot, installationRoot, dataRoot } = roots;
  directory(targetRoot);
  if (
    [installationRoot, dataRoot].some(
      (root) => root === targetRoot || targetRoot.startsWith(root + '/') || root.startsWith(targetRoot + '/'),
    )
  )
    throw new Error('unsafe_action_root');
  for (let ancestor = targetRoot; ; ancestor = path.dirname(ancestor)) {
    if (fs.lstatSync(path.join(ancestor, '.git'), { throwIfNoEntry: false })) throw new Error('unsafe_action_root');
    if (path.dirname(ancestor) === ancestor) break;
  }
  const calendar = path.join(targetRoot, 'calendar');
  directory(calendar);
  const protection = verifyCalendarStorage(roots, inspect),
    root = directory(path.join(calendar, 'writer-credentials')),
    denial = directory(path.join(calendar, 'writer-access-denials')),
    file = path.join(calendar, 'writer-oauth-client.json'),
    stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || fs.realpathSync(file) !== file) throw new Error('unsafe_action_client');
  const client = readPrivate<GoogleOAuthClient>(file, 16384);
  if (digest(verifyCalendarStorage(roots, inspect)) !== digest(protection)) throw new Error('action_storage_changed');
  return {
    client,
    pin: digest({
      protection,
      client,
      root: { dev: root.dev, ino: root.ino },
      denial: { dev: denial.dev, ino: denial.ino },
    }),
  };
}
/** Runtime opens the separately consented writer vault only. It never initializes state, falls back to the reader,
 * or contacts OAuth. Call verify before each provider operation, including after awaited token rotation.
 */
export function openWriterCredentials(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  transport: OAuthTransport = {},
  memory: () => void = verifyVaultMemory,
) {
  try {
    memory();
    const guard = () => {
      memory();
      verifyCalendarStorage(roots, inspect);
    };
    const pinned = protectedOwner(roots, inspect),
      calendar = path.join(roots.targetRoot, 'calendar'),
      fences = new CalendarAccessFences(path.join(calendar, 'writer-access-denials')),
      credentials = new CalendarWriterCredentialOwner(
        path.join(calendar, 'writer-credentials'),
        pinned.client,
        fences,
        transport,
        guard,
      );
    const verify = () => {
      try {
        memory();
        if (protectedOwner(roots, inspect).pin !== pinned.pin) throw new Error('action_storage_changed');
      } catch {
        // eslint-disable-next-line preserve-caught-error -- Host credential paths and inspection diagnostics are private.
        throw new Error('action_configuration_unavailable');
      }
    };
    verify();
    return { credentials, fences, verify };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Client bytes, filesystem paths and nested credential errors must not escape.
    throw new Error('action_configuration_unavailable');
  }
}
