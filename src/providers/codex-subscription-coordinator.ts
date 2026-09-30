import fs from 'node:fs';
import path from 'node:path';
import type { Session } from '../types.js';
import type { VolumeMount } from './provider-container-registry.js';
import type { SubscriptionCredentialSnapshot } from './codex-subscription-auth.js';
import { startSubscriptionBroker } from './codex-subscription-broker.js';

type Store = {
  cached(): SubscriptionCredentialSnapshot;
  refresh(generation: string): Promise<SubscriptionCredentialSnapshot>;
};
export function createSubscriptionCoordinator(options: {
  root: string;
  store: Store;
  assertAuthority(): void;
  authorizeSession(session: Session): Promise<boolean>;
}) {
  const root = path.resolve(options.root),
    stat = fs.lstatSync(root);
  if (
    fs.realpathSync(root) !== root ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    (stat.mode & 0o077) !== 0
  )
    throw new Error('unsafe_subscription_coordinator');
  const entries = new Map<string, { close(): Promise<void> }>();
  let closed = false;
  const authority = () => {
    if (closed) throw new Error('subscription_owner_closed');
    options.assertAuthority();
  };
  const closeSession = async (sessionId: string) => {
    const entry = entries.get(sessionId);
    entries.delete(sessionId);
    await entry?.close();
  };
  return {
    cached() {
      authority();
      return options.store.cached();
    },
    async prepare(session: Session, additionalAuthorization?: () => Promise<boolean>): Promise<VolumeMount> {
      authority();
      const allowed = async () => {
        authority();
        return (
          (await options.authorizeSession(session)) && (!additionalAuthorization || (await additionalAuthorization()))
        );
      };
      if (!(await allowed())) throw new Error('subscription_session_denied');
      await closeSession(session.id);
      const directory = fs.mkdtempSync(path.join(root, 'session-'));
      const socket = path.join(directory, 'credentials.sock');
      let broker: Awaited<ReturnType<typeof startSubscriptionBroker>> | undefined;
      try {
        broker = await startSubscriptionBroker({ socket, store: options.store, authorize: allowed });
        if (!(await allowed())) throw new Error('subscription_session_denied');
        const owned = broker;
        entries.set(session.id, {
          async close() {
            await owned.close();
            fs.rmSync(directory, { recursive: true, force: true });
          },
        });
        return { hostPath: socket, containerPath: '/run/nanoclaw/codex-credentials.sock', readonly: true };
      } catch (error) {
        await broker?.close();
        fs.rmSync(directory, { recursive: true, force: true });
        throw error;
      }
    },
    closeSession,
    async close() {
      closed = true;
      await Promise.all([...entries.keys()].map(closeSession));
    },
  };
}
export type SubscriptionCoordinator = ReturnType<typeof createSubscriptionCoordinator>;
let active: SubscriptionCoordinator | undefined;
export function subscriptionCoordinator() {
  return active;
}
/** Installed once by the trusted host lifecycle. Shutdown closes it without enabling legacy fallback. */
export function installSubscriptionCoordinator(coordinator: SubscriptionCoordinator) {
  if (active) throw new Error('subscription_owner_already_installed');
  active = coordinator;
  return () => {
    if (active === coordinator) active = undefined;
  };
}
