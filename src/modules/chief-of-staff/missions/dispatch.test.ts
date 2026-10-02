import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../../types.js';
const fixture = vi.hoisted(() => ({ root: '/tmp/cos-mission-dispatch-' + process.pid }));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: fixture.root + '/data',
}));
import { initTestDb, closeDb, getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { openInboundDb } from '../../../session-manager.js';
import { getSession } from '../../../db/sessions.js';
import { type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { prepareCosLaunch, permitCosExecution } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import { sealResearchWorkOrder, RESEARCH_TEMPLATE } from './work-order.js';
import { NativeMissionAllocation } from './native-allocation.js';
import { MissionDispatch } from './dispatch.js';
function input(canary = 'A') {
  const identity: CosMissionIdentity = {
    scopeId: 'private',
    missionId: 'mission-' + randomUUID(),
    attemptId: randomUUID(),
    generation: 1,
    agentGroupId: 'cos-mission-' + randomUUID(),
    sessionId: randomUUID(),
    provider: 'codex',
  };
  const order = sealResearchWorkOrder({
    missionId: identity.missionId,
    request: {
      question: 'Compare note ' + canary,
      goal_id: null,
      project_id: null,
      sources: [{ source_id: 'note-' + canary, revision_id: 'rev-' + canary }],
      acceptance_criteria: [{ id: 'comparison', description: 'Cite the note.' }],
      limits: { ...MISSION_DEFAULT_LIMITS },
    },
    origin: {
      scopeId: 'private',
      ownerId: 'owner',
      sessionId: 'main',
      agentGroupId: 'main',
      ingressId: 'ingress',
      bindingDigest: digest('binding'),
      delegationDigest: 'd'.repeat(64),
      contextGeneration: randomUUID(),
    },
    related: { goal: null, project: null },
    sources: [
      {
        source_id: 'note-' + canary,
        revision_id: 'rev-' + canary,
        source_version: 1,
        revision_digest: digest(canary),
        title: 'Note ' + canary,
        status: 'current',
        chunks: [{ ordinal: 0, start_line: 1, end_line: 1, text: 'CANARY_' + canary }],
      },
    ],
    provider: { profile: RESEARCH_TEMPLATE.providerProfile, model: 'fixture', policyDigest: digest('policy') },
    reviewedTemplateDigest: digest(RESEARCH_TEMPLATE),
    issuedAt: new Date().toISOString(),
  });
  return { identity, order, inputId: 'cos-mission-input-' + randomUUID() };
}
beforeEach(() => {
  runMigrations(initTestDb());
  fs.mkdirSync(fixture.root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(fixture.root + '/private', { mode: 0o700 });
  fs.mkdirSync(fixture.root + '/data', { mode: 0o700 });
});
afterEach(() => {
  closeDb();
  fs.rmSync(fixture.root, { recursive: true, force: true });
});
const allocator = (afterEffect?: (step: string) => void) =>
  new NativeMissionAllocation({ root: fixture.root + '/private', afterEffect });
function setup() {
  const value = input();
  const runs = {
    claimDispatch: vi.fn(async () => ({ status: 'ok' as const, ...value, lease: { owner: 'host', fence: 1 } })),
    authorizeDispatch: vi.fn(async () => ({ status: 'ok' as const })),
    authorizeWorker: vi.fn(async () => ({ status: 'ok' as const })),
    markDispatchReady: vi.fn(async () => ({ status: 'ok' as const })),
    beginExecution: vi.fn(async () => ({ status: 'ok' as const })),
    renewDispatch: vi.fn(async () => ({ status: 'ok' as const })),
    fail: vi.fn(async () => ({ status: 'ok' as const })),
    confirmStopped: vi.fn(async () => ({ status: 'ok' as const })),
  };
  const launcher = {
    prepare: vi.fn(async () => ({ containerName: 'restricted-child', args: ['fixture'] })),
    close: vi.fn(async () => {}),
  };
  const wake = vi.fn(async (session: Session) => {
    await prepareCosLaunch(session);
    return true;
  });
  const stop = vi.fn(async () => {}),
    stopped = vi.fn(async () => true),
    admitted = vi.fn(async () => true),
    local = vi.fn(() => true);
  const dispatcher = new MissionDispatch({
    runs,
    allocation: allocator(),
    launcher,
    wake,
    stop,
    stopped,
    admitted,
    local,
    pollIntervalMs: 0,
  });
  const context = {
    scopeId: value.identity.scopeId,
    ownerId: 'owner',
    agentGroupId: 'main',
    sessionId: 'main',
    ingressId: 'ingress',
  };
  return { value, runs, launcher, wake, stop, stopped, admitted, local, dispatcher, context };
}
it('S05-T03/T10 binds worker calls to the running native child and fences database uncertainty', async () => {
  const f = setup();
  try {
    f.wake.mockResolvedValueOnce(false);
    await f.dispatcher.dispatch(f.context, f.value.identity.attemptId);
    const session = getSession(f.value.identity.sessionId)!;
    expect(await f.dispatcher.workerGrant(session)).toBeNull();
    await prepareCosLaunch(session);
    expect(await f.dispatcher.workerGrant(session)).toEqual({
      identity: f.value.identity,
      lease: { owner: 'host', fence: 1 },
    });
    expect(await f.dispatcher.workerGrant({ ...session, agent_provider: 'claude' })).toBeNull();
    f.runs.authorizeWorker.mockRejectedValueOnce(new Error('offline'));
    expect(await f.dispatcher.workerGrant(session)).toBeNull();
    expect(f.stop).toHaveBeenCalledWith(f.value.identity, 'mission_authority_lost');
    expect(await f.dispatcher.workerGrant(session)).toBeNull();
    expect(permitCosExecution(session)).toBe(false);
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-T08 acknowledges a submitted result without renewing execution, then reconciles its stop', async () => {
  const f = setup();
  try {
    await f.dispatcher.dispatch(f.context, f.value.identity.attemptId);
    // Submission closed execution but still permits its current-lease acknowledgement.
    f.runs.authorizeDispatch.mockResolvedValue({ status: 'denied' } as never);
    f.runs.renewDispatch.mockResolvedValue({ status: 'denied' } as never);
    f.runs.fail.mockResolvedValue({ status: 'denied' } as never);
    expect(await f.dispatcher.workerGrant(getSession(f.value.identity.sessionId)!)).not.toBeNull();
    await f.dispatcher.poll();
    expect(f.stop).toHaveBeenCalledOnce();
    expect(f.runs.confirmStopped).toHaveBeenCalledWith(f.value.identity);
    expect(await f.dispatcher.workerGrant(getSession(f.value.identity.sessionId)!)).toBeNull();
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-T05 native false wake stays deferred with its original input and no execution transition', async () => {
  const f = setup();
  f.wake.mockResolvedValue(false);
  try {
    expect(await f.dispatcher.dispatch(f.context, f.value.identity.attemptId)).toMatchObject({
      status: 'pending',
      state: 'deferred',
    });
    expect(f.runs.beginExecution).not.toHaveBeenCalled();
    expect(await f.dispatcher.dispatch(f.context, f.value.identity.attemptId)).toMatchObject({
      status: 'pending',
      state: 'deferred',
    });
    const inbox = openInboundDb(f.value.identity.agentGroupId, f.value.identity.sessionId);
    try {
      expect(inbox.prepare('SELECT id FROM messages_in').all()).toEqual([{ id: f.value.inputId }]);
    } finally {
      inbox.close();
    }
    expect(f.stop).not.toHaveBeenCalled();
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-T11 returns after native wake without waiting for the specialist result', async () => {
  const f = setup();
  try {
    expect(await f.dispatcher.dispatch(f.context, f.value.identity.attemptId)).toMatchObject({
      status: 'ok',
      state: 'running',
    });
    expect(f.runs.beginExecution).toHaveBeenCalledTimes(1);
    expect(f.launcher.prepare).toHaveBeenCalledTimes(1);
    expect(f.wake).toHaveBeenCalledWith(getSession(f.value.identity.sessionId));
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-PG02 database loss closes the local grant and requests stop before any successful reconciliation', async () => {
  const f = setup();
  try {
    await f.dispatcher.dispatch(f.context, f.value.identity.attemptId);
    f.runs.renewDispatch.mockResolvedValue({ status: 'unavailable' } as any);
    f.runs.fail.mockResolvedValue({ status: 'unavailable' } as any);
    await f.dispatcher.poll();
    expect(permitCosExecution(getSession(f.value.identity.sessionId)!)).toBe(false);
    expect(f.stop).toHaveBeenCalledWith(f.value.identity, 'mission_authority_lost');
    expect(f.runs.confirmStopped).not.toHaveBeenCalled();
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-T07 loss of private admission during preparation fences the attempt without native execution', async () => {
  const f = setup();
  f.launcher.prepare.mockImplementation(async () => {
    f.local.mockReturnValue(false);
    return { containerName: 'never', args: [] };
  });
  try {
    expect((await f.dispatcher.dispatch(f.context, f.value.identity.attemptId)).status).toBe('denied');
    expect(f.runs.beginExecution).not.toHaveBeenCalled();
    expect(f.stop).toHaveBeenCalledTimes(1);
    expect(permitCosExecution(getSession(f.value.identity.sessionId)!)).toBe(false);
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-PG02 uncertain native stop remains fenced and is reconciled only after verified absence', async () => {
  const f = setup();
  try {
    await f.dispatcher.dispatch(f.context, f.value.identity.attemptId);
    f.runs.renewDispatch.mockResolvedValue({ status: 'unavailable' } as any);
    f.stop.mockRejectedValue(new Error('fixture_stop_uncertain'));
    f.stopped.mockResolvedValue(false);
    await f.dispatcher.poll();
    expect(permitCosExecution(getSession(f.value.identity.sessionId)!)).toBe(false);
    expect(f.runs.confirmStopped).not.toHaveBeenCalled();
    f.stop.mockResolvedValue(undefined);
    f.stopped.mockResolvedValue(true);
    await f.dispatcher.reconcileStops();
    expect(f.runs.confirmStopped).toHaveBeenCalledWith(f.value.identity);
    expect(permitCosExecution(getSession(f.value.identity.sessionId)!)).toBe(false);
  } finally {
    await f.dispatcher.close();
  }
});
it('S05-T03/T10 corrupted native ownership closes an existing grant and still stops the verified child', async () => {
  const f = setup();
  try {
    await f.dispatcher.dispatch(f.context, f.value.identity.attemptId);
    getDb()
      .prepare("UPDATE cos_mission_boundaries SET identity='broken' WHERE attempt_id=?")
      .run(f.value.identity.attemptId);
    await f.dispatcher.poll();
    expect(permitCosExecution(getSession(f.value.identity.sessionId)!)).toBe(false);
    expect(f.stop).toHaveBeenCalledWith(f.value.identity, 'mission_authority_lost');
  } finally {
    await f.dispatcher.close();
  }
});
