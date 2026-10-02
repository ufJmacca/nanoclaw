import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { missionBoundary } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped, stopCosMissionAttempt } from '../../../cos-mission-stop.js';
import { currentRelease, releaseMode, selectReleaseImage } from '../../../release-runtime.js';
import { subscriptionCoordinator } from '../../../providers/codex-subscription-coordinator.js';
import { digest } from '../domain/contracts.js';
import { readPrivate } from '../ops/target-state.js';
import { subscriptionActivation, reserveSubscriptionAttempt, ensureModelBudget } from '../bridge/model-policy.js';
import { startSubscriptionTurns } from '../bridge/subscription-turns.js';
import { startSubscriptionEgress } from '../bridge/subscription-egress.js';
import { restrictedLaunch } from '../bridge/restricted-launch.js';
import type { MissionLauncher } from './dispatch.js';
import type { MissionRunStore } from './run-store.js';
import type { NativeMissionInput, NativeMissionPaths } from './native-allocation.js';
import type { MissionAuthorityResolver } from './proposal-store.js';

/** Uses the existing subscription owner; never prepares or resets the main CoS conversation. */
export function createMissionLauncher(options: {
  targetRoot: string;
  db: Database.Database;
  runs: Pick<MissionRunStore, 'reserve'>;
  running(sessionId: string): boolean;
  authority: MissionAuthorityResolver;
}): MissionLauncher & { shutdown(): Promise<void> } {
  ensureModelBudget(options.db);
  const entries = new Map<string, { close(): Promise<void> }>(),
    preparing = new Set<string>();
  let closed = false;
  const close = async (sessionId: string) => {
    const entry = entries.get(sessionId);
    entries.delete(sessionId);
    await entry?.close();
  };
  const exactAllocation = (input: NativeMissionInput, paths: NativeMissionPaths, session: Session) => {
    const i = input.identity;
    const actual = options.db.prepare('SELECT * FROM sessions WHERE id=?').get(i.sessionId) as Session | undefined;
    if (!actual || session.id !== i.sessionId || session.agent_group_id !== i.agentGroupId) return false;
    for (const candidate of [session, actual]) {
      const boundary = missionBoundary(candidate, options.db);
      if (!boundary.restricted || !boundary.identity || digest(boundary.identity) !== digest(i)) return false;
    }
    const row = options.db.prepare('SELECT * FROM cos_mission_allocations WHERE attempt_id=?').get(i.attemptId) as
      | { identity: string; input_id: string; payload_digest: string; stage: string }
      | undefined;
    return (
      !!row &&
      row.stage === 'input' &&
      row.input_id === input.inputId &&
      digest(JSON.parse(row.identity)) === digest(i) &&
      row.payload_digest ===
        digest({
          identity: i,
          inputId: input.inputId,
          workOrder: input.order.digest,
          context: input.order.body.contextDigest,
          paths,
        }) &&
      digest(input.order.body) === input.order.digest &&
      digest(input.order.context) === input.order.body.contextDigest &&
      !isCosMissionStopped(i, options.db)
    );
  };
  return {
    close,
    async prepare(input, paths, session, authorize) {
      const i = input.identity;
      if (closed || preparing.has(i.sessionId) || options.running(i.sessionId))
        throw new Error('mission_launch_denied');
      preparing.add(i.sessionId);
      let cleanup: (() => Promise<void>) | undefined;
      try {
        const owner = subscriptionCoordinator(),
          release = currentRelease();
        if (!owner || !release || !releaseMode() || !exactAllocation(input, paths, session))
          throw new Error('mission_launch_denied');
        const activation = () => {
          if (subscriptionCoordinator() !== owner || !releaseMode()) return null;
          const account = JSON.parse(owner.cached().authJson)?.tokens?.account_id;
          if (typeof account !== 'string' || !account || account.length > 65536) return null;
          const policy = subscriptionActivation(
            readPrivate(path.join(options.targetRoot, 'model-activation.json')),
            i.scopeId,
            createHash('sha256').update(account).digest('hex'),
          );
          const body = input.order.body;
          const origin = body.origin;
          const authority = options.authority({
            scopeId: origin.scopeId,
            ownerId: origin.ownerId,
            agentGroupId: origin.agentGroupId,
            sessionId: origin.sessionId,
            ingressId: origin.ingressId,
          });
          return policy &&
            policy.model === body.provider.model &&
            digest(policy) === body.provider.policyDigest &&
            authority &&
            authority.contextGeneration === origin.contextGeneration &&
            authority.bindingDigest === origin.bindingDigest &&
            authority.delegationDigest === origin.delegationDigest &&
            digest(authority.provider) === digest(body.provider)
            ? policy
            : null;
        };
        const policy = activation();
        if (!policy || !(await authorize())) throw new Error('mission_launch_denied');
        const image = await selectReleaseImage(release, 'codex', { apt: [], npm: [] });
        await close(i.sessionId);
        const control = fs.lstatSync(paths.controlDirectory);
        if (
          !control.isDirectory() ||
          control.uid !== process.getuid?.() ||
          (control.mode & 0o777) !== 0o700 ||
          fs.realpathSync(paths.controlDirectory) !== paths.controlDirectory
        )
          throw new Error('mission_launch_denied');
        // Unix socket paths cannot use the deeply nested per-attempt workspace.
        const target = fs.lstatSync(options.targetRoot);
        if (
          !target.isDirectory() ||
          target.uid !== process.getuid?.() ||
          (target.mode & 0o777) !== 0o700 ||
          fs.realpathSync(options.targetRoot) !== options.targetRoot
        )
          throw new Error('mission_launch_denied');
        const directory = fs.mkdtempSync(path.join(options.targetRoot, 'mission-'));
        fs.chmodSync(directory, 0o700);
        let entryClosed = false,
          fenced = false;
        const resources: {
          gateway?: Awaited<ReturnType<typeof startSubscriptionEgress>>;
          turns?: Awaited<ReturnType<typeof startSubscriptionTurns>>;
        } = {};
        const fence = () => {
          fenced = true;
          try {
            stopCosMissionAttempt(i, 'authority_lost', options.db);
          } catch {
            // eslint-disable-next-line no-catch-all/no-catch-all -- Retain the in-process denial if the durable stop journal itself is unavailable; dispatcher reconciliation must retry it.
            /* No access is granted by a failed stop-journal write. */
          }
        };
        const allowed = async () => {
          // Every callback rechecks native identity, local stops, original deadline, model consent,
          // and the dispatcher's PostgreSQL/private-origin authority. Errors always close admission.
          try {
            if (closed || entryClosed || fenced) return false;
            if (
              !exactAllocation(input, paths, session) ||
              Date.parse(input.order.body.deadlineAt) <= Date.now() ||
              !(await authorize())
            ) {
              fence();
              return false;
            }
            const current = activation();
            const accepted =
              !closed &&
              !entryClosed &&
              !!current &&
              digest(current) === digest(policy) &&
              exactAllocation(input, paths, session) &&
              Date.parse(input.order.body.deadlineAt) > Date.now();
            if (!accepted) fence();
            return accepted;
            // eslint-disable-next-line no-catch-all/no-catch-all -- Any uncertain mission authority must close credential and model access.
          } catch {
            fence();
            return false;
          }
        };
        cleanup = async () => {
          entryClosed = true;
          await resources.gateway?.close();
          await resources.turns?.close();
          await owner.closeSession(i.sessionId);
          fs.rmSync(directory, { recursive: true, force: true });
        };
        if (!(await allowed())) throw new Error('mission_launch_denied');
        const credential = await owner.prepare(session, allowed);
        const socket = path.join(directory, 'model.sock'),
          turnSocket = path.join(directory, 'turn.sock'),
          configuration = path.join(directory, 'config.json');
        if (Buffer.byteLength(socket) > 103 || Buffer.byteLength(turnSocket) > 103)
          throw new Error('mission_launch_denied');
        const binding = {
          missionId: i.missionId,
          attemptId: i.attemptId,
          inputId: input.inputId,
          generation: i.generation,
          workOrderDigest: input.order.digest,
          contextDigest: input.order.body.contextDigest,
          templateDigest: input.order.body.template.digest,
        };
        fs.writeFileSync(
          configuration,
          JSON.stringify({
            provider: 'codex',
            model: policy.model,
            runtime: 'codex-subscription/v1',
            profile: 'research',
            contextGeneration: i.attemptId,
            agentGroupId: i.agentGroupId,
            assistantName: 'CoS Research',
            groupName: 'CoS Research',
            maxMessagesPerPrompt: 1,
            mcpServers: {},
            mission: binding,
          }),
          { mode: 0o600, flag: 'wx' },
        );
        resources.turns = await startSubscriptionTurns({
          socket: turnSocket,
          authorize: allowed,
          reserve: async (turnId) => {
            try {
              if (!(await allowed())) return false;
              const reservation = await options.runs.reserve(
                i,
                'model-' + turnId,
                'model',
                digest({ workOrder: input.order.digest, inputId: input.inputId, turnId, policy: digest(policy) }),
              );
              if (reservation.status !== 'ok') fence();
              return (
                reservation.status === 'ok' &&
                reservation.reserved === true &&
                (await allowed()) &&
                reserveSubscriptionAttempt(options.db, policy, input.order.body.origin.ingressId, turnId)
              );
              // eslint-disable-next-line no-catch-all/no-catch-all -- An uncertain reservation is never retried as a fresh grant on this worker.
            } catch {
              fence();
              return false;
            }
          },
        });
        const turnControl = resources.turns;
        resources.gateway = await startSubscriptionEgress({
          socketPath: socket,
          role: 'query',
          authorize: () => turnControl.allowed(),
        });
        if (!(await allowed())) throw new Error('mission_launch_denied');
        const launch = restrictedLaunch({
          image,
          sessionDirectory: paths.sessionDirectory,
          configurationFile: configuration,
          gatewaySocket: socket,
          uid: process.getuid!(),
          gid: process.getgid!(),
          entry: 'research',
          research: { contextDirectory: paths.contextDirectory, binding },
          subscription: {
            providerDirectory: paths.providerDirectory,
            credentialSocket: credential.hostPath,
            turnSocket,
            contextGeneration: i.attemptId,
          },
        });
        if (!(await allowed())) throw new Error('mission_launch_denied');
        entries.set(i.sessionId, { close: cleanup });
        return launch;
      } catch (error) {
        await cleanup?.();
        throw new Error('mission_launch_denied', { cause: error });
      } finally {
        preparing.delete(i.sessionId);
      }
    },
    async shutdown() {
      closed = true;
      await Promise.all([...entries.keys()].map(close));
    },
  };
}
