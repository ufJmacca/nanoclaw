import type Database from 'better-sqlite3';
import type { Session } from '../../../types.js';
import { cosBoundary } from '../../../cos-boundary.js';
import { hasTable } from '../../../db/connection.js';
import { digest, type Context } from '../domain/contracts.js';
import type { KnowledgeContext } from './store.js';
import { scheduledContext } from '../automation/scheduled-origin.js';

/** Read-only authority lookup. Missing history is never repaired or replaced by a tool request. */
export function resolveKnowledgeContext(
  session: Session,
  context: Context,
  db: Database.Database,
): KnowledgeContext | null {
  const boundary = cosBoundary(session, db);
  if (!boundary.restricted || !boundary.binding || boundary.paused) return null;
  if (context.origin) {
    const scheduled = scheduledContext(session, db);
    if (!scheduled || digest(scheduled) !== digest(context)) return null;
  } else if (boundary.ingressId !== context.ingressId || scheduledContext(session, db) !== undefined) return null;
  const binding = boundary.binding;
  if (
    binding.scopeId !== context.scopeId ||
    binding.ownerId !== context.ownerId ||
    binding.sessionId !== context.sessionId ||
    binding.agentGroupId !== context.agentGroupId
  )
    return null;
  if (!hasTable(db, 'cos_conversation_states')) return null;
  const row = db
    .prepare('SELECT binding_digest,generation,status FROM cos_conversation_states WHERE scope_id=?')
    .get(binding.scopeId) as { binding_digest: string; generation: string; status: string } | undefined;
  if (
    !row ||
    row.status !== 'active' ||
    row.binding_digest !== digest(binding) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.generation)
  )
    return null;
  return { ...context, provider: binding.provider, generation: row.generation };
}
