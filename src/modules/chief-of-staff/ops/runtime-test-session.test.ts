import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { serveRuntimeTestSession } from './runtime-test-session.js';
import { initializeTarget, readTarget, writeAtomic, protectTarget } from './target-state.js';
import { beginMaintenance, confirmQuiescence, finishMaintenance } from './maintenance.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-runtime-test-'));
  roots.push(parent);
  const root = path.join(parent, 'target');
  const binding = {
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
    service: 'nano.service',
    installationRoot: '/fixture/nano',
    dataRoot: '/fixture/nano/data',
  };
  initializeTarget(root, binding);
  const lease = beginMaintenance(root, binding, 'fixture-deployment', 'deployment');
  await confirmQuiescence(root, binding, lease, async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
  writeAtomic(root, 'state.json', { ...readTarget(root, binding), releaseId: 'release-fixture' });
  await finishMaintenance(root, binding, lease, async () => true);
  const effects = {
    verify: vi.fn(async () => {}),
    quiesce: vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 })),
    compatible: vi.fn(async () => true),
  };
  const responses: any[] = [];
  return {
    root,
    binding,
    owner: 'fixture-run',
    effects,
    send: async (value: unknown) => {
      responses.push(value);
    },
    responses,
  };
}
async function* messages(...actions: string[]) {
  for (const action of actions) yield { action, challenge: randomUUID() };
}
it('holds Pi-owned quiescence for a live challenge session and reopens only after compatible completion', async () => {
  const f = await fixture();
  await serveRuntimeTestSession({ ...f, input: messages('begin', 'check', 'finish') });
  expect(f.responses.map((value) => value.status)).toEqual(['ready', 'ready', 'complete']);
  expect(f.responses[0]).toMatchObject({
    databaseFingerprint: f.binding.databaseFingerprint,
    lifecycle: 'implementation_disposable',
  });
  expect(new Set(f.responses.map((value) => value.challenge)).size).toBe(3);
  expect(readTarget(f.root, f.binding)).toMatchObject({
    maintenance: false,
    maintenanceId: null,
    releaseId: 'release-fixture',
  });
  expect(f.effects.compatible).toHaveBeenCalledOnce();
});
it('a disconnected Mac leaves admission closed and only the same owner may reconcile the lease', async () => {
  const f = await fixture();
  await serveRuntimeTestSession({ ...f, input: messages('begin') });
  const closed = readTarget(f.root, f.binding);
  expect(closed.maintenance).toBe(true);
  expect(closed.maintenanceId).not.toBeNull();
  await expect(serveRuntimeTestSession({ ...f, owner: 'different-run', input: messages('begin') })).rejects.toThrow(
    'maintenance_owned',
  );
  await serveRuntimeTestSession({ ...f, input: messages('begin', 'finish') });
  expect(readTarget(f.root, f.binding).maintenance).toBe(false);
});
it('refuses protection, stale challenges and incompatible completion without reopening', async () => {
  const f = await fixture();
  f.effects.compatible.mockResolvedValue(false);
  await expect(serveRuntimeTestSession({ ...f, input: messages('begin', 'finish') })).rejects.toThrow(
    'reconciliation_required',
  );
  expect(readTarget(f.root, f.binding).maintenance).toBe(true);
  const other = await fixture();
  protectTarget(other.root, other.binding);
  await expect(serveRuntimeTestSession({ ...other, input: messages('begin') })).rejects.toThrow('protected_target');
  expect(other.effects.quiesce).not.toHaveBeenCalled();
  const fresh = await fixture(),
    challenge = randomUUID();
  async function* replay() {
    yield { action: 'begin', challenge };
    yield { action: 'finish', challenge };
  }
  await expect(serveRuntimeTestSession({ ...fresh, input: replay() })).rejects.toThrow('runtime_test_protocol_invalid');
  expect(readTarget(fresh.root, fresh.binding).maintenance).toBe(true);
});
