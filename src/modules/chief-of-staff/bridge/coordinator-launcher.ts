import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import type { CosBinding, CosLaunch } from '../../../cos-boundary.js';
import { currentRelease, releaseMode, selectReleaseImage } from '../../../release-runtime.js';
import { sessionDir } from '../../../session-manager.js';
import { digest } from '../domain/contracts.js';
import { readPrivate } from '../ops/target-state.js';
import { modelActivation, reserveModelRequest } from './model-policy.js';
import { startModelGateway } from './model-gateway.js';
import { restrictedLaunch } from './restricted-launch.js';

export type CoordinatorLauncher = {
  ready(binding: CosBinding): boolean;
  prepare(binding: CosBinding, session: Session, authorize: () => Promise<string | null>): Promise<CosLaunch>;
};
/** No activation file is created implicitly. It represents separately granted model consent and quota. */
export function createCoordinatorLauncher(options: { targetRoot: string; apiKey?: string; db: Database.Database }) {
  let closed = false;
  const entries = new Map<string, { close(): Promise<void> }>();
  const activation = (binding: CosBinding) => {
    if (closed || !options.apiKey || !releaseMode() || binding.provider !== 'codex') return null;
    try {
      return modelActivation(readPrivate(path.join(options.targetRoot, 'model-activation.json')), binding.scopeId);
    } catch {
      return null;
    }
  };
  const launcher: CoordinatorLauncher & { close(): Promise<void> } = {
    ready: (binding) => activation(binding) !== null,
    async prepare(binding, session, authorize) {
      const policy = activation(binding),
        release = currentRelease();
      if (!policy || !release || !(await authorize())) throw new Error('restricted_launch_denied');
      const image = await selectReleaseImage(release, 'codex', { apt: [], npm: [] });
      await entries.get(session.id)?.close();
      entries.delete(session.id);
      const directory = fs.mkdtempSync(path.join(options.targetRoot, 'model-'));
      fs.chmodSync(directory, 0o700);
      let gateway: Awaited<ReturnType<typeof startModelGateway>> | undefined;
      try {
        const socket = path.join(directory, 'model.sock'),
          configuration = path.join(directory, 'config.json');
        fs.writeFileSync(
          configuration,
          JSON.stringify({
            provider: 'codex',
            model: policy.model,
            agentGroupId: binding.agentGroupId,
            assistantName: 'CoS',
            groupName: 'CoS',
            maxMessagesPerPrompt: 10,
            mcpServers: {},
          }),
          { mode: 0o600, flag: 'wx' },
        );
        gateway = await startModelGateway({
          socket,
          model: policy.model,
          apiKey: options.apiKey!,
          authorize: async () => {
            const ingress = await authorize(),
              fresh = activation(binding);
            return (
              !!ingress &&
              !!fresh &&
              digest(fresh) === digest(policy) &&
              reserveModelRequest(options.db, fresh, ingress)
            );
          },
        });
        if (!activation(binding) || !(await authorize())) throw new Error('restricted_launch_denied');
        const launch = restrictedLaunch({
          image,
          sessionDirectory: sessionDir(binding.agentGroupId, session.id),
          configurationFile: configuration,
          gatewaySocket: socket,
          uid: process.getuid!(),
          gid: process.getgid!(),
          entry: 'coordinator',
        });
        const ownedGateway = gateway;
        entries.set(session.id, {
          async close() {
            await ownedGateway.close();
            fs.rmSync(directory, { recursive: true, force: true });
          },
        });
        return launch;
      } catch (error) {
        await gateway?.close();
        fs.rmSync(directory, { recursive: true, force: true });
        throw new Error('restricted_launch_denied', { cause: error });
      }
    },
    async close() {
      closed = true;
      await Promise.all([...entries.values()].map((entry) => entry.close()));
      entries.clear();
    },
  };
  return launcher;
}
