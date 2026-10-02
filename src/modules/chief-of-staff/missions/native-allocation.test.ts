import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const fixture = vi.hoisted(() => ({ root: '/tmp/cos-mission-allocation-' + process.pid }));
vi.mock('../../../config.js', async () => ({
  ...(await vi.importActual('../../../config.js')),
  DATA_DIR: fixture.root + '/data',
}));
import { initTestDb, closeDb, getDb } from '../../../db/connection.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { openInboundDb, sessionDir } from '../../../session-manager.js';
import { getSession } from '../../../db/sessions.js';
import { missionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { stopCosMissionFamily } from '../../../cos-mission-stop.js';
import { permitCosExecution } from '../../../cos-boundary.js';
import { digest } from '../domain/contracts.js';
import { MISSION_DEFAULT_LIMITS } from '../contracts/mission-protocol.js';
import { sealResearchWorkOrder, RESEARCH_TEMPLATE } from './work-order.js';
import { NativeMissionAllocation } from './native-allocation.js';
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
it('S05-T02 creates separate native groups, sessions, provider directories and exact context files for two canaries', async () => {
  const a = input('A'),
    b = input('B'),
    native = allocator();
  const x = await native.prepare(a, async () => true),
    y = await native.prepare(b, async () => true);
  for (const key of ['sessionDirectory', 'providerDirectory', 'contextDirectory', 'controlDirectory'] as const)
    expect(x[key]).not.toBe(y[key]);
  expect(x.sessionDirectory).toBe(sessionDir(a.identity.agentGroupId, a.identity.sessionId));
  const content = fs.readFileSync(path.join(x.contextDirectory, 'context.json'), 'utf8');
  expect(content).toContain('CANARY_A');
  expect(content).not.toContain('CANARY_B');
  expect(fs.readFileSync(path.join(y.contextDirectory, 'context.json'), 'utf8')).not.toContain('CANARY_A');
  expect(fs.readdirSync(x.providerDirectory)).toEqual([]);
  const session = getSession(a.identity.sessionId)!;
  expect(session.messaging_group_id).toBeNull();
  expect(session.thread_id).toBeNull();
  expect(missionBoundary(session, getDb())).toEqual({ restricted: true, identity: a.identity });
  expect(permitCosExecution(session)).toBe(false);
  const inbound = openInboundDb(a.identity.agentGroupId, a.identity.sessionId);
  try {
    expect(inbound.prepare('SELECT count(*) AS n FROM messages_in').get()).toEqual({ n: 1 });
    expect(inbound.prepare('SELECT count(*) AS n FROM destinations').get()).toEqual({ n: 0 });
  } finally {
    inbound.close();
  }
});
it.each(['intent', 'group', 'session', 'directories', 'context', 'transport', 'input'])(
  'S05-T06 recovers an interruption after %s without allocating a second identity',
  async (step) => {
    const value = input();
    let crashed = false;
    await expect(
      allocator((current) => {
        if (current === step && !crashed) {
          crashed = true;
          throw new Error('fixture_crash');
        }
      }).prepare(value, async () => true),
    ).rejects.toThrow('fixture_crash');
    const native = allocator(),
      first = await native.prepare(value, async () => true);
    expect(await native.prepare(value, async () => true)).toEqual(first);
    expect(getDb().prepare('SELECT count(*) AS n FROM agent_groups').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT count(*) AS n FROM sessions').get()).toEqual({ n: 1 });
    const inbound = openInboundDb(value.identity.agentGroupId, value.identity.sessionId);
    try {
      expect(inbound.prepare('SELECT id FROM messages_in').all()).toEqual([{ id: value.inputId }]);
    } finally {
      inbound.close();
    }
  },
);
it('S05-T03 refuses changed work orders, input IDs, pre-existing group identities and altered context bytes', async () => {
  const a = input(),
    native = allocator(),
    allocated = await native.prepare(a, async () => true);
  await expect(native.prepare({ ...a, inputId: 'other' }, async () => true)).rejects.toThrow();
  await expect(native.prepare({ ...a, order: input('other').order }, async () => true)).rejects.toThrow();
  fs.chmodSync(path.join(allocated.contextDirectory, 'context.json'), 0o600);
  fs.writeFileSync(path.join(allocated.contextDirectory, 'context.json'), 'forged');
  await expect(native.prepare(a, async () => true)).rejects.toThrow();
  const b = input();
  getDb()
    .prepare('INSERT INTO agent_groups(id,name,folder,agent_provider,created_at) VALUES(?,?,?,?,?)')
    .run(b.identity.agentGroupId, 'Existing', b.identity.agentGroupId, 'codex', new Date().toISOString());
  await expect(native.prepare(b, async () => true)).rejects.toThrow();
});
it('S05-T07 cancellation during allocation stops before writing the native input', async () => {
  const a = input();
  let checks = 0;
  await expect(
    allocator().prepare(a, async () => {
      if (++checks === 5) stopCosMissionFamily(a.identity.scopeId, a.identity.missionId, 'owner_cancel', getDb());
      return true;
    }),
  ).rejects.toThrow('mission_allocation_denied');
  const session = getSession(a.identity.sessionId);
  if (session) expect(permitCosExecution(session)).toBe(false);
  await expect(allocator().prepare(a, async () => true)).rejects.toThrow('mission_allocation_denied');
});
it('S05-T03 refuses an unowned or symlinked filesystem instead of adopting it', async () => {
  const a = input(),
    native = allocator();
  fs.mkdirSync(path.join(fixture.root, 'private', 'missions', a.identity.attemptId));
  await expect(native.prepare(a, async () => true)).rejects.toThrow();
  const b = input();
  fs.symlinkSync(fixture.root, path.join(fixture.root, 'private', 'missions', b.identity.attemptId));
  await expect(native.prepare(b, async () => true)).rejects.toThrow();
});
it('S05-T06 completed allocation cannot silently replace lost provider state or transport', async () => {
  const a = input(),
    native = allocator(),
    paths = await native.prepare(a, async () => true);
  fs.rmSync(paths.providerDirectory, { recursive: true });
  await expect(native.prepare(a, async () => true)).rejects.toThrow('mission_allocation_recovery_required');
});
it('S05-T03 refuses allocation writes while its native container is running', async () => {
  const a = input(),
    native = allocator();
  await native.prepare(a, async () => true);
  getDb().prepare("UPDATE sessions SET container_status='running' WHERE id=?").run(a.identity.sessionId);
  await expect(native.prepare(a, async () => true)).rejects.toThrow('mission_execution_active');
});
