import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/contracts/mattermost/**/*.contract.ts'],
    testTimeout: 180_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    maxWorkers: 1,
    retry: 0,
  },
});
