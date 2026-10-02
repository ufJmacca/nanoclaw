export {
  canonical,
  digest,
  validChange,
  validProposalChange,
  validSourceChange,
  type Change,
  type ProposalChange,
  type SourceChange,
} from '../contracts/protocol.js';

export type Context = {
  scopeId: string;
  ownerId: string;
  sessionId: string;
  agentGroupId: string;
  ingressId: string;
  origin?:
    | { kind: 'schedule'; runId: string; generation: number }
    | {
        kind: 'mission_review';
        runId: string;
        generation: number;
        submissionId: string;
        owner: string;
        fence: number;
      };
};
export type Result = { status: 'ok' | 'pending' | 'denied' | 'conflict' | 'unavailable'; [key: string]: unknown };
