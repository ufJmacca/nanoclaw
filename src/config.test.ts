import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.doUnmock('./env.js');
  vi.resetModules();
});

it('defaults global container admission to a conservative Pi-sized limit', async () => {
  vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '');
  vi.resetModules();

  const config = await import('./config.js');

  expect(config.MAX_CONCURRENT_CONTAINERS).toBe(2);
});

it('honors the global container limit from the project env file', async () => {
  vi.stubEnv('MAX_CONCURRENT_CONTAINERS', '');
  vi.doMock('./env.js', () => ({
    readEnvFile: vi.fn(() => ({ MAX_CONCURRENT_CONTAINERS: '3' })),
  }));
  vi.resetModules();

  const config = await import('./config.js');

  expect(config.MAX_CONCURRENT_CONTAINERS).toBe(3);
});
