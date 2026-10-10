import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
/** Official v0.19.1 Linux ARM64 release: SHA256SUMS signature verified against the documented primary key. */
export const RESTIC_ARTIFACT = Object.freeze({
  contract: 'cos-restic-artifact/v1' as const,
  version: '0.19.1' as const,
  platform: 'linux/arm64' as const,
  bytes: 28639394,
  sha256: '2fb45ac6f9071b6f20eb883953a188f9e7c7cb6bbe43c67a2e47ada4e85ee7f0',
  compressedSha256: 'a5f64aaab53d51e311fa3829124c5b703f2d14cf187d8640b6be3b2b49376465',
});
export function validateResticArtifactSeal(value: unknown): typeof RESTIC_ARTIFACT {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== Object.keys(RESTIC_ARTIFACT).sort().join(',') ||
    Object.entries(RESTIC_ARTIFACT).some(([key, expected]) => (value as Record<string, unknown>)[key] !== expected)
  )
    throw Error('backup_artifact_unverified');
  return RESTIC_ARTIFACT;
}
/** Trusted host only. Verify bytes and inode stability before any credential-bearing invocation. */
export function verifyResticBinary(file: string): typeof RESTIC_ARTIFACT {
  let fd: number | undefined;
  try {
    if (
      process.platform !== 'linux' ||
      process.arch !== 'arm64' ||
      !path.isAbsolute(file) ||
      fs.realpathSync(file) !== file
    )
      throw Error('wrong_platform');
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = fs.fstatSync(fd);
    if (
      !before.isFile() ||
      before.nlink !== 1 ||
      ![0, process.getuid?.()].includes(before.uid) ||
      (before.mode & 0o222) !== 0 ||
      (before.mode & 0o111) === 0 ||
      before.size !== RESTIC_ARTIFACT.bytes
    )
      throw Error('unsafe_binary');
    const hash = createHash('sha256'),
      buffer = Buffer.alloc(65536);
    let count: number;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, count));
    if (hash.digest('hex') !== RESTIC_ARTIFACT.sha256) throw Error('wrong_binary');
    const version = execFileSync('/proc/self/fd/3', ['version'], {
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C' },
      cwd: '/',
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 4096,
      stdio: ['ignore', 'pipe', 'pipe', fd],
    }).trim();
    if (!/^restic 0\.19\.1 compiled with go1\.26\.4 on linux\/arm64$/.test(version)) throw Error('wrong_version');
    const after = fs.fstatSync(fd),
      current = fs.lstatSync(file);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mode !== before.mode ||
      after.uid !== before.uid ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev ||
      current.ino !== before.ino
    )
      throw Error('binary_changed');
    return RESTIC_ARTIFACT;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Artifact paths and subprocess diagnostics never reach status output.
    throw Error('backup_artifact_unverified');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
/** Restic decrypts/authenticates config; the host independently binds its version and repository identity. */
export function verifyResticRepositoryIdentity(text: string, expectedId: string): { version: 2; id: string } {
  try {
    if (typeof text !== 'string' || Buffer.byteLength(text) > 65536 || !/^[a-f0-9]{64}$/.test(expectedId))
      throw Error('bounds');
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'chunker_polynomial,id,version' ||
      value.version !== 2 ||
      value.id !== expectedId ||
      typeof value.chunker_polynomial !== 'string' ||
      !/^[a-f0-9]{1,16}$/.test(value.chunker_polynomial) ||
      /^0+$/.test(value.chunker_polynomial)
    )
      throw Error('identity');
    return { version: 2, id: expectedId };
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Returned config, credentials and backend diagnostics stay private.
    throw Error('backup_repository_unverified');
  }
}
