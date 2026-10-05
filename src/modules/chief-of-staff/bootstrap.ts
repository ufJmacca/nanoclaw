import { DATA_DIR } from '../../config.js';
import { log } from '../../log.js';
import { currentRelease, releaseMode, selectReleaseImage } from '../../release-runtime.js';
import { startHostSubscriptionCredentials } from '../../providers/codex-subscription-runtime.js';
import { localTarget } from './ops/target-identity.js';
import { admittedGeneration } from './ops/maintenance.js';
import { readEnvFile } from '../../env.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { killContainer, wakeContainer, hasContainerExecution } from '../../container-runner.js';
import { NodeMattermostTransport } from '../../channels/mattermost-client.js';
import { validateMattermostSessionForExecution } from '../../channels/mattermost-subscription.js';
import { createMattermostFacts } from './bridge/mattermost-facts.js';
import { guardConversationAccess } from './bridge/conversation-access.js';
import type { CosBinding } from '../../cos-boundary.js';
import { connectCosHostStore } from './host-store.js';
import { CosService } from './service.js';
import { createCoordinatorLauncher } from './bridge/coordinator-launcher.js';
import { RestrictedExecutionProbe } from './bridge/native-execution.js';
import { getInstallSlug } from '../../install-slug.js';
import { sessionDir } from '../../session-manager.js';
import { createActionAuthorityResolver, createMissionAuthorityResolver } from './missions/authority.js';
import { createTeamAuthorityResolver } from './missions/team-authority.js';
import { MissionHost } from './missions/host.js';
import { createMissionExecution } from './missions/execution.js';
import { cosMissionIdentities, hasCosMissionBoundary } from '../../cos-mission-boundary.js';

/** Narrow host-service profile: never load migration or test credentials into this module. */
export function startCosHostModule(assertHostAuthority: () => void): { service: CosService; stop(): Promise<void> } {
  const keys = [
    'COS_ENABLED',
    'COS_KNOWLEDGE_ENABLED',
    'COS_CALENDAR_ENABLED',
    'COS_ACTIONS_ENABLED',
    'COS_KNOWLEDGE_RETENTION_DAYS',
    'COS_TARGET_STATE_DIR',
    'CODEX_MODEL',
    ...[
      'HOST',
      'PORT',
      'DATABASE',
      'USER',
      'PASSWORD',
      'SSLMODE',
      'SSLROOTCERT',
      '_ALLOW_PLAINTEXT',
      '_POOL_MAX',
      '_CONNECT_TIMEOUT_MS',
      '_STATEMENT_TIMEOUT_MS',
      '_QUERY_TIMEOUT_MS',
      '_LOCK_TIMEOUT_MS',
      '_IDLE_TIMEOUT_MS',
      '_IDLE_TX_TIMEOUT_MS',
      '_APPLICATION_NAME',
    ].map((key) => 'COS_PG' + key),
    'MATTERMOST_URL',
    'MATTERMOST_BOT_TOKEN',
    'MATTERMOST_INSTANCE',
  ];
  const file = readEnvFile(keys);
  const selected = Object.fromEntries(keys.map((key) => [key, process.env[key] ?? file[key]]));
  const activeBinding = (binding: CosBinding) => {
    const session = getSession(binding.sessionId);
    if (!session) return false;
    const boundary = validateMattermostSessionForExecution(session);
    return (
      boundary.strict &&
      boundary.valid &&
      boundary.value.agentGroup.id === binding.agentGroupId &&
      boundary.value.messagingGroup.id === binding.messagingGroupId
    );
  };
  const transportFacts = createMattermostFacts(
    {
      baseUrl: selected.MATTERMOST_URL ?? '',
      botToken: selected.MATTERMOST_BOT_TOKEN ?? '',
      instanceKey: selected.MATTERMOST_INSTANCE ?? '',
    },
    new NodeMattermostTransport(),
    activeBinding,
  );
  const targetRoot = selected.COS_TARGET_STATE_DIR ?? '';
  let credentials: ReturnType<typeof startHostSubscriptionCredentials> | undefined;
  if (selected.COS_ENABLED === 'true' && releaseMode()) {
    try {
      localTarget(targetRoot, process.cwd(), DATA_DIR);
      credentials = startHostSubscriptionCredentials({
        root: targetRoot,
        home: process.env.HOME ?? '',
        model: selected.CODEX_MODEL ?? 'gpt-6-astra',
        assertAuthority: assertHostAuthority,
        image: async () => {
          const release = currentRelease();
          if (!release) throw new Error('subscription_release_required');
          return selectReleaseImage(release, 'codex', { apt: [], npm: [] });
        },
        authorizeSession: async (session) => {
          const current = getSession(session.id);
          if (
            !current ||
            current.status !== 'active' ||
            current.agent_group_id !== session.agent_group_id ||
            current.messaging_group_id !== session.messaging_group_id ||
            current.thread_id !== session.thread_id
          )
            return false;
          const boundary = validateMattermostSessionForExecution(current);
          return !boundary.strict || boundary.valid;
        },
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Missing/unsafe CoS credentials must not stop unrelated startup or expose credential paths/errors.
    } catch {
      log.warn('CoS subscription credential coordination is unavailable');
    }
  }
  const admitted = () => {
    try {
      const target = localTarget(targetRoot, process.cwd(), DATA_DIR);
      return admittedGeneration(targetRoot, target.binding) !== null;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Missing/corrupt target maintenance history closes CoS admission without stopping unrelated startup.
    } catch {
      return false;
    }
  };
  const executionProbe = new RestrictedExecutionProbe(getInstallSlug());
  const missionExecution = createMissionExecution({
    db: getDb(),
    assertHostAuthority,
    session: getSession,
    directory: sessionDir,
    running: hasContainerExecution,
    stop: (id) => killContainer(id, 'CoS execution fenced'),
    probe: executionProbe,
  });
  const running = (id: string): boolean => {
    try {
      assertHostAuthority();
      const session = getSession(id);
      return !session || hasContainerExecution(id) || executionProbe.present(sessionDir(session.agent_group_id, id));
      // eslint-disable-next-line no-catch-all/no-catch-all -- An unconfirmed execution is conservatively treated as running, preventing another launch.
    } catch {
      return true;
    }
  };
  const stop = (id: string): void => {
    try {
      assertHostAuthority();
      const identity = cosMissionIdentities(getDb()).find((row) => row.sessionId === id);
      if (identity) {
        void missionExecution.stop(identity).catch(() => log.warn('CoS specialist stop requires reconciliation'));
        return;
      }
      // A corrupt child reservation cannot fall through to an ordinary workspace.
      const session = getSession(id);
      if (hasCosMissionBoundary(session?.agent_group_id ?? '', id, getDb())) return;
      killContainer(id, 'CoS execution fenced');
      if (session) executionProbe.stop(sessionDir(session.agent_group_id, id));
      // eslint-disable-next-line no-catch-all/no-catch-all -- Stop failures require reconciliation; native/credential diagnostics remain private.
    } catch {
      log.warn('CoS execution stop requires reconciliation');
    }
  };
  const launcher = createCoordinatorLauncher({ targetRoot, db: getDb(), running });
  const missionAuthority = createMissionAuthorityResolver({ targetRoot, db: getDb(), admitted, assertHostAuthority });
  const actionAuthority = createActionAuthorityResolver({ targetRoot, db: getDb(), admitted, assertHostAuthority });
  const teamAuthority = createTeamAuthorityResolver({ targetRoot, db: getDb(), missionAuthority });
  const facts = guardConversationAccess({
    active: activeBinding,
    facts: transportFacts,
    revoke: (binding) => {
      try {
        launcher.invalidate(binding.scopeId);
      } finally {
        stop(binding.sessionId);
      }
    },
  });
  const service = new CosService({
    launcher,
    db: getDb(),
    enabled: selected.COS_ENABLED === 'true',
    admission: admitted,
    facts,
    session: getSession,
    destination: getMessagingGroup,
    stop,
    running,
    missionExecution,
    wake: wakeContainer,
    specialists: (store) =>
      new MissionHost({
        root: targetRoot,
        db: getDb(),
        runs: store.missionRuns,
        teams: store.teamRuns,
        authority: missionAuthority,
        admitted,
        assertHostAuthority,
        facts,
        running: missionExecution.running,
        unallocated: missionExecution.unallocated,
        stop: missionExecution.stop,
        wake: wakeContainer,
      }),
    connect: () =>
      connectCosHostStore(
        selected,
        { targetRoot, installationRoot: process.cwd(), dataRoot: DATA_DIR },
        admitted,
        {},
        missionAuthority,
        teamAuthority,
        undefined,
        actionAuthority,
      ),
  });
  // PostgreSQL availability never holds up unrelated channel startup.
  void service.tick();
  const timer = setInterval(() => void service.tick(), 5000);
  timer.unref();
  return {
    service,
    async stop() {
      clearInterval(timer);
      await credentials?.coordinator.close();
      await service.stop();
      await launcher.close();
    },
  };
}
