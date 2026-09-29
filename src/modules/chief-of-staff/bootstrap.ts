import { readEnvFile } from '../../env.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { killContainer, wakeContainer } from '../../container-runner.js';
import { NodeMattermostTransport } from '../../channels/mattermost-client.js';
import { validateMattermostSessionForExecution } from '../../channels/mattermost-subscription.js';
import { createMattermostFacts } from './bridge/mattermost-facts.js';
import { connectChecked } from './store/preflight.js';
import { externalDatabaseConfig } from './store/config.js';
import { migrationStatus } from './store/migrations.js';
import { BoundedDatabase } from './store/client.js';
import { PriorityStore } from './store/priorities.js';
import { CosService } from './service.js';

/** Narrow host-service profile: never load migration or test credentials into this module. */
export function startCosHostModule(): { service: CosService; stop(): Promise<void> } {
  const keys = [
    'COS_ENABLED',
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
  const facts = createMattermostFacts(
    {
      baseUrl: selected.MATTERMOST_URL ?? '',
      botToken: selected.MATTERMOST_BOT_TOKEN ?? '',
      instanceKey: selected.MATTERMOST_INSTANCE ?? '',
    },
    new NodeMattermostTransport(),
    (binding) => {
      const session = getSession(binding.sessionId);
      if (!session) return false;
      const boundary = validateMattermostSessionForExecution(session);
      return (
        boundary.strict &&
        boundary.valid &&
        boundary.value.agentGroup.id === binding.agentGroupId &&
        boundary.value.messagingGroup.id === binding.messagingGroupId
      );
    },
  );
  const service = new CosService({
    db: getDb(),
    enabled: selected.COS_ENABLED === 'true',
    facts,
    session: getSession,
    destination: getMessagingGroup,
    stop: (id) => killContainer(id, 'CoS emergency pause'),
    wake: async (session) => {
      await wakeContainer(session);
    },
    connect: async () => {
      const check = await connectChecked(selected, 'runtime');
      try {
        if ((await migrationStatus(check)) !== 1) throw new Error('schema_incompatible');
      } finally {
        await check.end();
      }
      return new PriorityStore(BoundedDatabase.fromConfig(await externalDatabaseConfig(selected, 'runtime')));
    },
  });
  // PostgreSQL availability never holds up unrelated channel startup.
  void service.tick();
  const timer = setInterval(() => void service.tick(), 5000);
  timer.unref();
  return {
    service,
    async stop() {
      clearInterval(timer);
      await service.stop();
    },
  };
}
