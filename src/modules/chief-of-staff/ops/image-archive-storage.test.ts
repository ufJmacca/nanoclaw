import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  measureImageArchiveStorage,
  readImageArchiveStorage,
  assertImageImportSpace,
} from './image-archive-storage.js';

function tar(files: Record<string, Buffer | string>) {
  const blocks: Buffer[] = [];
  for (const [name, value] of Object.entries(files)) {
    const data = Buffer.from(value),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
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
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
const sha = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
async function* chunks(bytes: Buffer) {
  for (let i = 0; i < bytes.length; i += 73) yield bytes.subarray(i, i + 73);
}
function fixture(
  options: {
    differentParent?: boolean;
    corrupt?: boolean;
    wrongDiff?: boolean;
    curlyRaw?: boolean;
    zstd?: boolean;
  } = {},
) {
  const host = tar({ 'big-zero-file': Buffer.alloc(128 * 1024) }),
    worker = tar({ [options.curlyRaw ? '{worker' : 'worker']: 'worker' });
  const hostGzip = options.zstd ? Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0]) : gzipSync(host);
  if (options.corrupt) hostGzip[hostGzip.length - 8] ^= 1;
  const hostName = 'blobs/sha256/' + sha(hostGzip),
    workerName = 'worker/layer.tar';
  const config = (diffs: string[], role: string) =>
    JSON.stringify({
      architecture: 'arm64',
      os: 'linux',
      rootfs: { type: 'layers', diff_ids: diffs.map((x) => 'sha256:' + x) },
      config: { Labels: {} },
      comment: role,
    });
  const h = config([options.wrongDiff ? '0'.repeat(64) : sha(host)], 'host');
  const layers = options.differentParent ? [workerName, hostName] : [hostName, workerName];
  const w = config(options.differentParent ? [sha(worker), sha(host)] : [sha(host), sha(worker)], 'worker');
  const hName = sha(h) + '.json',
    wName = sha(w) + '.json';
  const files = {
    [hostName]: hostGzip,
    [workerName]: worker,
    [hName]: h,
    [wName]: w,
    'manifest.json': JSON.stringify([
      { Config: hName, RepoTags: ['fixture:host'], Layers: [hostName] },
      { Config: wName, RepoTags: ['fixture:worker'], Layers: layers },
    ]),
  };
  return {
    bytes: tar(files),
    hostConfigurationId: 'sha256:' + sha(h),
    hostBytes: host.length,
    workerBytes: worker.length,
    stored: Object.values(files).reduce((n, value) => n + Buffer.byteLength(value), 0),
  };
}
it('measures compressed content, shared unpacked prefixes, import scratch and host extraction before admission', async () => {
  const f = fixture(),
    measured = await measureImageArchiveStorage(chunks(f.bytes), f.hostConfigurationId);
  expect(measured.contentBytes).toBe(f.stored);
  expect(measured.snapshotBytes).toBe(f.hostBytes + f.workerBytes);
  expect(measured.archiveTarBytes).toBe(f.bytes.length);
  expect(measured.hostPayloadUpperBound).toBe(f.hostBytes);
  expect(() => assertImageImportSpace(measured.requiredFreeBytes - 1, measured)).toThrow('insufficient_target_disk');
  expect(() => assertImageImportSpace(measured.requiredFreeBytes, measured)).not.toThrow();
});
it('charges a reused layer again when it belongs to a different unpacked parent chain', async () => {
  const f = fixture({ differentParent: true });
  const measured = await measureImageArchiveStorage(chunks(f.bytes), f.hostConfigurationId);
  expect(measured.snapshotBytes).toBe(2 * f.hostBytes + f.workerBytes);
});
it('supports a valid raw layer whose first filename looks like JSON', async () => {
  const f = fixture({ curlyRaw: true });
  const measured = await measureImageArchiveStorage(chunks(f.bytes), f.hostConfigurationId);
  expect(measured.snapshotBytes).toBe(f.hostBytes + f.workerBytes);
});
it('refuses unsupported compression and a missing host configuration identity', async () => {
  const zstd = fixture({ zstd: true });
  await expect(measureImageArchiveStorage(chunks(zstd.bytes), zstd.hostConfigurationId)).rejects.toThrow();
  const f = fixture();
  await expect(measureImageArchiveStorage(chunks(f.bytes), 'sha256:' + '0'.repeat(64))).rejects.toThrow();
});
it('refuses a compressed layer with a bad CRC, a mismatched diff ID, or a truncated archive', async () => {
  for (const option of [{ corrupt: true }, { wrongDiff: true }]) {
    const f = fixture(option);
    await expect(measureImageArchiveStorage(chunks(f.bytes), f.hostConfigurationId)).rejects.toThrow();
  }
  const f = fixture();
  await expect(measureImageArchiveStorage(chunks(f.bytes.subarray(0, -600)), f.hostConfigurationId)).rejects.toThrow();
});
it('denies a forged capacity total and invalid available-space observations', async () => {
  const f = fixture(),
    measured = await measureImageArchiveStorage(chunks(f.bytes), f.hostConfigurationId);
  for (const available of [-1, NaN, Infinity, 0.5]) expect(() => assertImageImportSpace(available, measured)).toThrow();
  expect(() => assertImageImportSpace(1e12, { ...measured, requiredFreeBytes: 1 })).toThrow();
});
it('binds measured sizes to the complete held compressed archive hash and refuses changed bytes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-size-'));
  try {
    const f = fixture(),
      archive = gzipSync(f.bytes),
      file = root + '/images.tar.gz';
    fs.writeFileSync(file, archive, { mode: 0o600 });
    const measured = await readImageArchiveStorage(file, sha(archive), f.hostConfigurationId);
    expect(measured.snapshotBytes).toBe(f.hostBytes + f.workerBytes);
    await expect(readImageArchiveStorage(file, '0'.repeat(64), f.hostConfigurationId)).rejects.toThrow();
    fs.linkSync(file, root + '/other-copy');
    await expect(readImageArchiveStorage(file, sha(archive), f.hostConfigurationId)).rejects.toThrow();
    fs.unlinkSync(root + '/other-copy');
    fs.writeFileSync(file, archive.subarray(0, -8));
    await expect(readImageArchiveStorage(file, sha(archive), f.hostConfigurationId)).rejects.toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
