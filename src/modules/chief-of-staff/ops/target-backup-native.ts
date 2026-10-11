import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { CosBinding } from '../../../cos-boundary.js';

/** Parse an already admitted native database, including read-only recovered memory.
 * These identities are evidence; parsing never binds or activates a host writer. */
export function readBackupNativeIdentity(db: Database.Database) {
  const rows = db
    .prepare(
      'SELECT scope_id,agent_group_id,messaging_group_id,session_id,binding FROM cos_identity_boundaries LIMIT 2',
    )
    .all() as Array<Record<string, string>>;
  if (rows.length !== 1) throw new Error('action_backup_binding_required');
  const row = rows[0],
    binding = JSON.parse(row.binding) as CosBinding;
  const ids = [
    'scopeId',
    'ownerId',
    'botId',
    'instanceId',
    'channelId',
    'agentGroupId',
    'messagingGroupId',
    'sessionId',
  ] as const;
  if (
    !binding ||
    Object.keys(binding).length !== 9 ||
    binding.provider !== 'codex' ||
    ids.some((key) => typeof binding[key] !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(binding[key])) ||
    binding.ownerId === binding.botId ||
    binding.scopeId !== row.scope_id ||
    binding.agentGroupId !== row.agent_group_id ||
    binding.sessionId !== row.session_id ||
    binding.messagingGroupId !== row.messaging_group_id
  )
    throw new Error('action_backup_binding_required');
  const sessions = db.prepare('SELECT id,agent_group_id FROM sessions ORDER BY id LIMIT 10001').all() as Array<{
    id: string;
    agent_group_id: string;
  }>;
  if (
    sessions.length > 10000 ||
    !sessions.some((s) => s.id === binding.sessionId && s.agent_group_id === binding.agentGroupId)
  )
    throw new Error('action_backup_binding_required');
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length)
    throw new Error('unsafe_session_reference');
  for (const session of sessions) {
    if ([session.id, session.agent_group_id].some((id) => !/^[a-zA-Z0-9_-]{1,200}$/.test(id)))
      throw new Error('unsafe_session_reference');
  }
  return { binding, sessions };
}
export function backupNativeDatabaseCandidates(
  dataRoot: string,
  sessions: ReturnType<typeof readBackupNativeIdentity>['sessions'],
) {
  const databases = [path.join(dataRoot, 'v2.db')];
  for (const session of sessions) {
    if ([session.id, session.agent_group_id].some((id) => !/^[a-zA-Z0-9_-]{1,200}$/.test(id)))
      throw new Error('unsafe_session_reference');
    for (const suffix of ['', 'cos-v1'])
      for (const name of ['inbound.db', 'outbound.db']) {
        const file = path.join(dataRoot, 'v2-sessions', session.agent_group_id, session.id, suffix, name);
        databases.push(file);
      }
  }
  return databases;
}
export function readBackupNativeInventory(dataRoot: string) {
  const db = new Database(path.join(dataRoot, 'v2.db'), { readonly: true, fileMustExist: true });
  try {
    const { binding, sessions } = readBackupNativeIdentity(db),
      databases = backupNativeDatabaseCandidates(dataRoot, sessions).filter(
        (file, index) => index === 0 || !!fs.lstatSync(file, { throwIfNoEntry: false }),
      );
    if (databases.length > 10000 || new Set(databases).size !== databases.length)
      throw new Error('action_backup_bounds');
    return { binding, databases };
  } finally {
    db.close();
  }
}
export function assertBackupNativeWritersStopped(central: string) {
  const db = new Database(central, { readonly: true, fileMustExist: true });
  try {
    const row = db.prepare('SELECT pid FROM host_execution_lease WHERE singleton_id=1').get() as
      | { pid: number }
      | undefined;
    if (row) {
      if (!Number.isSafeInteger(row.pid) || row.pid < 1) throw new Error('target_host_writer_active');
      try {
        process.kill(row.pid, 0);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
        throw error;
      }
      throw new Error('target_host_writer_active');
    }
  } finally {
    db.close();
  }
}
