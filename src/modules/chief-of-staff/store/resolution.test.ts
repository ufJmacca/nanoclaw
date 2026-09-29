import { describe, it, expect, vi, beforeEach } from 'vitest';
const dns = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock('node:dns/promises', () => ({ lookup: dns.lookup }));
vi.mock('node:os', () => ({ networkInterfaces: () => ({ fixture: [{ address: '192.168.50.1' }] }) }));
import { verifyExternalHost } from './config.js';
beforeEach(() => {
  dns.lookup.mockReset();
});
describe('S01-PG01 bounded external target resolution', () => {
  it('returns only the verified remote addresses so the connection can pin its target', async () => {
    dns.lookup.mockResolvedValue([{ address: '192.168.50.2', family: 4 }]);
    expect(await verifyExternalHost('fixture-db.invalid')).toEqual(['192.168.50.2']);
  });
  it('rejects mixed public/private DNS answers and this host itself', async () => {
    dns.lookup.mockResolvedValue([
      { address: '192.168.50.2', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]);
    await expect(verifyExternalHost('fixture-db.invalid')).rejects.toThrow('COS_PGHOST');
    dns.lookup.mockResolvedValue([{ address: '192.168.50.1', family: 4 }]);
    await expect(verifyExternalHost('fixture-db.invalid')).rejects.toThrow('COS_PGHOST');
  });
  it('bounds stalled DNS before attempting any socket connection', async () => {
    vi.useFakeTimers();
    dns.lookup.mockReturnValue(new Promise(() => {}));
    try {
      let failure: string | null = null;
      void verifyExternalHost('fixture-db.invalid').catch((error) => {
        failure = error.message;
      });
      await vi.advanceTimersByTimeAsync(3001);
      expect(failure).toContain('COS_PGHOST');
    } finally {
      vi.useRealTimers();
    }
  });
});
