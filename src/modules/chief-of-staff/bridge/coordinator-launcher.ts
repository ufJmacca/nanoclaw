import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { CosBinding, CosLaunch } from '../../../cos-boundary.js';
import { currentRelease, releaseMode, selectReleaseImage } from '../../../release-runtime.js';
import { subscriptionCoordinator } from '../../../providers/codex-subscription-coordinator.js';
import { sessionDir } from '../../../session-manager.js';
import { digest } from '../domain/contracts.js';
import { readPrivate } from '../ops/target-state.js';
import { subscriptionActivation, reserveSubscriptionAttempt } from './model-policy.js';
import { createConversationState } from './conversation-state.js';
import { startSubscriptionEgress } from './subscription-egress.js';
import { startSubscriptionTurns } from './subscription-turns.js';
import { restrictedLaunch } from './restricted-launch.js';
import type { TurnAuthorization } from './turn-authorization.js';

export type CoordinatorLauncher = {
  ready(binding: CosBinding): boolean;
  prepare(binding: CosBinding, session: Session, authorize: TurnAuthorization): Promise<CosLaunch>;
};
/** Native subscription only. Deployment never creates a model activation. */
export function createCoordinatorLauncher(options: { targetRoot: string; db: Database.Database }) {
  let closed = false;
  let conversations: ReturnType<typeof createConversationState> | undefined;
  const contexts = () => (conversations ??= createConversationState(options.targetRoot, options.db));
  const entries = new Map<string, { close(): Promise<void> }>();
  const context = (binding: CosBinding) => {
    const owner = subscriptionCoordinator();
    if (closed || !owner || !releaseMode() || binding.provider !== 'codex') throw new Error('restricted_launch_denied');
    const account = JSON.parse(owner.cached().authJson)?.tokens?.account_id;
    if (typeof account !== 'string' || !account || account.length > 65536) throw new Error('restricted_launch_denied');
    const accountFingerprint = createHash('sha256').update(account).digest('hex');
    return { ...contexts().prepare(binding, accountFingerprint), accountFingerprint };
  };
  const activation = (binding: CosBinding) => {
    try {
      const retained = context(binding);
      const policy = subscriptionActivation(
        readPrivate(path.join(options.targetRoot, 'model-activation.json')),
        binding.scopeId,
        retained.accountFingerprint,
      );
      return policy?.contextGeneration === retained.generation ? { policy, retained } : null;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Missing consent, private state or credentials all make the native launcher unavailable.
    } catch {
      return null;
    }
  };
  return {
    context,
    invalidate(scopeId: string) {
      contexts().invalidate(scopeId, 'access_changed');
    },
    ready: (binding: CosBinding) => activation(binding) !== null,
    async prepare(binding: CosBinding, session: Session, authorize: TurnAuthorization): Promise<CosLaunch> {
      const admitted = activation(binding),
        release = currentRelease(),
        owner = subscriptionCoordinator();
      if (!admitted || !release || !owner || binding.sessionId !== session.id || !(await authorize()))
        throw new Error('restricted_launch_denied');
      const { policy, retained } = admitted;
      const image = await selectReleaseImage(release, 'codex', { apt: [], npm: [] });
      await entries.get(session.id)?.close();
      entries.delete(session.id);
      const directory = fs.mkdtempSync(path.join(options.targetRoot, 'model-'));
      fs.chmodSync(directory, 0o700);
      let gateway: Awaited<ReturnType<typeof startSubscriptionEgress>> | undefined;
      let turns: Awaited<ReturnType<typeof startSubscriptionTurns>> | undefined;
      let entryClosed = false;
      const allowed = async () => {
        if (entryClosed || closed || subscriptionCoordinator() !== owner) return false;
        if (!(await authorize('poll'))) return false;
        const fresh = activation(binding);
        return (
          !entryClosed &&
          !closed &&
          !!fresh &&
          digest(fresh) === digest(admitted) &&
          contexts().current(binding, retained.accountFingerprint, retained.generation)
        );
      };
      const close = async () => {
        entryClosed = true;
        await gateway?.close();
        await turns?.close();
        await owner.closeSession(session.id);
        fs.rmSync(directory, { recursive: true, force: true });
      };
      try {
        const socket = path.join(directory, 'model.sock'),
          turnSocket = path.join(directory, 'turn.sock'),
          configuration = path.join(directory, 'config.json');
        const credential = await owner.prepare(session, allowed);
        fs.writeFileSync(
          configuration,
          JSON.stringify({
            provider: 'codex',
            model: policy.model,
            runtime: 'codex-subscription/v1',
            contextGeneration: retained.generation,
            agentGroupId: binding.agentGroupId,
            assistantName: 'CoS',
            groupName: 'CoS',
            maxMessagesPerPrompt: 10,
            mcpServers: {},
          }),
          { mode: 0o600, flag: 'wx' },
        );
        turns = await startSubscriptionTurns({
          socket: turnSocket,
          authorize: allowed,
          reserve: async (attemptId) => {
            const ingress = await authorize();
            return !!ingress && (await allowed()) && reserveSubscriptionAttempt(options.db, policy, ingress, attemptId);
          },
        });
        const turnControl = turns;
        gateway = await startSubscriptionEgress({
          socketPath: socket,
          role: 'query',
          authorize: () => turnControl.allowed(),
        });
        if (!(await allowed())) throw new Error('restricted_launch_denied');
        const launch = restrictedLaunch({
          image,
          sessionDirectory: sessionDir(binding.agentGroupId, session.id),
          configurationFile: configuration,
          gatewaySocket: socket,
          uid: process.getuid!(),
          gid: process.getgid!(),
          entry: 'coordinator',
          subscription: {
            providerDirectory: retained.directory,
            credentialSocket: credential.hostPath,
            turnSocket,
            contextGeneration: retained.generation,
          },
        });
        entries.set(session.id, { close });
        return launch;
      } catch (error) {
        await close();
        throw new Error('restricted_launch_denied', { cause: error });
      }
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map((entry) => entry.close()));
      entries.clear();
    },
  };
}
