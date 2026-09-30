export { canonical, digest, validChange, type Change } from '../contracts/protocol.js';

export type Context = { scopeId: string; ownerId: string; sessionId: string; agentGroupId: string; ingressId: string };
export type Result = { status: 'ok' | 'pending' | 'denied' | 'conflict' | 'unavailable'; [key: string]: unknown };
