import { runVaultRootGateway } from './vault-root-gateway.js';
import { runVaultRootInstaller } from './vault-root-installer.js';
import { runBackupSmbCredentialProbe } from './backup-smb-probe.js';
import { runBackupNasRootMount } from './backup-nas-root-runtime.js';
import { runBackupNasRootSetup } from './backup-nas-root-setup.js';
import { runBackupNasRootRecovery } from './backup-nas-root-recovery.js';
try {
  // Fixed capabilities only. The owner probe independently verifies its actual root parent, owner and vault before holding any credential.
  if (
    process.stdin.isTTY ||
    !(
      process.argv.length === 2 ||
      (process.argv.length === 3 &&
        [
          '--install',
          '--backup-credential-probe',
          '--backup-mount',
          '--backup-unmount',
          '--backup-configure',
          '--backup-recover-unmount',
        ].includes(process.argv[2]))
    )
  )
    throw Error('invalid_root_invocation');
  if (process.argv[2] === '--backup-credential-probe') {
    await runBackupSmbCredentialProbe(process.stdin, process.stdout);
  } else {
    const result =
      process.argv[2] === '--install'
        ? await runVaultRootInstaller(process.stdin)
        : process.argv[2] === '--backup-configure'
          ? await runBackupNasRootSetup(process.stdin)
          : process.argv[2] === '--backup-recover-unmount'
            ? await runBackupNasRootRecovery(process.stdin)
            : process.argv[2] === '--backup-mount' || process.argv[2] === '--backup-unmount'
              ? await runBackupNasRootMount(process.argv[2] === '--backup-mount' ? 'mount' : 'unmount')
              : await runVaultRootGateway(process.stdin);
    process.stdout.write(JSON.stringify(result) + '\n');
  }
  // eslint-disable-next-line no-catch-all/no-catch-all -- Installed CLI errors are always a fixed non-secret receipt.
} catch {
  process.stderr.write(
    process.argv.length === 3 && process.argv[2] === '--install'
      ? '{"code":"vault_root_installation_unavailable"}\n'
      : process.argv.length === 3 && process.argv[2] === '--backup-credential-probe'
        ? '{"code":"backup_smb_probe_unavailable"}\n'
        : process.argv.length === 3 && process.argv[2] === '--backup-configure'
          ? '{"code":"backup_nas_root_setup_unavailable"}\n'
          : process.argv.length === 3 && process.argv[2] === '--backup-recover-unmount'
            ? '{"code":"backup_nas_root_recovery_unavailable"}\n'
            : process.argv.length === 3 && ['--backup-mount', '--backup-unmount'].includes(process.argv[2])
              ? '{"code":"backup_nas_root_mount_unavailable"}\n'
              : '{"code":"vault_root_gateway_unavailable"}\n',
  );
  process.exitCode = 1;
}
