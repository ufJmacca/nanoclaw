import { afterEach, expect, it, vi } from 'vitest';
import { fixtureVaultRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import type { DeploymentSettings } from './deployment-settings.js';
const f = vi.hoisted(() => ({
  memory: vi.fn(),
  binding: vi.fn(),
  proof: vi.fn(),
  create: vi.fn(),
  verify: vi.fn(),
  healthy: vi.fn(),
  inspect: vi.fn(),
  reconcile: vi.fn(),
  mount: vi.fn(),
  upload: vi.fn(),
  maintain: vi.fn(),
}));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./target-host.js', () => ({ targetBinding: f.binding }));
vi.mock('./backup-initialization-repair.js', () => ({ verifyBackupInitializationRepair: f.proof }));
vi.mock('./backup-upload-job-effects.js', () => ({ createBackupUploadJobEffects: f.create }));
import { createBackupUploadRepairEffects } from './backup-upload-repair.js';
afterEach(() => vi.resetAllMocks());
const settings = { releaseRoot: '/synthetic/releases', stateRoot: '/synthetic/state' } as DeploymentSettings,
  invoked = '/synthetic/releases/release-repair/payload/dist/modules/chief-of-staff/ops/target-helper.js';
function fixture() {
  const runtime = fixtureVaultRelease('G02'),
    helper = fixtureVaultRelease('G02');
  runtime.releaseId = 'release-runtime';
  helper.releaseId = 'release-repair';
  helper.previousReleaseIds = [runtime.releaseId];
  f.proof.mockResolvedValue({ runtime, helper });
  f.verify.mockResolvedValue(runtime);
  f.healthy.mockResolvedValue(true);
  f.inspect.mockResolvedValue({ items: [], lastRemoteCheckpointAt: null });
  f.create.mockReturnValue({
    verify: f.verify,
    healthy: f.healthy,
    inspect: f.inspect,
    reconcile: f.reconcile,
    mount: f.mount,
    upload: f.upload,
    maintain: f.maintain,
  });
  return { runtime, helper, effects: createBackupUploadRepairEffects(settings, invoked) };
}
it('uses the separately verified runtime ports and preserves the original upload identity and caller guard', async () => {
  const s = fixture(),
    guard = vi.fn(),
    operationId = '01234567-89ab-4def-8123-456789abcdef';
  expect(await s.effects.verify()).toEqual(s.runtime);
  expect(f.proof).toHaveBeenCalledWith(settings, f.binding.mock.results[0].value, invoked);
  expect(f.create).toHaveBeenCalledWith(
    settings,
    '/synthetic/releases/release-runtime/payload/dist/modules/chief-of-staff/ops/target-helper.js',
  );
  await s.effects.upload('state', operationId, guard);
  expect(f.upload).toHaveBeenCalledWith('state', operationId, guard);
  expect(f.proof).toHaveBeenCalledTimes(3);
  expect(Object.keys(s.effects).sort()).toEqual([
    'healthy',
    'inspect',
    'maintain',
    'mount',
    'reconcile',
    'upload',
    'verify',
  ]);
});
it.each(['reconcile', 'mount', 'upload', 'maintain'] as const)(
  'refuses withdrawn provenance before %s',
  async (effect) => {
    const s = fixture(),
      guard = vi.fn();
    await s.effects.verify();
    f.proof.mockRejectedValue(Error('backup_initialization_repair_unverified'));
    const operation = () =>
      effect === 'upload'
        ? s.effects.upload('credentials', '01234567-89ab-4def-8123-456789abcdef', guard)
        : effect === 'reconcile'
          ? s.effects.reconcile('credentials', guard)
          : s.effects[effect](guard);
    await expect(operation()).rejects.toThrow('backup_initialization_repair_unverified');
    expect(f[effect]).not.toHaveBeenCalled();
  },
);
it('refuses a different prepared helper after an awaited effect rather than rebinding to it', async () => {
  const s = fixture(),
    guard = vi.fn();
  await s.effects.verify();
  f.mount.mockImplementation(async () => {
    f.proof.mockResolvedValue({ runtime: s.runtime, helper: { ...s.helper, releaseId: 'release-replacement' } });
  });
  await expect(s.effects.mount(guard)).rejects.toThrow('backup_upload_repair_changed');
  await expect(s.effects.upload('state', '01234567-89ab-4def-8123-456789abcdef', guard)).rejects.toThrow(
    'backup_upload_repair_changed',
  );
  expect(f.upload).not.toHaveBeenCalled();
});
it('refuses a changed installed manifest and missing memory protection before upload ports are admitted', async () => {
  const s = fixture();
  f.memory.mockImplementationOnce(() => {
    throw Error('memory_unprotected');
  });
  await expect(s.effects.verify()).rejects.toThrow('memory_unprotected');
  expect(f.create).not.toHaveBeenCalled();
  f.verify.mockResolvedValue({ ...s.runtime, releaseId: 'release-foreign' });
  await expect(s.effects.verify()).rejects.toThrow('backup_upload_repair_runtime_changed');
  expect(f.upload).not.toHaveBeenCalled();
});
it('checks the caller before and after the awaited effect without passing a replacement guard', async () => {
  const s = fixture(),
    guard = vi.fn(() => {
      throw Error('caller_closed');
    });
  await expect(s.effects.mount(guard)).rejects.toThrow('caller_closed');
  expect(f.mount).not.toHaveBeenCalled();
  guard.mockReset();
  f.mount.mockImplementation(async () => {
    guard.mockImplementation(() => {
      throw Error('caller_closed');
    });
  });
  await expect(s.effects.mount(guard)).rejects.toThrow('caller_closed');
});
