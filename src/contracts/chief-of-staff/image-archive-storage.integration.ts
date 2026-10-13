import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  measureImageArchiveStorage,
  assertImageImportSpace,
  readImageArchiveStorage,
} from '../../modules/chief-of-staff/ops/image-archive-storage.js';

function tar(files: Record<string, Buffer | string>) {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const bytes = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(bytes.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write(
      header
        .reduce((sum, byte) => sum + byte, 0)
        .toString(8)
        .padStart(6, '0') + '\0 ',
      148,
    );
    blocks.push(header, bytes, Buffer.alloc((512 - (bytes.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const hash = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function* chunks(bytes: Buffer) {
  for (let i = 0; i < bytes.length; i += 257) yield bytes.subarray(i, i + 257);
}
function archive(corrupt = false) {
  const layer = tar({ 'large-compressible-file': Buffer.alloc(1024 * 1024) }),
    compressed = gzipSync(layer);
  if (corrupt) compressed[compressed.length - 8] ^= 1;
  const config = JSON.stringify({
    architecture: 'arm64',
    os: 'linux',
    rootfs: { type: 'layers', diff_ids: ['sha256:' + hash(layer)] },
    config: { Labels: {} },
  });
  const configuration = hash(config),
    layerName = 'blobs/sha256/' + hash(compressed),
    configName = configuration + '.json';
  const bytes = tar({
    [layerName]: compressed,
    [configName]: config,
    'manifest.json': JSON.stringify([{ Config: configName, RepoTags: ['fixture:host'], Layers: [layerName] }]),
  });
  return { bytes, host: 'sha256:' + configuration, expanded: layer.length };
}
test('G02 compiled helper accounts for actual compressed and unpacked image storage before import', async () => {
  const f = archive(),
    measured = await measureImageArchiveStorage(chunks(f.bytes), f.host);
  assert.equal(measured.snapshotBytes, f.expanded);
  assert.equal(measured.hostPayloadUpperBound, f.expanded);
  assert.equal(measured.archiveTarBytes, f.bytes.length);
  assert.ok(measured.snapshotBytes > measured.contentBytes * 100);
  assert.throws(() => assertImageImportSpace(measured.requiredFreeBytes - 1, measured), /insufficient_target_disk/);
  assert.doesNotThrow(() => assertImageImportSpace(measured.requiredFreeBytes, measured));
});
test('G02 compiled helper refuses corrupted layer compression and wrong saved host identity', async () => {
  const bad = archive(true);
  await assert.rejects(measureImageArchiveStorage(chunks(bad.bytes), bad.host));
  const good = archive();
  await assert.rejects(measureImageArchiveStorage(chunks(good.bytes), 'sha256:' + '0'.repeat(64)));
});
test('G02 compiled file reader finishes cleanup without closing a reused unrelated descriptor', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-size-close-'));
  const originalClose = fs.close,
    pending: Array<() => Promise<void>> = [];
  let sibling: number | undefined;
  const delayedClose = (fd: number, callback?: fs.NoParamCallback) => {
    pending.push(
      () =>
        new Promise<void>((resolve) =>
          originalClose(fd, (error) => {
            callback?.(error);
            resolve();
          }),
        ),
    );
  };
  fs.close = Object.assign(delayedClose, { __promisify__: originalClose.__promisify__ });
  try {
    const f = archive(),
      compressed = gzipSync(f.bytes),
      file = root + '/images.tar.gz';
    fs.writeFileSync(file, compressed, { mode: 0o600 });
    fs.writeFileSync(root + '/retained', 'retain', { mode: 0o600 });
    const measured = await readImageArchiveStorage(file, hash(compressed), f.host);
    assert.equal(measured.snapshotBytes, f.expanded);
    sibling = fs.openSync(root + '/retained', 'r');
    for (const finish of pending.splice(0)) await finish();
    assert.equal(fs.readFileSync(sibling, 'utf8'), 'retain');
  } finally {
    fs.close = originalClose;
    for (const finish of pending.splice(0)) await finish();
    if (sibling !== undefined && fs.existsSync('/proc/self/fd/' + sibling)) fs.closeSync(sibling);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
