import type Database from 'better-sqlite3';
import type { Session, MessagingGroup } from '../../types.js';
import { cosBoundary, setCosBoundaryHooks, type CosBinding } from '../../cos-boundary.js';
import { registerDeliveryAction } from '../../delivery.js';
import { deletePendingApproval } from '../../db/sessions.js';
import { requestCorrelatedApproval } from '../approvals/correlated.js';
import { CosController } from './bridge/controller.js';
import { CosOutbox } from './bridge/outbox.js';
import { createRpcHandler } from './bridge/rpc.js';
import { validPrivateChannel, type ChannelFacts } from './bridge/identity.js';
import type { PriorityStore } from './store/priorities.js';

export type RuntimeDependencies = {
  db: Database.Database;
  enabled: boolean;
  store?: PriorityStore;
  facts(binding: CosBinding): Promise<ChannelFacts>;
  session(id: string): Session | undefined;
  destination(id: string): MessagingGroup | undefined;
  stop(sessionId: string): void;
};
export function createCosRuntime(dependencies: RuntimeDependencies) {
  const d = dependencies;
  const enabled = () => d.enabled && !!d.store;
  const controller = new CosController({
    db: d.db,
    enabled,
    facts: d.facts,
    session: d.session,
    decide: (...args) => (d.store ? d.store.decide(...args) : Promise.resolve({ status: 'unavailable' })),
    acknowledge: (proposal) => deletePendingApproval('cos-' + proposal),
    stop: d.stop,
  });
  const admitted = async (binding: CosBinding): Promise<boolean> => {
    if (!enabled()) return false;
    const session = d.session(binding.sessionId);
    if (!session) return false;
    const boundary = cosBoundary(session, d.db);
    if (!boundary.restricted || !boundary.binding || boundary.paused) return false;
    if (!validPrivateChannel(binding, await d.facts(binding))) return false;
    const current = cosBoundary(session, d.db);
    return current.restricted && !!current.binding && !current.paused;
  };
  const outbox = d.store
    ? new CosOutbox({
        store: d.store,
        admitted,
        preview: async (binding, preview) => {
          const session = d.session(preview.sessionId),
            destination = d.destination(binding.messagingGroupId);
          if (
            !session ||
            !destination ||
            destination.platform_id !== `mattermost:${binding.instanceId}:${binding.channelId}`
          )
            return false;
          return requestCorrelatedApproval({
            id: preview.id,
            session,
            ownerId: binding.ownerId,
            destination,
            payload: { proposal_id: preview.proposalId, change: preview.change },
            text: preview.text,
            expiresAt: preview.expiresAt,
            validateDestination: () => admitted(binding),
          });
        },
      })
    : null;
  setCosBoundaryHooks({
    // Remains closed until the separately tested restricted launcher is installed.
    executionReady: () => false,
    ingress: (binding, event) => controller.ingress(binding, event),
    validatePrivateDestination: async (binding) => {
      if (!(await admitted(binding))) return false;
      const session = d.session(binding.sessionId);
      if (!session || !d.store) return false;
      const context = await controller.context(session);
      return !!context && (await d.store.context(context)).status === 'ok';
    },
  });
  if (enabled())
    registerDeliveryAction(
      'cos_rpc',
      createRpcHandler({ resolveContext: (session) => controller.context(session), store: d.store! }),
    );
  return {
    controller,
    pump: async (binding: CosBinding) => {
      if (enabled()) await outbox?.drain(binding);
    },
    dispose: () => setCosBoundaryHooks(null),
  };
}
