import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { imageConfigurations } from './image-archive.js';
function tar(files: Record<string, string>) {
  const blocks: Buffer[] = [];
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text),
      header = Buffer.alloc(512);
    header.write(name);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    header.fill(32, 148, 156);
    header[156] = 48;
    header.write('ustar\0', 257);
    header.write('00', 263);
    const sum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
async function* chunks(bytes: Buffer) {
  for (let index = 0; index < bytes.length; index += 73) yield bytes.subarray(index, index + 73);
}
const config = JSON.stringify({
  architecture: 'arm64',
  os: 'linux',
  rootfs: { type: 'layers', diff_ids: [] },
  config: { Labels: { 'org.opencontainers.image.revision': 'fixture' } },
});
const hash = createHash('sha256').update(config).digest('hex'),
  name = 'blobs/sha256/' + hash;
describe('S01-REL05 Docker archive configuration identity', () => {
  it('binds the immutable engine manifest identity to independently hashed configuration bytes', async () => {
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      config: { digest: 'sha256:' + hash },
      layers: [],
    });
    const manifestHash = createHash('sha256').update(manifest).digest('hex');
    const archive = tar({
      [name]: config,
      ['blobs/sha256/' + manifestHash]: manifest,
      'manifest.json': JSON.stringify([{ Config: name, RepoTags: ['fixture:agent'], Layers: [] }]),
    });
    const [image] = await imageConfigurations(chunks(archive));
    expect(image.engineIds).toContain('sha256:' + manifestHash);
    expect(image.engineIds).toContain('sha256:' + hash);
  });
  it('hashes configuration bytes separately from manifest digests without extracting layers', async () => {
    const archive = tar({
      [name]: config,
      'manifest.json': JSON.stringify([{ Config: name, RepoTags: ['fixture:agent'], Layers: [] }]),
    });
    expect(await imageConfigurations(chunks(archive))).toEqual([
      {
        configurationId: 'sha256:' + hash,
        engineIds: ['sha256:' + hash],
        tags: ['fixture:agent'],
        os: 'linux',
        architecture: 'arm64',
        labels: { 'org.opencontainers.image.revision': 'fixture' },
      },
    ]);
  });
  it('refuses altered configuration bytes, traversal, missing metadata and truncated archives', async () => {
    for (const archive of [
      tar({
        [name]: config.replace('arm64', 'amd64'),
        'manifest.json': JSON.stringify([{ Config: name, RepoTags: [], Layers: [] }]),
      }),
      tar({ '../escape': '{}' }),
      tar({ unrelated: '{}' }),
      tar({ [name]: config }).subarray(0, 550),
    ])
      await expect(imageConfigurations(chunks(archive))).rejects.toThrow();
  });
});
