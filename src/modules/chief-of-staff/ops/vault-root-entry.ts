import { runVaultRootGateway } from './vault-root-gateway.js';
import { runVaultRootInstaller } from './vault-root-installer.js';
import { runBackupSmbCredentialProbe } from './backup-smb-probe.js';
try {
  // Fixed capabilities only. The owner probe independently verifies its actual root parent, owner and vault before holding any credential.
  if (
    process.stdin.isTTY ||
    !(
      process.argv.length === 2 ||
      (process.argv.length === 3 && ['--install', '--backup-credential-probe'].includes(process.argv[2]))
    )
  )
    throw Error('invalid_root_invocation');
  if (process.argv[2] === '--backup-credential-probe') {
    await runBackupSmbCredentialProbe(process.stdin, process.stdout);
  } else {
    const result =
      process.argv[2] === '--install'
        ? await runVaultRootInstaller(process.stdin)
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
        : '{"code":"vault_root_gateway_unavailable"}\n',
  );
  process.exitCode = 1;
}
