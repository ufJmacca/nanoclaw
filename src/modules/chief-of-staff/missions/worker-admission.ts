import type { PoolClient } from 'pg';
import { MAX_CONCURRENT_CONTAINERS } from '../../../config.js';

export type MissionWorkerCapacity = { nativeCapacity: number; maxWorkers: number };
export const defaultMissionWorkerCapacity = (): MissionWorkerCapacity => ({
  nativeCapacity: MAX_CONCURRENT_CONTAINERS,
  maxWorkers: 2,
});
export function missionWorkerCapacity(capacity: MissionWorkerCapacity): number {
  if (
    !Number.isSafeInteger(capacity.nativeCapacity) ||
    capacity.nativeCapacity < 1 ||
    capacity.nativeCapacity > 64 ||
    !Number.isSafeInteger(capacity.maxWorkers) ||
    capacity.maxWorkers < 1 ||
    capacity.maxWorkers > 2
  )
    throw Error('team_capacity_invalid');
  return Math.min(capacity.maxWorkers, capacity.nativeCapacity - 1);
}
/** Acquire before root/mission row locks. Shared by team intent creation and ordinary attempt leasing. */
export async function lockMissionWorkerAdmission(client: PoolClient): Promise<void> {
  await client.query('SELECT pg_advisory_xact_lock(73101006)');
}
/** Team intents already reserve a slot; ordinary queued backlog does not. A lost lease is not proof of stop. */
export async function missionWorkerOccupancy(client: PoolClient, exceptAttempt: string | null = null) {
  const row = (
    await client.query(
      `SELECT count(*)::int AS active,
    count(*) FILTER (WHERE s.child_mission_id IS NOT NULL)::int AS teams
    FROM cos.mission_attempts a LEFT JOIN cos.mission_team_steps s
      ON s.scope_id=a.scope_id AND s.child_mission_id=a.mission_id
    WHERE a.allocation->>'stop_confirmed' IS DISTINCT FROM 'true' AND ($1::text IS NULL OR a.id<>$1)
      AND (s.child_mission_id IS NOT NULL OR a.allocation ? 'dispatch_fence'
        OR a.state IN ('allocating','ready','running','submitted'))`,
      [exceptAttempt],
    )
  ).rows[0];
  return { active: Number(row.active), teams: Number(row.teams) };
}
