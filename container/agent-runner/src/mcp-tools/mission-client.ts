import { executeScopedRequest } from './scoped-rpc-client.js';
import {
  MISSION_WORKER_PROTOCOL,
  validMissionWorkerRequest,
  validMissionWorkerResponse,
  type MissionWorkerRequest,
  type MissionWorkerResponse,
} from './generated/mission-worker-protocol.js';

/** Not registered with generic MCP; available only to the fixed specialist profile. */
export function executeMissionRequest(request: MissionWorkerRequest, waitMs?: number, signal?: AbortSignal) {
  return executeScopedRequest(
    request,
    {
      protocol: MISSION_WORKER_PROTOCOL,
      action: 'cos_mission_rpc',
      prefix: 'cos-mission-',
      validRequest: validMissionWorkerRequest,
      validResponse: validMissionWorkerResponse,
      response: (status): MissionWorkerResponse => ({
        protocol: MISSION_WORKER_PROTOCOL,
        request_id: request.request_id,
        status,
      }),
    },
    waitMs,
    signal,
  );
}
