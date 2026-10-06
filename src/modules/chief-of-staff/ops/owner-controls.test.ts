import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import { installCosMissionBoundary, type CosMissionIdentity } from '../../../cos-mission-boundary.js';
import { isCosMissionStopped } from '../../../cos-mission-stop.js';
import type { Session } from '../../../types.js';
import { HostOwnerControls, parseOwnerControl } from './owner-controls.js';
const databases: Database.Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});
const binding: CosBinding = {
  scopeId: 'scope',
  ownerId: 'owner',
  botId: 'bot',
  instanceId: 'fixture',
  channelId: 'private',
  agentGroupId: 'group',
  messagingGroupId: 'messages',
  sessionId: 'main',
  provider: 'codex',
};
function fixture() {
  const db = new Database(':memory:');
  databases.push(db);
  installCosBoundary(binding, db);
  db.exec('UPDATE cos_identity_boundaries SET paused=0');
  const identities: CosMissionIdentity[] = ['one', 'two', 'foreign'].map((name) => ({
    scopeId: name === 'foreign' ? 'other' : 'scope',
    missionId: name === 'foreign' ? 'other-mission' : 'mission',
    attemptId: name,
    generation: 1,
    agentGroupId: 'group-' + name,
    sessionId: 'child-' + name,
    provider: 'codex',
  }));
  for (const identity of identities) installCosMissionBoundary(identity, db);
  const sessions = new Map<string, Session>([
    [
      binding.sessionId,
      {
        id: binding.sessionId,
        agent_group_id: binding.agentGroupId,
        messaging_group_id: binding.messagingGroupId,
        thread_id: null,
        status: 'active',
        agent_provider: 'codex',
      } as Session,
    ],
    ...identities.map(
      (i) =>
        [
          i.sessionId,
          {
            id: i.sessionId,
            agent_group_id: i.agentGroupId,
            messaging_group_id: null,
            thread_id: null,
            status: 'active',
            agent_provider: 'codex',
          } as Session,
        ] as [string, Session],
    ),
  ]);
  const stop = vi.fn();
  const controls = new HostOwnerControls({ db, session: (id) => sessions.get(id), stop });
  const ingress = (text: string, id = 'owner-event') => ({
    id,
    ownerId: 'owner',
    text,
    timestamp: new Date().toISOString(),
  });
  return { db, identities, sessions, stop, controls, ingress };
}
it('S11-T02/T09 pause immediately fences only the exact scope main and specialists without PostgreSQL/model access', () => {
  const f = fixture(),
    request = f.ingress('cos pause admission');
  expect(f.controls.record(binding, request, parseOwnerControl(request.text)!)).toMatchObject({
    status: 'ok',
    state: 'admission_paused',
    effects: 'requires_reconciliation',
  });
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
  expect(f.stop.mock.calls.map((c) => c[0]).sort()).toEqual(['main', 'child-one', 'child-two'].sort());
  expect(f.identities.map((i) => isCosMissionStopped(i, f.db))).toEqual([true, true, false]);
  expect(f.controls.record(binding, request, parseOwnerControl(request.text)!)).toMatchObject({ status: 'ok' });
  expect(f.db.prepare('SELECT count(*) AS n FROM cos_operator_denials').get()).toEqual({ n: 1 });
});
it('S11-T02/T09 failed native stop retains durable denial and continues fencing the remaining scope', () => {
  const f = fixture();
  f.stop.mockImplementation((id) => {
    if (id === 'child-one') throw Error('PRIVATE_NATIVE_ERROR');
  });
  const request = f.ingress('cos stop');
  const result = f.controls.record(binding, request, parseOwnerControl(request.text)!);
  expect(result).toMatchObject({ status: 'pending', state: 'admission_paused' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE');
  expect(f.stop).toHaveBeenCalledWith('child-two');
  expect(f.identities.slice(0, 2).every((i) => isCosMissionStopped(i, f.db))).toBe(true);
});
it('S11-UI01 offline mission cancellation remains precisely scoped, durable and replay-safe', async () => {
  const f = fixture(),
    request = f.ingress('cos cancel mission mission');
  expect(f.controls.record(binding, request, parseOwnerControl(request.text)!)).toMatchObject({
    state: 'cancellation_recorded',
    ledger: 'pending',
  });
  expect(f.stop.mock.calls.map((c) => c[0]).sort()).toEqual(['child-one', 'child-two']);
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 0 });
  const cancel = vi
    .fn()
    .mockResolvedValueOnce({ status: 'unavailable' })
    .mockResolvedValue({ status: 'ok', state: 'cancelling' });
  await f.controls.reconcile(binding, cancel);
  await f.controls.reconcile(binding, cancel);
  await f.controls.reconcile(binding, cancel);
  expect(cancel).toHaveBeenCalledTimes(2);
  expect(cancel).toHaveBeenLastCalledWith(
    expect.objectContaining({ scopeId: 'scope', ownerId: 'owner', sessionId: 'main', ingressId: 'owner-event' }),
    'mission',
  );
  expect(f.db.prepare('SELECT state FROM cos_operator_denials').get()).toEqual({ state: 'reconciled' });
});
it('S11-T06 host denial cannot select a foreign scope/owner or reuse a changed event/binding', () => {
  const f = fixture(),
    request = f.ingress('cos cancel mission mission'),
    control = parseOwnerControl(request.text)!;
  expect(f.controls.record({ ...binding, ownerId: 'other' }, request, control)).toEqual({ status: 'denied' });
  expect(f.controls.record(binding, { ...request, ownerId: 'other' }, control)).toEqual({ status: 'denied' });
  f.controls.record(binding, request, control);
  expect(f.controls.record(binding, { ...request, text: 'cos stop' }, parseOwnerControl('cos stop')!)).toEqual({
    status: 'denied',
  });
  expect(f.identities[2] && isCosMissionStopped(f.identities[2], f.db)).toBe(false);
});
it('S11-UI01 exact controls reject quoted, malformed, broad and admission-opening commands', () => {
  for (const text of [
    'please cos stop',
    '> cos pause admission',
    'cos cancel mission ../../ordinary',
    'cos cancel mission a b',
    'cos resume',
    'cos disable everything',
  ])
    expect(parseOwnerControl(text)).toBeNull();
  expect(parseOwnerControl('cos pause automation')).toEqual({ kind: 'pause_automation' });
});
