import { defineConfig } from 'vitest/config';
import { ROOT_UNIT_FIXTURES } from './src/contracts/chief-of-staff/root-unit-fixtures.js';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // The Mac release coordinator runs both identities. Root receives only these
    // synthetic administration fixtures in a separate container without secrets.
    include: process.getuid?.() === 0 ? ROOT_UNIT_FIXTURES : ['src/**/*.test.ts', 'setup/**/*.test.ts'],
    exclude: process.getuid?.() === 0 ? [] : ROOT_UNIT_FIXTURES,
  },
});
