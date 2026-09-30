/** Retention consumer, reachable only under owner maintenance and native-writer quiescence. */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';
import { digest, type Result } from '../domain/contracts.js';
import { ensureRpcSchema } from '../bridge/rpc.js';
import { writeAtomic } from './target-state.js';
import {
  contextGenerationPattern,
  privateConversationDirectory,
  readConversationOwner,
  syncConversationDirectory,
} from './conversation-ownership.js';
export type RetainedContext = { sessionId: string; generation: string };
type Entry = { file: string; stat: fs.Stats };
function inventory(root: string): Entry[] {
  const entries: Entry[] = [];
  const visit = (file: string, depth: number) => {
    if (depth > 64 || entries.length >= 100000) throw new Error('unsafe_conversation_purge');
    const stat = fs.lstatSync(file);
    if (
      stat.uid !== process.getuid?.() ||
      stat.isSymbolicLink() ||
      stat.mode & 0o022 ||
      !(stat.isDirectory() || (stat.isFile() && stat.nlink === 1))
    )
      throw new Error('unsafe_conversation_purge');
    entries.push({ file, stat });
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name), depth + 1);
  };
  visit(root, 0);
  return entries;
}
export async function purgeRetiredContexts(o: {
  root: string;
  db: Database.Database;
  inbound: Database.Database;
  binding: CosBinding;
  contexts: RetainedContext[];
  check(): Promise<void>;
  assertAuthority(): void;
}): Promise<Result> {
  const guard = () => {
    o.assertAuthority();
    const boundary = o.db
      .prepare('SELECT binding,paused FROM cos_identity_boundaries WHERE scope_id=?')
      .get(o.binding.scopeId) as { binding: string; paused: number } | undefined;
    if (!boundary || boundary.paused !== 1 || digest(JSON.parse(boundary.binding)) !== digest(o.binding))
      throw new Error('conversation_purge_authority_required');
  };
  guard();
  await o.check();
  guard();
  if (
    !Array.isArray(o.contexts) ||
    o.contexts.length > 1000 ||
    o.contexts.some((c) => !c || c.sessionId !== o.binding.sessionId || !contextGenerationPattern.test(c.generation))
  )
    throw new Error('unsafe_conversation_ownership');
  const generations = [...new Set(o.contexts.map((c) => c.generation))];
  privateConversationDirectory(o.root);
  const histories = path.join(o.root, 'conversations');
  privateConversationDirectory(histories);
  const plans = [];
  // Validate the whole batch before removing any file. Evidence alone cannot claim another local context.
  for (const generation of generations) {
    const owner = readConversationOwner(o.root, generation, o.binding);
    if (o.db.prepare('SELECT 1 FROM cos_conversation_states WHERE generation=?').get(generation))
      return { status: 'pending', code: 'context_recovery_required' };
    const directory = path.join(histories, generation),
      present = !!fs.lstatSync(directory, { throwIfNoEntry: false });
    if (owner.state === 'purged' && present) throw new Error('conversation_purge_conflict');
    if (present) privateConversationDirectory(directory);
    plans.push({ generation, owner, entries: present ? inventory(directory) : [] });
  }
  await o.check();
  guard();
  for (const plan of plans) {
    if (o.db.prepare('SELECT 1 FROM cos_conversation_states WHERE generation=?').get(plan.generation))
      return { status: 'pending', code: 'context_recovery_required' };
    for (const entry of plan.entries.reverse()) {
      guard();
      const now = fs.lstatSync(entry.file);
      if (
        now.dev !== entry.stat.dev ||
        now.ino !== entry.stat.ino ||
        now.isSymbolicLink() ||
        now.uid !== process.getuid?.() ||
        now.mode & 0o022 ||
        (!now.isDirectory() &&
          (!now.isFile() || now.nlink !== 1 || now.size !== entry.stat.size || now.mtimeMs !== entry.stat.mtimeMs))
      )
        throw new Error('unsafe_conversation_purge');
      if (now.isDirectory()) fs.rmdirSync(entry.file);
      else fs.unlinkSync(entry.file);
      syncConversationDirectory(path.dirname(entry.file));
    }
    guard();
    // Only host-owned CoS response cache rows carry this generation's provenance.
    // Native messages, approvals and ordinary untagged RPC data are preserved.
    ensureRpcSchema(o.inbound);
    o.inbound.transaction(() => {
      guard();
      o.inbound
        .prepare(
          `DELETE FROM cos_rpc_responses WHERE EXISTS(SELECT 1 FROM cos_rpc_contexts c
        WHERE c.request_id=cos_rpc_responses.request_id AND c.payload_hash=cos_rpc_responses.payload_hash
          AND c.delivery_id=cos_rpc_responses.delivery_id AND c.scope_id=? AND c.session_id=? AND c.generation=?)`,
        )
        .run(o.binding.scopeId, o.binding.sessionId, plan.generation);
      o.inbound
        .prepare('DELETE FROM cos_rpc_contexts WHERE scope_id=? AND session_id=? AND generation=?')
        .run(o.binding.scopeId, o.binding.sessionId, plan.generation);
    })();
    writeAtomic(path.join(o.root, 'conversation-owners'), plan.generation + '.json', {
      ...plan.owner,
      state: 'purged',
    });
  }
  await o.check();
  guard();
  return { status: 'ok', generations: generations.length };
}
