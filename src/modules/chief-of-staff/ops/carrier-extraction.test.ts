import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { extractCarrierPayload } from './carrier-extraction.js';
import { payloadDigest } from './payload.js';

it('extracts sealed read-only helper directories as the non-root owner and restores their exact modes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-carrier-extraction-'));
  const source = path.join(root, 'source'),
    destination = path.join(root, 'destination'),
    archive = path.join(root, 'payload.tar');
  fs.mkdirSync(source, { mode: 0o755 });
  fs.mkdirSync(destination, { mode: 0o700 });
  const sealed = path.join(source, 'vault-artifacts', 'a'.repeat(64));
  fs.mkdirSync(sealed, { recursive: true });
  fs.writeFileSync(path.join(sealed, 'artifact.json'), '{"synthetic":true}\n', { mode: 0o444 });
  fs.writeFileSync(path.join(sealed, 'gateway.mjs'), '// sealed fixture\n', { mode: 0o444 });
  fs.writeFileSync(path.join(sealed, 'node'), 'synthetic executable\n', { mode: 0o555 });
  fs.chmodSync(sealed, 0o500);
  execFileSync('/usr/bin/tar', ['--create', '--file=' + archive, '--directory=' + source, '.']);
  const expected = await payloadDigest(source);
  try {
    expect(process.getuid?.()).not.toBe(0);
    await extractCarrierPayload('b'.repeat(64), destination, () => ({
      output: fs.createReadStream(archive),
      completed: Promise.resolve(),
      close() {},
    }));
    expect(await payloadDigest(destination)).toBe(expected);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(destination, 'vault-artifacts', 'a'.repeat(64))).mode & 0o777).toBe(0o500);
    expect(fs.readFileSync(path.join(destination, 'vault-artifacts', 'a'.repeat(64), 'artifact.json'), 'utf8')).toBe(
      '{"synthetic":true}\n',
    );
    fs.writeFileSync(path.join(destination, 'stale-partial-file'), 'failed earlier copy');
    await extractCarrierPayload('b'.repeat(64), destination, () => ({
      output: fs.createReadStream(archive),
      completed: Promise.resolve(),
      close() {},
    }));
    expect(await payloadDigest(destination)).toBe(expected);
    expect(fs.existsSync(path.join(destination, 'stale-partial-file'))).toBe(false);
  } finally {
    fs.chmodSync(sealed, 0o700);
    const copied = path.join(destination, 'vault-artifacts', 'a'.repeat(64));
    if (fs.existsSync(copied)) fs.chmodSync(copied, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('refuses incomplete source streams and restores the private staging root without acknowledging extraction', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-carrier-extraction-failure-'));
  fs.chmodSync(root, 0o700);
  let closed = false;
  const source = () => ({
    output: fs.createReadStream('/dev/null'),
    completed: Promise.resolve(),
    close() {
      closed = true;
    },
  });
  try {
    await expect(extractCarrierPayload('b'.repeat(64), root, source)).rejects.toThrow('carrier_extraction_failed');
    expect(closed).toBe(true);
    expect(fs.statSync(root).mode & 0o777).toBe(0o700);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('rejects a linked destination or invalid carrier identity before opening a copy stream', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-carrier-extraction-path-'));
  const linked = path.join(root, 'linked');
  fs.symlinkSync(root, linked);
  const source = () => {
    throw Error('unexpected_copy');
  };
  try {
    await expect(extractCarrierPayload('../foreign', root, source)).rejects.toThrow('carrier_extraction_failed');
    await expect(extractCarrierPayload('b'.repeat(64), linked, source)).rejects.toThrow('carrier_extraction_failed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
