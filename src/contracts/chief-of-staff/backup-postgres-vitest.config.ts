import { defineConfig } from 'vitest/config';
import { BACKUP_POSTGRES_FILES } from './backup-postgres-report.js';

export default defineConfig({
  test: {
    include: [...BACKUP_POSTGRES_FILES],
    fileParallelism: false,
    maxWorkers: 1,
    testNamePattern:
      'admitted separate PostgreSQL|complete real-producer capture through the default|actual admitted test database selected again',
  },
});
