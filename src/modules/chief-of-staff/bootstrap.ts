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

/** Narrow host-service profile: never load migration or test credentials into this module. */
export function startCosHostModule(assertHostAuthority: () => void): { service: CosService; stop(): Promise<void> } {
  const keys = [
    'COS_ENABLED',
    'COS_KNOWLEDGE_ENABLED',
    'COS_CALENDAR_ENABLED',
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
    } catch {
      return false;
    }
  };
  const launcher = createCoordinatorLauncher({ targetRoot, db: getDb(), running: hasContainerExecution });
  const facts = guardConversationAccess({
    active: activeBinding,
    facts: transportFacts,
    revoke: (binding) => {
      try {
        launcher.invalidate(binding.scopeId);
      } finally {
        killContainer(binding.sessionId, 'CoS conversation access revoked');
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
    stop: (id) => killContainer(id, 'CoS emergency pause'),
    running: hasContainerExecution,
    wake: async (session) => {
      await wakeContainer(session);
    },
    connect: () =>
      connectCosHostStore(selected, { targetRoot, installationRoot: process.cwd(), dataRoot: DATA_DIR }, admitted),
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
