import type { VaultAllocationPaths } from './vault-allocation.js';
import type { VaultProvisionIdentity } from './vault-provision.js';
export type VaultCryptoPaths = VaultAllocationPaths & { bootKey: string; mapper: string };
export type VaultCryptoResult = { status: number; output: string };
export type VaultCryptoControls = {
  assertMemory(): void;
  run?(command: string, args: string[], volumeFd: number, keyFd: number | null, input?: Buffer): VaultCryptoResult;
  mapping?(): 'absent' | 'matching' | 'conflict';
  withMappedDevice?<T>(operation: (fd: number) => T): T;
  disableKeyring?: boolean;
};
export function createVaultCrypto(
  paths: VaultCryptoPaths,
  identity: VaultProvisionIdentity,
  controls: VaultCryptoControls,
) {
  const safe = <T>(operation: () => T): T => {
    try {
      controls.assertMemory();
      const result = operation();
      controls.assertMemory();
      return result;
    } catch {
      // eslint-disable-next-line preserve-caught-error -- Cryptsetup diagnostics, key transport and private paths stay behind this boundary.
      throw Error('vault_crypto_unavailable');
    }
  };
  const runCommand = (
    tool: string,
    args: string[],
    volumeFd: number,
    keyFd: number | null,
    input?: Buffer,
  ): VaultCryptoResult => {
    controls.assertMemory();
    const result = (
      controls.run ??
      ((command, values, pinnedVolume, pinnedKey, secret) => {
        const child = spawnSync(command, values, {
          cwd: '/',
          env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C', LC_ALL: 'C' },
          input: secret,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'ignore', pinnedVolume, pinnedKey ?? 'ignore'],
          maxBuffer: 262144,
          timeout: 120000,
        });
        if (child.error || child.signal || child.status === null) throw Error('crypto_utility_failed');
        return { status: child.status, output: child.stdout ?? '' };
      })
    )(tool, args, volumeFd, keyFd, input);
    controls.assertMemory();
    if (
      !Number.isSafeInteger(result.status) ||
      result.status < 0 ||
      typeof result.output !== 'string' ||
      Buffer.byteLength(result.output) > 262144
    )
      throw Error('crypto_utility_unverified');
    return result;
  };
  const command = (args: string[], boot: boolean, input?: Buffer): VaultCryptoResult =>
    safe(() => {
      if (
        process.platform !== 'linux' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(paths.mapper) ||
        !/^[a-f0-9-]{36}$/.test(identity.luksUuid)
      )
        throw Error('unsafe_crypto_identity');
      if (input && (!Buffer.isBuffer(input) || input.length !== 64)) throw Error('invalid_recovery_key');
      return withVaultFile(paths, identity, (volumeFd) => {
        let keyFd: number | null = null;
        try {
          let before: fs.Stats | undefined;
          if (boot) {
            const parent = path.dirname(paths.bootKey),
              stat = fs.lstatSync(parent);
            if (
              !path.isAbsolute(paths.bootKey) ||
              path.resolve(paths.bootKey) !== paths.bootKey ||
              fs.realpathSync(parent) !== parent ||
              !stat.isDirectory() ||
              stat.uid !== process.getuid?.() ||
              (stat.mode & 0o777) !== 0o700
            )
              throw Error('unsafe_boot_key_directory');
            keyFd = fs.openSync(paths.bootKey, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            before = fs.fstatSync(keyFd);
            if (
              !before.isFile() ||
              before.uid !== process.getuid?.() ||
              (before.mode & 0o777) !== 0o600 ||
              before.nlink !== 1 ||
              before.size !== 64
            )
              throw Error('unsafe_boot_key');
          }
          const result = runCommand('/usr/sbin/cryptsetup', args, volumeFd, keyFd, input);
          if (before) {
            const after = fs.lstatSync(paths.bootKey);
            if (
              !after.isFile() ||
              after.dev !== before.dev ||
              after.ino !== before.ino ||
              after.size !== 64 ||
              after.uid !== before.uid ||
              (after.mode & 0o777) !== 0o600 ||
              after.nlink !== 1
            )
              throw Error('boot_key_changed');
          }
          return result;
        } finally {
          if (keyFd !== null) fs.closeSync(keyFd);
        }
      });
    });
  const success = (args: string[], boot: boolean, input?: Buffer) => {
    const result = command(args, boot, input);
    if (result.status !== 0) throw Error('crypto_utility_failed');
    return result.output;
  };
  const metadata = () => {
    if (success(['luksUUID', '/proc/self/fd/3'], false).trim() !== identity.luksUuid) throw Error('luks_uuid_conflict');
    const value = JSON.parse(success(['luksDump', '--dump-json-metadata', '/proc/self/fd/3'], false));
    if (
      !value ||
      !value.keyslots ||
      typeof value.keyslots !== 'object' ||
      Array.isArray(value.keyslots) ||
      !Object.hasOwn(value.keyslots, '0') ||
      Object.keys(value.keyslots).some((key) => !['0', '1'].includes(key)) ||
      !value.tokens ||
      typeof value.tokens !== 'object' ||
      Array.isArray(value.tokens) ||
      Object.keys(value.tokens).length
    )
      throw Error('luks_slots_conflict');
    return value as { keyslots: Record<string, unknown> };
  };
  const bootProof = () => {
    metadata();
    success(
      [
        'open',
        '--type',
        'luks2',
        '--test-passphrase',
        '--key-slot',
        '0',
        '--key-file',
        '/proc/self/fd/4',
        '/proc/self/fd/3',
      ],
      true,
    );
  };
  const inspect = (): 'absent' | 'matching' | 'conflict' => {
    try {
      return safe(() => {
        const result = command(['isLuks', '--type', 'luks2', '/proc/self/fd/3'], false);
        if (result.status === 1) return 'absent';
        if (result.status !== 0) throw Error('luks_unverified');
        bootProof();
        return 'matching';
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Inspection carries no utility diagnostics or key material.
    } catch {
      return 'conflict';
    }
  };
  const recoveryStatus = (key: Buffer): 'absent' | 'matching' | 'conflict' => {
    try {
      return safe(() => {
        if (!Buffer.isBuffer(key) || key.length !== 64) throw Error('invalid_recovery_key');
        const record = metadata();
        if (!Object.hasOwn(record.keyslots, '1')) return 'absent';
        return command(
          ['open', '--type', 'luks2', '--test-passphrase', '--key-slot', '1', '--key-file', '-', '/proc/self/fd/3'],
          false,
          key,
        ).status === 0
          ? 'matching'
          : 'conflict';
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Fixed status only; no recovery or provider diagnostics.
    } catch {
      return 'conflict';
    }
  };
  const mapping = (requirePrivate = true): 'absent' | 'matching' | 'conflict' =>
    safe(() => {
      if (controls.mapping) return controls.mapping();
      const device = path.join('/dev/mapper', paths.mapper),
        link = fs.lstatSync(device, { throwIfNoEntry: false });
      if (!link) return 'absent';
      const stat = fs.statSync(device);
      if (!stat.isBlockDevice() || stat.uid !== 0 || (requirePrivate && (stat.mode & 0o777) !== 0o600))
        return 'conflict';
      const number = BigInt(stat.rdev),
        major = ((number >> 8n) & 0xfffn) | ((number >> 32n) & 0xfffff000n),
        minor = (number & 0xffn) | ((number >> 12n) & 0xffffff00n);
      const root = fs.realpathSync(`/sys/dev/block/${major}:${minor}`),
        slaves = fs.readdirSync(path.join(root, 'slaves'));
      if (
        fs.readFileSync(path.join(root, 'dm/uuid'), 'utf8').trim() !==
          `CRYPT-LUKS2-${identity.luksUuid.replace(/-/g, '')}-${paths.mapper}` ||
        slaves.length !== 1 ||
        !/^loop[0-9]+$/.test(slaves[0]) ||
        fs.readFileSync(path.join(root, 'slaves', slaves[0], 'loop/backing_file'), 'utf8').trim() !== paths.volume ||
        inspectVaultAllocation(paths, identity) !== 'matching'
      )
        return 'conflict';
      return 'matching';
    });
  const protectMapper = () => {
    if (controls.mapping) return;
    if (mapping(false) !== 'matching') throw Error('mapper_conflict');
    const device = path.join('/dev/mapper', paths.mapper),
      before = fs.statSync(device);
    const fd = fs.openSync(fs.realpathSync(device), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const pinned = fs.fstatSync(fd);
      if (
        !pinned.isBlockDevice() ||
        pinned.uid !== 0 ||
        pinned.dev !== before.dev ||
        pinned.ino !== before.ino ||
        pinned.rdev !== before.rdev ||
        mapping(false) !== 'matching'
      )
        throw Error('mapper_changed');
      // cryptsetup's default root/disk mode is 0660. Tighten only this operation's verified device node.
      fs.fchmodSync(fd, 0o600);
      const after = fs.statSync(device);
      if (
        after.dev !== pinned.dev ||
        after.ino !== pinned.ino ||
        after.rdev !== pinned.rdev ||
        mapping() !== 'matching'
      )
        throw Error('mapper_changed');
    } finally {
      fs.closeSync(fd);
    }
  };
  const withMappedDevice = <T>(operation: (fd: number) => T): T =>
    safe(() => {
      if (mapping() !== 'matching') throw Error('mapper_unverified');
      const withDevice =
        controls.withMappedDevice ??
        (<T>(operation: (fd: number) => T): T => {
          const device = path.join('/dev/mapper', paths.mapper),
            before = fs.statSync(device);
          const fd = fs.openSync(fs.realpathSync(device), fs.constants.O_RDWR | fs.constants.O_NOFOLLOW);
          try {
            const pinned = fs.fstatSync(fd);
            if (
              !pinned.isBlockDevice() ||
              pinned.uid !== 0 ||
              (pinned.mode & 0o777) !== 0o600 ||
              pinned.dev !== before.dev ||
              pinned.ino !== before.ino ||
              pinned.rdev !== before.rdev ||
              mapping() !== 'matching'
            )
              throw Error('mapper_changed');
            const result = operation(fd),
              after = fs.statSync(device);
            if (
              after.dev !== pinned.dev ||
              after.ino !== pinned.ino ||
              after.rdev !== pinned.rdev ||
              mapping() !== 'matching'
            )
              throw Error('mapper_changed');
            return result;
          } finally {
            fs.closeSync(fd);
          }
        });
      return withDevice((fd) => {
        const result = operation(fd);
        if (result && typeof (result as { then?: unknown }).then === 'function')
          throw Error('synchronous_descriptor_operation_required');
        if (mapping() !== 'matching') throw Error('mapper_changed');
        return result;
      });
    });
  const deviceCommand = (tool: string, args: string[]) => withMappedDevice((fd) => runCommand(tool, args, fd, null));
  const filesystemStatus = (): 'absent' | 'matching' | 'conflict' => {
    try {
      return safe(() => {
        const result = deviceCommand('/usr/sbin/blkid', ['--probe', '--output', 'export', '/proc/self/fd/3']);
        if (result.status === 2 && !result.output.trim()) return 'absent';
        if (result.status !== 0) throw Error('filesystem_unverified');
        const properties = new Map<string, string>();
        for (const line of result.output.trim().split('\n')) {
          const match = /^([A-Z0-9_]+)=([^\r\n]*)$/.exec(line);
          if (!match || properties.has(match[1])) throw Error('filesystem_properties_conflict');
          properties.set(match[1], match[2]);
        }
        return properties.get('TYPE') === 'ext4' && properties.get('UUID') === identity.filesystemUuid
          ? 'matching'
          : 'conflict';
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- Expose only bounded filesystem status, without raw block-device diagnostics.
    } catch {
      return 'conflict';
    }
  };
  return {
    withMappedDevice,
    inspect,
    recoveryStatus,
    filesystemStatus,
    formatFilesystem() {
      return safe(() => {
        if (!/^[a-f0-9-]{36}$/.test(identity.filesystemUuid) || filesystemStatus() !== 'absent')
          throw Error('filesystem_format_denied');
        if (
          deviceCommand('/usr/sbin/mkfs.ext4', ['-q', '-U', identity.filesystemUuid, '/proc/self/fd/3']).status !== 0 ||
          filesystemStatus() !== 'matching'
        )
          throw Error('filesystem_format_unverified');
      });
    },
    format() {
      return safe(() => {
        if (inspect() !== 'absent') throw Error('luks_format_denied');
        withVaultFile(paths, identity, (fd) => {
          const bytes = Buffer.alloc(4096);
          for (const offset of [0, VAULT_BYTES - bytes.length]) {
            if (fs.readSync(fd, bytes, 0, bytes.length, offset) !== bytes.length || bytes.some((byte) => byte !== 0))
              throw Error('luks_nonempty_file');
          }
        });
        success(
          [
            'luksFormat',
            '--type',
            'luks2',
            '--batch-mode',
            '--pbkdf',
            'argon2id',
            '--pbkdf-memory',
            '131072',
            '--pbkdf-parallel',
            '1',
            '--uuid',
            identity.luksUuid,
            '--key-file',
            '/proc/self/fd/4',
            '/proc/self/fd/3',
          ],
          true,
        );
        if (inspect() !== 'matching') throw Error('luks_format_unverified');
      });
    },
    addRecovery(key: Buffer) {
      return safe(() => {
        if (inspect() !== 'matching') throw Error('luks_unverified');
        const observed = recoveryStatus(key);
        if (observed === 'conflict') throw Error('recovery_slot_conflict');
        if (observed === 'absent')
          success(
            [
              'luksAddKey',
              '--key-slot',
              '1',
              '--pbkdf',
              'argon2id',
              '--pbkdf-memory',
              '131072',
              '--pbkdf-parallel',
              '1',
              '--key-file',
              '/proc/self/fd/4',
              '/proc/self/fd/3',
              '-',
            ],
            true,
            key,
          );
        if (recoveryStatus(key) !== 'matching') throw Error('recovery_slot_unverified');
      });
    },
    open(key?: Buffer) {
      return safe(() => {
        if (key ? recoveryStatus(key) !== 'matching' : inspect() !== 'matching') throw Error('luks_unverified');
        const observed = mapping(false);
        if (observed === 'conflict') throw Error('mapper_conflict');
        if (observed === 'absent')
          success(
            [
              'open',
              '--type',
              'luks2',
              ...(controls.disableKeyring ? ['--disable-keyring'] : []),
              '--key-file',
              key ? '-' : '/proc/self/fd/4',
              '/proc/self/fd/3',
              paths.mapper,
            ],
            !key,
            key,
          );
        protectMapper();
        if (mapping() !== 'matching') throw Error('mapper_unverified');
      });
    },
    close() {
      return safe(() => {
        const observed = mapping(false);
        if (observed === 'conflict') throw Error('mapper_conflict');
        if (observed === 'matching') {
          protectMapper();
          success(['close', paths.mapper], false);
        }
        if (mapping() !== 'absent') throw Error('mapper_unverified');
      });
    },
  };
}
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { VAULT_BYTES } from './vault-admission.js';
import { inspectVaultAllocation, withVaultFile } from './vault-allocation.js';
