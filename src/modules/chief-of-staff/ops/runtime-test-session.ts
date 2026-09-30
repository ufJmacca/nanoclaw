import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { readPrivate, readTarget, writeAtomic, type TargetBinding } from './target-state.js';
import {
  admittedGeneration,
  beginMaintenance,
  confirmQuiescence,
  assertMaintenanceLease,
  finishMaintenance,
  type MaintenanceLease,
} from './maintenance.js';

export type RuntimeTestEffects = {
  /** Verify the installed host, actual database identity and current schema, without mutating ordinary NanoClaw. */
  verify(): Promise<void>;
  /** The durable latch is already closed. Drain only CoS and prove no database writer remains. */
  quiesce(): Promise<{ activeCoordinators: number; activeDatabaseOperations: number }>;
  /** Refuse completion while a Mac database fence remains held or the installed schema is incompatible. */
  compatible(): Promise<boolean>;
};
type SessionRecord = {
  version: 1;
  bindingDigest: string;
  owner: string;
  releaseId: string;
  reopen: boolean;
  lease: MaintenanceLease | null;
  phase: 'pending' | 'finishing' | 'complete';
};
/** Live stdin/stdout control channel under the Pi OS lock. EOF never reopens the durable latch. */
export async function serveRuntimeTestSession(request: {
  root: string;
  binding: TargetBinding;
  owner: string;
  effects: RuntimeTestEffects;
  input: AsyncIterable<unknown>;
  send(value: Record<string, unknown>): Promise<void>;
}) {
  const { root, binding, owner, effects, input, send } = request;
  if (!/^[a-zA-Z0-9_-]{1,120}$/.test(owner)) throw new Error('invalid_runtime_test_owner');
  let record: SessionRecord | undefined;
  const challenges = new Set<string>();
  const directory = path.join(root, 'runtime-tests'),
    file = path.join(directory, owner + '.json');
  const save = () => writeAtomic(directory, owner + '.json', record);
  const response = (challenge: string, status: string) =>
    send({
      challenge,
      status,
      owner,
      lease: record!.lease,
      releaseId: record!.releaseId,
      databaseFingerprint: binding.databaseFingerprint,
      bindingDigest: digest(binding),
      lifecycle: 'implementation_disposable',
      reopened: status === 'complete' ? record!.reopen : false,
    });
  for await (const value of input) {
    const message = value as { action?: string; challenge?: string };
    if (
      !message ||
      Object.keys(message).some((key) => !['action', 'challenge'].includes(key)) ||
      !['begin', 'check', 'finish', 'abort'].includes(message.action ?? '') ||
      !/^[a-f0-9-]{36}$/.test(message.challenge ?? '') ||
      challenges.has(message.challenge!) ||
      challenges.size >= 4096
    )
      throw new Error('runtime_test_protocol_invalid');
    const challenge = message.challenge!;
    challenges.add(challenge);
    if (!record) {
      if (message.action !== 'begin') throw new Error('runtime_test_protocol_invalid');
      await effects.verify();
      const state = readTarget(root, binding);
      if (state.lifecycle !== 'implementation_disposable') throw new Error('protected_target');
      if (!state.releaseId) throw new Error('installed_runtime_test_helper_required');
      if (state.maintenanceId) {
        const active = readPrivate<MaintenanceLease>(path.join(root, 'maintenance.json'));
        if (active.owner !== owner || active.purpose !== 'runtime-disposable') throw new Error('maintenance_owned');
      }
      if (!fs.lstatSync(directory, { throwIfNoEntry: false })) fs.mkdirSync(directory, { mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (
        !stat.isDirectory() ||
        fs.realpathSync(directory) !== directory ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o777) !== 0o700
      )
        throw new Error('unsafe_runtime_test_history');
      if (fs.lstatSync(file, { throwIfNoEntry: false })) {
        record = readPrivate<SessionRecord>(file);
        if (
          record.version !== 1 ||
          record.bindingDigest !== digest(binding) ||
          record.owner !== owner ||
          record.releaseId !== state.releaseId ||
          typeof record.reopen !== 'boolean' ||
          !['pending', 'finishing', 'complete'].includes(record.phase)
        )
          throw new Error('runtime_test_history_conflict');
      } else {
        if (state.maintenanceId) throw new Error('runtime_test_history_conflict');
        record = {
          version: 1,
          bindingDigest: digest(binding),
          owner,
          releaseId: state.releaseId,
          reopen: admittedGeneration(root, binding) !== null,
          lease: null,
          phase: 'pending',
        };
        save();
      }
      if (record.phase === 'complete' || (record.phase === 'finishing' && !state.maintenanceId)) {
        const completed = readPrivate<MaintenanceLease & { phase: string; reopen: boolean }>(
          path.join(root, 'maintenance.json'),
        );
        if (
          !record.lease ||
          completed.nonce !== record.lease.nonce ||
          completed.phase !== 'complete' ||
          completed.reopen !== record.reopen ||
          state.generation !== record.lease.generation + 1 ||
          state.maintenance !== !record.reopen
        )
          throw new Error('runtime_test_history_conflict');
        record.phase = 'complete';
        save();
        await response(challenge, 'complete');
        return;
      }
      const lease = beginMaintenance(root, binding, owner, 'runtime-disposable');
      if (record.lease && digest(record.lease) !== digest(lease)) throw new Error('runtime_test_history_conflict');
      record.lease = lease;
      save();
      await confirmQuiescence(root, binding, lease, effects.quiesce);
      // A failed compatibility check can be retried under the original lease; no stale snapshot grants admission.
      record.phase = 'pending';
      save();
      await response(challenge, 'ready');
      continue;
    }
    if (message.action === 'begin') throw new Error('runtime_test_protocol_invalid');
    const state = assertMaintenanceLease(root, binding, record.lease!);
    if (state.releaseId !== record.releaseId) throw new Error('runtime_test_history_conflict');
    if (message.action === 'check') {
      await response(challenge, 'ready');
      continue;
    }
    if (message.action === 'abort') {
      await response(challenge, 'paused');
      return;
    }
    record.phase = 'finishing';
    save();
    await finishMaintenance(root, binding, record.lease!, effects.compatible, record.reopen);
    record.phase = 'complete';
    save();
    await response(challenge, 'complete');
    return;
  }
}
