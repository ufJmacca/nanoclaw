import { expect, it, vi } from 'vitest';
import { MailMaintenance, mailMaintenanceContexts } from './maintenance.js';
import { initTestDb, closeDb } from '../../../db/connection.js';
import { installCosBoundary, type CosBinding } from '../../../cos-boundary.js';
import type { MailMaintenanceResources } from './maintenance.js';
function fixture() {
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'mail-maintenance',
    provider: 'codex',
  };
  const mail = { poke: vi.fn(), close: vi.fn(async () => {}) };
  const purgeDue = vi.fn(async () => ({ status: 'pending' }));
  const end = vi.fn(async () => {});
  const resources = {
    mail,
    knowledge: { purgeDue },
    database: { pool: { end } },
  } as unknown as MailMaintenanceResources;
  const connect = vi.fn(async () => resources),
    admitted = vi.fn(() => true),
    retention = vi.fn(() => true);
  const maintenance = new MailMaintenance({
    connect,
    admitted,
    contexts: () => [context],
    authority: { retention, poll: () => true },
  });
  return { maintenance, context, mail, purgeDue, end, connect, admitted, retention, resources };
}
it('keeps global-off maintenance tightening-only and preserves pending native history purge', async () => {
  const f = fixture();
  await f.maintenance.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.mail.poke).toHaveBeenCalledOnce();
  const [context, authority] = f.mail.poke.mock.calls[0] as unknown as [
    typeof f.context,
    { poll(ctx: typeof f.context): boolean; retention(ctx: typeof f.context): boolean },
  ];
  expect(context).toEqual(f.context);
  expect(authority.poll(context)).toBe(false);
  expect(authority.retention(context)).toBe(true);
  expect(f.purgeDue).toHaveBeenCalledWith(f.context.scopeId);
  expect(f.maintenance.status()).toEqual({ state: 'retaining', purge: 'pending' });
  await f.maintenance.close();
  expect(f.mail.close.mock.invocationCallOrder[0]).toBeLessThan(f.end.mock.invocationCallOrder[0]);
});
it('does not open a database without admitted current native owner bindings', async () => {
  const f = fixture();
  f.retention.mockReturnValue(false);
  await f.maintenance.tick();
  expect(f.connect).not.toHaveBeenCalled();
  f.retention.mockReturnValue(true);
  f.admitted.mockReturnValue(false);
  await f.maintenance.tick();
  expect(f.connect).not.toHaveBeenCalled();
  await f.maintenance.close();
});
it('retains uncertain retirement and never opens a replacement over it', async () => {
  const f = fixture();
  await f.maintenance.tick();
  f.admitted.mockReturnValue(false);
  f.mail.close.mockRejectedValueOnce(Error('PRIVATE_RETIREMENT_DIAGNOSTICS'));
  await f.maintenance.tick();
  expect(f.maintenance.status().state).toBe('unavailable');
  expect(f.end).not.toHaveBeenCalled();
  f.admitted.mockReturnValue(true);
  await f.maintenance.tick();
  expect(f.mail.close).toHaveBeenCalledTimes(2);
  expect(f.end).toHaveBeenCalledOnce();
  expect(f.connect).toHaveBeenCalledTimes(2);
  await f.maintenance.close();
});
it('waits for actual startup before retiring a stopped owner without doing maintenance', async () => {
  const f = fixture();
  let opened!: (resources: MailMaintenanceResources) => void;
  f.connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  const ticking = f.maintenance.tick();
  await Promise.resolve();
  expect(f.connect).toHaveBeenCalledOnce();
  await f.maintenance.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  let closed = false;
  const closing = f.maintenance.close().then(() => {
    closed = true;
  });
  expect(closed).toBe(false);
  opened(f.resources);
  await Promise.all([ticking, closing]);
  expect(f.mail.poke).not.toHaveBeenCalled();
  expect(f.purgeDue).not.toHaveBeenCalled();
  expect(f.end).toHaveBeenCalledOnce();
});
it('rechecks current host admission after asynchronous startup before poking any retained data', async () => {
  const f = fixture();
  f.connect.mockImplementationOnce(async () => {
    f.admitted.mockReturnValue(false);
    return f.resources;
  });
  await f.maintenance.tick();
  expect(f.mail.poke).not.toHaveBeenCalled();
  expect(f.purgeDue).not.toHaveBeenCalled();
  expect(f.mail.close).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  await f.maintenance.close();
});
it('pages only registered native metadata, skips malformed bindings and never reads model or message tables', () => {
  const db = initTestDb();
  try {
    for (let n = 0; n < 12; n++)
      installCosBoundary(
        {
          scopeId: 'scope-' + String(n).padStart(2, '0'),
          ownerId: 'owner',
          botId: 'bot',
          instanceId: 'fixture',
          channelId: 'private-' + n,
          agentGroupId: 'group-' + n,
          messagingGroupId: 'mg-' + n,
          sessionId: 'session-' + n,
          provider: 'codex',
        } satisfies CosBinding,
        db,
      );
    db.prepare("UPDATE cos_identity_boundaries SET binding='invalid' WHERE scope_id='scope-00'").run();
    const prepare = vi.spyOn(db, 'prepare');
    const contexts = mailMaintenanceContexts(db);
    const first = contexts();
    expect(first).toHaveLength(9);
    expect(contexts().map((x) => x.scopeId)).toEqual(['scope-10', 'scope-11']);
    expect(contexts()).toHaveLength(9);
    expect(first[0].ingressId).toBe('mail-maintenance');
    expect(prepare.mock.calls.every(([sql]) => sql.includes('cos_identity_boundaries'))).toBe(true);
    prepare.mockRestore();
  } finally {
    closeDb();
  }
});
