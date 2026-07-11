import fs from 'node:fs';

import { closeDb, initDb, runMigrations } from '../index.js';
import { acquireHostExecutionLease, releaseHostExecutionLease } from '../host-execution-lease.js';

const [dbPath, mode, markerPath] = process.argv.slice(2);
if (!dbPath || !mode || !markerPath || !['hold', 'once'].includes(mode)) {
  throw new Error('Expected database path, hold|once mode, and marker path');
}

const db = initDb(dbPath);
try {
  runMigrations(db);
  const lease = acquireHostExecutionLease(db);
  fs.writeFileSync(markerPath, String(process.pid), { mode: 0o600 });
  fs.writeSync(1, 'acquired\n');
  if (mode === 'hold') {
    setInterval(() => {}, 60_000);
  } else {
    if (!releaseHostExecutionLease(db, lease)) throw new Error('Exact host lease release failed');
    closeDb();
  }
} catch (err) {
  closeDb();
  const message = err instanceof Error ? err.message : 'Unknown host execution lease failure';
  fs.writeSync(2, `${message}\n`);
  process.exitCode = 2;
}
