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
import { mailSettings, openMailCredentials, openMailFences, type MailHostFences } from './mail/config.js';
import { MailStore } from './mail/store.js';
import { MailConnector } from './mail/connector.js';
import { MailView } from './mail/view.js';
import { MailHost, closeMailProfile } from './mail/host.js';
import type { Context } from './domain/contracts.js';
import type { MailMaintenanceResources } from './mail/maintenance.js';
import { mailDraftSettings } from './mail-drafts/config.js';
import { openMailDraftHost } from './mail-drafts/open-host.js';
import type { MailDraftAuthorityResolver } from './mail-drafts/authority.js';
async function optionalGoogleHost<T>(open: () => T | Promise<T>, unavailable: string): Promise<T | undefined> {
  try {
    return await open();
  } catch (error) {
    if (!(error instanceof Error) || error.message !== unavailable) throw error;
    return undefined;
  }
}
type HostRoots = { targetRoot: string; installationRoot: string; dataRoot: string };
async function checkRuntimeDatabase(env: NodeJS.ProcessEnv, roots: HostRoots): Promise<void> {
  const check = await connectChecked(env, 'runtime');
  try {
    const target = localTarget(roots.targetRoot, roots.installationRoot, roots.dataRoot);
    if ((await databaseFingerprint(check, parseDatabaseConfig(env, 'runtime'))) !== target.binding.databaseFingerprint)
      throw new DatabasePreflightError('database_identity_mismatch');
    if ((await migrationStatus(check)) !== SCHEMA_VERSION) throw new DatabasePreflightError('schema_incompatible');
  } finally {
    await check.end();
  }
}
/** No source adapters, OAuth token owner, RPC stores or model credentials.
 * The caller owns this lifetime even when the whole CoS service is disabled. */
export async function connectCosMailMaintenanceStore(
  env: NodeJS.ProcessEnv,
  roots: HostRoots,
  admitted: () => boolean,
): Promise<MailMaintenanceResources> {
  const guard = () => {
    if (!admitted()) throw Error('mail_maintenance_unavailable');
  };
  guard();
  await checkRuntimeDatabase(env, roots);
  guard();
  const settings = knowledgeSettings({ ...env, COS_KNOWLEDGE_ENABLED: 'false' });
  const artifacts = openKnowledgeArtifacts(roots.targetRoot, [roots.installationRoot, roots.dataRoot]);
  const database = BoundedDatabase.fromConfig(await externalDatabaseConfig(env, 'runtime'), admitted);
  let resource: MailHostFences | undefined, mail: MailHost | undefined;
  try {
    guard();
    resource = await optionalGoogleHost(() => openMailFences(roots), 'mail_configuration_unavailable');
    mail = new MailHost({ store: new MailStore(database, artifacts), resource });
    guard();
    return {
      mail,
      database,
      knowledge: new KnowledgeStore(
        database,
        artifacts,
        {},
        { retrievalEnabled: () => false, retentionMs: settings.retentionMs },
      ),
    };
  } catch (error) {
    try {
      if (mail) await mail.close();
      else if (resource) await closeMailProfile(resource);
    } finally {
      await database.pool.end();
    }
    throw error;
  }
}

/** Runtime credentials only. Startup validates the schema; it never migrates or opens source access implicitly. */
export async function connectCosHostStore(
  env: NodeJS.ProcessEnv,
  roots: HostRoots,
  admitted: () => boolean,
  retention: Pick<PurgeHooks, 'purgeContexts'> = {},
  missionAuthority?: MissionAuthorityResolver,
  teamAuthority?: TeamAuthorityResolver,
  actionDependencies?: ActionDependencies,
  actionAuthority?: ActionAuthorityResolver,
  mailAuthority?: (context: Context & { provider: string }) => boolean,
  draftAuthority?: MailDraftAuthorityResolver,
): Promise<PriorityStore> {
  const settings = knowledgeSettings(env);
  const calendarConfig = calendarSettings(env);
  const actionConfig = actionSettings(env);
  const mailConfig = mailSettings(env);
  const draftConfig = mailDraftSettings(env);
  if (actionConfig.enabled && !actionAuthority && !actionDependencies) throw new Error('action_authority_required');
  if (draftConfig.enabled && !draftAuthority) throw new Error('mail_draft_authority_required');
  await checkRuntimeDatabase(env, roots);
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
  let mailResource: MailHostFences | undefined,
    mail: MailHost | undefined,
    draftHost: Awaited<ReturnType<typeof openMailDraftHost>>;
  try {
    const mailOwner = mailConfig.enabled
      ? await optionalGoogleHost(() => openMailCredentials(roots), 'mail_configuration_unavailable')
      : undefined;
    mailResource =
      mailOwner ?? (await optionalGoogleHost(() => openMailFences(roots), 'mail_configuration_unavailable'));
    const mailStore = new MailStore(database, artifacts);
    const mailConnector = mailOwner
      ? new MailConnector({
          store: mailStore,
          ...mailOwner,
          admitted: (context) => admitted() && mailConfig.enabled && (mailAuthority?.(context) ?? false),
        })
      : undefined;
    mail = new MailHost({ store: mailStore, connector: mailConnector, resource: mailResource });
    draftHost = draftConfig.enabled
      ? await optionalGoogleHost(
          () => openMailDraftHost(env, roots, admitted, draftAuthority!, mailOwner),
          'mail_draft_host_unavailable',
        )
      : undefined;
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
      mailEnabled: () => !!mail?.active() && admitted(),
      mailAccess: (scopeId, bindingId) => {
        if (!mail?.active() || !admitted()) return false;
        mail.connector!.assertOpen(scopeId, bindingId);
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
      mailConnector
        ? new MailView({
            store: mailStore,
            knowledge,
            enabled: () => !!mail?.active() && admitted(),
            assertOpen: (scope, binding) => mailConnector.assertOpen(scope, binding),
          })
        : undefined,
      mail,
      draftHost?.dependencies,
      draftHost,
    );
  } catch (error) {
    try {
      await draftHost?.close();
      if (mail) await mail.close();
      else if (mailResource) await closeMailProfile(mailResource);
    } finally {
      await database.pool.end();
    }
    throw error;
  }
}
