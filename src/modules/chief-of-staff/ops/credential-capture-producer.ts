import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { digest } from '../domain/contracts.js';
import { localTarget } from './target-identity.js';
import { admittedGeneration } from './maintenance.js';
import { withVaultCredentialSnapshot } from './credential-vault-snapshot.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { makeCredentialCapture, streamCredentialCapture } from './credential-capture.js';
const uuid = (value: string) => /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
/** Fixed trusted command producer for Restic. Arguments identify the installed
 * target, admitted generation and expected content/cycle; no secrets, arbitrary
 * source files or destinations. The independently opened primary snapshot must
 * match before the first byte is emitted. No queue/staging write or provider call. */
export async function credentialCaptureProducerCommand(
  args: string[],
  emit: (bytes: Buffer) => Promise<void>,
): Promise<{ bytes: number; sha256: string }> {
  try {
    if (
      !Array.isArray(args) ||
      args.length !== 8 ||
      args.some((arg) => typeof arg !== 'string') ||
      typeof emit !== 'function'
    )
      throw Error('capture_producer_arguments');
    const [targetRoot, installationRoot, dataRoot, releaseId, generationText, cycleAt, operationId, setOperationId] =
      args;
    for (const root of [targetRoot, installationRoot, dataRoot])
      if (
        !path.isAbsolute(root) ||
        path.resolve(root) !== root ||
        root === '/' ||
        Buffer.byteLength(root) > 4096 ||
        /[\0\r\n]/.test(root)
      )
        throw Error('capture_producer_root');
    const generation = Number(generationText),
      cycleTime = Date.parse(cycleAt);
    if (
      !Number.isSafeInteger(generation) ||
      generation < 1 ||
      String(generation) !== generationText ||
      !/^release-[a-zA-Z0-9_-]{1,120}$/.test(releaseId) ||
      !uuid(operationId) ||
      !uuid(setOperationId) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/.test(cycleAt) ||
      !Number.isFinite(cycleTime) ||
      new Date(cycleTime).toISOString() !== cycleAt
    )
      throw Error('capture_producer_identity');
    const roots = Object.freeze({ targetRoot, installationRoot, dataRoot }),
      original = localTarget(targetRoot, installationRoot, dataRoot),
      bindingDigest = digest(original.binding);
    const assertAuthority = () => {
      const current = localTarget(targetRoot, installationRoot, dataRoot),
        now = Date.now();
      if (
        current.lifecycle !== 'protected' ||
        current.maintenance !== false ||
        current.releaseId !== releaseId ||
        current.generation !== generation ||
        digest(current.binding) !== bindingDigest ||
        admittedGeneration(targetRoot, current.binding) !== generation ||
        !Number.isFinite(now) ||
        now < cycleTime ||
        now - cycleTime >= 2 * 60 * 60 * 1000
      )
        throw Error('capture_producer_authority_changed');
    };
    assertAuthority();
    const result = await withVaultCredentialSnapshot(roots, { assertAuthority }, async (snapshot) => {
      assertAuthority();
      snapshot.assertCurrent();
      const set = makeRoutedCredentialRecoveryManifest(snapshot.ownerDigest, snapshot.sources),
        capture = makeCredentialCapture(snapshot.ownerDigest, cycleAt, set);
      if (set.operationId !== setOperationId || capture.operationId !== operationId)
        throw Error('capture_producer_source_changed');
      return streamCredentialCapture(snapshot, capture, emit);
    });
    assertAuthority();
    return result;
  } catch {
    // eslint-disable-next-line preserve-caught-error -- Caller and primary-snapshot failures cannot expose vault paths or credential content.
    throw Error('credential_capture_producer_unavailable');
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.on('error', () => {});
  credentialCaptureProducerCommand(
    process.argv.slice(2),
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(bytes, (error) => (error ? reject(error) : resolve()));
      }),
  ).catch(() => {
    process.stderr.write('credential_capture_producer_unavailable\n');
    process.exitCode = 77;
  });
}
