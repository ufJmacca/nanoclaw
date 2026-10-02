/** Permanent host boundary. Restricted identities never depend on feature loading. */
import type Database from 'better-sqlite3';
import { getDb, hasTable } from './db/connection.js';
import type { Session } from './types.js';
import type { InboundEvent } from './channels/adapter.js';
import type { Binding } from './modules/chief-of-staff/bridge/identity.js';
import { hasCosMissionBoundary } from './cos-mission-boundary.js';
import { missionExecutionReady, prepareMissionLaunch } from './cos-mission-execution.js';

export type CosBinding = Binding & { sessionId: string };
export function hasCosStateBoundary(agentGroupId: string, sessionId: string): boolean {
  const db = getDb();
  return (
    hasCosMissionBoundary(agentGroupId, sessionId, db) ||
    (hasTable(db, 'cos_identity_boundaries') &&
      !!db
        .prepare('SELECT 1 FROM cos_identity_boundaries WHERE agent_group_id=? OR session_id=?')
        .get(agentGroupId, sessionId))
  );
}
export function ensureCosBoundarySchema(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cos_identity_boundaries (
    scope_id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL UNIQUE,
    messaging_group_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE,
    platform_id TEXT NOT NULL UNIQUE, binding TEXT NOT NULL,
    paused INTEGER NOT NULL DEFAULT 1 CHECK(paused IN (0,1)),
    ingress_id TEXT, ingress_at TEXT);
    CREATE TABLE IF NOT EXISTS cos_ingress_receipts (
      scope_id TEXT NOT NULL, ingress_id TEXT NOT NULL, received_at TEXT NOT NULL,
      PRIMARY KEY(scope_id,ingress_id));`);
  ensureCosIngressProjectionSchema(db);
}
export function ensureCosIngressProjectionSchema(db: Database.Database): void {
  const columns = db.prepare('PRAGMA table_info(cos_ingress_receipts)').all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'payload_digest'))
    db.exec('ALTER TABLE cos_ingress_receipts ADD COLUMN payload_digest TEXT');
  // Existing receipts must never grant a fresh replay capability after upgrade.
  if (!columns.some((column) => column.name === 'projected'))
    db.exec(
      'ALTER TABLE cos_ingress_receipts ADD COLUMN projected INTEGER NOT NULL DEFAULT 1 CHECK(projected IN (0,1))',
    );
}
type Row = {
  binding: string;
  session_id: string;
  paused: number;
  ingress_id: string | null;
  ingress_at: string | null;
};
export type CosBoundary =
  | { restricted: false }
  | {
      restricted: true;
      binding: CosBinding | null;
      paused: boolean;
      ingressId: string | null;
      ingressAt: string | null;
    };
export function cosBoundary(session: Session, db: Database.Database = getDb()): CosBoundary {
  // A child has no channel binding. Coordinator hooks cannot authorize it.
  if (hasCosMissionBoundary(session.agent_group_id, session.id, db))
    return { restricted: true, binding: null, paused: true, ingressId: null, ingressAt: null };
  if (!hasTable(db, 'cos_identity_boundaries')) return { restricted: false };
  const rows = db
    .prepare(`SELECT * FROM cos_identity_boundaries WHERE session_id=? OR agent_group_id=? OR messaging_group_id=?`)
    .all(session.id, session.agent_group_id, session.messaging_group_id) as Row[];
  if (!rows.length) return { restricted: false };
  const denied: CosBoundary = { restricted: true, binding: null, paused: true, ingressId: null, ingressAt: null };
  if (rows.length !== 1) return denied;
  try {
    const binding = JSON.parse(rows[0].binding) as CosBinding;
    if (
      !binding ||
      binding.sessionId !== session.id ||
      binding.agentGroupId !== session.agent_group_id ||
      binding.messagingGroupId !== session.messaging_group_id ||
      binding.provider !== session.agent_provider ||
      session.status !== 'active' ||
      session.thread_id !== null
    )
      return denied;
    return {
      restricted: true,
      binding,
      paused: rows[0].paused !== 0,
      ingressId: rows[0].ingress_id,
      ingressAt: rows[0].ingress_at,
    };
  } catch {
    return denied;
  }
}
export type Outbound = {
  kind: string;
  channel_type: string | null;
  platform_id: string | null;
  thread_id: string | null;
  content: string;
};
export type CosLaunch = { containerName: string; args: string[] };
type Hooks = {
  executionReady(binding: CosBinding): boolean;
  launch?(binding: CosBinding, session: Session): Promise<CosLaunch>;
  validatePrivateDestination(binding: CosBinding, purpose?: 'chat' | 'rpc', text?: string): Promise<boolean>;
  ingress(binding: CosBinding, event: InboundEvent): Promise<boolean>;
};
let hooks: Hooks | null = null;
export function setCosBoundaryHooks(value: Hooks | null): void {
  hooks = value;
}
export async function permitCosOutbound(session: Session, message: Outbound): Promise<boolean> {
  const boundary = cosBoundary(session);
  if (!boundary.restricted) return true;
  if (!boundary.binding || boundary.paused || !hooks) return false;
  try {
    const content = JSON.parse(message.content);
    if (message.kind === 'system') {
      if (
        content?.action !== 'cos_rpc' ||
        message.channel_type !== null ||
        message.platform_id !== null ||
        message.thread_id !== null
      )
        return false;
    } else if (
      message.kind !== 'chat' ||
      message.channel_type !== 'mattermost' ||
      message.platform_id !== `mattermost:${boundary.binding.instanceId}:${boundary.binding.channelId}` ||
      !content ||
      typeof content.text !== 'string' ||
      Buffer.byteLength(message.content) > 65_536 ||
      Object.keys(content).some((key) => key !== 'text')
    )
      return false;
    if (
      !(await hooks.validatePrivateDestination(
        boundary.binding,
        message.kind === 'system' ? 'rpc' : 'chat',
        message.kind === 'chat' ? content.text : undefined,
      ))
    )
      return false;
    const current = cosBoundary(session);
    return (
      current.restricted && !!current.binding && !current.paused && current.binding.scopeId === boundary.binding.scopeId
    );
  } catch {
    return false;
  }
}
export function permitCosExecution(session: Session): boolean {
  if (hasCosMissionBoundary(session.agent_group_id, session.id, getDb())) return missionExecutionReady(session);
  const boundary = cosBoundary(session);
  if (!boundary.restricted) return true;
  return !!boundary.binding && !boundary.paused && !!hooks?.executionReady(boundary.binding);
}
/** Only ordinary identities may use the generic launcher. Recheck after every asynchronous preparation. */
export async function prepareCosLaunch(session: Session): Promise<CosLaunch | null> {
  if (hasCosMissionBoundary(session.agent_group_id, session.id, getDb())) return prepareMissionLaunch(session);
  const boundary = cosBoundary(session);
  if (!boundary.restricted) return null;
  const currentHooks = hooks;
  if (!boundary.binding || boundary.paused || !currentHooks?.launch || !currentHooks.executionReady(boundary.binding))
    throw new Error('restricted_launch_denied');
  const launch = await currentHooks.launch(boundary.binding, session);
  const current = cosBoundary(session);
  if (
    hooks !== currentHooks ||
    !current.restricted ||
    !current.binding ||
    current.paused ||
    current.binding.scopeId !== boundary.binding.scopeId ||
    !currentHooks.executionReady(current.binding)
  )
    throw new Error('restricted_launch_denied');
  return launch;
}
export async function interceptCosIngress(event: InboundEvent): Promise<boolean> {
  const db = getDb();
  if (!hasTable(db, 'cos_identity_boundaries')) return false;
  const row = db.prepare('SELECT binding FROM cos_identity_boundaries WHERE platform_id=?').get(event.platformId) as
    | { binding: string }
    | undefined;
  if (!row) return false;
  if (!hooks) return true;
  try {
    return await hooks.ingress(JSON.parse(row.binding), event);
  } catch {
    return true;
  }
}
export function installCosBoundary(binding: CosBinding, db: Database.Database): void {
  if (hasCosMissionBoundary(binding.agentGroupId, binding.sessionId, db)) throw new Error('mission_identity_conflict');
  ensureCosBoundarySchema(db);
  db.prepare(
    `INSERT INTO cos_identity_boundaries(scope_id,agent_group_id,messaging_group_id,session_id,platform_id,binding)
    VALUES(?,?,?,?,?,?)`,
  ).run(
    binding.scopeId,
    binding.agentGroupId,
    binding.messagingGroupId,
    binding.sessionId,
    `mattermost:${binding.instanceId}:${binding.channelId}`,
    JSON.stringify(binding),
  );
}
