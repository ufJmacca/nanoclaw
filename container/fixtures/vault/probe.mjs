import fs from 'node:fs';
import assert from 'node:assert/strict';
import {
  configureVaultStorage,
  verifyVaultStorage,
  withVaultDirectory,
  vaultStorageStatus,
} from '/code/modules/chief-of-staff/ops/vault-storage.js';
import { verifyVaultMemory } from '/code/modules/chief-of-staff/ops/vault-memory.js';
const roots = { targetRoot: '/case/target', installationRoot: '/case/application', dataRoot: '/case/data' };
const mode = process.argv[2];
if (mode === 'memory') {
  verifyVaultMemory();
} else if (mode === 'capture') {
  configureVaultStorage(roots, '/case/vault');
  await withVaultDirectory(roots, 'backup-credentials', async (pinned) => {
    const fd = fs.openSync(pinned + '/canary', 'wx', 0o600);
    try {
      fs.writeFileSync(fd, 'SYNTHETIC_ENCRYPTED_CANARY');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  });
} else if (mode === 'recovery') {
  verifyVaultStorage(roots);
  await withVaultDirectory(roots, 'backup-credentials', async (pinned) => {
    assert.equal(fs.readFileSync(pinned + '/canary', 'utf8'), 'SYNTHETIC_ENCRYPTED_CANARY');
    assert.equal(fs.readFileSync(pinned + '/race-canary', 'utf8'), 'SYNTHETIC_RACE_CANARY');
  });
} else if (mode === 'race') {
  await assert.rejects(
    withVaultDirectory(roots, 'backup-credentials', async (pinned) => {
      fs.writeFileSync('/case/target/race-request', 'synthetic', { flag: 'wx', mode: 0o600 });
      let detached = false;
      for (let attempt = 0; attempt < 500; attempt++) {
        if (fs.existsSync('/case/target/race-closed')) {
          detached = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(detached, true);
      const fd = fs.openSync(pinned + '/race-canary', 'wx', 0o600);
      try {
        fs.writeFileSync(fd, 'SYNTHETIC_RACE_CANARY');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }),
    /vault_storage_unavailable/,
  );
} else if (mode === 'unavailable' || mode === 'denied') {
  assert.equal(vaultStorageStatus(roots).status, 'unavailable');
  await assert.rejects(
    withVaultDirectory(roots, 'backup-credentials', async () => {
      throw Error('unexpected credential access');
    }),
    /vault_storage_unavailable/,
  );
} else throw Error('unknown fixture mode');
