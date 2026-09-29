import { afterEach, describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { payloadDigest } from './payload.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-payload-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'lib'));
  fs.writeFileSync(path.join(root, 'lib/code.js'), 'fixture');
  fs.symlinkSync('lib/code.js', path.join(root, 'entry'));
  return root;
}
describe('S01-REL05 extracted host payload identity', () => {
  it('is stable across timestamps but detects content, executable modes and link changes', async () => {
    const root = fixture(),
      before = await payloadDigest(root);
    fs.utimesSync(path.join(root, 'lib/code.js'), new Date(0), new Date(0));
    expect(await payloadDigest(root)).toBe(before);
    fs.chmodSync(path.join(root, 'lib/code.js'), 0o755);
    expect(await payloadDigest(root)).not.toBe(before);
    fs.chmodSync(path.join(root, 'lib/code.js'), 0o644);
    fs.writeFileSync(path.join(root, 'lib/code.js'), 'changed');
    expect(await payloadDigest(root)).not.toBe(before);
  });
  it('rejects source links outside the payload and private runtime files', async () => {
    for (const name of ['external', '.env', 'data']) {
      const root = fixture();
      if (name === 'external') fs.symlinkSync('/etc/passwd', path.join(root, name));
      else fs.writeFileSync(path.join(root, name), 'must-not-package');
      await expect(payloadDigest(root)).rejects.toThrow('unsafe_release_payload');
    }
  });
});
