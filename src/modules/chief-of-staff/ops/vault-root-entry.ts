import { runVaultRootGateway } from './vault-root-gateway.js';
import { runVaultRootInstaller } from './vault-root-installer.js';
try {
  // Two fixed capabilities. Installation must execute from the exact staged sealed package; provisioning from the root-owned package.
  if (
    process.stdin.isTTY ||
    !(process.argv.length === 2 || (process.argv.length === 3 && process.argv[2] === '--install'))
  )
    throw Error('invalid_root_invocation');
  const result =
    process.argv.length === 3 ? await runVaultRootInstaller(process.stdin) : await runVaultRootGateway(process.stdin);
  process.stdout.write(JSON.stringify(result) + '\n');
  // eslint-disable-next-line no-catch-all/no-catch-all -- Installed CLI errors are always a fixed non-secret receipt.
} catch {
  process.stderr.write(
    process.argv.length === 3 && process.argv[2] === '--install'
      ? '{"code":"vault_root_installation_unavailable"}\n'
      : '{"code":"vault_root_gateway_unavailable"}\n',
  );
  process.exitCode = 1;
}
