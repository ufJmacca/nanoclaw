import { createHash } from 'node:crypto';
export type SavedImage = {
  configurationId: string;
  engineIds: string[];
  tags: string[];
  os: string;
  architecture: string;
  labels: Record<string, string>;
};
/** Reads Docker save metadata only. Layer bytes are streamed past; nothing is extracted or executed. */
export async function imageConfigurations(source: AsyncIterable<Uint8Array>): Promise<SavedImage[]> {
  const iterator = source[Symbol.asyncIterator]();
  let buffer = Buffer.alloc(0),
    consumed = 0;
  const reject = (): never => {
    throw new Error('invalid_image_archive');
  };
  const read = async (size: number, capture = true): Promise<Buffer> => {
    const result: Buffer[] = [];
    while (size > 0) {
      if (!buffer.length) {
        const next = await iterator.next();
        if (next.done) return reject();
        buffer = Buffer.from(next.value);
      }
      const count = Math.min(size, buffer.length);
      if (capture) result.push(buffer.subarray(0, count));
      buffer = buffer.subarray(count);
      size -= count;
      consumed += count;
      if (consumed > 64 * 1024 * 1024 * 1024) return reject();
    }
    return capture ? Buffer.concat(result) : Buffer.alloc(0);
  };
  const string = (bytes: Buffer) => bytes.toString('utf8').replace(/\0.*$/s, '');
  const octal = (bytes: Buffer) => {
    const value = string(bytes).trim();
    if (!/^[0-7]+$/.test(value)) return reject();
    const number = parseInt(value, 8);
    if (!Number.isSafeInteger(number)) return reject();
    return number;
  };
  const configs = new Map<string, Omit<SavedImage, 'tags' | 'engineIds'>>(),
    manifests = new Map<string, string[]>(),
    names = new Set<string>();
  let manifest: unknown,
    ended = false;
  for (let count = 0; count < 100000; count++) {
    const header = await read(512);
    if (header.every((byte) => byte === 0)) {
      if (!(await read(512)).every((byte) => byte === 0)) return reject();
      if (buffer.some((byte) => byte !== 0)) return reject();
      for await (const remaining of { [Symbol.asyncIterator]: () => iterator })
        if (remaining.some((byte) => byte !== 0)) return reject();
      ended = true;
      break;
    }
    const expected = octal(header.subarray(148, 156));
    const actual = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
    if (actual !== expected || !string(header.subarray(257, 263)).startsWith('ustar')) return reject();
    const prefix = string(header.subarray(345, 500)),
      base = string(header.subarray(0, 100));
    const name = (prefix ? prefix + '/' : '') + base;
    if (
      !name ||
      name.startsWith('/') ||
      name.split('/').some((part) => part === '..' || part === '.') ||
      names.has(name)
    )
      return reject();
    names.add(name);
    const size = octal(header.subarray(124, 136)),
      type = header[156];
    if (![0, 48, 53].includes(type)) return reject();
    const capture = type !== 53 && size <= 4 * 1024 * 1024;
    const bytes = await read(size, capture);
    await read((512 - (size % 512)) % 512, false);
    if (!capture) continue;
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch {
      if (name === 'manifest.json') return reject();
      continue;
    }
    if (name === 'manifest.json') {
      manifest = value;
      continue;
    }
    if (
      value?.schemaVersion === 2 &&
      ['application/vnd.oci.image.manifest.v1+json', 'application/vnd.docker.distribution.manifest.v2+json'].includes(
        String(value.mediaType),
      )
    ) {
      const hash = createHash('sha256').update(bytes).digest('hex'),
        configuration = (value.config as { digest?: string })?.digest;
      if (name !== 'blobs/sha256/' + hash || !configuration || !/^sha256:[a-f0-9]{64}$/.test(configuration))
        return reject();
      manifests.set(configuration, [...(manifests.get(configuration) ?? []), 'sha256:' + hash]);
    }
    if (value && typeof value === 'object' && 'architecture' in value && 'rootfs' in value && 'config' in value) {
      const hash = createHash('sha256').update(bytes).digest('hex');
      if (![hash + '.json', 'blobs/sha256/' + hash].includes(name) || configs.size >= 20) return reject();
      const config = value.config as { Labels?: Record<string, string> };
      if (typeof value.os !== 'string' || typeof value.architecture !== 'string' || !config) return reject();
      configs.set(name, {
        configurationId: 'sha256:' + hash,
        os: value.os,
        architecture: value.architecture,
        labels: config.Labels ?? {},
      });
    }
  }
  if (!ended || !Array.isArray(manifest) || !manifest.length || manifest.length > 20) return reject();
  const seen = new Set<string>();
  return manifest.map((item) => {
    const configuration = configs.get(item?.Config);
    if (
      !configuration ||
      !Array.isArray(item.RepoTags) ||
      !item.RepoTags.every((tag: unknown) => typeof tag === 'string') ||
      seen.has(item.Config)
    )
      return reject();
    seen.add(item.Config);
    return {
      ...configuration,
      engineIds: [configuration.configurationId, ...(manifests.get(configuration.configurationId) ?? [])],
      tags: item.RepoTags,
    };
  });
}
