import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { fixtureRelease } from '../../../contracts/chief-of-staff/release-fixture.js';
import { deployRelease, type DeploymentEffects } from './deployment.js';
import { initializeTarget, readTarget, type TargetBinding } from './target-state.js';
import { admittedGeneration } from './maintenance.js';
import { readPrivate } from './target-state.js';
import type { DeploymentReceipt } from './deployment.js';
import * as targetState from './target-state.js';
import { maintenanceLeaseForOwner, beginMaintenance } from './maintenance.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it.each(['activate', 'health'] as const)(
  'rolls forward a failed %s release only through an explicit tested replacement',
  async (failure) => {
    const f = fixture();
    await deployRelease(f);
    const good = f.manifest.releaseId;
    f.manifest = { ...fixtureRelease('S02'), releaseId: 'release-failed', previousReleaseIds: [good] };
    if (failure === 'activate') vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed start'));
    else vi.mocked(f.effects.health).mockResolvedValueOnce(false);
    await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
    const old = readPrivate<DeploymentReceipt>(path.join(f.root, 'releases', f.manifest.releaseId, 'deployment.json'));
    const replacement = {
      ...fixtureRelease('S02'),
      releaseId: 'release-corrected',
      previousReleaseIds: [readTarget(f.root, f.binding).releaseId!],
    };
    const prepareRecovery = vi.fn(async (record: DeploymentReceipt) => {
      expect(record.releaseId).toBe(old.releaseId);
      expect(maintenanceLeaseForOwner(f.root, f.binding, old.releaseId)).toEqual(old.lease);
      expect(admittedGeneration(f.root, f.binding)).toBeNull();
      return { activeCoordinators: 0, activeDatabaseOperations: 0 };
    });
    const recovery = {
      ...f,
      manifest: replacement,
      recoverFrom: old.releaseId,
      effects: { ...f.effects, prepareRecovery },
    };
    await expect(deployRelease(recovery)).resolves.toMatchObject({ status: 'healthy', recoveryFrom: old.releaseId });
    expect(prepareRecovery).toHaveBeenCalled();
    const superseded = readPrivate<DeploymentReceipt>(path.join(f.root, 'releases', old.releaseId, 'deployment.json'));
    expect(superseded).toMatchObject({
      status: 'superseded',
      supersededBy: replacement.releaseId,
      lease: old.lease,
      completed: old.completed,
    });
    expect(readTarget(f.root, f.binding)).toMatchObject({ releaseId: replacement.releaseId, maintenance: false });
    await expect(deployRelease(f)).rejects.toThrow('deployment_superseded');
  },
);

it.each(['intent-save', 'old-lease-close', 'closed-before-new', 'new-lease-save'] as const)(
  'reconciles an interrupted recovery handoff at %s without opening admission',
  async (interruption) => {
    const f = fixture();
    f.manifest = fixtureRelease('S02');
    vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed start'));
    await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
    const replacement = { ...fixtureRelease('S02'), releaseId: 'release-corrected' };
    const recovery = {
      ...f,
      manifest: replacement,
      recoverFrom: f.manifest.releaseId,
      effects: {
        ...f.effects,
        prepareRecovery: vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 })),
      },
    };
    const original = targetState.writeAtomic;
    let interrupted = false;
    vi.spyOn(targetState, 'writeAtomic').mockImplementation((root, name, value) => {
      const record = value as Record<string, unknown>;
      if (
        !interrupted &&
        interruption === 'closed-before-new' &&
        name === 'state.json' &&
        record.maintenanceId === null
      ) {
        interrupted = true;
        original(root, name, value);
        throw new Error('interrupted_handoff');
      }
      if (
        !interrupted &&
        (interruption === 'intent-save'
          ? name === 'deployment.json' && record.status === 'superseded'
          : interruption === 'old-lease-close'
            ? name === 'state.json' && record.maintenanceId === null
            : root.endsWith(replacement.releaseId) && name === 'deployment.json' && !!record.lease)
      ) {
        interrupted = true;
        throw new Error('interrupted_handoff');
      }
      return original(root, name, value);
    });
    await expect(deployRelease(recovery)).rejects.toThrow('interrupted_handoff');
    expect(interrupted).toBe(true);
    expect(admittedGeneration(f.root, f.binding)).toBeNull();
    expect(() => beginMaintenance(f.root, f.binding, 'release-competing', 'deployment')).toThrow('maintenance_owned');
    expect(() => beginMaintenance(f.root, f.binding, replacement.releaseId, 'runtime-disposable')).toThrow(
      'maintenance_owned',
    );
    await expect(deployRelease(recovery)).resolves.toMatchObject({ status: 'healthy' });
    expect(readTarget(f.root, f.binding).releaseId).toBe(replacement.releaseId);
    expect(readTarget(f.root, f.binding).recoveryOwner).toBeUndefined();
  },
);

it.each(['healthy', 'uncertain-migration', 'foreign-binding', 'runtime-lease', 'other-successor'] as const)(
  'refuses to take over %s history',
  async (kind) => {
    const f = fixture();
    vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed start'));
    await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
    const directory = path.join(f.root, 'releases', f.manifest.releaseId);
    const previous = readPrivate<DeploymentReceipt>(path.join(directory, 'deployment.json'));
    const changes = {
      healthy: { status: 'healthy' },
      'uncertain-migration': {
        status: 'failed',
        completed: ['source', 'artifacts', 'quiesce', 'backup'],
        pending: 'migrate',
      },
      'foreign-binding': { bindingDigest: '0'.repeat(64) },
      'runtime-lease': { lease: { ...previous.lease, purpose: 'runtime-disposable' } },
      'other-successor': { status: 'superseded', supersededBy: 'release-other' },
    }[kind];
    targetState.writeAtomic(directory, 'deployment.json', { ...previous, ...changes });
    const prepareRecovery = vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 }));
    await expect(
      deployRelease({
        ...f,
        manifest: { ...fixtureRelease('S02'), releaseId: 'release-corrected' },
        recoverFrom: f.manifest.releaseId,
        effects: { ...f.effects, prepareRecovery },
      }),
    ).rejects.toThrow('deployment_recovery_denied');
    expect(prepareRecovery).not.toHaveBeenCalled();
    expect(admittedGeneration(f.root, f.binding)).toBeNull();
  },
);

it('does not implicitly retire another deployment when recovery was not selected', async () => {
  const f = fixture();
  vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed start'));
  await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
  await expect(
    deployRelease({ ...f, manifest: { ...fixtureRelease('S02'), releaseId: 'release-corrected' } }),
  ).rejects.toThrow('maintenance_owned');
  expect(
    readPrivate<DeploymentReceipt>(path.join(f.root, 'releases', f.manifest.releaseId, 'deployment.json')).status,
  ).toBe('health_failed');
});

it('can replace a failed recovery candidate without releasing its reservation to another operation', async () => {
  const f = fixture();
  f.manifest = fixtureRelease('S02');
  vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed initial start'));
  await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
  const first = {
    ...f,
    manifest: { ...fixtureRelease('S02'), releaseId: 'release-first-correction' },
    recoverFrom: f.manifest.releaseId,
    effects: {
      ...f.effects,
      prepareRecovery: vi.fn(async () => ({ activeCoordinators: 0, activeDatabaseOperations: 0 })),
    },
  };
  vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('failed corrected start'));
  await expect(deployRelease(first)).rejects.toThrow('deployment_health_failed');
  expect(readTarget(f.root, f.binding).recoveryOwner).toBe(first.manifest.releaseId);
  const next = {
    ...first,
    manifest: { ...fixtureRelease('S02'), releaseId: 'release-next-correction' },
    recoverFrom: first.manifest.releaseId,
  };
  await expect(deployRelease(next)).resolves.toMatchObject({ status: 'healthy' });
  expect(readTarget(f.root, f.binding).recoveryOwner).toBeUndefined();
});
function fixture() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-deploy-'));
  roots.push(parent);
  const root = path.join(parent, 'target');
  const binding: TargetBinding = {
    hostFingerprint: '1'.repeat(64),
    databaseFingerprint: '2'.repeat(64),
    service: 'nano.service',
    installationRoot: '/fixture/nano',
    dataRoot: '/fixture/nano/data',
  };
  initializeTarget(root, binding);
  const calls: string[] = [];
  const effect = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const effects: DeploymentEffects = {
    verify: effect('verify'),
    source: effect('source'),
    artifacts: effect('artifacts'),
    quiesce: vi.fn(async () => {
      calls.push('quiesce');
      return { activeCoordinators: 0, activeDatabaseOperations: 0 };
    }),
    backup: effect('backup'),
    migrate: effect('migrate'),
    activate: effect('activate'),
    health: vi.fn(async () => {
      calls.push('health');
      return true;
    }),
    reconcile: vi.fn(async () => 'retry_safe' as const),
    rollback: vi.fn(async () => false),
  };
  return { root, binding, manifest: fixtureRelease(), effects, calls };
}
it('requires complete local evidence and verified target before touching source, artifacts or maintenance', async () => {
  const f = fixture();
  f.manifest.checks.root.status = 'failed';
  await expect(deployRelease(f)).rejects.toThrow('release_not_transferable');
  expect(f.calls).toEqual([]);
  f.manifest.checks.root.status = 'passed';
  f.effects.verify = vi.fn(async () => {
    throw new Error('wrong host');
  });
  await expect(deployRelease(f)).rejects.toThrow('deployment_verification_failed');
  expect(f.effects.source).not.toHaveBeenCalled();
  expect(readTarget(f.root, f.binding).maintenanceId).toBeNull();
});
it('backs up before migration, retains closed admission until health, and reconciles a completed retry', async () => {
  const f = fixture();
  f.effects.health = vi.fn(async () => {
    f.calls.push('health');
    expect(admittedGeneration(f.root, f.binding)).toBeNull();
    return true;
  });
  const receipt = await deployRelease(f);
  expect(receipt.status).toBe('healthy');
  expect(f.calls).toEqual(['verify', 'source', 'artifacts', 'quiesce', 'backup', 'migrate', 'activate', 'health']);
  expect(readTarget(f.root, f.binding)).toMatchObject({ releaseId: f.manifest.releaseId, maintenance: false });
  f.effects.health = vi.fn(async () => true);
  await expect(deployRelease(f)).resolves.toEqual(receipt);
  expect(f.effects.activate).toHaveBeenCalledOnce();
  expect(f.effects.migrate).toHaveBeenCalledOnce();
});
it('retains the lease and requires reconciliation after an uncertain migration result', async () => {
  const f = fixture();
  f.effects.migrate = vi.fn(async () => {
    throw new Error('lost connection with private details');
  });
  await expect(deployRelease(f)).rejects.toThrow('deployment_incomplete');
  expect(readTarget(f.root, f.binding)).toMatchObject({ maintenance: true, releaseId: null });
  expect(f.effects.activate).not.toHaveBeenCalled();
  f.effects.reconcile = vi.fn(async () => 'blocked' as const);
  await expect(deployRelease(f)).rejects.toThrow('deployment_reconciliation_required');
  expect(f.effects.migrate).toHaveBeenCalledOnce();
  f.effects.reconcile = vi.fn(async () => 'done' as const);
  await expect(deployRelease(f)).resolves.toMatchObject({ status: 'healthy' });
  expect(f.effects.migrate).toHaveBeenCalledOnce();
});
it('failed health keeps CoS closed and only records rollback after compatible recovery succeeds', async () => {
  const f = fixture();
  f.effects.health = vi.fn(async () => false);
  await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
  expect(f.effects.rollback).toHaveBeenCalledWith(null);
  expect(readTarget(f.root, f.binding).maintenance).toBe(true);
  expect(fs.readFileSync(path.join(f.root, 'releases', f.manifest.releaseId, 'deployment.json'), 'utf8')).not.toContain(
    'private details',
  );
  f.effects.rollback = vi.fn(async () => true);
  await expect(deployRelease(f)).rejects.toThrow('deployment_rolled_back');
  expect(readTarget(f.root, f.binding)).toMatchObject({ releaseId: null, maintenance: true });
});

it('attempts compatible recovery when service activation fails after migration', async () => {
  const f = fixture();
  f.effects.activate = vi.fn(async () => {
    throw new Error('service start failed');
  });
  f.effects.rollback = vi.fn(async () => true);
  await expect(deployRelease(f)).rejects.toThrow('deployment_rolled_back');
  expect(f.effects.rollback).toHaveBeenCalledWith(null);
  expect(readTarget(f.root, f.binding)).toMatchObject({ releaseId: null, maintenance: true, maintenanceId: null });
});

it.each(['activate', 'health'] as const)(
  'retries the exact migrated candidate after failed %s when rollback is incompatible',
  async (failure) => {
    const f = fixture();
    f.manifest = fixtureRelease('S02');
    const receipt = () =>
      readPrivate<DeploymentReceipt>(path.join(f.root, 'releases', f.manifest.releaseId, 'deployment.json'));
    if (failure === 'activate')
      vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('transient start failure'));
    else vi.mocked(f.effects.health).mockResolvedValueOnce(false);
    await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
    expect(receipt().status).toBe('health_failed');
    const lease = receipt().lease;
    f.calls.length = 0;
    f.effects.quiesce = vi.fn(async () => {
      f.calls.push('quiesce');
      expect(admittedGeneration(f.root, f.binding)).toBeNull();
      expect(receipt().lease).toEqual(lease);
      return { activeCoordinators: 0, activeDatabaseOperations: 0 };
    });
    await expect(deployRelease(f)).resolves.toMatchObject({ status: 'healthy', lease, activationRetries: 1 });
    expect(f.calls).toEqual(['verify', 'quiesce', 'activate', 'health']);
    expect(f.effects.migrate).toHaveBeenCalledOnce();
    expect(f.effects.backup).toHaveBeenCalledOnce();
    expect(f.effects.activate).toHaveBeenCalledTimes(2);
  },
);

it('does not retry activation when fresh recovery quiescence fails', async () => {
  const f = fixture();
  vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('transient start failure'));
  await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
  vi.mocked(f.effects.quiesce).mockResolvedValue({ activeCoordinators: 1, activeDatabaseOperations: 0 });
  await expect(deployRelease(f)).rejects.toThrow('target_not_quiescent');
  expect(f.effects.activate).toHaveBeenCalledOnce();
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
});

it('refuses changed candidate evidence on a failed-activation retry', async () => {
  const f = fixture();
  vi.mocked(f.effects.activate).mockRejectedValueOnce(new Error('transient start failure'));
  await expect(deployRelease(f)).rejects.toThrow('deployment_health_failed');
  f.manifest.source.tree = '9'.repeat(40);
  await expect(deployRelease(f)).rejects.toThrow('deployment_receipt_conflict');
  expect(f.effects.activate).toHaveBeenCalledOnce();
  expect(f.effects.quiesce).toHaveBeenCalledOnce();
  expect(admittedGeneration(f.root, f.binding)).toBeNull();
});
