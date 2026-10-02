import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { hasTable } from '../../../db/connection.js';
import type { CosBinding } from '../../../cos-boundary.js';
import {
  cosMissionIdentities,
  hasCosMissionBoundary,
  installCosMissionBoundary,
  validCosMissionIdentity,
  type CosMissionIdentity,
} from '../../../cos-mission-boundary.js';
import { stopCosMissionAttempt } from '../../../cos-mission-stop.js';
import { digest, type Result } from '../domain/contracts.js';
import { inventoryRetainedTree, removeRetainedTree } from './conversation-purge.js';
import { privateConversationDirectory, syncConversationDirectory } from './conversation-ownership.js';
import { readPrivate, writeAtomic } from './target-state.js';

type Receipt = { version: 1; identity: CosMissionIdentity; bindingDigest: string; state: 'purged' };
/** Identities must first be resolved from the owned external mission ledger, never from worker arguments. */
export async function purgeMissionContexts(o: {
  root: string;
  dataRoot: string;
  db: Database.Database;
  binding: CosBinding;
  identities: CosMissionIdentity[];
  check(): Promise<void>;
  assertAuthority(): void;
  retire(identity: CosMissionIdentity): Promise<Result>;
}): Promise<Result> {
  const guard = () => {
    o.assertAuthority();
    const row = o.db
      .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
      .get(o.binding.scopeId) as { binding: string; paused: number } | undefined;
    if (!row || row.paused !== 1 || digest(JSON.parse(row.binding)) !== digest(o.binding))
      throw Error('mission_purge_authority_required');
    privateConversationDirectory(o.root);
  };
  guard();
  await o.check();
  guard();
  if (
    !Array.isArray(o.identities) ||
    o.identities.length > 1000 ||
    o.identities.some(
      (i) =>
        !validCosMissionIdentity(i) ||
        i.scopeId !== o.binding.scopeId ||
        i.sessionId === o.binding.sessionId ||
        i.agentGroupId === o.binding.agentGroupId,
    )
  )
    throw Error('unsafe_mission_purge');
  const identities = [...new Map(o.identities.map((i) => [i.attemptId, i])).values()];
  if (identities.some((i) => o.identities.some((j) => j.attemptId === i.attemptId && digest(i) !== digest(j))))
    throw Error('unsafe_mission_purge');
  const receipts = path.join(o.root, 'mission-purges');
  const present = (file: string) => !!fs.lstatSync(file, { throwIfNoEntry: false });
  const checkDirectory = (file: string) => {
    if (present(file)) privateConversationDirectory(file);
  };
  const checkDataParent = (file: string) => {
    if (!path.isAbsolute(file) || path.resolve(file) !== file) throw Error('unsafe_mission_purge');
    if (!present(file)) return;
    const stat = fs.lstatSync(file);
    if (fs.realpathSync(file) !== file || !stat.isDirectory() || stat.uid !== process.getuid?.() || stat.mode & 0o022)
      throw Error('unsafe_mission_purge');
  };
  checkDirectory(receipts);
  const snapshot = (i: CosMissionIdentity) => {
    const marker = cosMissionIdentities(o.db).find((row) => row.attemptId === i.attemptId);
    const allocation = hasTable(o.db, 'cos_mission_allocations')
      ? (o.db.prepare('SELECT * FROM cos_mission_allocations WHERE attempt_id=?').get(i.attemptId) as
          | { identity: string; stage: string }
          | undefined)
      : undefined;
    const group = o.db.prepare('SELECT * FROM agent_groups WHERE id=?').get(i.agentGroupId) as
      | { folder: string; agent_provider: string; name: string }
      | undefined;
    const session = o.db.prepare('SELECT * FROM sessions WHERE id=?').get(i.sessionId) as
      | { agent_group_id: string; agent_provider: string; messaging_group_id: string | null; thread_id: string | null }
      | undefined;
    if (marker ? digest(marker) !== digest(i) : hasCosMissionBoundary(i.agentGroupId, i.sessionId, o.db))
      throw Error('unsafe_mission_purge');
    if (
      allocation &&
      (!marker ||
        digest(JSON.parse(allocation.identity)) !== digest(i) ||
        !['intent', 'group', 'session', 'directories', 'context', 'transport', 'input'].includes(allocation.stage))
    )
      throw Error('unsafe_mission_purge');
    if (
      group &&
      (!allocation ||
        group.folder !== i.agentGroupId ||
        group.agent_provider !== 'codex' ||
        group.name !== 'CoS research')
    )
      throw Error('unsafe_mission_purge');
    if (
      session &&
      (!allocation ||
        session.agent_group_id !== i.agentGroupId ||
        session.agent_provider !== 'codex' ||
        session.messaging_group_id !== null ||
        session.thread_id !== null)
    )
      throw Error('unsafe_mission_purge');
    if (o.db.prepare('SELECT 1 FROM sessions WHERE agent_group_id=? AND id<>?').get(i.agentGroupId, i.sessionId))
      throw Error('unsafe_mission_purge');
    return { marker: marker ?? null, allocation: allocation ?? null, group: group ?? null, session: session ?? null };
  };
  const plans: Array<{
    identity: CosMissionIdentity;
    fingerprint: string;
    paths(): void;
    trees: ReturnType<typeof inventoryRetainedTree>[];
    inbound?: Database.Database;
  }> = [];
  try {
    // Validate every identity and tree before removing any member of this batch.
    for (const identity of identities) {
      const state = snapshot(identity),
        base = path.join(o.root, 'missions', identity.attemptId);
      const native = path.join(o.dataRoot, 'v2-sessions', identity.agentGroupId, identity.sessionId, 'cos-v1');
      const paths = () => {
        for (const dir of [o.dataRoot, path.join(o.dataRoot, 'v2-sessions')]) checkDataParent(dir);
        for (const dir of [
          path.join(o.root, 'missions'),
          base,
          path.dirname(path.dirname(native)),
          path.dirname(native),
          native,
          path.join(base, 'context'),
          path.join(base, 'provider'),
          path.join(native, 'agent'),
          path.join(native, 'outbox'),
        ])
          checkDirectory(dir);
      };
      paths();
      if (!state.allocation && (present(base) || present(path.dirname(path.dirname(native)))))
        throw Error('unsafe_mission_purge');
      const targets = [
        path.join(base, 'context'),
        path.join(base, 'provider'),
        path.join(native, 'agent'),
        path.join(native, 'outbox'),
      ];
      let receipt: Receipt | undefined;
      const receiptFile = path.join(receipts, identity.attemptId + '.json');
      if (present(receiptFile)) {
        const stat = fs.lstatSync(receiptFile);
        if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_mission_purge');
        receipt = readPrivate<Receipt>(receiptFile);
        if (
          receipt.version !== 1 ||
          receipt.state !== 'purged' ||
          digest(receipt.identity) !== digest(identity) ||
          receipt.bindingDigest !== digest(o.binding)
        )
          throw Error('unsafe_mission_purge');
        if (targets.some(present)) throw Error('mission_purge_conflict');
      }
      const trees = targets.filter(present).map(inventoryRetainedTree);
      const plan = {
        identity,
        fingerprint: digest(state),
        paths,
        trees,
        inbound: undefined as Database.Database | undefined,
      };
      plans.push(plan);
      const file = path.join(native, 'inbound.db');
      if (present(file)) {
        const original = fs.lstatSync(file),
          directories = plan.paths;
        plan.paths = () => {
          directories();
          const current = fs.lstatSync(file);
          if (current.dev !== original.dev || current.ino !== original.ino) throw Error('unsafe_mission_purge');
          for (const suffix of ['', '-wal', '-shm', '-journal']) {
            if (!present(file + suffix)) continue;
            const stat = fs.lstatSync(file + suffix);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.nlink !== 1 ||
              stat.uid !== process.getuid?.() ||
              stat.mode & 0o022
            )
              throw Error('unsafe_mission_purge');
          }
        };
        plan.paths();
        plan.inbound = new Database(file, { fileMustExist: true });
        if (
          receipt &&
          hasTable(plan.inbound, 'cos_rpc_contexts') &&
          plan.inbound
            .prepare('SELECT 1 FROM cos_rpc_contexts WHERE scope_id=? AND session_id=? AND generation=?')
            .get(identity.scopeId, identity.sessionId, identity.attemptId)
        )
          throw Error('mission_purge_conflict');
      }
    }
    await o.check();
    guard();
    for (const plan of plans) {
      if (digest(snapshot(plan.identity)) !== plan.fingerprint) throw Error('unsafe_mission_purge');
      installCosMissionBoundary(plan.identity, o.db);
      stopCosMissionAttempt(plan.identity, 'authority_lost', o.db);
      plan.fingerprint = digest(snapshot(plan.identity));
      const result = await o.retire(plan.identity);
      if (result.status !== 'ok') return result;
      guard();
    }
    await o.check();
    guard();
    if (!present(receipts)) {
      fs.mkdirSync(receipts, { mode: 0o700 });
      syncConversationDirectory(o.root);
    }
    checkDirectory(receipts);
    for (const plan of plans) {
      const current = () => {
        guard();
        checkDirectory(receipts);
        plan.paths();
        if (digest(snapshot(plan.identity)) !== plan.fingerprint) throw Error('unsafe_mission_purge');
      };
      current();
      for (const tree of plan.trees) removeRetainedTree(tree, current);
      const inbound = plan.inbound,
        i = plan.identity;
      if (inbound && hasTable(inbound, 'cos_rpc_contexts') && hasTable(inbound, 'cos_rpc_responses')) {
        inbound.pragma('secure_delete=ON');
        inbound.transaction(() => {
          current();
          inbound
            .prepare(
              `DELETE FROM cos_rpc_responses WHERE EXISTS(SELECT 1 FROM cos_rpc_contexts c WHERE c.request_id=cos_rpc_responses.request_id AND c.payload_hash=cos_rpc_responses.payload_hash AND c.delivery_id=cos_rpc_responses.delivery_id AND c.scope_id=? AND c.session_id=? AND c.generation=?)`,
            )
            .run(i.scopeId, i.sessionId, i.attemptId);
          inbound
            .prepare('DELETE FROM cos_rpc_contexts WHERE scope_id=? AND session_id=? AND generation=?')
            .run(i.scopeId, i.sessionId, i.attemptId);
        })();
        inbound.pragma('wal_checkpoint(TRUNCATE)');
      }
      current();
      writeAtomic(receipts, i.attemptId + '.json', {
        version: 1,
        identity: i,
        bindingDigest: digest(o.binding),
        state: 'purged',
      } satisfies Receipt);
    }
    await o.check();
    guard();
    return { status: 'ok', attempts: identities.length };
  } finally {
    for (const plan of plans) plan.inbound?.close();
  }
}
