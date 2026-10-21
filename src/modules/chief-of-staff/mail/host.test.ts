import { expect, it, vi } from 'vitest';
import { MailHost } from './host.js';
import type { MailStore } from './store.js';
import type { MailConnector } from './connector.js';
import type { MailHostFences } from './config.js';
function fixture() {
  const events: string[] = [];
  const connector = {
    close: vi.fn(async () => {
      events.push('connector');
    }),
  };
  const resource = {
    close: vi.fn(async () => {
      events.push('resource');
    }),
    closed: vi.fn(() => true),
  };
  const host = new MailHost({
    store: {} as MailStore,
    connector: connector as unknown as MailConnector,
    resource: resource as unknown as MailHostFences,
  });
  return { host, connector, resource, events };
}
it('fences the host immediately and awaits connector work before closing pinned credential resources', async () => {
  const f = fixture();
  let settle!: () => void;
  f.connector.close.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        settle = resolve;
      }),
  );
  expect(f.host.active()).toBe(true);
  const closing = f.host.close();
  expect(f.host.active()).toBe(false);
  await Promise.resolve();
  expect(f.resource.close).not.toHaveBeenCalled();
  settle();
  await closing;
  expect(f.resource.close).toHaveBeenCalledOnce();
  await f.host.close();
  expect(f.resource.close).toHaveBeenCalledOnce();
});
it('accepts a terminal lost-proof diagnostic only after the profile lifetime actually settled', async () => {
  const f = fixture();
  f.resource.close.mockRejectedValue(Error('mail_configuration_unavailable'));
  await f.host.close();
  expect(f.host.active()).toBe(false);
  expect(f.events).toEqual(['connector']);
});
it('retains uncertain resource cleanup and permits reconciliation without reopening source admission', async () => {
  const f = fixture();
  f.resource.closed.mockReturnValue(false);
  f.resource.close.mockRejectedValueOnce(Error('mail_configuration_unavailable'));
  await expect(f.host.close()).rejects.toThrow('mail_host_retirement_unavailable');
  expect(f.host.active()).toBe(false);
  f.resource.closed.mockReturnValue(true);
  await f.host.close();
  expect(f.resource.close).toHaveBeenCalledTimes(2);
});
it('owns background maintenance through actual database settlement before releasing profile resources', async () => {
  const f = fixture();
  let settle!: (value: { status: string }) => void;
  const inventory = vi.fn(
    () =>
      new Promise<{ status: string }>((resolve) => {
        settle = resolve;
      }),
  );
  Object.assign(f.host.store, { maintenanceBindings: inventory });
  const context = {
    scopeId: 'scope',
    ownerId: 'owner',
    agentGroupId: 'group',
    sessionId: 'session',
    ingressId: 'mail-maintenance',
    provider: 'codex',
  };
  f.host.poke(context, { retention: () => true, poll: () => false });
  expect(inventory).toHaveBeenCalledOnce();
  const close = f.host.close();
  await Promise.resolve();
  expect(f.host.active()).toBe(false);
  expect(f.resource.close).not.toHaveBeenCalled();
  f.host.poke(context, { retention: () => true, poll: () => true });
  expect(inventory).toHaveBeenCalledOnce();
  settle({ status: 'unavailable' });
  await close;
  expect(f.resource.close).toHaveBeenCalledOnce();
});
