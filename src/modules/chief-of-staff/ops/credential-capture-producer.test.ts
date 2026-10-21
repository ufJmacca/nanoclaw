import { afterEach, expect, it, vi } from 'vitest';
import { makeCredentialEvent } from './backup-credential-event.js';
import { makeRoutedCredentialRecoveryManifest } from './credential-recovery-routing.js';
import { makeCredentialCapture, readCredentialCaptureArchive } from './credential-capture.js';
const f = vi.hoisted(() => ({ target: vi.fn(), admitted: vi.fn(), snapshot: vi.fn() }));
vi.mock('./target-identity.js', () => ({ localTarget: f.target }));
vi.mock('./maintenance.js', () => ({ admittedGeneration: f.admitted }));
vi.mock('./credential-vault-snapshot.js', () => ({ withVaultCredentialSnapshot: f.snapshot }));
import { credentialCaptureProducerCommand } from './credential-capture-producer.js';
afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});
function fixture() {
  const now = Date.parse('2026-10-16T00:30:00.000Z');
  vi.spyOn(Date, 'now').mockReturnValue(now);
  const owner = 'a'.repeat(64),
    bytes = Buffer.from('SYNTHETIC_PRODUCER_TOKEN');
  const event = makeCredentialEvent(
    {
      sourceKind: 'mail_reader',
      sourceKey: 'b'.repeat(64),
      generation: 1,
      phase: 'ready',
      files: [{ name: 'credential.json', bytes }],
    },
    owner,
  );
  const sources = [
    {
      event,
      files: [
        {
          name: 'credential.json',
          destination: 'google/calendar/mail-reader/credentials/10000000-0000-4000-8000-000000000001.json',
          bytes,
        },
      ],
    },
  ];
  const capture = makeCredentialCapture(
    owner,
    '2026-10-16T00:00:00.000Z',
    makeRoutedCredentialRecoveryManifest(owner, sources),
  );
  const binding = { syntheticBinding: true },
    target = { lifecycle: 'protected', maintenance: false, releaseId: 'release-fixture', generation: 7, binding };
  f.target.mockReturnValue(target);
  f.admitted.mockReturnValue(7);
  f.snapshot.mockImplementation(async (_roots, options, operation) => {
    options.assertAuthority();
    return operation({ ownerDigest: owner, sources, assertCurrent: options.assertAuthority });
  });
  const args = [
    '/fixture/state',
    '/fixture/app',
    '/fixture/data',
    'release-fixture',
    '7',
    capture.cycleAt,
    capture.operationId,
    capture.set.operationId,
  ];
  return { owner, bytes, capture, args, target, sources, now };
}
it('opens the fixed vault reader under actual fresh target admission and emits only the expected capture bytes', async () => {
  const x = fixture(),
    parts: Buffer[] = [];
  const result = await credentialCaptureProducerCommand(x.args, async (bytes) => {
    parts.push(Buffer.from(bytes));
  });
  expect(f.snapshot).toHaveBeenCalledOnce();
  expect(f.snapshot.mock.calls[0][0]).toEqual({
    targetRoot: '/fixture/state',
    installationRoot: '/fixture/app',
    dataRoot: '/fixture/data',
  });
  expect(f.admitted).toHaveBeenCalledWith('/fixture/state', x.target.binding);
  async function* stream() {
    for (const part of parts) yield part;
  }
  const read = await readCredentialCaptureArchive(
    stream(),
    { ownerDigest: x.owner, operationId: x.capture.operationId },
    () => {},
  );
  expect(result).toEqual({ bytes: read.archiveBytes, sha256: read.archiveSha256 });
  expect(read.capture).toEqual(x.capture);
});
for (const problem of [
  'missing-argument',
  'foreign-root',
  'old-cycle',
  'future-cycle',
  'non-hour-cycle',
  'generation',
  'release',
  'maintenance',
  'unadmitted',
  'binding',
] as const)
  it(`refuses ${problem} before opening credentials or emitting an archive`, async () => {
    const x = fixture(),
      emit = vi.fn(async () => {});
    if (problem === 'missing-argument') x.args.pop();
    if (problem === 'foreign-root') x.args[0] = '../foreign';
    if (problem === 'old-cycle') x.args[5] = '2026-10-15T22:00:00.000Z';
    if (problem === 'future-cycle') x.args[5] = '2026-10-16T01:00:00.000Z';
    if (problem === 'non-hour-cycle') x.args[5] = '2026-10-16T00:01:00.000Z';
    if (problem === 'generation') x.args[4] = '6';
    if (problem === 'release') x.args[3] = 'release-older';
    if (problem === 'maintenance') f.target.mockReturnValue({ ...x.target, maintenance: true });
    if (problem === 'unadmitted') f.admitted.mockReturnValue(null);
    if (problem === 'binding')
      f.target.mockReturnValueOnce(x.target).mockReturnValue({ ...x.target, binding: { different: true } });
    await expect(credentialCaptureProducerCommand(x.args, emit)).rejects.toThrow(
      'credential_capture_producer_unavailable',
    );
    expect(f.snapshot).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });
for (const problem of ['content', 'capture-id'] as const)
  it(`refuses changed ${problem} from the independent child snapshot before emitting private bytes`, async () => {
    const x = fixture(),
      emit = vi.fn(async () => {});
    if (problem === 'content') x.args[7] = '10000000-0000-4000-8000-000000000001';
    else x.args[6] = '10000000-0000-4000-8000-000000000001';
    await expect(credentialCaptureProducerCommand(x.args, emit)).rejects.toThrow(
      'credential_capture_producer_unavailable',
    );
    expect(f.snapshot).toHaveBeenCalledOnce();
    expect(emit).not.toHaveBeenCalled();
  });
it('withdraws the stream when real target admission changes after awaited output', async () => {
  const x = fixture(),
    borrowed: Buffer[] = [];
  await expect(
    credentialCaptureProducerCommand(x.args, async (bytes) => {
      borrowed.push(bytes);
      f.admitted.mockReturnValue(null);
    }),
  ).rejects.toThrow('credential_capture_producer_unavailable');
  expect(borrowed).toHaveLength(1);
  expect(borrowed[0].every((byte) => byte === 0)).toBe(true);
});
