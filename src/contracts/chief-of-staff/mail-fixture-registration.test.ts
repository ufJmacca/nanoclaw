import { expect, it, vi } from 'vitest';
import { MAIL_STORE_CASES } from './mail-fixture-report.js';

const registered = vi.hoisted(() => ({ names: [] as string[] }));
vi.mock('node:test', () => ({
  before: () => {},
  after: () => {},
  // Inspect the real declarations without running database hooks or test bodies.
  test: (name: string) => registered.names.push(name),
}));

it('keeps required Mail fixture coverage aligned with the actual database-test registrations', async () => {
  await import('./mail-store.integration.js');
  expect(registered.names.length).toBeGreaterThan(0);
  expect(new Set(registered.names).size).toBe(registered.names.length);
  expect([...registered.names].sort()).toEqual([...MAIL_STORE_CASES].sort());
});
