import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { digest } from '../domain/contracts.js';
import { packageVaultRootArtifact } from './vault-root-package.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    const output = root + '/artifacts';
    if (fs.existsSync(output)) for (const name of fs.readdirSync(output)) fs.chmodSync(output + '/' + name, 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vault-package-'));
  roots.push(root);
  const input = {
    sourceCommit: 'c'.repeat(40),
    sourceTree: 'd'.repeat(40),
    gateway: root + '/compiled.mjs',
    output: root + '/artifacts',
  };
  fs.writeFileSync(input.gateway, 'fixture compiled gateway\n');
  return { root, input, controls: { assertToolchain() {} } };
}
it('packages only a sealed gateway and the executing pinned Node binary', () => {
  const f = fixture(),
    result = packageVaultRootArtifact(f.input, f.controls);
  expect(result.digest).toBe(digest(result.seal));
  expect(result.root).toBe(f.input.output + '/' + result.digest);
  expect(fs.readdirSync(result.root).sort()).toEqual(['artifact.json', 'gateway.mjs', 'node']);
  expect(fs.statSync(result.root).mode & 0o777).toBe(0o555);
  expect(fs.statSync(result.root + '/node').mode & 0o777).toBe(0o555);
  expect(fs.statSync(result.root + '/gateway.mjs').mode & 0o777).toBe(0o444);
  expect(result.seal.files['gateway.mjs'].sha256).toBe(
    createHash('sha256').update(fs.readFileSync(f.input.gateway)).digest('hex'),
  );
  expect(result.seal.files.node.sha256).toBe(
    createHash('sha256').update(fs.readFileSync(process.execPath)).digest('hex'),
  );
  expect(JSON.parse(fs.readFileSync(result.root + '/artifact.json', 'utf8'))).toEqual(result.seal);
});
it.each(['source', 'tree', 'symlink', 'oversized', 'toolchain', 'existing-artifact'])(
  'refuses %s without publishing a replacement',
  (reason) => {
    const f = fixture();
    if (reason === 'source') f.input.sourceCommit = 'main';
    if (reason === 'tree') f.input.sourceTree = 'private-tree';
    if (reason === 'symlink') {
      fs.renameSync(f.input.gateway, f.root + '/foreign');
      fs.symlinkSync('foreign', f.input.gateway);
    }
    if (reason === 'oversized') fs.truncateSync(f.input.gateway, 2 * 1024 * 1024 + 1);
    if (reason === 'toolchain')
      f.controls.assertToolchain = () => {
        throw Error('PRIVATE_TOOLCHAIN');
      };
    if (reason === 'existing-artifact') packageVaultRootArtifact(f.input, f.controls);
    expect(() => packageVaultRootArtifact(f.input, f.controls)).toThrow('vault_root_package_unavailable');
    if (fs.existsSync(f.input.output))
      expect(fs.readdirSync(f.input.output).some((name) => name.startsWith('.pending'))).toBe(false);
  },
);
