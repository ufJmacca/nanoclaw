import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi, type Mock } from 'vitest';
import { BackupRepositoryWriter } from './backup-repository-lease.js';
import {
  initializePinnedBackupRepository,
  type BackupRepositoryInitializationPorts,
} from './backup-repository-initialize.js';
const temporary: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of temporary.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
async function fixture(
  work: (
    input: BackupRepositoryInitializationPorts,
    create: Mock<() => Promise<void>>,
    identify: Mock<() => Promise<string>>,
    root: string,
  ) => Promise<void>,
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cos-repository-init-'));
  temporary.push(root);
  const directory = path.join(root, 'credentials'),
    sharePath = path.join(root, 'share'),
    lock = path.join(root, 'lock');
  for (const folder of [root, directory, sharePath, lock]) {
    if (folder !== root) fs.mkdirSync(folder, { mode: 0o700 });
    fs.chmodSync(folder, 0o700);
  }
  const fd = fs.openSync(sharePath, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
    shareStat = fs.fstatSync(fd);
  const current = () => {
    const named = fs.statSync(sharePath);
    if (named.dev !== shareStat.dev || named.ino !== shareStat.ino) throw Error('WITHDRAWN_SHARE');
  };
  const create = vi.fn(async () => {
    fs.writeFileSync(path.join(sharePath, 'restic', 'config'), 'synthetic authenticated config', { mode: 0o600 });
  });
  const identify = vi.fn(async () => {
    if (!fs.existsSync(path.join(sharePath, 'restic', 'config'))) throw Error('NO_AUTHENTICATED_CONFIG');
    return 'c'.repeat(64);
  });
  try {
    await new BackupRepositoryWriter('a'.repeat(64), async (cb) => cb(lock)).exclusive((writer) =>
      work(
        {
          roots: { targetRoot: root + '/state', installationRoot: root + '/install', dataRoot: root + '/data' },
          filesystemUuid: randomUUID(),
          credentialReference: randomUUID(),
          operationId: randomUUID(),
          mount: { host: '192.168.56.12', share: 'nanoclaw-cos-backups', mount: sharePath },
          directory,
          share: { fd, assertCurrent: current },
          writer,
          check: async () => {
            current();
            writer.assertCurrent();
          },
          restic: () => ({ create, identify }),
          openRepository: async (share, cb) => {
            share.assertCurrent();
            const file = sharePath + '/restic',
              repo = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW),
              original = fs.fstatSync(repo);
            try {
              return await cb({
                fd: repo,
                assertCurrent() {
                  share.assertCurrent();
                  const next = fs.lstatSync(file);
                  if (
                    !next.isDirectory() ||
                    next.ino !== original.ino ||
                    next.dev !== original.dev ||
                    (next.mode & 0o777) !== 0o700
                  )
                    throw Error('WITHDRAWN_REPOSITORY');
                },
              });
            } finally {
              fs.closeSync(repo);
            }
          },
        },
        create,
        identify,
        root,
      ),
    );
  } finally {
    fs.closeSync(fd);
  }
}
it('creates the fixed directory once and binds only its authenticated repository identity', async () =>
  fixture(async (input, create, identify) => {
    const result = await initializePinnedBackupRepository(input);
    expect(result.status).toBe('backup_repository_initialized');
    expect(create).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalled();
    const file = path.join(input.directory, 'backup-repository.json'),
      inode = fs.statSync(file).ino;
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).repositoryId).toBe('c'.repeat(64));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect((await initializePinnedBackupRepository({ ...input, operationId: randomUUID() })).status).toBe(
      'backup_repository_bound',
    );
    expect(create).toHaveBeenCalledOnce();
    expect(fs.statSync(file).ino).toBe(inode);
  }));
it('records the exact unsigned 64-bit NAS inode and reconciles it without another initialization', async () =>
  fixture(async (input, create) => {
    const inode = 11453233246511605176n;
    const fstat = fs.fstatSync,
      lstat = fs.lstatSync;
    vi.spyOn(fs, 'fstatSync').mockImplementation((fd, options) => {
      const value = fstat(fd, options);
      return fs.readlinkSync('/proc/self/fd/' + fd) === input.mount.mount + '/restic'
        ? (Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
            ino: options?.bigint ? inode : Number(inode),
          }) as ReturnType<typeof fstat>)
        : value;
    });
    vi.spyOn(fs, 'lstatSync').mockImplementation((file, options) => {
      const value = lstat(file, options);
      return value && String(file).endsWith('/restic')
        ? (Object.assign(Object.create(Object.getPrototypeOf(value)), value, {
            ino: options?.bigint ? inode : Number(inode),
          }) as ReturnType<typeof lstat>)
        : value;
    });
    expect((await initializePinnedBackupRepository(input)).status).toBe('backup_repository_initialized');
    const journal = JSON.parse(fs.readFileSync(input.directory + '/backup-repository-initialization.json', 'utf8'));
    expect(journal.repository.inode).toBe(inode.toString());
    expect(typeof journal.share.inode).toBe('number');
    expect((await initializePinnedBackupRepository(input)).status).toBe('backup_repository_bound');
    expect(create).toHaveBeenCalledOnce();
  }));
it('reconciles a lost initialization acknowledgement by reading the original repository, without initializing again', async () =>
  fixture(async (input, create, identify) => {
    create.mockImplementationOnce(async () => {
      fs.writeFileSync(input.mount.mount + '/restic/config', 'synthetic config', { mode: 0o600 });
      throw Error('LOST_ACK');
    });
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    const inode = fs.statSync(input.mount.mount + '/restic').ino;
    expect((await initializePinnedBackupRepository(input)).status).toBe('backup_repository_initialized');
    expect(create).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalled();
    expect(fs.statSync(input.mount.mount + '/restic').ino).toBe(inode);
  }));
it.each([
  Number(11453233246511605176n),
  '11453233246511605176\n',
  '18446744073709551616',
  '011453233246511605176',
  '-1',
  '0',
])('holds a journal with a noncanonical or out-of-range inode %j', async (changed) =>
  fixture(async (input, create) => {
    await initializePinnedBackupRepository(input);
    const file = input.directory + '/backup-repository-initialization.json';
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    journal.repository.inode = changed;
    fs.writeFileSync(file, JSON.stringify(journal));
    const profile = fs.readFileSync(input.directory + '/backup-repository.json');
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(fs.readFileSync(input.directory + '/backup-repository.json')).toEqual(profile);
    expect(create).toHaveBeenCalledOnce();
  }),
);
it('preserves an unclaimed existing repository and unrelated share content', async () =>
  fixture(async (input, create) => {
    fs.mkdirSync(input.mount.mount + '/restic', { mode: 0o700 });
    fs.writeFileSync(input.mount.mount + '/unrelated', 'preserve', { mode: 0o600 });
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(create).not.toHaveBeenCalled();
    expect(fs.readFileSync(input.mount.mount + '/unrelated', 'utf8')).toBe('preserve');
    expect(fs.readdirSync(input.directory)).toEqual([]);
  }));
it('holds an incomplete utility attempt rather than blindly repeating initialization', async () =>
  fixture(async (input, create, identify) => {
    create.mockRejectedValueOnce(Error('PARTIAL_UTILITY_FAILURE'));
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    const journal = JSON.parse(fs.readFileSync(input.directory + '/backup-repository-initialization.json', 'utf8'));
    expect(journal.phase).toBe('initializing');
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(create).toHaveBeenCalledOnce();
    expect(identify).toHaveBeenCalledOnce();
    expect(fs.existsSync(input.directory + '/backup-repository.json')).toBe(false);
  }));
it('does not adopt a directory after losing the acknowledgement between creation and its durable claim', async () =>
  fixture(async (input, create) => {
    const original = input.check;
    input.check = async () => {
      await original();
      if (fs.existsSync(input.mount.mount + '/restic')) throw Error('LOST_DIRECTORY_ACK');
    };
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    const inode = fs.statSync(input.mount.mount + '/restic').ino;
    input.check = original;
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(create).not.toHaveBeenCalled();
    expect(fs.statSync(input.mount.mount + '/restic').ino).toBe(inode);
  }));
it.each([
  'reference',
  'operation',
  'mount',
  'filesystem',
  'journal-fields',
  'journal-mode',
  'profile-mode',
  'profile-link',
] as const)('rejects %s conflicts while retaining the original repository and profile', async (reason) =>
  fixture(async (input, create) => {
    await initializePinnedBackupRepository(input);
    const profile = input.directory + '/backup-repository.json',
      before = fs.readFileSync(profile),
      inode = fs.statSync(input.mount.mount + '/restic').ino;
    if (reason === 'reference') input.credentialReference = randomUUID();
    if (reason === 'mount') input.mount = { ...input.mount, host: '192.168.56.13' };
    if (reason === 'filesystem') input.filesystemUuid = randomUUID();
    const journalFile = input.directory + '/backup-repository-initialization.json';
    if (reason === 'operation' || reason === 'journal-fields') {
      const value = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
      if (reason === 'operation') {
        value.phase = 'identified';
        input.operationId = randomUUID();
      } else value.password = 'SYNTHETIC_SECRET';
      fs.writeFileSync(journalFile, JSON.stringify(value));
    }
    if (reason === 'journal-mode') fs.chmodSync(journalFile, 0o644);
    if (reason === 'profile-mode') fs.chmodSync(profile, 0o644);
    if (reason === 'profile-link') fs.linkSync(profile, input.directory + '/foreign-alias');
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(create).toHaveBeenCalledOnce();
    expect(fs.readFileSync(profile)).toEqual(before);
    expect(fs.statSync(input.mount.mount + '/restic').ino).toBe(inode);
  }),
);
it('refuses an identity changed during reconciliation without publishing a profile', async () =>
  fixture(async (input, create, identify) => {
    create.mockImplementationOnce(async () => {
      fs.writeFileSync(input.mount.mount + '/restic/config', 'synthetic config', { mode: 0o600 });
      throw Error('LOST_ACK');
    });
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    const originalIdentify = identify.getMockImplementation()!;
    identify.mockImplementationOnce(async () => {
      const result = await originalIdentify();
      fs.renameSync(input.mount.mount + '/restic', input.mount.mount + '/original');
      fs.mkdirSync(input.mount.mount + '/restic', { mode: 0o700 });
      return result;
    });
    await expect(initializePinnedBackupRepository(input)).rejects.toThrow(
      'backup_repository_initialization_unavailable',
    );
    expect(create).toHaveBeenCalledOnce();
    expect(fs.existsSync(input.directory + '/backup-repository.json')).toBe(false);
    expect(fs.readFileSync(input.mount.mount + '/original/config', 'utf8')).toBe('synthetic config');
  }));
