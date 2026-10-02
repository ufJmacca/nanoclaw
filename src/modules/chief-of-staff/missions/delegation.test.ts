import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { digest } from '../domain/contracts.js';
import { RESEARCH_TEMPLATE } from './work-order.js';
import { readDelegation, configureDelegation, parseDelegationChange } from './delegation.js';
import type { CosBinding } from '../../../cos-boundary.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-delegation-'));
  roots.push(root);
  const binding: CosBinding = {
    scopeId: 'scope',
    ownerId: 'owner',
    botId: 'bot',
    agentGroupId: 'main',
    sessionId: 'main',
    messagingGroupId: 'mg',
    provider: 'codex',
    instanceId: 'fixture',
    channelId: 'private',
  };
  const change = {
    expectedRevision: 0,
    enabled: true,
    templateDigest: digest(RESEARCH_TEMPLATE),
    reviewRef: 'fixture-reviewed-template',
  };
  return { root, binding, change };
}
it('S05-T03 delegation is disabled without an exact owner-configured template and replays one revision', () => {
  const f = fixture(),
    requestId = randomUUID();
  expect(readDelegation(f.root, f.binding)).toBeNull();
  const record = configureDelegation(f.root, f.binding, requestId, f.change);
  expect(record).toMatchObject({
    revision: 1,
    enabled: true,
    ownerId: 'owner',
    bindingDigest: digest(f.binding),
    templateDigest: digest(RESEARCH_TEMPLATE),
  });
  expect(configureDelegation(f.root, f.binding, requestId, f.change)).toEqual(record);
  expect(readDelegation(f.root, f.binding)).toEqual(record);
  expect(readDelegation(f.root, { ...f.binding, ownerId: 'foreign' })).toBeNull();
  expect(() => configureDelegation(f.root, f.binding, requestId, { ...f.change, enabled: false })).toThrow(
    'mission_configuration_conflict',
  );
  expect(() => configureDelegation(f.root, f.binding, randomUUID(), f.change)).toThrow(
    'mission_configuration_conflict',
  );
  const disabled = configureDelegation(f.root, f.binding, randomUUID(), {
    ...f.change,
    expectedRevision: 1,
    enabled: false,
  });
  expect(disabled).toMatchObject({ revision: 2, enabled: false });
  expect(() => configureDelegation(f.root, f.binding, requestId, f.change)).toThrow('mission_configuration_conflict');
});
it.each([
  { templateDigest: 'a'.repeat(64) },
  { enabled: 'yes' },
  { expectedRevision: -1 },
  { reviewRef: '' },
  { tool: 'shell' },
])('S05-T03 rejects non-reviewed or caller-expanded delegation %j', (patch) => {
  expect(() => parseDelegationChange({ ...fixture().change, ...patch })).toThrow('invalid_mission_configuration');
});
it('S05-T03 unsafe private state cannot grant or overwrite delegation', () => {
  const f = fixture();
  configureDelegation(f.root, f.binding, randomUUID(), f.change);
  const file = path.join(f.root, 'mission-delegation-' + digest(f.binding.scopeId) + '.json');
  fs.chmodSync(file, 0o644);
  expect(readDelegation(f.root, f.binding)).toBeNull();
  expect(() => configureDelegation(f.root, f.binding, randomUUID(), { ...f.change, expectedRevision: 1 })).toThrow();
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, '{invalid');
  expect(readDelegation(f.root, f.binding)).toBeNull();
});
it('S05-T03 changed delegation bytes cannot reuse the approved request digest', () => {
  const f = fixture();
  const record = configureDelegation(f.root, f.binding, randomUUID(), { ...f.change, enabled: false });
  fs.writeFileSync(
    path.join(f.root, 'mission-delegation-' + digest(f.binding.scopeId) + '.json'),
    JSON.stringify({ ...record, enabled: true }),
  );
  expect(readDelegation(f.root, f.binding)).toBeNull();
});
it('S05-T03 hard-linked configuration is not an exclusive operator-owned record', () => {
  const f = fixture();
  configureDelegation(f.root, f.binding, randomUUID(), f.change);
  fs.linkSync(
    path.join(f.root, 'mission-delegation-' + digest(f.binding.scopeId) + '.json'),
    path.join(f.root, 'alias.json'),
  );
  expect(readDelegation(f.root, f.binding)).toBeNull();
});
it.each(['symlink', 'directory', 'oversized', 'pipe'])(
  'S05-T03 refuses %s configuration without blocking or replacing it',
  (kind) => {
    const f = fixture();
    const file = path.join(f.root, 'mission-delegation-' + digest(f.binding.scopeId) + '.json');
    if (kind === 'symlink') fs.symlinkSync('missing.json', file);
    if (kind === 'directory') fs.mkdirSync(file, { mode: 0o700 });
    if (kind === 'oversized') fs.writeFileSync(file, 'x'.repeat(4097), { mode: 0o600 });
    if (kind === 'pipe') execFileSync('mkfifo', ['-m', '600', file]);
    expect(readDelegation(f.root, f.binding)).toBeNull();
    expect(() => configureDelegation(f.root, f.binding, randomUUID(), f.change)).toThrow();
    expect(fs.lstatSync(file)).toBeTruthy();
  },
);
