import { describe, it, expect, vi, afterEach } from 'vitest';
import { initTestDb, closeDb } from '../../db/connection.js';
import { ensureCosBoundarySchema } from '../../cos-boundary.js';
import { CosService } from './service.js';
import type { PriorityStore } from './store/priorities.js';
const services: CosService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  closeDb();
});
function fixture(enabled: boolean) {
  const db = initTestDb();
  ensureCosBoundarySchema(db);
  const end = vi.fn().mockResolvedValue(undefined),
    query = vi.fn().mockResolvedValue({ rows: [{ version: 1 }] });
  const store = {
    database: { pool: { end }, run: vi.fn().mockImplementation((fn) => fn({ query })) },
    pendingOutbox: vi.fn().mockResolvedValue({ status: 'ok', items: [] }),
  } as unknown as PriorityStore;
  const connect = vi.fn().mockResolvedValue(store);
  const admission = vi.fn().mockReturnValue(true),
    stop = vi.fn();
  const service = new CosService({
    db,
    enabled,
    connect,
    facts: vi.fn(),
    session: () => undefined,
    destination: () => undefined,
    stop,
    admission,
    wake: vi.fn().mockResolvedValue(undefined),
  });
  services.push(service);
  return { service, connect, end, query, admission, stop };
}
describe('S01-T01 host startup and dependency service', () => {
  it('disabled operation starts and ticks without connecting to PostgreSQL', async () => {
    const f = fixture(false);
    await f.service.tick();
    expect(f.connect).not.toHaveBeenCalled();
    expect(f.service.status).toBe('disabled');
  });
  it('creates one runtime pool and recovers bounded connection failures without rejecting host work', async () => {
    const f = fixture(true);
    f.connect.mockRejectedValueOnce(new Error('private database diagnostic'));
    await expect(f.service.tick()).resolves.toBeUndefined();
    expect(f.service.status).toBe('unreachable');
    await f.service.tick();
    expect(f.service.status).toBe('ready');
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledTimes(2);
  });
  it('does not start another connection while a previous tick is in progress', async () => {
    const f = fixture(true);
    let resolve!: () => void;
    const store = await f.connect();
    f.connect.mockClear();
    f.connect.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = () => done(store);
        }),
    );
    const first = f.service.tick();
    await f.service.tick();
    expect(f.connect).toHaveBeenCalledOnce();
    resolve();
    await first;
  });
  it('closes the pool and prevents reconnection after shutdown', async () => {
    const f = fixture(true);
    await f.service.tick();
    await f.service.stop();
    await f.service.tick();
    expect(f.end).toHaveBeenCalledOnce();
    expect(f.connect).toHaveBeenCalledOnce();
  });
});

it('closes only CoS admission during maintenance and reconnects after verified reopening', async () => {
  const f = fixture(true);
  await f.service.tick();
  f.admission.mockReturnValue(false);
  await f.service.tick();
  expect(f.service.status).toBe('maintenance');
  expect(f.end).toHaveBeenCalledOnce();
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledOnce();
  expect(f.end).toHaveBeenCalledOnce();
  f.admission.mockReturnValue(true);
  await f.service.tick();
  expect(f.connect).toHaveBeenCalledTimes(2);
  expect(f.service.status).toBe('ready');
});
