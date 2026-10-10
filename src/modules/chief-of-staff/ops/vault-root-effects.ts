import fs from 'node:fs';
import path from 'node:path';
import { digest } from '../domain/contracts.js';
import { acquireTargetLock, readPrivate, writeAtomic } from './target-state.js';
import { allocateVaultFile, inspectVaultAllocation } from './vault-allocation.js';
import { createVaultKey, inspectVaultKey } from './vault-key.js';
import { createVaultCrypto, type VaultCryptoControls, type VaultCryptoPaths } from './vault-crypto.js';
import { createVaultMounts } from './vault-mounts.js';
import { createVaultUnitInstaller, type VaultUnitControls } from './vault-unit-install.js';
import { vaultUnits, type VaultUnitInput } from './vault-units.js';
import { installVaultUtilities, vaultUtilitiesStatus, VAULT_UTILITY_RESERVE } from './vault-utilities.js';
import { verifyVaultMemory } from './vault-memory.js';
import type {
  VaultProvisionIdentity,
  VaultProvisionJournal,
  VaultProvisionPorts,
  VaultProvisionStep,
} from './vault-provision.js';
import type { VaultRecoveryPorts } from './vault-recovery.js';
export type VaultRootPaths = VaultCryptoPaths & {
  vaultRoot: string;
  calendarRoot: string;
  systemUnits: string;
  ownerUnits: string;
};
export type VaultRootInput = VaultUnitInput & { groupId: number };
export type VaultRootControls = {
  /** The installed gateway supplies a live owner proof tied to protected maintenance and host leases. */
  assertAuthority(): Promise<void>;
  assertMemory?(): void;
  assertRole?(): void;
  availableBytes?(): number;
  crypto?: VaultCryptoControls;
  units?: Pick<VaultUnitControls, 'run'>;
  /** Code-only orchestration model. No CLI or environment selector exposes this seam. */
  effects?: {
    inspect(step: VaultProvisionStep): Promise<'absent' | 'matching' | 'conflict'>;
    apply(step: VaultProvisionStep): Promise<void>;
  };
};
type CanaryClaim = { contract: 'cos-vault-canary/v1'; identityDigest: string; inode: number };
/** Root effect composition, not an installed gateway. It reads no account environment or database. */
export function createVaultRootEffects(
  paths: VaultRootPaths,
  identity: VaultProvisionIdentity,
  input: VaultRootInput,
  recovery: Buffer,
  controls: VaultRootControls,
): VaultProvisionPorts & VaultRecoveryPorts {
  paths = Object.freeze({ ...paths });
  identity = Object.freeze({ ...identity });
  input = Object.freeze({ ...input });
  const assertIdentity = (value: VaultProvisionIdentity) => {
    if (digest(value) !== digest(identity)) throw Error('root_effect_scope_changed');
  };
  const assertMemory = controls.assertMemory ?? verifyVaultMemory;
  const assertRole =
    controls.assertRole ??
    (() => {
      if (process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0)
        throw Error('root_process_required');
    });
  const guard = () => {
    assertMemory();
    assertRole();
    if (
      !Buffer.isBuffer(recovery) ||
      recovery.length !== 64 ||
      input.calendarRoot !== paths.calendarRoot ||
      !Number.isSafeInteger(input.groupId) ||
      input.groupId < 1
    )
      throw Error('invalid_root_provisioning_input');
    vaultUnits(input);
    for (const value of [paths.stateRoot, path.dirname(paths.volume), path.dirname(paths.bootKey)]) {
      const stat = fs.lstatSync(value);
      if (
        !path.isAbsolute(value) ||
        path.resolve(value) !== value ||
        fs.realpathSync(value) !== value ||
        !stat.isDirectory() ||
        stat.uid !== process.getuid?.() ||
        stat.mode & 0o022 ||
        (value !== path.dirname(paths.volume) && (stat.mode & 0o777) !== 0o700)
      )
        throw Error('unsafe_root_provisioning_state');
    }
  };
  const availableBytes = () => {
    guard();
    if (controls.availableBytes) return controls.availableBytes();
    const stat = fs.statfsSync(path.dirname(paths.volume), { bigint: true }),
      bytes = stat.bavail * stat.bsize;
    if (bytes > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('capacity_bounds');
    return Number(bytes);
  };
  const assertAuthority = async () => {
    guard();
    await controls.assertAuthority();
    guard();
  };
  let adapters: ReturnType<typeof build> | undefined;
  function build() {
    const common = { assertAuthority, assertMemory };
    const crypto = createVaultCrypto(paths, identity, { ...controls.crypto, assertMemory });
    const mounts = createVaultMounts(
      { stateRoot: paths.stateRoot, vaultRoot: paths.vaultRoot, calendarRoot: paths.calendarRoot },
      identity,
      { uid: input.userId, gid: input.groupId },
      {
        ...common,
        assertFilesystem() {
          if (crypto.filesystemStatus() !== 'matching') throw Error('filesystem_unverified');
        },
        withMappedDevice(operation) {
          return crypto.withMappedDevice((fd) => operation(fd, fs.fstatSync(fd).rdev));
        },
      },
    );
    const units = createVaultUnitInstaller(
      { stateRoot: paths.stateRoot, systemUnits: paths.systemUnits, ownerUnits: paths.ownerUnits },
      input,
      identity,
      { ...controls.units, ...common },
    );
    const text = 'cos-vault-canary/v1:' + digest(identity) + '\n';
    const claim = (): CanaryClaim | null => {
      const file = path.join(paths.stateRoot, 'canary.json'),
        stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat) return null;
      if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_canary_claim');
      const value = readPrivate<CanaryClaim>(file, 1024);
      if (
        !value ||
        Object.keys(value).sort().join(',') !== 'contract,identityDigest,inode' ||
        value.contract !== 'cos-vault-canary/v1' ||
        value.identityDigest !== digest(identity) ||
        !Number.isSafeInteger(value.inode) ||
        value.inode < 1
      )
        throw Error('canary_claim_conflict');
      return value;
    };
    const checkCanary = (directoryFd: number) => {
      const expected = claim(),
        file = `/proc/self/fd/${directoryFd}/.vault-canary`,
        stat = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!stat && !expected) return 'absent' as const;
      if (!stat || !expected) throw Error('unclaimed_canary');
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const current = fs.fstatSync(fd);
        if (
          !current.isFile() ||
          current.uid !== process.getuid?.() ||
          current.nlink !== 1 ||
          (current.mode & 0o777) !== 0o600 ||
          current.ino !== expected.inode ||
          current.size !== Buffer.byteLength(text) ||
          fs.readFileSync(fd, 'utf8') !== text ||
          fs.lstatSync(file).ino !== current.ino
        )
          throw Error('canary_changed');
      } finally {
        fs.closeSync(fd);
      }
      return 'matching' as const;
    };
    const canary = () => mounts.withArea('journals', checkCanary);
    const createCanary = () => {
      if (canary() === 'matching') return;
      mounts.withArea('journals', (directoryFd) => {
        const fd = fs.openSync(
          `/proc/self/fd/${directoryFd}/.vault-canary`,
          fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeFileSync(fd, text);
          fs.fsyncSync(fd);
          fs.fsyncSync(directoryFd);
          const stat = fs.fstatSync(fd);
          if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600)
            throw Error('canary_creation_unverified');
          guard();
          writeAtomic(paths.stateRoot, 'canary.json', {
            contract: 'cos-vault-canary/v1',
            identityDigest: digest(identity),
            inode: stat.ino,
          } satisfies CanaryClaim);
        } finally {
          fs.closeSync(fd);
        }
      });
      if (canary() !== 'matching') throw Error('canary_unverified');
    };
    return { common, crypto, mounts, units, canary, createCanary, checkCanary };
  }
  const current = () => {
    guard();
    return (adapters ??= build());
  };
  const journal = path.join(paths.stateRoot, 'provision.json');
  const inspect: VaultProvisionPorts['inspect'] = async (step, suppliedIdentity) => {
    assertIdentity(suppliedIdentity);
    await assertAuthority();
    if (controls.effects) return controls.effects.inspect(step);
    const { common, crypto, mounts, units, canary } = current();
    if (step === 'utilities') return vaultUtilitiesStatus(common);
    if (step === 'keys') return inspectVaultKey(paths, identity);
    if (step === 'allocate') return inspectVaultAllocation(paths, identity);
    if (step === 'luks') return crypto.inspect();
    if (step === 'recovery') return crypto.recoveryStatus(recovery);
    crypto.open();
    if (step === 'filesystem') return crypto.filesystemStatus();
    if (step === 'mount') return mounts.inspect();
    if (step === 'canary') return canary();
    return units.inspect();
  };
  return {
    assertAuthority,
    assertMemory,
    availableBytes,
    async withLock(operation) {
      guard();
      const release = acquireTargetLock(paths.stateRoot);
      try {
        return await operation();
      } finally {
        release();
      }
    },
    async preflight() {
      await assertAuthority();
      const utilities = await inspect('utilities', identity);
      if (utilities === 'conflict') throw Error('utility_conflict');
      const exists = (file: string) => !!fs.lstatSync(file, { throwIfNoEntry: false });
      return {
        platform: 'linux',
        architecture: 'arm64',
        lifecycle: 'protected',
        maintenanceHeld: true,
        hostLeaseHeld: true,
        privilegedAccess: true,
        availableBytes: availableBytes(),
        utilityInstallationBytes: utilities === 'absent' ? VAULT_UTILITY_RESERVE : 0,
        volumePresent: exists(paths.volume),
        mountPresent: exists(paths.vaultRoot) || exists('/dev/mapper/' + paths.mapper),
        credentialsPresent: exists(paths.calendarRoot) || exists(paths.bootKey),
      };
    },
    readJournal() {
      guard();
      const stat = fs.lstatSync(journal, { throwIfNoEntry: false });
      if (!stat) return null;
      if (!stat.isFile() || stat.nlink !== 1) throw Error('unsafe_root_journal');
      return readPrivate<VaultProvisionJournal>(journal, 4096);
    },
    writeJournal(record) {
      guard();
      assertIdentity(record.identity);
      writeAtomic(paths.stateRoot, 'provision.json', record);
    },
    inspect,
    async inspectRecovery() {
      await assertAuthority();
      const { common, crypto, mounts, units } = current();
      if (
        (await vaultUtilitiesStatus(common)) !== 'matching' ||
        inspectVaultKey(paths, identity) !== 'matching' ||
        inspectVaultAllocation(paths, identity) !== 'matching' ||
        crypto.inspect() !== 'matching' ||
        crypto.recoveryStatus(recovery) !== 'matching' ||
        units.inspect() !== 'matching'
      )
        throw Error('recovery_claims_unverified');
      const mapping = crypto.mappingStatus();
      if (mapping === 'matching' && crypto.filesystemStatus() === 'matching' && mounts.inspect() === 'matching')
        return 'mounted';
      if (mapping === 'absent' && mounts.closed() && units.inactive()) return 'closed';
      throw Error('recovery_storage_conflict');
    },
    async closeStorage() {
      await assertAuthority();
      const { crypto, mounts, units } = current();
      const mapped = crypto.mappingStatus();
      if (mapped === 'absent' && mounts.closed() && units.inactive()) return;
      if (mapped !== 'matching' || mounts.inspect() !== 'matching') throw Error('recovery_storage_conflict');
      await units.stopStorage();
      await assertAuthority();
      if (!mounts.closed()) throw Error('recovery_mount_still_open');
      crypto.close();
      await assertAuthority();
      if (crypto.mappingStatus() !== 'absent' || !mounts.closed() || !units.inactive())
        throw Error('recovery_close_unverified');
    },
    async openRecovery() {
      await assertAuthority();
      const { crypto, mounts, units } = current();
      if (crypto.mappingStatus() !== 'absent' || !mounts.closed() || !units.inactive())
        throw Error('closed_storage_required');
      crypto.open(recovery);
      await assertAuthority();
      if (crypto.filesystemStatus() !== 'matching') throw Error('recovery_filesystem_unverified');
    },
    async verifyRecoveryCanary() {
      await assertAuthority();
      const { crypto, mounts, units, checkCanary } = current();
      if (crypto.mappingStatus() !== 'matching' || !mounts.closed() || !units.inactive())
        throw Error('recovery_storage_conflict');
      await mounts.withRecoveryArea('journals', (fd) => {
        if (checkCanary(fd) !== 'matching') throw Error('recovery_canary_unverified');
      });
      await assertAuthority();
    },
    async closeRecovery() {
      await assertAuthority();
      const { crypto, mounts, units } = current();
      if (crypto.mappingStatus() !== 'matching' || !mounts.closed() || !units.inactive())
        throw Error('recovery_storage_conflict');
      crypto.close();
      await assertAuthority();
      if (crypto.mappingStatus() !== 'absent' || !mounts.closed() || !units.inactive())
        throw Error('recovery_close_unverified');
    },
    async activateStorage() {
      await assertAuthority();
      if (controls.effects) return;
      const { crypto, mounts, units, canary } = current();
      if (
        units.inspect() !== 'matching' ||
        inspectVaultKey(paths, identity) !== 'matching' ||
        inspectVaultAllocation(paths, identity) !== 'matching' ||
        crypto.inspect() !== 'matching'
      )
        throw Error('normal_storage_claims_unverified');
      const mapped = crypto.mappingStatus();
      if (mapped === 'matching') {
        if (crypto.filesystemStatus() !== 'matching') throw Error('filesystem_unverified');
        const mounted = mounts.inspect() === 'matching';
        if (!mounted && !mounts.closed()) throw Error('normal_storage_conflict');
        if (mounted && units.active()) {
          if (canary() !== 'matching') throw Error('canary_unverified');
          return;
        }
        if (!units.inactive()) await units.stopStorage();
        await assertAuthority();
        if (!mounts.closed() || !units.inactive()) throw Error('closed_storage_required');
        crypto.close();
      } else if (mapped !== 'absent' || !mounts.closed() || !units.inactive()) {
        throw Error('normal_storage_conflict');
      }
      await assertAuthority();
      if (crypto.mappingStatus() !== 'absent') throw Error('closed_storage_required');
      await units.startStorage();
      await assertAuthority();
      if (
        crypto.mappingStatus() !== 'matching' ||
        crypto.filesystemStatus() !== 'matching' ||
        mounts.inspect() !== 'matching' ||
        canary() !== 'matching'
      )
        throw Error('normal_storage_unverified');
      await assertAuthority();
    },
    async verifyCanary() {
      await assertAuthority();
      if (current().canary() !== 'matching') throw Error('recovery_canary_unverified');
      await assertAuthority();
    },
    async startStorage() {
      await assertAuthority();
      const { crypto, mounts, units } = current();
      if (crypto.mappingStatus() !== 'absent' || !mounts.closed() || !units.inactive())
        throw Error('closed_storage_required');
      await units.startStorage();
      await assertAuthority();
      if (
        crypto.mappingStatus() !== 'matching' ||
        crypto.filesystemStatus() !== 'matching' ||
        mounts.inspect() !== 'matching'
      )
        throw Error('normal_storage_unverified');
    },
    async apply(step, suppliedIdentity) {
      assertIdentity(suppliedIdentity);
      await assertAuthority();
      if (controls.effects) {
        await controls.effects.apply(step);
        return;
      }
      const { common, crypto, mounts, units, createCanary } = current();
      if (step === 'utilities') await installVaultUtilities(common);
      else if (step === 'keys') await createVaultKey(paths, identity, common);
      else if (step === 'allocate') await allocateVaultFile(paths, identity, { ...common, availableBytes });
      else if (step === 'luks') crypto.format();
      else if (step === 'recovery') crypto.addRecovery(recovery);
      else {
        crypto.open();
        if (step === 'filesystem') crypto.formatFilesystem();
        else if (step === 'mount') await mounts.mount();
        else if (step === 'canary') createCanary();
        else await units.install();
      }
      await assertAuthority();
    },
  };
}
