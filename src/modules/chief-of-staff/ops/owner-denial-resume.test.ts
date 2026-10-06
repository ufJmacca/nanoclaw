import Database from 'better-sqlite3';
import { afterEach, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { Session } from '../../../types.js';
import { HostOwnerControls, parseOwnerControl } from './owner-controls.js';
import { ownerDenialsPermitResume } from './owner-denial-resume.js';
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
  const session = {
    id: 'main',
    agent_group_id: 'group',
    messaging_group_id: 'messages',
    thread_id: null,
    status: 'active',
    agent_provider: 'codex',
  } as Session;
  const controls = new HostOwnerControls({ db, session: () => session, stop: () => {} });
  const record = (text: string, id = 'control') => {
    const ingress = { id, ownerId: 'owner', text, timestamp: new Date().toISOString() };
    return controls.record(binding, ingress, parseOwnerControl(text)!);
  };
  const query = vi.fn(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes('count(*)') ? [{ n: 0 }] : [{ id: 'scope' }],
  }));
  return { db, controls, record, query, client: { query } as unknown as PoolClient };
}
it('S11-T05 pending access denials block resume before database inspection and never open admission', async () => {
  const f = fixture();
  f.record('cos revoke source source');
  expect(await ownerDenialsPermitResume(f.db, binding, f.client)).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});
it('S11-T05 reconciled local revocation remains authoritative if an older remote checkpoint lost its tombstone', async () => {
  const f = fixture();
  f.record('cos revoke source source');
  await f.controls.reconcile(binding, vi.fn(), { revokeSource: async () => ({ status: 'ok' }) });
  expect(await ownerDenialsPermitResume(f.db, binding, f.client)).toBe(true);
  f.query.mockImplementation(async (sql: string) => ({
    rowCount: 1,
    rows: sql.includes('cos.sources') ? [{ n: 1 }] : sql.includes('count(*)') ? [{ n: 0 }] : [{ id: 'scope' }],
  }));
  expect(await ownerDenialsPermitResume(f.db, binding, f.client)).toBe(false);
  expect(f.db.prepare('SELECT paused FROM cos_identity_boundaries').get()).toEqual({ paused: 1 });
});
it('S11-T05 denial added during remote inspection, foreign binding and private database failures cannot authorize resume', async () => {
  const f = fixture();
  f.record('cos revoke source source');
  await f.controls.reconcile(binding, vi.fn(), { revokeSource: async () => ({ status: 'ok' }) });
  f.query.mockImplementationOnce(async () => {
    f.record('cos revoke source another', 'new-control');
    return { rowCount: 1, rows: [{ id: 'scope' }] };
  });
  expect(await ownerDenialsPermitResume(f.db, binding, f.client)).toBe(false);
  expect(await ownerDenialsPermitResume(f.db, { ...binding, ownerId: 'foreign' }, f.client)).toBe(false);
  f.query.mockRejectedValue(Error('PRIVATE_DATABASE_ERROR'));
  expect(await ownerDenialsPermitResume(f.db, binding, f.client)).toBe(false);
});
