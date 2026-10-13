import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { backupProducerFile } from '../../modules/chief-of-staff/ops/backup-producer-file.js';

test('G02 compiled producer remains in its verified payload when the data installation contains no dist', () => {
  const original = process.cwd(),
    installation = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-data-installation-'));
  try {
    process.chdir(installation);
    assert.equal(fs.existsSync(path.join(installation, 'dist')), false);
    const producer = backupProducerFile(),
      expected = fileURLToPath(new URL('../../modules/chief-of-staff/ops/backup-archive-producer.js', import.meta.url)),
      stat = fs.lstatSync(producer);
    assert.equal(producer, expected);
    assert.equal(fs.realpathSync(producer), producer);
    assert(stat.isFile());
    assert.equal(stat.nlink, 1);
    assert.equal(stat.mode & 0o022, 0);
    assert.equal(fs.existsSync(path.join(installation, 'dist')), false);
  } finally {
    process.chdir(original);
    fs.rmSync(installation, { recursive: true });
  }
});
