import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createActionIntent } from './intent.js';
import { digest } from '../domain/contracts.js';
import { ActionWitness, initializeActionWitness, type StartedActionWitness } from './witness.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-effect-witness-'));
  roots.push(parent);
  const root = path.join(parent, 'effects'),
    installation = digest('fixture installation');
  const owner = initializeActionWitness(root, installation),
    witness = new ActionWitness(root, installation, owner.generation);
  const now = Date.parse('2026-10-05T21:00:00Z'),
    id = '11111111-1111-4111-8111-111111111111';
  const intent = createActionIntent({
    now,
    requestId: id,
    context: { scopeId: 'scope', ownerId: 'owner', agentGroupId: 'group', sessionId: 'session', ingressId: 'ingress' },
    destination: { instanceId: 'fixture', channelId: 'private' },
    request: {
      kind: 'calendar_block',
      binding_id: id,
      calendar_id: 'owner@example.test',
      start: '2026-10-05T22:00:00Z',
      end: '2026-10-05T23:00:00Z',
      time_zone: 'UTC',
      title: 'Focus work',
      description: '',
      project_id: null,
      mission_id: null,
      attendees: [],
    },
    resources: [
      { kind: 'writer_binding', id, version: 1, digest: digest('writer'), observed_at: '2026-10-05T21:00:00Z' },
      {
        kind: 'availability',
        id: 'availability-' + digest('slot'),
        version: 1,
        digest: digest('free'),
        observed_at: '2026-10-05T21:00:00Z',
      },
    ],
  });
  const start: StartedActionWitness = {
    format: 'cos-action-start-witness/v1',
    intent,
    approvedDigest: digest(intent),
    proposalId: id,
    decisionIngressId: 'owner-approval',
    leaseOwner: id,
    fence: 1,
    recordedAt: '2026-10-05T21:01:00Z',
  };
  return { parent, root, owner, witness, start, installation };
}
describe('S09 target-owned deny-only effect witness', () => {
  it('bounds each recovery inventory page before reading witness contents', () => {
    const f = fixture();
    for (let index = 0; index < 205; index++)
      fs.writeFileSync(
        path.join(f.root, 'action-' + index.toString(16).padStart(64, '0') + '.json'),
        'fixture page entry',
        { mode: 0o600 },
      );
    const find = vi.spyOn(f.witness, 'find').mockReturnValue(f.start);
    expect(f.witness.list('scope')).toHaveLength(100);
    expect(find).toHaveBeenCalledTimes(100);
    find.mockClear();
    expect(f.witness.page('scope', 100).nextOffset).toBe(200);
    expect(find).toHaveBeenCalledTimes(100);
    find.mockClear();
    expect(f.witness.page('scope', 200)).toEqual({ entries: Array(5).fill(f.start), nextOffset: null });
    expect(find).toHaveBeenCalledTimes(5);
    find.mockRestore();
  });
  it('S09-T10 retains the complete original identity across restarts independently of PostgreSQL', () => {
    const f = fixture();
    expect(f.witness.find(f.start.intent.actionId)).toBeNull();
    f.witness.begin(f.start);
    const restarted = new ActionWitness(f.root, f.installation, f.owner.generation);
    expect(restarted.find(f.start.intent.actionId)).toEqual(f.start);
    expect(restarted.list('scope')).toEqual([f.start]);
    expect(() => restarted.begin({ ...f.start, leaseOwner: '22222222-2222-4222-8222-222222222222', fence: 2 })).toThrow(
      'action_already_started',
    );
    expect(restarted.find(f.start.intent.actionId)?.intent.eventId).toBe(f.start.intent.eventId);
  });
  it('writes a durable cancellation fence without granting execution or deleting effects', () => {
    const f = fixture();
    f.witness.cancel(f.start.intent, digest(f.start.intent));
    expect(f.witness.cancelled(f.start.intent.actionId)).toBe(true);
    expect(() => f.witness.begin(f.start)).toThrow('action_cancelled');
    expect(f.witness.find(f.start.intent.actionId)).toBeNull();
  });
  it('fails closed for changed identity, permissions, symlinked roots and a replaced witness generation', () => {
    const f = fixture();
    f.witness.begin(f.start);
    expect(() => new ActionWitness(f.root, f.installation, '22222222-2222-4222-8222-222222222222')).toThrow();
    fs.chmodSync(path.join(f.root, f.start.intent.actionId + '.json'), 0o644);
    expect(() => f.witness.find(f.start.intent.actionId)).toThrow();
    fs.chmodSync(path.join(f.root, f.start.intent.actionId + '.json'), 0o600);
    fs.writeFileSync(
      path.join(f.root, f.start.intent.actionId + '.json'),
      JSON.stringify({ ...f.start, intent: { ...f.start.intent, eventId: 'f'.repeat(64) } }),
    );
    expect(() => f.witness.find(f.start.intent.actionId)).toThrow();
    const link = path.join(f.parent, 'link');
    fs.symlinkSync(f.root, link);
    expect(() => new ActionWitness(link, f.installation, f.owner.generation)).toThrow();
  });
});
