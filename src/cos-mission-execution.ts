/** Dedicated child execution admission. It never creates a channel binding or an ordinary-agent fallback. */
import { getDb, hasTable } from './db/connection.js';
import { getSession } from './db/sessions.js';
import { missionBoundary, type CosMissionIdentity } from './cos-mission-boundary.js';
import { isCosMissionStopped } from './cos-mission-stop.js';
import type { CosLaunch, Outbound } from './cos-boundary.js';
import {
  MISSION_WORKER_REQUEST_BYTES,
  validMissionRpcEnvelope,
} from './modules/chief-of-staff/contracts/mission-worker-protocol.js';
import type { Session } from './types.js';
export type CosMissionExecutionHooks = {
  /** Synchronous local fence backed by a still-current host dispatch grant. Remote admission happens in launch. */
  ready(identity: CosMissionIdentity): boolean;
  launch(identity: CosMissionIdentity, session: Session): Promise<CosLaunch>;
  /** A fresh host lease/authority check; no generic outbound capability is implied. */
  rpc?(identity: CosMissionIdentity, session: Session): Promise<boolean>;
};
let hooks: CosMissionExecutionHooks | null = null;
export function installCosMissionExecutionHooks(value: CosMissionExecutionHooks): () => void {
  hooks = value;
  return () => {
    if (hooks === value) hooks = null;
  };
}
function current(session: Session): CosMissionIdentity | null {
  const db = getDb(),
    passed = missionBoundary(session, db);
  if (!passed.restricted || !passed.identity || isCosMissionStopped(passed.identity, db) || !hasTable(db, 'sessions'))
    return null;
  const actual = getSession(session.id);
  if (!actual) return null;
  const stored = missionBoundary(actual, db);
  return stored.restricted &&
    stored.identity &&
    Object.entries(passed.identity).every(([key, value]) => stored.identity![key as keyof CosMissionIdentity] === value)
    ? stored.identity
    : null;
}
export function missionExecutionReady(session: Session): boolean {
  try {
    const identity = current(session);
    return !!identity && !!hooks?.ready(identity);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Any local identity/policy uncertainty closes child execution.
  } catch {
    return false;
  }
}
export async function permitMissionRpc(session: Session, message: Outbound): Promise<boolean> {
  try {
    if (
      message.kind !== 'system' ||
      message.channel_type !== null ||
      message.platform_id !== null ||
      message.thread_id !== null ||
      Buffer.byteLength(message.content) > MISSION_WORKER_REQUEST_BYTES + 256 ||
      !validMissionRpcEnvelope(JSON.parse(message.content))
    )
      return false;
    const selected = hooks,
      identity = current(session);
    if (!selected?.rpc || !identity || !selected.ready(identity) || !(await selected.rpc(identity, session)))
      return false;
    const after = current(session);
    return (
      hooks === selected &&
      !!after &&
      selected.ready(after) &&
      Object.entries(identity).every(([key, value]) => after[key as keyof CosMissionIdentity] === value)
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Any malformed row or uncertain authority denies specialist delivery.
  } catch {
    return false;
  }
}
export async function prepareMissionLaunch(session: Session): Promise<CosLaunch> {
  const selected = hooks,
    identity = current(session);
  if (!selected || !identity || !selected.ready(identity)) throw new Error('restricted_launch_denied');
  const launch = await selected.launch(identity, session);
  const after = current(session);
  if (
    hooks !== selected ||
    !after ||
    !Object.entries(identity).every(([key, value]) => after[key as keyof CosMissionIdentity] === value) ||
    !selected.ready(after)
  )
    throw new Error('restricted_launch_denied');
  return launch;
}
