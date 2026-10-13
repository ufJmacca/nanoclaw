import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
import {
  withBackupNasInitializationProgress,
  type BackupNasInitializationProgress,
} from './backup-nas-initialization-progress.js';
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-nas-progress-'));
  fs.chmodSync(root, 0o700);
  const scope = { nasDigest: 'a'.repeat(64), vaultStateDigest: 'b'.repeat(64) },
    resource = {
      kind: 'configuration-stage' as const,
      stageId: randomUUID(),
      device: 17,
      inode: 23,
      contentDigest: 'c'.repeat(64),
    },
    observed = {
      contract: 'cos-backup-nas-initialization-progress/v1' as const,
      ...scope,
      resource,
      phase: 'observed' as const,
    },
    input = { root, ...scope, check: vi.fn(async () => {}) },
    file = path.join(root, 'nas-initialization-progress.' + digest(scope) + '.json');
  return { root, scope, resource, observed, input, file };
}
it('refuses an unsupported architecture before checking authority or publishing progress', async () => {
  const f = fixture(),
    architecture = Object.getOwnPropertyDescriptor(process, 'arch')!,
    operation = vi.fn(async () => true);
  try {
    Object.defineProperty(process, 'arch', { ...architecture, value: 'x64' });
    await expect(withBackupNasInitializationProgress(f.input, operation)).rejects.toThrow(
      /^backup_nas_initialization_progress_unavailable$/,
    );
    expect(f.input.check).not.toHaveBeenCalled();
    expect(operation).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.root)).toEqual([]);
  } finally {
    Object.defineProperty(process, 'arch', architecture);
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('durably retains exact observed metadata and completion across fresh invocations', async () => {
  const f = fixture();
  try {
    await withBackupNasInitializationProgress(f.input, async (lease) => {
      expect(lease.read()).toBeNull();
      await lease.write(f.observed);
      expect(lease.read()).toEqual(f.observed);
      expect(fs.statSync(f.file).mode & 0o7777).toBe(0o600);
      expect(fs.statSync(f.file).nlink).toBe(1);
    });
    await withBackupNasInitializationProgress(f.input, async (lease) => {
      expect(lease.read()).toEqual(f.observed);
      await lease.write({ ...f.observed, phase: 'retired' });
    });
    await withBackupNasInitializationProgress(f.input, async (lease) => expect(lease.read()?.phase).toBe('retired'));
    expect(f.input.check).toHaveBeenCalled();
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('preserves the durable observation when the caller fails after publication', async () => {
  const f = fixture();
  try {
    await expect(
      withBackupNasInitializationProgress(f.input, async (lease) => {
        await lease.write(f.observed);
        throw Error('interrupted');
      }),
    ).rejects.toThrow(/^backup_nas_initialization_progress_unavailable$/);
    await withBackupNasInitializationProgress(f.input, async (lease) => expect(lease.read()).toEqual(f.observed));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it.each(['foreign-scope', 'extra', 'symbol', 'different-resource', 'retired-without-observation'])(
  'denies %s metadata without replacing progress',
  async (reason) => {
    const f = fixture();
    try {
      await withBackupNasInitializationProgress(f.input, async (lease) => {
        if (reason !== 'retired-without-observation') await lease.write(f.observed);
        const next: Record<PropertyKey, unknown> = { ...f.observed };
        if (reason === 'foreign-scope') next.nasDigest = 'd'.repeat(64);
        if (reason === 'extra') next.path = '/tmp/foreign';
        if (reason === 'symbol') next[Symbol('path')] = '/tmp/foreign';
        if (reason === 'different-resource') next.resource = { ...f.resource, inode: 24 };
        if (reason === 'retired-without-observation') next.phase = 'retired';
        await expect(lease.write(next as BackupNasInitializationProgress)).rejects.toThrow();
      });
      if (reason !== 'retired-without-observation')
        expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual(f.observed);
      else expect(fs.existsSync(f.file)).toBe(false);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
it('allows a freshly verified observation to replace only completed metadata', async () => {
  const f = fixture();
  try {
    await withBackupNasInitializationProgress(f.input, async (lease) => {
      await lease.write(f.observed);
      await lease.write({ ...f.observed, phase: 'retired' });
      await lease.write({ ...f.observed, resource: { ...f.resource, inode: 24 } });
      expect(lease.read()?.resource.inode).toBe(24);
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it.each(['mode', 'symlink', 'hardlink', 'bytes', 'parent'])(
  'denies changed %s while retaining foreign resources',
  async (reason) => {
    const f = fixture();
    try {
      await withBackupNasInitializationProgress(f.input, async (lease) => {
        await lease.write(f.observed);
      });
      const alias = path.join(f.root, 'foreign');
      if (reason === 'mode') fs.chmodSync(f.file, 0o644);
      if (reason === 'symlink') {
        fs.renameSync(f.file, alias);
        fs.symlinkSync(alias, f.file);
      }
      if (reason === 'hardlink') fs.linkSync(f.file, alias);
      if (reason === 'bytes') fs.writeFileSync(f.file, 'private diagnostic');
      if (reason === 'parent') fs.chmodSync(f.root, 0o755);
      await expect(withBackupNasInitializationProgress(f.input, async () => true)).rejects.toThrow(
        /^backup_nas_initialization_progress_unavailable$/,
      );
      expect(fs.existsSync(f.file)).toBe(true);
      if (['symlink', 'hardlink'].includes(reason)) expect(fs.existsSync(alias)).toBe(true);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  },
);
it('denies replacement during a fresh check before publication', async () => {
  const f = fixture();
  try {
    await expect(
      withBackupNasInitializationProgress(f.input, async (lease) => {
        await lease.write(f.observed);
        f.input.check.mockImplementation(async () => {
          fs.writeFileSync(f.file, JSON.stringify({ ...f.observed, resource: { ...f.resource, inode: 25 } }) + '\n');
        });
        await expect(lease.write({ ...f.observed, phase: 'retired' })).rejects.toThrow();
        expect(JSON.parse(fs.readFileSync(f.file, 'utf8')).resource.inode).toBe(25);
      }),
    ).rejects.toThrow(/^backup_nas_initialization_progress_unavailable$/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('captures metadata before awaiting permission and leaves no capability in storage', async () => {
  const f = fixture();
  try {
    await withBackupNasInitializationProgress(f.input, async (lease) => {
      const record = structuredClone(f.observed);
      f.input.check.mockImplementation(async () => {
        record.resource.inode = 99;
      });
      await lease.write(record);
      expect(lease.read()?.resource.inode).toBe(23);
      expect(Object.keys(JSON.parse(fs.readFileSync(f.file, 'utf8'))).sort()).toEqual([
        'contract',
        'nasDigest',
        'phase',
        'resource',
        'vaultStateDigest',
      ]);
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('revocation denies publication and closes retained leases', async () => {
  const f = fixture();
  let held: Parameters<Parameters<typeof withBackupNasInitializationProgress>[1]>[0] | undefined;
  try {
    await expect(
      withBackupNasInitializationProgress(f.input, async (lease) => {
        held = lease;
        f.input.check.mockRejectedValue(Error('revoked'));
        await expect(lease.write(f.observed)).rejects.toThrow();
      }),
    ).rejects.toThrow(/^backup_nas_initialization_progress_unavailable$/);
    expect(fs.existsSync(f.file)).toBe(false);
    expect(() => held!.read()).toThrow();
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('does not acknowledge detached writes and drains them before closing descriptors', async () => {
  const f = fixture();
  let pending: Promise<void> | undefined;
  try {
    await expect(
      withBackupNasInitializationProgress(f.input, async (lease) => {
        pending = lease.write(f.observed);
      }),
    ).rejects.toThrow(/^backup_nas_initialization_progress_unavailable$/);
    await pending?.catch(() => {});
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
it('retains published metadata when the parent durability check fails, and retries durability', async () => {
  const f = fixture();
  const actual = fs.fsyncSync;
  try {
    await expect(
      withBackupNasInitializationProgress(f.input, async (lease) => {
        const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
          if (fs.existsSync(f.file) && fs.fstatSync(fd).isDirectory()) throw Error('fsync_interrupted');
          actual(fd);
        });
        try {
          await lease.write(f.observed);
        } finally {
          spy.mockRestore();
        }
      }),
    ).rejects.toThrow(/^backup_nas_initialization_progress_unavailable$/);
    expect(JSON.parse(fs.readFileSync(f.file, 'utf8'))).toEqual(f.observed);
    await withBackupNasInitializationProgress(f.input, async (lease) => expect(lease.read()).toEqual(f.observed));
  } finally {
    vi.restoreAllMocks();
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
