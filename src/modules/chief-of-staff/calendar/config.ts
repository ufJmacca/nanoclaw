import fs from 'node:fs';
import path from 'node:path';
import { CalendarAccessFences } from './access-fences.js';
import { CalendarCredentialOwner } from './credentials.js';
import type { GoogleOAuthClient } from './oauth.js';
import { readPrivate } from '../ops/target-state.js';
import { DatabaseConfigurationError } from '../store/config.js';
import { verifyCalendarStorage, type CalendarStorageRoots } from './storage-policy.js';
import type { StorageInspection } from './storage-protection.js';
import { digest } from '../domain/contracts.js';
import { verifyVaultMemory } from '../ops/vault-memory.js';
export function calendarSettings(env: NodeJS.ProcessEnv): { enabled: boolean } {
  const enabled = env.COS_CALENDAR_ENABLED ?? 'false';
  if (!['true', 'false'].includes(enabled)) throw new DatabaseConfigurationError('COS_CALENDAR_ENABLED');
  return { enabled: enabled === 'true' };
}
function privateDirectory(root: string): void {
  const stat = fs.lstatSync(root);
  if (
    !path.isAbsolute(root) ||
    path.resolve(root) !== root ||
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o777) !== 0o700
  )
    throw new Error('unsafe_calendar_root');
}
/** Disconnect/status do not need working OAuth tokens, and never open them. */
export function openCalendarFences(roots: CalendarStorageRoots, inspect?: StorageInspection): CalendarAccessFences {
  try {
    const protection = verifyCalendarStorage(roots, inspect);
    const fences = new CalendarAccessFences(path.join(roots.targetRoot, 'calendar', 'access-denials'));
    if (digest(verifyCalendarStorage(roots, inspect)) !== digest(protection))
      throw new Error('calendar_storage_changed');
    return fences;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Host paths and private configuration must not enter diagnostics.
    throw new Error('calendar_configuration_unavailable');
  }
}
/** Runtime opens existing protected host state only. Operator setup owns initialization and storage-protection verification. */
export function openCalendarCredentials(
  roots: CalendarStorageRoots,
  inspect?: StorageInspection,
  memory: () => void = verifyVaultMemory,
): { fences: CalendarAccessFences; credentials: CalendarCredentialOwner; verifyStorage(): void } {
  try {
    memory();
    const { targetRoot, installationRoot, dataRoot } = roots;
    privateDirectory(targetRoot);
    if (
      [installationRoot, dataRoot].some(
        (root) => root === targetRoot || targetRoot.startsWith(root + '/') || root.startsWith(targetRoot + '/'),
      )
    )
      throw new Error('unsafe_calendar_root');
    for (let ancestor = targetRoot; ; ancestor = path.dirname(ancestor)) {
      if (fs.lstatSync(path.join(ancestor, '.git'), { throwIfNoEntry: false })) throw new Error('unsafe_calendar_root');
      if (path.dirname(ancestor) === ancestor) break;
    }
    const root = path.join(targetRoot, 'calendar');
    privateDirectory(root);
    const protection = verifyCalendarStorage(roots, inspect);
    const clientFile = path.join(root, 'oauth-client.json'),
      stat = fs.lstatSync(clientFile);
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('unsafe_calendar_client');
    const client = readPrivate<GoogleOAuthClient>(clientFile, 16384);
    const fences = new CalendarAccessFences(path.join(root, 'access-denials'));
    const guard = () => {
      memory();
      if (digest(verifyCalendarStorage(roots, inspect)) !== digest(protection))
        throw new Error('calendar_storage_changed');
    };
    const credentials = new CalendarCredentialOwner(path.join(root, 'credentials'), client, fences, {}, guard);
    if (digest(verifyCalendarStorage(roots, inspect)) !== digest(protection))
      throw new Error('calendar_storage_changed');
    return { fences, credentials, verifyStorage: guard };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Host paths and credential parse failures must not expose sensitive configuration, including through a nested cause.
    throw new Error('calendar_configuration_unavailable');
  }
}
