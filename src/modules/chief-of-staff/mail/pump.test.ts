import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { MailPump } from './pump.js';
import { CalendarReadError } from '../calendar/reader.js';
import type { MailStore } from './store.js';
import type { MailConnector } from './connector.js';
function fixture() {
  let now = 0;
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'mail-maintenance',
    provider: 'codex',
  };
  const binding = randomUUID();
  const store = {
    maintenanceBindings: vi.fn(async () => ({
      status: 'ok',
      items: [{ binding_id: binding, auth: 'ready', provider_allowed: true, poll_due: true }],
      next_after: null as string | null,
    })),
    claimPoll: vi.fn(async () => ({ status: 'ok', claimed: true })),
    maintain: vi.fn(async () => ({ status: 'ok', changed: false })),
    setAuth: vi.fn(async () => ({ status: 'ok' })),
  };
  const connector = { refresh: vi.fn(async () => ({ result: { status: 'ok' } })) };
  const authority = { poll: vi.fn(() => true), retention: vi.fn(() => true) };
  const fences = { assertOpen: vi.fn() };
  const pump = new MailPump({
    store: store as unknown as MailStore,
    connector: connector as unknown as MailConnector,
    authority,
    fences,
    now: () => now,
  });
  return {
    context,
    binding,
    store,
    connector,
    authority,
    fences,
    pump,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
it('polls only after the database claim and limits retention to its own five-minute cadence', async () => {
  const f = fixture();
  f.store.claimPoll.mockResolvedValueOnce({ status: 'ok', claimed: false });
  f.pump.poke(f.context);
  await vi.waitFor(() => expect(f.store.claimPoll).toHaveBeenCalledOnce());
  expect(f.connector.refresh).not.toHaveBeenCalled();
  expect(f.store.maintain).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(f.pump.poke(f.context)).toBe(true));
  await vi.waitFor(() => expect(f.connector.refresh).toHaveBeenCalledOnce());
  expect(f.store.maintain).toHaveBeenCalledOnce();
  f.advance(300000);
  await vi.waitFor(() => expect(f.pump.poke(f.context)).toBe(true));
  await vi.waitFor(() => expect(f.store.maintain).toHaveBeenCalledTimes(2));
  await f.pump.close();
});
it('retains while native admission is paused or the reader is disabled, without provider or model work', async () => {
  const f = fixture();
  f.authority.poll.mockReturnValue(false);
  f.pump.poke(f.context);
  await vi.waitFor(() => expect(f.store.maintain).toHaveBeenCalledOnce());
  expect(f.store.claimPoll).not.toHaveBeenCalled();
  expect(f.connector.refresh).not.toHaveBeenCalled();
  await f.pump.close();
  const disabled = new MailPump({ store: f.store as unknown as MailStore, authority: f.authority });
  disabled.poke(f.context);
  await vi.waitFor(() => expect(f.store.maintain).toHaveBeenCalledTimes(2));
  await disabled.close();
});
it('reconciles known independent revocation before tightening raw storage; unknown proof failure never invents a grant', async () => {
  const f = fixture();
  f.fences.assertOpen.mockImplementation(() => {
    throw new CalendarReadError('calendar_auth_revoked');
  });
  f.pump.poke(f.context);
  await vi.waitFor(() => expect(f.store.maintain).toHaveBeenCalledOnce());
  expect(f.store.setAuth).toHaveBeenCalledWith(f.context, f.binding, 'revoked');
  expect(f.store.setAuth.mock.invocationCallOrder[0]).toBeLessThan(f.store.maintain.mock.invocationCallOrder[0]);
  expect(f.connector.refresh).not.toHaveBeenCalled();
  await f.pump.close();
  const g = fixture();
  g.fences.assertOpen.mockImplementation(() => {
    throw new Error('private vault diagnostics');
  });
  g.pump.poke(g.context);
  await vi.waitFor(() => expect(g.store.maintain).toHaveBeenCalledOnce());
  expect(g.store.setAuth).not.toHaveBeenCalled();
  expect(g.connector.refresh).not.toHaveBeenCalled();
  await g.pump.close();
});
it('rechecks retention and poll authority after asynchronous inventory and claims', async () => {
  const f = fixture();
  f.store.maintenanceBindings.mockImplementationOnce(async () => {
    f.authority.retention.mockReturnValue(false);
    return {
      status: 'ok',
      items: [{ binding_id: f.binding, auth: 'ready', provider_allowed: true, poll_due: true }],
      next_after: null,
    };
  });
  f.pump.poke(f.context);
  await vi.waitFor(() => expect(f.store.maintenanceBindings).toHaveBeenCalledOnce());
  await f.pump.close();
  expect(f.store.maintain).not.toHaveBeenCalled();
  expect(f.store.claimPoll).not.toHaveBeenCalled();
  const g = fixture();
  g.store.claimPoll.mockImplementationOnce(async () => {
    g.authority.poll.mockReturnValue(false);
    return { status: 'ok', claimed: true };
  });
  g.pump.poke(g.context);
  await vi.waitFor(() => expect(g.store.claimPoll).toHaveBeenCalledOnce());
  await g.pump.close();
  expect(g.connector.refresh).not.toHaveBeenCalled();
});
it('returns without waiting for Google, keeps one actual refresh, and retirement awaits it after abort', async () => {
  const f = fixture();
  let settle!: () => void;
  f.connector.refresh.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = () => resolve({ result: { status: 'ok' } });
      }),
  );
  expect(f.pump.poke(f.context)).toBe(true);
  await vi.waitFor(() => expect(f.connector.refresh).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.pump.poke(f.context)).toBe(true));
  await vi.waitFor(() => expect(f.store.maintenanceBindings).toHaveBeenCalledTimes(2));
  expect(f.connector.refresh).toHaveBeenCalledOnce();
  let closed = false;
  const close = f.pump.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  expect(f.pump.poke(f.context)).toBe(false);
  expect((f.connector.refresh.mock.calls[0] as unknown as unknown[])[4]).toMatchObject({ aborted: true });
  settle();
  await close;
  expect(closed).toBe(true);
});
it('pages historical bindings fairly and does not duplicate a pending inventory owner', async () => {
  const f = fixture();
  f.store.maintenanceBindings.mockResolvedValueOnce({ status: 'ok', items: [], next_after: f.binding });
  f.pump.poke(f.context);
  expect(f.pump.poke(f.context)).toBe(false);
  await vi.waitFor(() => expect(f.store.maintenanceBindings).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(f.pump.poke(f.context)).toBe(true));
  await vi.waitFor(() => expect(f.store.maintenanceBindings).toHaveBeenCalledTimes(2));
  expect(f.store.maintenanceBindings.mock.calls[1]).toEqual([f.context, f.binding]);
  await f.pump.close();
});
it('reserves its sole refresh slot before an asynchronous claim, including across owner scopes', async () => {
  const f = fixture();
  let claim!: (value: { status: string; claimed: boolean }) => void;
  f.store.claimPoll.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        claim = resolve;
      }),
  );
  f.pump.poke(f.context);
  await vi.waitFor(() => expect(f.store.claimPoll).toHaveBeenCalledOnce());
  const other = { ...f.context, scopeId: 'other-scope' };
  f.pump.poke(other);
  await vi.waitFor(() => expect(f.store.maintain).toHaveBeenCalledTimes(2));
  expect(f.store.claimPoll).toHaveBeenCalledOnce();
  claim({ status: 'ok', claimed: true });
  await vi.waitFor(() => expect(f.connector.refresh).toHaveBeenCalledOnce());
  await f.pump.close();
});
