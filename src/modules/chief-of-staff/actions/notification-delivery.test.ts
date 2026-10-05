import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { CosBinding } from '../../../cos-boundary.js';
import type { KnowledgeContext } from '../knowledge/store.js';
import type { Result } from '../domain/contracts.js';
import { digest } from '../domain/contracts.js';
import { ActionWitness, initializeActionWitness } from './witness.js';
import { ActionNotificationDelivery } from './notification-delivery.js';
import type { ActionNotification } from './notification-protocol.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-notice-'));
  roots.push(root);
  const journal = path.join(root, 'effects'),
    installation = digest('fixture target'),
    owner = initializeActionWitness(journal, installation),
    witness = new ActionWitness(journal, installation, owner.generation);
  const binding: CosBinding = {
      scopeId: 'scope',
      ownerId: 'owner',
      agentGroupId: 'group',
      messagingGroupId: 'mg',
      sessionId: 'main',
      provider: 'codex',
      instanceId: 'fixture',
      channelId: 'private',
      botId: 'bot',
    },
    context: KnowledgeContext = {
      scopeId: 'scope',
      ownerId: 'owner',
      agentGroupId: 'group',
      sessionId: 'main',
      ingressId: 'historic',
      provider: 'codex',
      generation: randomUUID(),
    },
    id = 'action-' + 'a'.repeat(64),
    text = 'Calendar block verified. Exact original event.';
  const notice: ActionNotification = {
    format: 'cos-action-notification/v1',
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'main',
    instanceId: 'fixture',
    channelId: 'private',
    actionId: id,
    intentDigest: digest('intent'),
    state: 'verified',
    textDigest: digest(text),
  };
  let current: KnowledgeContext | null = context;
  const admitted = vi.fn(async () => true),
    project = vi.fn(),
    send = vi.fn(async (): Promise<string | undefined> => 'fixture-receipt'),
    read = vi.fn(async (): Promise<Result> => ({ status: 'ok', notice, text })),
    pending = vi.fn(async (): Promise<Result> => ({ status: 'ok', action_ids: [id], next_after: null }));
  const dependencies = { notices: { read, pending }, witness, current: () => current, admitted, project, send },
    delivery = new ActionNotificationDelivery(dependencies);
  return {
    binding,
    context,
    id,
    text,
    notice,
    witness,
    dependencies,
    delivery,
    admitted,
    project,
    send,
    read,
    pending,
    setCurrent: (value: KnowledgeContext | null) => {
      current = value;
    },
  };
}
it('consumes before transport and never resends after restart or restored remote delivery state', async () => {
  const f = fixture();
  f.send.mockImplementation(async () => {
    expect(f.witness.consumeNotification(f.notice)).toBe(false);
    return 'fixture-receipt';
  });
  expect((await f.delivery.deliver(f.binding, f.context, f.id)).state).toBe('delivered');
  const restarted = new ActionNotificationDelivery(f.dependencies);
  expect(await restarted.deliver(f.binding, f.context, f.id)).toEqual({
    status: 'pending',
    reason: 'notification_consumed',
  });
  expect(f.send).toHaveBeenCalledTimes(1);
  expect(f.project).toHaveBeenCalledTimes(1);
});
it.each(['throw', 'missing_receipt'])('retains a consumed %s send without repeating it', async (kind) => {
  const f = fixture();
  if (kind === 'throw') f.send.mockRejectedValue(new Error('PRIVATE_PROVIDER_DIAGNOSTIC'));
  else f.send.mockResolvedValue(undefined);
  expect(await f.delivery.deliver(f.binding, f.context, f.id)).toMatchObject({ status: 'pending', state: 'uncertain' });
  await f.delivery.deliver(f.binding, f.context, f.id);
  expect(f.send).toHaveBeenCalledTimes(1);
});
it.each(['destination', 'owner', 'text', 'action'])(
  'blocks a forged %s before reserving or projecting',
  async (kind) => {
    const f = fixture(),
      changed = { ...f.notice };
    if (kind === 'destination') changed.channelId = 'public';
    if (kind === 'owner') changed.ownerId = 'intruder';
    if (kind === 'text') changed.textDigest = digest('different');
    if (kind === 'action') changed.actionId = 'action-' + 'b'.repeat(64);
    f.read.mockResolvedValue({ status: 'ok', notice: changed, text: f.text });
    expect((await f.delivery.deliver(f.binding, f.context, f.id)).status).toBe('denied');
    expect(f.project).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.witness.consumeNotification(f.notice)).toBe(true);
  },
);
it('blocks retained-context replacement during the remote receipt read', async () => {
  const f = fixture();
  f.read.mockImplementation(async () => {
    f.setCurrent({ ...f.context, generation: randomUUID() });
    return { status: 'ok', notice: f.notice, text: f.text };
  });
  expect((await f.delivery.deliver(f.binding, f.context, f.id)).status).toBe('denied');
  expect(f.project).not.toHaveBeenCalled();
  expect(f.send).not.toHaveBeenCalled();
});
it('keeps a consumed notice closed when a pause arrives after passive projection', async () => {
  const f = fixture();
  f.project.mockImplementation(() => f.setCurrent(null));
  expect((await f.delivery.deliver(f.binding, f.context, f.id)).status).toBe('denied');
  expect(f.send).not.toHaveBeenCalled();
  f.setCurrent(f.context);
  expect((await f.delivery.deliver(f.binding, f.context, f.id)).reason).toBe('notification_consumed');
});
it('does not consume or publish while private membership is absent', async () => {
  const f = fixture();
  f.admitted.mockResolvedValue(false);
  await f.delivery.deliver(f.binding, f.context, f.id);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.project).not.toHaveBeenCalled();
  expect(f.witness.consumeNotification(f.notice)).toBe(true);
});
it('advances past consumed notification pages and performs no work after shutdown', async () => {
  const f = fixture(),
    ids = Array.from({ length: 20 }, (_, index) => 'action-' + index.toString(16).padStart(64, '0'));
  f.pending.mockResolvedValueOnce({ status: 'ok', action_ids: ids, next_after: ids.at(-1) });
  f.read.mockResolvedValue({ status: 'denied' });
  await f.delivery.drain(f.binding);
  await f.delivery.drain(f.binding);
  expect(f.pending.mock.calls[1]).toEqual([f.context, ids.at(-1)]);
  f.delivery.close();
  await f.delivery.drain(f.binding);
  expect(f.pending).toHaveBeenCalledTimes(2);
  expect(f.send).not.toHaveBeenCalled();
});
