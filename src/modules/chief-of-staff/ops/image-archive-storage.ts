import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { imageConfigurations, type ArchiveFileObserver } from './image-archive.js';

const maximum = 64 * 1024 ** 3;
// Allocation/metadata headroom plus the existing 1 GiB protected-runtime floor.
const reserve = 2 * 1024 ** 3;
export type ImageArchiveStorage = Readonly<{
  contentBytes: number;
  snapshotBytes: number;
  archiveTarBytes: number;
  hostPayloadUpperBound: number;
  requiredFreeBytes: number;
}>;
type Blob = { bytes: number; expanded: number; diffId: string };
type Config = { rootfs?: { type?: string; diff_ids?: unknown } };
type Entry = { Config?: string; Layers?: unknown };
const reject = (): never => {
  throw Error('image_archive_storage_unverified');
};

/** Count actual layer expansion, including independent unpacked parent chains.
 * No footer-size approximation, cached-layer credit, extraction or execution. */
export async function measureImageArchiveStorage(
  source: AsyncIterable<Uint8Array>,
  hostConfigurationId: string,
): Promise<ImageArchiveStorage> {
  if (!/^sha256:[a-f0-9]{64}$/.test(hostConfigurationId)) return reject();
  const blobs = new Map<string, Blob>(),
    configs = new Map<string, Config>();
  let cancelActive: (() => void) | undefined;
  let entries: Entry[] | undefined,
    archiveTarBytes = 0,
    contentBytes = 0,
    totalExpanded = 0;
  const counted = async function* () {
    for await (const chunk of source) {
      archiveTarBytes += chunk.byteLength;
      if (archiveTarBytes > maximum) return reject();
      yield chunk;
    }
  };
  const observer: ArchiveFileObserver = (name, size) => {
    let probe = Buffer.alloc(0),
      decided = false,
      gzip = false,
      expanded = 0;
    let input: PassThrough | undefined, output: ReturnType<typeof createGunzip> | undefined;
    let copying: Promise<void> | undefined, counting: Promise<void> | undefined;
    cancelActive = () => {
      input?.destroy();
      output?.destroy();
    };
    const hash = createHash('sha256'),
      metadata: Buffer[] = [];
    const add = (chunk: Uint8Array) => {
      expanded += chunk.byteLength;
      totalExpanded += chunk.byteLength;
      if (totalExpanded > maximum) return reject();
      hash.update(chunk);
    };
    const write = async (chunk: Buffer) => {
      if (gzip) {
        if (!input!.write(chunk)) await once(input!, 'drain');
      } else add(chunk);
    };
    return {
      async write(chunk) {
        contentBytes += chunk.byteLength;
        if (contentBytes > maximum) return reject();
        if (size <= 4 * 1024 ** 2) metadata.push(Buffer.from(chunk));
        if (!decided) {
          probe = Buffer.concat([probe, chunk]);
          if (probe.length < 4 && probe.length < size) return;
          decided = true;
          if (probe.length >= 4 && probe.readUInt32LE(0) === 0xfd2fb528) return reject();
          gzip = probe[0] === 0x1f && probe[1] === 0x8b;
          if (gzip) {
            input = new PassThrough();
            output = createGunzip();
            copying = pipeline(input, output);
            counting = (async () => {
              try {
                for await (const decoded of output!) add(decoded);
              } catch (error) {
                input!.destroy(error as Error);
                output!.destroy(error as Error);
                throw error;
              }
            })();
            void copying.catch(() => {});
            void counting.catch(() => {});
          }
          await write(probe);
          probe = Buffer.alloc(0);
        } else await write(Buffer.from(chunk));
      },
      async finish() {
        if (gzip) {
          input!.end();
          await Promise.all([copying, counting]);
        }
        cancelActive = undefined;
        blobs.set(name, { bytes: size, expanded, diffId: 'sha256:' + hash.digest('hex') });
        if (!gzip && metadata.length) {
          const bytes = Buffer.concat(metadata),
            text = bytes.toString('utf8').trimStart();
          if (!text.startsWith('{') && !text.startsWith('[')) return;
          let value: unknown;
          try {
            value = JSON.parse(text);
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            if (name === 'manifest.json') return reject();
            return;
          }
          if (name === 'manifest.json') {
            if (!Array.isArray(value)) return reject();
            entries = value;
          } else if (value && typeof value === 'object' && 'rootfs' in value) {
            const rootfs = (value as Config).rootfs;
            configs.set(name, { rootfs: { type: rootfs?.type, diff_ids: rootfs?.diff_ids } });
          }
        }
      },
    };
  };
  let saved: Awaited<ReturnType<typeof imageConfigurations>>;
  try {
    saved = await imageConfigurations(counted(), observer);
  } finally {
    cancelActive?.();
  }
  if (!entries || entries.length !== saved.length || !saved.some((x) => x.configurationId === hostConfigurationId))
    return reject();
  const chains = new Set<string>();
  let snapshotBytes = 0,
    hostPayloadUpperBound = 0,
    hosts = 0;
  for (const entry of entries) {
    if (!entry.Config || !Array.isArray(entry.Layers) || entry.Layers.length > 512) return reject();
    const config = configs.get(entry.Config),
      diffs = config?.rootfs?.diff_ids;
    if (config?.rootfs?.type !== 'layers' || !Array.isArray(diffs) || diffs.length !== entry.Layers.length)
      return reject();
    const host = [hostConfigurationId.slice(7) + '.json', 'blobs/sha256/' + hostConfigurationId.slice(7)].includes(
      entry.Config,
    );
    if (host) hosts++;
    let parent = '';
    for (let index = 0; index < entry.Layers.length; index++) {
      const name = entry.Layers[index];
      if (typeof name !== 'string') return reject();
      const blob = blobs.get(name);
      if (!blob || blob.diffId !== diffs[index]) return reject();
      parent = createHash('sha256')
        .update(parent + ' ' + blob.diffId)
        .digest('hex');
      if (!chains.has(parent)) {
        chains.add(parent);
        snapshotBytes += blob.expanded;
      }
      if (host) hostPayloadUpperBound += blob.expanded;
    }
  }
  if (hosts !== 1) return reject();
  const requiredFreeBytes = contentBytes + snapshotBytes + archiveTarBytes + hostPayloadUpperBound + reserve;
  if (!Number.isSafeInteger(requiredFreeBytes)) return reject();
  return Object.freeze({ contentBytes, snapshotBytes, archiveTarBytes, hostPayloadUpperBound, requiredFreeBytes });
}

export function assertImageImportSpace(availableBytes: number, storage: ImageArchiveStorage): void {
  if (
    !Number.isSafeInteger(availableBytes) ||
    availableBytes < 0 ||
    Object.keys(storage).sort().join(',') !==
      'archiveTarBytes,contentBytes,hostPayloadUpperBound,requiredFreeBytes,snapshotBytes' ||
    Object.values(storage).some((x) => !Number.isSafeInteger(x) || x < 0) ||
    storage.requiredFreeBytes !==
      storage.contentBytes +
        storage.snapshotBytes +
        storage.archiveTarBytes +
        storage.hostPayloadUpperBound +
        reserve ||
    availableBytes < storage.requiredFreeBytes
  )
    throw Error('insufficient_target_disk');
}

/** Rehash the complete held archive while measuring. Size measurements can
 * grant admission only for exactly the already verified saved-image bytes. */
export async function readImageArchiveStorage(file: string, expectedHash: string, hostConfigurationId: string) {
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || fs.realpathSync(file) !== file) return reject();
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW),
    initial = fs.fstatSync(fd, { bigint: true });
  let source: ReturnType<typeof fs.createReadStream> | undefined,
    hashed: Transform | undefined,
    expanded: ReturnType<typeof createGunzip> | undefined,
    copying: Promise<void> | undefined;
  try {
    if (
      !initial.isFile() ||
      initial.nlink !== 1n ||
      initial.uid !== BigInt(process.getuid!()) ||
      initial.mode & 0o022n ||
      initial.size > BigInt(maximum)
    )
      return reject();
    const hash = createHash('sha256');
    source = fs.createReadStream(file, { fd, autoClose: false });
    hashed = new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    expanded = createGunzip();
    copying = pipeline(source, hashed, expanded);
    void copying.catch(() => {});
    const measured = await measureImageArchiveStorage(expanded, hostConfigurationId);
    await copying;
    const same = (stat: fs.BigIntStats) =>
      ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs', 'nlink'].every(
        (key) => stat[key as keyof fs.BigIntStats] === initial[key as keyof fs.BigIntStats],
      );
    if (
      hash.digest('hex') !== expectedHash ||
      !same(fs.fstatSync(fd, { bigint: true })) ||
      !same(fs.lstatSync(file, { bigint: true }))
    )
      return reject();
    return measured;
  } finally {
    source?.destroy();
    hashed?.destroy();
    expanded?.destroy();
    if (copying) await copying.catch(() => {});
    fs.closeSync(fd);
  }
}
