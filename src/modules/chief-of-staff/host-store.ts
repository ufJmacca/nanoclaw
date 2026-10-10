import { localTarget, databaseFingerprint } from './ops/target-identity.js';
import { connectChecked, DatabasePreflightError } from './store/preflight.js';
import { externalDatabaseConfig, parseDatabaseConfig } from './store/config.js';
import { migrationStatus, SCHEMA_VERSION } from './store/migrations.js';
import { BoundedDatabase } from './store/client.js';
import { PriorityStore } from './store/priorities.js';
import type { PurgeHooks } from './knowledge/purge.js';
import { KnowledgeStore } from './knowledge/store.js';
import { knowledgeSettings, openKnowledgeArtifacts } from './knowledge/config.js';
import { calendarSettings, openCalendarCredentials } from './calendar/config.js';
import { CalendarStore } from './calendar/store.js';
import { CalendarEvidence } from './calendar/evidence.js';
import { CalendarConnector } from './calendar/connector.js';
import { CalendarView } from './calendar/view.js';
import type { MissionAuthorityResolver } from './missions/proposal-store.js';
import type { TeamAuthorityResolver } from './missions/team-proposal-store.js';
import type { ActionDependencies } from './actions/store.js';
import type { ActionAuthorityResolver } from './actions/authority.js';
import { actionSettings } from './actions/config.js';
import { openActionHost } from './actions/host.js';
async function optionalGoogleHost<T>(open: () => T | Promise<T>, unavailable: string): Promise<T | undefined> {
  try {
    return await open();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== unavailable) throw error;
    return undefined;
  }
}

/** Runtime credentials only. Startup validates the schema; it never migrates or opens source access implicitly. */
export async function connectCosHostStore(
  env: NodeJS.ProcessEnv,
  roots: { targetRoot: string; installationRoot: string; dataRoot: string },
  admitted: () => boolean,
  retention: Pick<PurgeHooks, 'purgeContexts'> = {},
  missionAuthority?: MissionAuthorityResolver,
  teamAuthority?: TeamAuthorityResolver,
  actionDependencies?: ActionDependencies,
  actionAuthority?: ActionAuthorityResolver,
): Promise<PriorityStore> {
  const settings = knowledgeSettings(env);
  const calendarConfig = calendarSettings(env);
  const actionConfig = actionSettings(env);
  if (actionConfig.enabled && !actionAuthority && !actionDependencies) throw new Error('action_authority_required');
  const check = await connectChecked(env, 'runtime');
  try {
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if ((await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !== target.binding.databaseFingerprint)
      throw new DatabasePreflightError('database_identity_mismatch');
    if ((await migrationStatus(check)) !== SCHEMA_VERSION) throw new DatabasePreflightError('schema_incompatible');
  } finally {
    await check.end();
  }
  const actions =
    actionDependencies ??
    (actionAuthority
      ? await optionalGoogleHost(() => openActionHost(env, roots, admitted, actionAuthority), 'action_host_unavailable')
      : undefined);
  const artifacts = openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]);
  const calendarOwner = calendarConfig.enabled
    ? await optionalGoogleHost(() => openCalendarCredentials(roots), 'calendar_configuration_unavailable')
    : undefined;
  const database = BoundedDatabase.fromConfig(await externalDatabaseConfig(env, 'runtime'), admitted);
  const calendarStore = calendarOwner ? new CalendarStore(database, {}, new CalendarEvidence(artifacts)) : undefined;
  const calendar = calendarOwner
    ? new CalendarConnector({
        store: calendarStore!,
        ...calendarOwner,
        admitted,
      })
    : undefined;
  // Keep the store and its denial/retention obligations active when ingestion/retrieval are switched off.
  const knowledge = new KnowledgeStore(database, artifacts, retention, {
    retentionMs: settings.retentionMs,
    retrievalEnabled: () => settings.enabled,
    calendarEnabled: () => !!calendar && admitted(),
    calendarAccess: (scopeId, bindingId) => {
      if (!calendar || !admitted()) return false;
      calendar.assertOpen(scopeId, bindingId);
      return true;
    },
  });
  return new PriorityStore(
    database,
    knowledge,
    calendar,
    calendar && calendarStore
      ? new CalendarView({
          store: calendarStore,
          knowledge,
          enabled: admitted,
          assertOpen: (scope, binding) => calendar.assertOpen(scope, binding),
        })
      : undefined,
    missionAuthority ? (context) => (admitted() ? missionAuthority(context) : null) : undefined,
    teamAuthority ? (context) => (admitted() ? teamAuthority(context) : null) : undefined,
    actions
      ? {
          ...actions,
          authority: (context) => (admitted() ? actions.authority(context) : null),
          writer: (context, id, binding) => (admitted() ? actions.writer(context, id, binding) : null),
          writerEnabled: (context, id, binding) =>
            admitted() && (actions.writerEnabled?.(context, id, binding) ?? true),
        }
      : undefined,
  );
}
