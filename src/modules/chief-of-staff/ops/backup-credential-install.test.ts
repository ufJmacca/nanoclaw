import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { digest } from '../domain/contracts.js';
const f = vi.hoisted(() => ({ memory: vi.fn(), access: vi.fn(), vault: vi.fn(), target: vi.fn() }));
vi.mock('./vault-memory.js', () => ({ verifyVaultMemory: f.memory }));
vi.mock('./vault-storage.js', () => ({ withVaultDirectory: f.access, verifyVaultStorage: f.vault }));
vi.mock('./target-identity.js', () => ({ localTarget: f.target }));
import { installBackupCredentials, readBackupCredentialInstallation } from './backup-credential-install.js';
import { createVaultBackupQueue } from './backup-queue.js';

const temporary: string[] = [];
const operationId = '48f99256-b105-4ee3-848c-00140c98151d';
const credentialReference = '319c6740-24ba-4d68-9d3c-a4d53c9607d1';
const filesystemUuid = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  vi.restoreAllMocks();
  for (const fn of Object.values(f)) fn.mockReset();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function bundle(smb = Buffer.alloc(16, 0x62), restic = Buffer.alloc(64, 0x61)) {
  return Buffer.concat([Buffer.from([0x43, 0x4f, 0x53, 0x42, 1, smb.length, restic.length]), smb, restic]);
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-backup-credential-install-'));
  temporary.push(root);
  const directory = path.join(root, 'backup-credentials');
  fs.mkdirSync(directory, { mode: 0o700 });
  const journals = path.join(root, 'journals');
  fs.mkdirSync(journals, { mode: 0o700 });
  const roots = { targetRoot: root + '/state', installationRoot: root + '/install', dataRoot: root + '/data' };
  const policy = { vaultRoot: root, targetDigest: digest(roots.targetRoot), volume: { filesystemUuid } };
  f.vault.mockReturnValue(policy);
  f.access.mockImplementation(async (_roots, area, callback) =>
    callback(area === 'journals' ? journals : directory, () => {
      f.vault();
      f.memory();
    }),
  );
  f.target.mockReturnValue({
    lifecycle: 'protected',
    maintenance: true,
    maintenanceId: operationId,
    generation: 10,
    releaseId: 'release-fixture',
  });
  const check = vi.fn(async () => {});
  const assertAuthority = vi.fn(() => {});
  const input = { roots, operationId, credentialReference, bytes: bundle(), check, assertAuthority };
  return {
    root,
    directory,
    roots,
    policy,
    input,
    journal: path.join(directory, 'backup-credential-installation.json'),
  };
}

it('publishes a ready marker only after both private credential files are synced', async () => {
  const s = fixture();
  const result = await installBackupCredentials(s.input);
  expect(result).toEqual({
    contract: 'cos-backup-credential-installation-result/v1',
    status: 'ready',
    rootsDigest: digest(s.roots),
    filesystemUuid,
  });
  expect(f.access.mock.calls[0].slice(0, 2)).toEqual([s.roots, 'backup-credentials']);
  expect(s.input.check).toHaveBeenCalled();
  expect(s.input.assertAuthority).toHaveBeenCalled();
  const marker = readBackupCredentialInstallation(s.directory, s.roots, filesystemUuid);
  expect(marker.phase).toBe('ready');
  const smb = fs.readFileSync(path.join(s.directory, 'smb-credentials'));
  expect(
    smb.equals(
      Buffer.concat([
        Buffer.from('username=nanoclaw-cos-backup\npassword='),
        Buffer.alloc(16, 0x62),
        Buffer.from('\n'),
      ]),
    ),
  ).toBe(true);
  expect(
    fs
      .readFileSync(path.join(s.directory, 'restic-password'))
      .equals(Buffer.concat([Buffer.alloc(64, 0x61), Buffer.from('\n')])),
  ).toBe(true);
  for (const name of fs.readdirSync(s.directory)) {
    const stat = fs.lstatSync(path.join(s.directory, name));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.nlink).toBe(1);
  }
  expect(s.input.bytes.every((byte) => byte === 0)).toBe(true);
  const queue = createVaultBackupQueue(s.roots),
    pending = await queue.pending('credentials');
  expect(pending).toHaveLength(1);
  await queue.withPending('credentials', pending[0].operationId, async (directory) => {
    expect(fs.readFileSync(directory + '/smb-credentials').equals(smb)).toBe(true);
    expect(JSON.parse(fs.readFileSync(directory + '/credential-event.json', 'utf8'))).toMatchObject({
      sourceKind: 'backup_repository',
      phase: 'ready',
      generation: 1,
    });
  });
});

it('replays the same installation without changing either credential inode or contents', async () => {
  const s = fixture();
  await installBackupCredentials(s.input);
  const names = ['smb-credentials', 'restic-password'];
  const before = names.map((name) => fs.lstatSync(path.join(s.directory, name)));
  await installBackupCredentials({ ...s.input, bytes: bundle() });
  names.forEach((name, index) => {
    const after = fs.lstatSync(path.join(s.directory, name));
    expect(after.ino).toBe(before[index].ino);
    expect(after.ctimeMs).toBe(before[index].ctimeMs);
    expect(after.mtimeMs).toBe(before[index].mtimeMs);
  });
  expect(await createVaultBackupQueue(s.roots).pending('credentials')).toHaveLength(1);
});

it.each(['smb', 'restic', 'reference', 'operation'])(
  'refuses changed %s on replay and preserves installed credentials',
  async (reason) => {
    const s = fixture();
    await installBackupCredentials(s.input);
    const files = ['smb-credentials', 'restic-password', 'backup-credential-installation.json'];
    const before = files.map((name) => fs.readFileSync(path.join(s.directory, name)));
    const bytes = bundle(
      reason === 'smb' ? Buffer.alloc(16, 0x63) : undefined,
      reason === 'restic' ? Buffer.alloc(64, 0x62) : undefined,
    );
    await expect(
      installBackupCredentials({
        ...s.input,
        bytes,
        credentialReference: reason === 'reference' ? '8c462c7f-0c31-4d63-9a8f-54c68ba17994' : credentialReference,
        operationId: reason === 'operation' ? '6f776279-93e9-4499-9d51-4c7d8c9eb3c5' : operationId,
      }),
    ).rejects.toThrow(/^backup_credential_installation_unavailable$/);
    files.forEach((name, index) =>
      expect(fs.readFileSync(path.join(s.directory, name)).equals(before[index])).toBe(true),
    );
    expect(bytes.every((byte) => byte === 0)).toBe(true);
  },
);

it('keeps an interrupted owned installation closed, then resumes the same bytes and operation', async () => {
  const s = fixture();
  s.input.check.mockImplementation(async () => {
    if (fs.existsSync(path.join(s.directory, 'smb-credentials'))) throw Error('PRIVATE_LOST_AUTHORITY');
  });
  await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
  expect(JSON.parse(fs.readFileSync(s.journal, 'utf8')).phase).toBe('preparing');
  expect(() => readBackupCredentialInstallation(s.directory, s.roots, filesystemUuid)).toThrow(
    /^backup_credential_installation_unavailable$/,
  );
  const smb = fs.lstatSync(path.join(s.directory, 'smb-credentials'));
  s.input.check.mockImplementation(async () => {});
  await installBackupCredentials({ ...s.input, bytes: bundle() });
  expect(fs.lstatSync(path.join(s.directory, 'smb-credentials')).ino).toBe(smb.ino);
  expect(readBackupCredentialInstallation(s.directory, s.roots, filesystemUuid).phase).toBe('ready');
});

it.each(['smb-credentials', 'restic-password', 'backup-repository.json'])(
  'refuses an unclaimed existing %s without creating an installation journal',
  async (name) => {
    const s = fixture();
    const file = path.join(s.directory, name);
    fs.writeFileSync(file, 'foreign-data', { mode: 0o600 });
    await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
    expect(fs.readFileSync(file, 'utf8')).toBe('foreign-data');
    expect(fs.existsSync(s.journal)).toBe(false);
    expect(s.input.bytes.every((byte) => byte === 0)).toBe(true);
  },
);

it.each(['memory', 'vault', 'authority', 'unprotected-target', 'not-maintenance', 'malformed-frame'])(
  'refuses %s before leaving credential files or a journal',
  async (reason) => {
    const s = fixture();
    if (reason === 'memory')
      f.memory.mockImplementation(() => {
        throw Error('PRIVATE_MEMORY');
      });
    if (reason === 'vault') f.access.mockRejectedValue(Error('PRIVATE_VAULT'));
    if (reason === 'authority')
      s.input.assertAuthority.mockImplementation(() => {
        throw Error('PRIVATE_AUTHORITY');
      });
    if (reason === 'unprotected-target') f.target.mockReturnValue({ lifecycle: 'implementation_disposable' });
    if (reason === 'not-maintenance') f.target.mockReturnValue({ lifecycle: 'protected', maintenance: false });
    if (reason === 'malformed-frame') s.input.bytes[0] = 0;
    await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
    expect(fs.readdirSync(s.directory)).toEqual([]);
    expect(s.input.bytes.every((byte) => byte === 0)).toBe(true);
  },
);

it.each(['symlink', 'hardlink', 'permissions', 'directory'])(
  'refuses a replaced %s credential file and preserves the journal',
  async (reason) => {
    const s = fixture();
    await installBackupCredentials(s.input);
    const file = path.join(s.directory, 'restic-password');
    const marker = fs.readFileSync(s.journal);
    if (reason === 'symlink') {
      fs.renameSync(file, file + '.old');
      fs.symlinkSync(file + '.old', file);
    }
    if (reason === 'hardlink') fs.linkSync(file, file + '.other');
    if (reason === 'permissions') fs.chmodSync(file, 0o644);
    if (reason === 'directory') {
      fs.unlinkSync(file);
      fs.mkdirSync(file, { mode: 0o700 });
    }
    await expect(installBackupCredentials({ ...s.input, bytes: bundle() })).rejects.toThrow(
      /^backup_credential_installation_unavailable$/,
    );
    expect(fs.readFileSync(s.journal).equals(marker)).toBe(true);
  },
);

it('refuses a target or vault change across awaited authority checks', async () => {
  const s = fixture();
  s.input.check.mockImplementation(async () => {
    f.target.mockReturnValue({ ...f.target(), generation: 11 });
  });
  await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
  expect(fs.readdirSync(s.directory)).toEqual([]);
});
it.each(['smb-credentials', 'restic-password'])(
  'never recreates a missing %s after installation was marked complete',
  async (name) => {
    const s = fixture();
    await installBackupCredentials(s.input);
    const marker = fs.readFileSync(s.journal);
    const file = path.join(s.directory, name);
    fs.unlinkSync(file);
    await expect(installBackupCredentials({ ...s.input, bytes: bundle() })).rejects.toThrow(
      /^backup_credential_installation_unavailable$/,
    );
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.readFileSync(s.journal).equals(marker)).toBe(true);
  },
);
it('refuses a replaced credential directory before writing through the held old directory', async () => {
  const s = fixture();
  let changed = false;
  s.input.check.mockImplementation(async () => {
    if (!changed) {
      changed = true;
      fs.renameSync(s.directory, s.directory + '.old');
      fs.mkdirSync(s.directory, { mode: 0o700 });
    }
  });
  await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
  expect(fs.readdirSync(s.directory)).toEqual([]);
  expect(fs.readdirSync(s.directory + '.old')).toEqual([]);
});
it('requires a successful file sync again when resuming after a failed durability check', async () => {
  const s = fixture();
  const original = fs.fsyncSync;
  let fail = true,
    resticSyncs = 0;
  vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
    if (fs.readlinkSync('/proc/self/fd/' + fd) === path.join(s.directory, 'restic-password')) {
      resticSyncs++;
      if (fail) throw Error('PRIVATE_SYNC_FAILURE');
    }
    original(fd);
  });
  await expect(installBackupCredentials(s.input)).rejects.toThrow(/^backup_credential_installation_unavailable$/);
  expect(JSON.parse(fs.readFileSync(s.journal, 'utf8')).phase).toBe('preparing');
  expect(() => readBackupCredentialInstallation(s.directory, s.roots, filesystemUuid)).toThrow(
    /^backup_credential_installation_unavailable$/,
  );
  const count = resticSyncs;
  fail = false;
  await installBackupCredentials({ ...s.input, bytes: bundle() });
  expect(resticSyncs).toBeGreaterThan(count);
  expect(readBackupCredentialInstallation(s.directory, s.roots, filesystemUuid).phase).toBe('ready');
});
